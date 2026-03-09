use serde::{Deserialize, Deserializer, Serialize};
use std::{
  error::Error,
  fs,
  path::{Path, PathBuf},
  time::Duration,
};
use tauri::{AppHandle, Manager};
use thiserror::Error;
use walkdir::WalkDir;
use base64::{engine::general_purpose::STANDARD, Engine as _};

const SETTINGS_FILE_NAME: &str = "settings.json";
const IMAGE_EXTENSIONS: [&str; 4] = ["jpg", "jpeg", "png", "webp"];

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PromptPreset {
  pub id: String,
  pub name: String,
  pub system_prompt: String,
  pub user_prompt: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PromptPresetCompat {
  id: String,
  name: String,
  system_prompt: Option<String>,
  user_prompt: Option<String>,
  prompt: Option<String>,
}

impl<'de> Deserialize<'de> for PromptPreset {
  fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
  where
    D: Deserializer<'de>,
  {
    let compat = PromptPresetCompat::deserialize(deserializer)?;
    Ok(Self {
      id: compat.id,
      name: compat.name,
      system_prompt: compat.system_prompt.unwrap_or_else(default_system_prompt),
      user_prompt: compat
        .user_prompt
        .or(compat.prompt)
        .unwrap_or_else(default_user_prompt),
    })
  }
}

fn default_system_prompt() -> String {
  "You are a helpful image captioning assistant. Return only the final caption text without reasoning or explanation.".to_string()
}

fn default_user_prompt() -> String {
  "Generate a concise caption for this image.".to_string()
}

fn should_generate_caption(entry: &ImageEntry, overwrite_mode: &str) -> Result<bool, BackendError> {
  if !Path::new(&entry.caption_path).exists() {
    return Ok(true);
  }

  match overwrite_mode {
    "overwrite" => Ok(true),
    "only-empty" => {
      let existing = fs::read_to_string(&entry.caption_path)?;
      Ok(existing.trim().is_empty())
    }
    _ => Ok(false),
  }
}

fn describe_reqwest_error(error: &reqwest::Error) -> String {
  let category = if error.is_timeout() {
    "timeout"
  } else if error.is_connect() {
    "connect"
  } else if error.is_request() {
    "request"
  } else if error.is_body() {
    "body"
  } else if error.is_decode() {
    "decode"
  } else if error.is_status() {
    "status"
  } else if error.is_builder() {
    "builder"
  } else if error.is_redirect() {
    "redirect"
  } else {
    "unknown"
  };

  let mut chain = Vec::new();
  let mut current = error.source();
  while let Some(source) = current {
    chain.push(source.to_string());
    current = source.source();
  }

  if chain.is_empty() {
    format!("[{category}] {error}")
  } else {
    format!("[{category}] {error}; causes: {}", chain.join(" | "))
  }
}

fn build_responses_endpoint(base_url: &str) -> String {
  let trimmed = base_url.trim_end_matches('/');
  if trimmed.ends_with("/responses") {
    trimmed.to_string()
  } else if trimmed.ends_with("/chat/completions") {
    format!("{}/responses", trimmed.trim_end_matches("/chat/completions"))
  } else {
    format!("{trimmed}/responses")
  }
}

async fn generate_caption_for_image(
  image_path: &str,
  system_prompt: &str,
  user_prompt: &str,
  settings: &AppSettings,
) -> Result<String, BackendError> {
  if settings.base_url.trim().is_empty() {
    return Err(BackendError::Config("base_url is required".to_string()));
  }

  if settings.model.trim().is_empty() {
    return Err(BackendError::Config("model is required".to_string()));
  }

  let image_bytes = fs::read(image_path)?;
  let extension = Path::new(image_path)
    .extension()
    .and_then(|ext| ext.to_str())
    .unwrap_or("jpeg")
    .to_ascii_lowercase();
  let mime = match extension.as_str() {
    "png" => "image/png",
    "webp" => "image/webp",
    _ => "image/jpeg",
  };

  let image_data_url = format!("data:{mime};base64,{}", STANDARD.encode(image_bytes));
  let endpoint = build_responses_endpoint(&settings.base_url);
  let client = reqwest::Client::builder()
    .timeout(Duration::from_secs(settings.request_timeout_seconds.max(1) as u64))
    .build()?;

  let payload = ResponsesRequest {
    model: settings.model.clone(),
    input: vec![
      ResponsesInputItem {
        role: "system".to_string(),
        content: vec![ResponsesContent::InputText {
          text: system_prompt.to_string(),
        }],
      },
      ResponsesInputItem {
        role: "user".to_string(),
        content: vec![
          ResponsesContent::InputText {
            text: user_prompt.to_string(),
          },
          ResponsesContent::InputImage {
            image_url: image_data_url,
          },
        ],
      },
    ],
    reasoning: Some(ReasoningConfig {
      effort: "low".to_string(),
    }),
  };

  let mut request = client.post(&endpoint).json(&payload);
  if !settings.api_key.trim().is_empty() {
    request = request.bearer_auth(settings.api_key.trim());
  }

  let endpoint_for_error = endpoint.clone();
  let response = request.send().await.map_err(|error| {
    BackendError::Config(format!(
      "request to {endpoint_for_error} failed: {}",
      describe_reqwest_error(&error)
    ))
  })?;

  let status = response.status();
  let response_text = response.text().await.map_err(|error| {
    BackendError::Config(format!(
      "failed to read response body from {endpoint_for_error}: {error}"
    ))
  })?;

  if !status.is_success() {
    return Err(BackendError::Config(format!(
      "request to {endpoint_for_error} returned HTTP {}: {}",
      status,
      response_text.trim()
    )));
  }

  let parsed: ResponsesResponse = serde_json::from_str(&response_text).map_err(|error| {
    BackendError::Config(format!(
      "failed to parse responses payload from {endpoint_for_error}: {error}. Raw response: {}",
      response_text.trim()
    ))
  })?;
  parsed
    .output
    .into_iter()
    .find_map(|item| match item {
      ResponseOutputItem::Message { content, .. } => Some(content),
      _ => None,
    })
    .and_then(|content| {
      content.into_iter().find_map(|item| match item {
        ResponseMessageContent::OutputText { text } => {
          let trimmed = text.trim().to_string();
          if trimmed.is_empty() {
            None
          } else {
            Some(trimmed)
          }
        }
        _ => None,
      })
    })
    .ok_or_else(|| {
      BackendError::Config(format!(
        "no final output_text returned from API {endpoint_for_error}. Raw response: {}",
        response_text.trim()
      ))
    })
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
  pub base_url: String,
  pub api_key: String,
  pub model: String,
  pub concurrency: u32,
  pub retry_count: u32,
  pub request_timeout_seconds: u32,
  pub selected_prompt_preset_id: String,
  pub prompt_presets: Vec<PromptPreset>,
  pub last_opened_directory: String,
  pub overwrite_mode: String,
  pub dry_run_count: u32,
  pub theme: String,
}

impl Default for AppSettings {
  fn default() -> Self {
    Self {
      base_url: String::new(),
      api_key: String::new(),
      model: String::new(),
      concurrency: 3,
      retry_count: 2,
      request_timeout_seconds: 300,
      selected_prompt_preset_id: "default".to_string(),
      prompt_presets: vec![PromptPreset {
        id: "default".to_string(),
        name: "Default".to_string(),
        system_prompt: "You are a helpful image captioning assistant. Return only the final caption text without reasoning or explanation.".to_string(),
        user_prompt: "Generate a concise caption for this image.".to_string(),
      }],
      last_opened_directory: String::new(),
      overwrite_mode: "skip".to_string(),
      dry_run_count: 5,
      theme: "system".to_string(),
    }
  }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImageEntry {
  pub image_path: String,
  pub caption_path: String,
  pub file_name: String,
  pub relative_path: String,
  pub has_caption: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BatchResult {
  pub image_path: String,
  pub caption_path: String,
  pub status: String,
  pub caption: String,
  pub error: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResponsesRequest {
  model: String,
  input: Vec<ResponsesInputItem>,
  #[serde(skip_serializing_if = "Option::is_none")]
  reasoning: Option<ReasoningConfig>,
}

#[derive(Debug, Serialize)]
struct ResponsesInputItem {
  role: String,
  content: Vec<ResponsesContent>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type")]
enum ResponsesContent {
  #[serde(rename = "input_text")]
  InputText { text: String },
  #[serde(rename = "input_image")]
  InputImage { image_url: String },
}

#[derive(Debug, Serialize)]
struct ReasoningConfig {
  effort: String,
}

#[derive(Debug, Deserialize)]
struct ResponsesResponse {
  output: Vec<ResponseOutputItem>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum ResponseOutputItem {
  #[serde(rename = "message")]
  Message {
    content: Vec<ResponseMessageContent>,
  },
  #[serde(other)]
  Other,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum ResponseMessageContent {
  #[serde(rename = "output_text")]
  OutputText { text: String },
  #[serde(other)]
  Other,
}

#[derive(Debug, Error)]
enum BackendError {
  #[error("failed to resolve app config directory")]
  MissingConfigDir,
  #[error("io error: {0}")]
  Io(#[from] std::io::Error),
  #[error("serialization error: {0}")]
  Serde(#[from] serde_json::Error),
  #[error("path is invalid")]
  InvalidPath,
  #[error("http error: {0}")]
  Http(#[from] reqwest::Error),
  #[error("configuration error: {0}")]
  Config(String),
}

impl Serialize for BackendError {
  fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
  where
    S: serde::Serializer,
  {
    serializer.serialize_str(&self.to_string())
  }
}

fn app_config_dir(app: &AppHandle) -> Result<PathBuf, BackendError> {
  app
    .path()
    .app_config_dir()
    .map_err(|_| BackendError::MissingConfigDir)
}

fn settings_file_path(app: &AppHandle) -> Result<PathBuf, BackendError> {
  Ok(app_config_dir(app)?.join(SETTINGS_FILE_NAME))
}

fn ensure_parent_dir(path: &Path) -> Result<(), BackendError> {
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent)?;
  }
  Ok(())
}

#[tauri::command]
async fn generate_caption(
  image_path: String,
  system_prompt: String,
  user_prompt: String,
  settings: AppSettings,
) -> Result<String, BackendError> {
  generate_caption_for_image(&image_path, &system_prompt, &user_prompt, &settings).await
}

#[tauri::command]
async fn generate_captions_batch(
  images: Vec<ImageEntry>,
  settings: AppSettings,
  system_prompt: String,
  user_prompt: String,
) -> Result<Vec<BatchResult>, BackendError> {
  let limit = if settings.dry_run_count == 0 {
    images.len()
  } else {
    settings.dry_run_count as usize
  };

  let mut results = Vec::new();

  for image in images.into_iter().take(limit) {
    if !should_generate_caption(&image, &settings.overwrite_mode)? {
      results.push(BatchResult {
        image_path: image.image_path,
        caption_path: image.caption_path,
        status: "skipped".to_string(),
        caption: String::new(),
        error: String::new(),
      });
      continue;
    }

    match generate_caption_for_image(&image.image_path, &system_prompt, &user_prompt, &settings).await {
      Ok(caption) => {
        save_caption(image.caption_path.clone(), caption.clone())?;
        results.push(BatchResult {
          image_path: image.image_path,
          caption_path: image.caption_path,
          status: "success".to_string(),
          caption,
          error: String::new(),
        });
      }
      Err(error) => {
        results.push(BatchResult {
          image_path: image.image_path,
          caption_path: image.caption_path,
          status: "failed".to_string(),
          caption: String::new(),
          error: error.to_string(),
        });
      }
    }
  }

  Ok(results)
}

fn caption_path_for(image_path: &Path) -> Result<PathBuf, BackendError> {
  let stem = image_path.file_stem().ok_or(BackendError::InvalidPath)?;
  let mut caption_path = image_path.to_path_buf();
  caption_path.set_file_name(format!("{}.txt", stem.to_string_lossy()));
  Ok(caption_path)
}

fn is_supported_image(path: &Path) -> bool {
  path
    .extension()
    .and_then(|ext| ext.to_str())
    .map(|ext| IMAGE_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
    .unwrap_or(false)
}

fn scan_images(root: &Path) -> Result<Vec<ImageEntry>, BackendError> {
  let mut entries = Vec::new();

  for entry in WalkDir::new(root)
    .into_iter()
    .filter_map(Result::ok)
    .filter(|entry| entry.file_type().is_file())
  {
    let path = entry.path();
    if !is_supported_image(path) {
      continue;
    }

    let caption_path = caption_path_for(path)?;
    let relative_path = path
      .strip_prefix(root)
      .map_err(|_| BackendError::InvalidPath)?
      .to_string_lossy()
      .to_string();

    entries.push(ImageEntry {
      image_path: path.to_string_lossy().to_string(),
      caption_path: caption_path.to_string_lossy().to_string(),
      file_name: path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_string(),
      relative_path,
      has_caption: caption_path.exists(),
    });
  }

  entries.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
  Ok(entries)
}

#[tauri::command]
fn load_settings(app: AppHandle) -> Result<AppSettings, BackendError> {
  let path = settings_file_path(&app)?;

  if !path.exists() {
    return Ok(AppSettings::default());
  }

  let content = fs::read_to_string(path)?;
  Ok(serde_json::from_str(&content)?)
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: AppSettings) -> Result<(), BackendError> {
  let path = settings_file_path(&app)?;
  ensure_parent_dir(&path)?;
  fs::write(path, serde_json::to_string_pretty(&settings)?)?;
  Ok(())
}

#[tauri::command]
fn scan_directory(directory_path: String) -> Result<Vec<ImageEntry>, BackendError> {
  let root = PathBuf::from(directory_path);
  if !root.exists() || !root.is_dir() {
    return Err(BackendError::InvalidPath);
  }
  scan_images(&root)
}

#[tauri::command]
fn read_caption(caption_path: String) -> Result<String, BackendError> {
  let path = PathBuf::from(caption_path);
  if !path.exists() {
    return Ok(String::new());
  }
  Ok(fs::read_to_string(path)?)
}

#[tauri::command]
fn save_caption(caption_path: String, content: String) -> Result<(), BackendError> {
  let path = PathBuf::from(caption_path);
  ensure_parent_dir(&path)?;
  fs::write(path, content)?;
  Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())
    .invoke_handler(tauri::generate_handler![
      load_settings,
      save_settings,
      scan_directory,
      read_caption,
      save_caption,
      generate_caption,
      generate_captions_batch,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
  use super::*;
  use tempfile::tempdir;

  #[test]
  fn caption_path_uses_same_basename() {
    let image_path = PathBuf::from("/tmp/example/photo.JPG");
    let caption_path = caption_path_for(&image_path).unwrap();
    assert_eq!(caption_path, PathBuf::from("/tmp/example/photo.txt"));
  }

  #[test]
  fn supported_extensions_are_case_insensitive() {
    assert!(is_supported_image(Path::new("sample.JPG")));
    assert!(is_supported_image(Path::new("sample.jpeg")));
    assert!(is_supported_image(Path::new("sample.png")));
    assert!(is_supported_image(Path::new("sample.WebP")));
    assert!(!is_supported_image(Path::new("sample.gif")));
  }

  #[test]
  fn scan_directory_collects_images_and_caption_state() {
    let dir = tempdir().unwrap();
    let nested = dir.path().join("nested");
    fs::create_dir_all(&nested).unwrap();

    let image_a = dir.path().join("a.jpg");
    let image_b = nested.join("b.PNG");
    let ignored = nested.join("c.txt");
    let caption_b = nested.join("b.txt");

    fs::write(&image_a, b"a").unwrap();
    fs::write(&image_b, b"b").unwrap();
    fs::write(&ignored, b"ignored").unwrap();
    fs::write(&caption_b, "caption").unwrap();

    let result = scan_images(dir.path()).unwrap();
    assert_eq!(result.len(), 2);
    assert_eq!(result[0].relative_path, "a.jpg");
    assert!(!result[0].has_caption);
    assert_eq!(result[1].relative_path, "nested/b.PNG");
    assert!(result[1].has_caption);
    assert!(result[1].caption_path.ends_with("nested/b.txt"));
  }
}
