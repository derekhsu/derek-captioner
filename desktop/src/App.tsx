import { useEffect, useMemo, useState } from 'react'
import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import {
  Alert,
  AppShell,
  Badge,
  Box,
  Button,
  Card,
  Divider,
  Flex,
  Group,
  NumberInput,
  Paper,
  PasswordInput,
  ScrollArea,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Textarea,
  ThemeIcon,
  Title,
  UnstyledButton,
} from '@mantine/core'
import './App.css'

type PromptPreset = {
  id: string
  name: string
  systemPrompt: string
  userPrompt: string
}

type AppSettings = {
  baseUrl: string
  apiKey: string
  model: string
  concurrency: number
  retryCount: number
  requestTimeoutSeconds: number
  selectedPromptPresetId: string
  promptPresets: PromptPreset[]
  lastOpenedDirectory: string
  overwriteMode: string
  dryRunCount: number
  theme: string
}

type ImageEntry = {
  imagePath: string
  captionPath: string
  fileName: string
  relativePath: string
  hasCaption: boolean
}

type BatchResult = {
  imagePath: string
  captionPath: string
  status: string
  caption: string
  error: string
}

const defaultSettings: AppSettings = {
  baseUrl: '',
  apiKey: '',
  model: '',
  concurrency: 3,
  retryCount: 2,
  requestTimeoutSeconds: 300,
  selectedPromptPresetId: 'default',
  promptPresets: [
    {
      id: 'default',
      name: 'Default',
      systemPrompt:
        'You are a helpful image captioning assistant. Return only the final caption text without reasoning or explanation.',
      userPrompt: 'Generate a concise caption for this image.',
    },
  ],
  lastOpenedDirectory: '',
  overwriteMode: 'skip',
  dryRunCount: 5,
  theme: 'system',
}

const defaultSystemPrompt =
  'You are a helpful image captioning assistant. Return only the final caption text without reasoning or explanation.'

const defaultUserPrompt = 'Generate a concise caption for this image.'

type ImageViewMode = 'grid' | 'list'

function App() {
  const [settings, setSettings] = useState<AppSettings>(defaultSettings)
  const [images, setImages] = useState<ImageEntry[]>([])
  const [selectedImagePath, setSelectedImagePath] = useState<string>('')
  const [captionText, setCaptionText] = useState('')
  const [savedCaptionText, setSavedCaptionText] = useState('')
  const [statusMessage, setStatusMessage] = useState('Loading settings...')
  const [errorMessage, setErrorMessage] = useState('')
  const [isBusy, setIsBusy] = useState(false)
  const [batchResults, setBatchResults] = useState<BatchResult[]>([])
  const [imageViewMode, setImageViewMode] = useState<ImageViewMode>('list')

  const selectedImage = useMemo(
    () => images.find((entry) => entry.imagePath === selectedImagePath) ?? null,
    [images, selectedImagePath],
  )

  const summary = useMemo(() => {
    const total = images.length
    const hasCaption = images.filter((image) => image.hasCaption).length
    return {
      total,
      hasCaption,
      pending: total - hasCaption,
    }
  }, [images])

  const selectedPromptPreset = useMemo(
    () => settings.promptPresets.find((preset) => preset.id === settings.selectedPromptPresetId) ?? settings.promptPresets[0],
    [settings.promptPresets, settings.selectedPromptPresetId],
  )

  function buildPresetId() {
    return `preset-${Date.now()}`
  }

  function handleCreatePreset() {
    const newPreset: PromptPreset = {
      id: buildPresetId(),
      name: `Preset ${settings.promptPresets.length + 1}`,
      systemPrompt: defaultSystemPrompt,
      userPrompt: defaultUserPrompt,
    }
    const nextSettings = {
      ...settings,
      selectedPromptPresetId: newPreset.id,
      promptPresets: [...settings.promptPresets, newPreset],
    }
    void persistSettings(nextSettings)
  }

  function handleDuplicatePreset() {
    if (!selectedPromptPreset) {
      return
    }

    const duplicatedPreset: PromptPreset = {
      ...selectedPromptPreset,
      id: buildPresetId(),
      name: `${selectedPromptPreset.name} Copy`,
    }
    const nextSettings = {
      ...settings,
      selectedPromptPresetId: duplicatedPreset.id,
      promptPresets: [...settings.promptPresets, duplicatedPreset],
    }
    void persistSettings(nextSettings)
  }

  function handleDeletePreset() {
    if (!selectedPromptPreset || settings.promptPresets.length <= 1) {
      return
    }

    const nextPromptPresets = settings.promptPresets.filter((preset) => preset.id !== selectedPromptPreset.id)
    const nextSelectedPresetId = nextPromptPresets[0]?.id ?? 'default'
    const nextSettings = {
      ...settings,
      selectedPromptPresetId: nextSelectedPresetId,
      promptPresets: nextPromptPresets,
    }
    void persistSettings(nextSettings)
  }

  async function handleGenerateSelected() {
    if (!selectedImage) {
      return
    }

    setIsBusy(true)
    setStatusMessage('Generating caption for selected image...')
    setErrorMessage('')

    try {
      const caption = await invoke<string>('generate_caption', {
        imagePath: selectedImage.imagePath,
        systemPrompt: selectedPromptPreset?.systemPrompt ?? '',
        userPrompt: selectedPromptPreset?.userPrompt ?? '',
        settings,
      })
      setCaptionText(caption)
      setSavedCaptionText(caption)
      await invoke('save_caption', {
        captionPath: selectedImage.captionPath,
        content: caption,
      })
      setImages((current) =>
        current.map((image) =>
          image.imagePath === selectedImage.imagePath ? { ...image, hasCaption: caption.trim().length > 0 } : image,
        ),
      )
      setStatusMessage('Caption generated and saved.')
    } catch (error) {
      setErrorMessage(String(error))
      setStatusMessage('Failed to generate caption.')
    } finally {
      setIsBusy(false)
    }
  }

  async function handleGenerateBatch() {
    setIsBusy(true)
    setStatusMessage('Generating captions in batch...')
    setErrorMessage('')

    try {
      const results = await invoke<BatchResult[]>('generate_captions_batch', {
        images,
        settings,
        systemPrompt: selectedPromptPreset?.systemPrompt ?? '',
        userPrompt: selectedPromptPreset?.userPrompt ?? '',
      })
      setBatchResults(results)
      setImages((current) =>
        current.map((image) => {
          const result = results.find((item) => item.imagePath === image.imagePath)
          if (!result) {
            return image
          }
          return { ...image, hasCaption: result.status === 'success' || image.hasCaption }
        }),
      )
      if (selectedImage) {
        const selectedResult = results.find((item) => item.imagePath === selectedImage.imagePath)
        if (selectedResult?.status === 'success') {
          setCaptionText(selectedResult.caption)
          setSavedCaptionText(selectedResult.caption)
        }
      }
      const successCount = results.filter((result) => result.status === 'success').length
      const skippedCount = results.filter((result) => result.status === 'skipped').length
      const failedCount = results.filter((result) => result.status === 'failed').length
      setStatusMessage(`Batch complete. Success: ${successCount}, skipped: ${skippedCount}, failed: ${failedCount}.`)
    } catch (error) {
      setErrorMessage(String(error))
      setStatusMessage('Batch generation failed.')
    } finally {
      setIsBusy(false)
    }
  }

  useEffect(() => {
    void initialize()
  }, [])

  useEffect(() => {
    if (!selectedImage) {
      setCaptionText('')
      setSavedCaptionText('')
      return
    }

    void loadCaption(selectedImage.captionPath)
  }, [selectedImagePath])

  async function initialize() {
    try {
      const loadedSettings = await invoke<AppSettings>('load_settings')
      setSettings(loadedSettings)
      setStatusMessage('Settings loaded.')

      if (loadedSettings.lastOpenedDirectory) {
        await handleScanDirectory(loadedSettings.lastOpenedDirectory, false)
      }
    } catch (error) {
      setErrorMessage(String(error))
      setStatusMessage('Failed to load settings.')
    }
  }

  async function persistSettings(nextSettings: AppSettings) {
    setSettings(nextSettings)
    try {
      await invoke('save_settings', { settings: nextSettings })
      setStatusMessage('Settings saved.')
      setErrorMessage('')
    } catch (error) {
      setErrorMessage(String(error))
      setStatusMessage('Failed to save settings.')
    }
  }

  async function loadCaption(captionPath: string) {
    try {
      const content = await invoke<string>('read_caption', { captionPath })
      setCaptionText(content)
      setSavedCaptionText(content)
      setErrorMessage('')
    } catch (error) {
      setErrorMessage(String(error))
    }
  }

  async function handleSelectDirectory() {
    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath: settings.lastOpenedDirectory || undefined,
    })

    if (!selected || Array.isArray(selected)) {
      return
    }

    await handleScanDirectory(selected, true)
  }

  async function handleScanDirectory(directoryPath: string, persist: boolean) {
    setIsBusy(true)
    setStatusMessage('Scanning directory...')
    setErrorMessage('')

    try {
      const scanned = await invoke<ImageEntry[]>('scan_directory', { directoryPath })
      setImages(scanned)
      setSelectedImagePath(scanned[0]?.imagePath ?? '')
      setStatusMessage(`Loaded ${scanned.length} image(s).`)

      if (persist) {
        const nextSettings = { ...settings, lastOpenedDirectory: directoryPath }
        await persistSettings(nextSettings)
      }
    } catch (error) {
      setErrorMessage(String(error))
      setStatusMessage('Directory scan failed.')
    } finally {
      setIsBusy(false)
    }
  }

  async function handleSaveCaption() {
    if (!selectedImage) {
      return
    }

    setIsBusy(true)
    try {
      await invoke('save_caption', {
        captionPath: selectedImage.captionPath,
        content: captionText,
      })
      setSavedCaptionText(captionText)
      setImages((current) =>
        current.map((image) =>
          image.imagePath === selectedImage.imagePath ? { ...image, hasCaption: captionText.trim().length > 0 } : image,
        ),
      )
      setStatusMessage('Caption saved.')
      setErrorMessage('')
    } catch (error) {
      setErrorMessage(String(error))
      setStatusMessage('Failed to save caption.')
    } finally {
      setIsBusy(false)
    }
  }

  function updateSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    void persistSettings({ ...settings, [key]: value })
  }

  function updateSelectedPreset(patch: Partial<PromptPreset>) {
    const nextPromptPresets = settings.promptPresets.map((preset) =>
      preset.id === settings.selectedPromptPresetId ? { ...preset, ...patch } : preset,
    )
    setSettings((current) => ({ ...current, promptPresets: nextPromptPresets }))
  }

  const hasUnsavedCaption = captionText !== savedCaptionText

  return (
    <AppShell header={{ height: 72 }} padding="md" className="app-shell">
      <AppShell.Header className="mantine-header">
        <Group justify="space-between" align="center" h="100%" px="md">
          <Box>
            <Title order={2}>Captioner</Title>
            <Text c="dimmed" size="sm">
              Scan image folders, preview results, and edit caption text files.
            </Text>
          </Box>
          <Button onClick={() => void handleSelectDirectory()} loading={isBusy} variant="filled">
            Select Folder
          </Button>
        </Group>
      </AppShell.Header>

      <AppShell.Main className="app-main-shell">
        <Stack gap="md" h="calc(100vh - 88px)" className="app-main-stack">
          <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
            <Paper withBorder p="md" className="panel-surface">
              <Stack gap="xs">
                <Text size="xs" tt="uppercase" fw={700} c="dimmed">
                  Status
                </Text>
                <Text fw={600}>{statusMessage}</Text>
                {errorMessage ? (
                  <Alert color="red" variant="light" title="Last error">
                    {errorMessage}
                  </Alert>
                ) : null}
              </Stack>
            </Paper>

            <SimpleGrid cols={3} spacing="sm">
              <Paper withBorder p="md" className="panel-surface summary-card">
                <Text c="dimmed" size="sm">
                  Total
                </Text>
                <Title order={2}>{summary.total}</Title>
              </Paper>
              <Paper withBorder p="md" className="panel-surface summary-card">
                <Text c="dimmed" size="sm">
                  With caption
                </Text>
                <Title order={2}>{summary.hasCaption}</Title>
              </Paper>
              <Paper withBorder p="md" className="panel-surface summary-card">
                <Text c="dimmed" size="sm">
                  Pending
                </Text>
                <Title order={2}>{summary.pending}</Title>
              </Paper>
            </SimpleGrid>
          </SimpleGrid>

          <Group gap="sm">
            <Button onClick={() => void handleGenerateSelected()} disabled={isBusy || !selectedImage}>
              Generate Selected
            </Button>
            <Button onClick={() => void handleGenerateBatch()} disabled={isBusy || images.length === 0} variant="default">
              Generate Batch
            </Button>
          </Group>

          <Box className="workspace-shell">
            <Flex gap="md" className="workspace-grid">
              <Paper withBorder p="md" className="panel-surface settings-panel desktop-panel">
                <Stack gap="md" h="100%" className="desktop-panel-stack">
                  <Title order={3}>Settings</Title>
                  <ScrollArea type="auto" offsetScrollbars className="panel-scroll-area">
                    <Stack gap="md" pr="xs">
                      <TextInput
                        label="Base URL"
                        value={settings.baseUrl}
                        onChange={(event) => setSettings((current) => ({ ...current, baseUrl: event.currentTarget.value }))}
                        onBlur={() => updateSetting('baseUrl', settings.baseUrl)}
                        placeholder="http://localhost:1234/v1"
                      />

                      <PasswordInput
                        label="API Key"
                        value={settings.apiKey}
                        onChange={(event) => setSettings((current) => ({ ...current, apiKey: event.currentTarget.value }))}
                        onBlur={() => updateSetting('apiKey', settings.apiKey)}
                        placeholder="Optional"
                      />

                      <TextInput
                        label="Model"
                        value={settings.model}
                        onChange={(event) => setSettings((current) => ({ ...current, model: event.currentTarget.value }))}
                        onBlur={() => updateSetting('model', settings.model)}
                        placeholder="gpt-4.1-mini"
                      />

                      <SimpleGrid cols={2} spacing="sm">
                        <NumberInput
                          label="Concurrency"
                          min={1}
                          value={settings.concurrency}
                          onChange={(value) => setSettings((current) => ({ ...current, concurrency: Number(value) || 1 }))}
                          onBlur={() => updateSetting('concurrency', settings.concurrency)}
                        />
                        <NumberInput
                          label="Retries"
                          min={0}
                          value={settings.retryCount}
                          onChange={(value) => setSettings((current) => ({ ...current, retryCount: Number(value) || 0 }))}
                          onBlur={() => updateSetting('retryCount', settings.retryCount)}
                        />
                      </SimpleGrid>

                      <SimpleGrid cols={2} spacing="sm">
                        <NumberInput
                          label="Timeout (s)"
                          min={1}
                          value={settings.requestTimeoutSeconds}
                          onChange={(value) =>
                            setSettings((current) => ({ ...current, requestTimeoutSeconds: Number(value) || 1 }))
                          }
                          onBlur={() => updateSetting('requestTimeoutSeconds', settings.requestTimeoutSeconds)}
                        />
                        <NumberInput
                          label="Dry run"
                          min={1}
                          value={settings.dryRunCount}
                          onChange={(value) => setSettings((current) => ({ ...current, dryRunCount: Number(value) || 1 }))}
                          onBlur={() => updateSetting('dryRunCount', settings.dryRunCount)}
                        />
                      </SimpleGrid>

                      <Select
                        label="Overwrite mode"
                        value={settings.overwriteMode}
                        onChange={(value) => value && updateSetting('overwriteMode', value)}
                        data={[
                          { value: 'skip', label: 'skip' },
                          { value: 'overwrite', label: 'overwrite' },
                          { value: 'only-empty', label: 'only-empty' },
                        ]}
                      />

                      <Divider label="Prompt presets" labelPosition="left" />

                      <Group grow>
                        <Button type="button" onClick={handleCreatePreset} disabled={isBusy} variant="default">
                          New Preset
                        </Button>
                        <Button type="button" onClick={handleDuplicatePreset} disabled={isBusy || !selectedPromptPreset} variant="default">
                          Duplicate
                        </Button>
                        <Button
                          type="button"
                          onClick={handleDeletePreset}
                          disabled={isBusy || settings.promptPresets.length <= 1 || !selectedPromptPreset}
                          color="red"
                          variant="light"
                        >
                          Delete
                        </Button>
                      </Group>

                      <Select
                        label="Prompt preset"
                        value={settings.selectedPromptPresetId}
                        onChange={(value) => value && updateSetting('selectedPromptPresetId', value)}
                        data={settings.promptPresets.map((preset) => ({ value: preset.id, label: preset.name }))}
                      />

                      <TextInput
                        label="Preset name"
                        value={selectedPromptPreset?.name ?? ''}
                        onChange={(event) => updateSelectedPreset({ name: event.currentTarget.value })}
                        onBlur={() => updateSetting('promptPresets', settings.promptPresets)}
                      />

                      <Textarea
                        label="System prompt"
                        minRows={5}
                        autosize
                        value={selectedPromptPreset?.systemPrompt ?? ''}
                        onChange={(event) => updateSelectedPreset({ systemPrompt: event.currentTarget.value })}
                        onBlur={() => updateSetting('promptPresets', settings.promptPresets)}
                      />

                      <Textarea
                        label="User prompt"
                        minRows={8}
                        autosize
                        value={selectedPromptPreset?.userPrompt ?? ''}
                        onChange={(event) => updateSelectedPreset({ userPrompt: event.currentTarget.value })}
                        onBlur={() => updateSetting('promptPresets', settings.promptPresets)}
                      />
                    </Stack>
                  </ScrollArea>
                </Stack>
              </Paper>

              <Paper withBorder p="md" className="panel-surface image-list-panel desktop-panel">
                <Stack gap="md" h="100%" className="desktop-panel-stack">
                  <Group justify="space-between" align="flex-start">
                    <Stack gap={4}>
                      <Title order={3}>Images</Title>
                      <Text size="xs" c="dimmed" maw={180} style={{ wordBreak: 'break-word' }}>
                        {settings.lastOpenedDirectory || 'No folder selected'}
                      </Text>
                    </Stack>

                    <Group gap={6} wrap="nowrap">
                      <Button
                        size="xs"
                        variant={imageViewMode === 'list' ? 'filled' : 'default'}
                        color="cyan"
                        onClick={() => setImageViewMode('list')}
                      >
                        List
                      </Button>
                      <Button
                        size="xs"
                        variant={imageViewMode === 'grid' ? 'filled' : 'default'}
                        color="cyan"
                        onClick={() => setImageViewMode('grid')}
                      >
                        Grid
                      </Button>
                    </Group>
                  </Group>

                  <ScrollArea type="auto" offsetScrollbars className="panel-scroll-area image-list-scroll-area">
                    {imageViewMode === 'grid' ? (
                      <SimpleGrid cols={2} spacing="xs" pr="xs">
                        {images.length === 0 ? <Text c="dimmed">No images loaded yet.</Text> : null}
                        {images.map((image) => {
                          const isSelected = selectedImagePath === image.imagePath
                          return (
                            <UnstyledButton
                              key={image.imagePath}
                              onClick={() => setSelectedImagePath(image.imagePath)}
                              className={`image-grid-card ${isSelected ? 'selected' : ''}`}
                            >
                              <Stack gap="xs">
                                <Box className="image-thumb-frame image-grid-thumb-frame">
                                  <img
                                    src={convertFileSrc(image.imagePath)}
                                    alt={image.fileName}
                                    className="image-thumb"
                                  />
                                </Box>
                                <Stack gap={4} className="image-grid-copy">
                                  <Text fw={600} size="sm" lineClamp={2}>
                                    {image.fileName}
                                  </Text>
                                  <Group justify="space-between" gap={6} wrap="nowrap" align="center">
                                    <Text size="xs" c="dimmed" truncate>
                                      {image.relativePath}
                                    </Text>
                                    <Badge color={image.hasCaption ? 'teal' : 'yellow'} variant="light">
                                      {image.hasCaption ? 'captioned' : 'empty'}
                                    </Badge>
                                  </Group>
                                </Stack>
                              </Stack>
                            </UnstyledButton>
                          )
                        })}
                      </SimpleGrid>
                    ) : (
                      <Stack gap="xs" pr="xs">
                        {images.length === 0 ? <Text c="dimmed">No images loaded yet.</Text> : null}
                        {images.map((image) => {
                          const isSelected = selectedImagePath === image.imagePath
                          return (
                            <UnstyledButton
                              key={image.imagePath}
                              onClick={() => setSelectedImagePath(image.imagePath)}
                              className={`image-row-card ${isSelected ? 'selected' : ''}`}
                            >
                              <Group justify="space-between" align="center" wrap="nowrap">
                                <Group gap="sm" wrap="nowrap" className="image-row-main">
                                  <Box className="image-thumb-frame image-list-thumb-frame">
                                    <img
                                      src={convertFileSrc(image.imagePath)}
                                      alt={image.fileName}
                                      className="image-thumb"
                                    />
                                  </Box>
                                  <Stack gap={4} className="image-row-copy">
                                    <Text fw={600} truncate>
                                      {image.fileName}
                                    </Text>
                                    <Text size="xs" c="dimmed" truncate>
                                      {image.relativePath}
                                    </Text>
                                  </Stack>
                                </Group>
                                <Badge color={image.hasCaption ? 'teal' : 'yellow'} variant="light">
                                  {image.hasCaption ? 'captioned' : 'empty'}
                                </Badge>
                              </Group>
                            </UnstyledButton>
                          )
                        })}
                      </Stack>
                    )}
                  </ScrollArea>

                  {batchResults.length > 0 ? (
                    <Paper withBorder p="sm" className="sub-panel-surface">
                      <Stack gap="xs">
                        <Text fw={600}>Batch Results</Text>
                        <ScrollArea.Autosize mah={180} type="auto" offsetScrollbars>
                          <Stack gap="xs">
                            {batchResults.slice(0, 20).map((result) => (
                              <Card key={result.imagePath} padding="sm" withBorder className="batch-result-card">
                                <Stack gap={4}>
                                  <Group justify="space-between">
                                    <Text fw={600}>{result.status}</Text>
                                    <Text size="xs" c="dimmed">
                                      {result.imagePath.split('/').pop()}
                                    </Text>
                                  </Group>
                                  {result.error ? (
                                    <Text size="xs" c="red.3">
                                      {result.error}
                                    </Text>
                                  ) : null}
                                </Stack>
                              </Card>
                            ))}
                          </Stack>
                        </ScrollArea.Autosize>
                      </Stack>
                    </Paper>
                  ) : null}
                </Stack>
              </Paper>

              <Paper withBorder p="md" className="panel-surface preview-panel desktop-panel">
                <Stack gap="md" h="100%" className="desktop-panel-stack">
                  <Group justify="space-between" align="flex-start">
                    <Title order={3}>Preview & Caption</Title>
                    {selectedImage ? (
                      <Text size="xs" c="dimmed" ta="right" maw={220} style={{ wordBreak: 'break-word' }}>
                        {selectedImage.relativePath}
                      </Text>
                    ) : null}
                  </Group>

                  {selectedImage ? (
                    <ScrollArea type="auto" offsetScrollbars className="panel-scroll-area">
                      <Stack gap="md" pr="xs">
                        <Paper withBorder className="image-preview-frame">
                          <img src={convertFileSrc(selectedImage.imagePath)} alt={selectedImage.fileName} className="preview-image" />
                        </Paper>

                        <Textarea
                          label="Caption text"
                          minRows={12}
                          autosize
                          value={captionText}
                          onChange={(event) => setCaptionText(event.currentTarget.value)}
                        />

                        <Group justify="space-between" className="sticky-action-row">
                          <Button onClick={() => void handleSaveCaption()} disabled={isBusy || !hasUnsavedCaption}>
                            Save Caption
                          </Button>
                          <Group gap="xs">
                            <ThemeIcon size="sm" variant={hasUnsavedCaption ? 'filled' : 'light'} color={hasUnsavedCaption ? 'yellow' : 'teal'}>
                              <Box component="span" className="status-dot" />
                            </ThemeIcon>
                            <Text size="sm" c={hasUnsavedCaption ? 'yellow.2' : 'teal.2'}>
                              {hasUnsavedCaption ? 'Unsaved changes' : 'Saved'}
                            </Text>
                          </Group>
                        </Group>
                      </Stack>
                    </ScrollArea>
                  ) : (
                    <Flex align="center" justify="center" className="empty-preview-state">
                      <Text c="dimmed">Select an image to preview and edit its caption.</Text>
                    </Flex>
                  )}
                </Stack>
              </Paper>
            </Flex>
          </Box>
        </Stack>
      </AppShell.Main>
    </AppShell>
  )
}

export default App
