import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MantineProvider } from '@mantine/core'
import '@mantine/core/styles.css'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MantineProvider
      defaultColorScheme="dark"
      theme={{
        primaryColor: 'cyan',
        defaultRadius: 'xs',
        fontFamily: "Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      }}
    >
      <App />
    </MantineProvider>
  </StrictMode>,
)
