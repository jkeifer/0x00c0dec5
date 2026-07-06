import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { App } from './components/layout/App.tsx'
import { AppStateProvider } from './state/useAppState.ts'
import { HoverProvider } from './hooks/useHover.ts'
import { loadUiPrefs, applyTheme, watchSystemTheme } from './state/uiPrefs.ts'

// index.html's blocking script already set data-theme pre-paint; re-applying
// here keeps a single source of truth (uiPrefs) once the app is running, and
// the watcher re-resolves on OS theme changes while the pref is 'system'.
applyTheme(loadUiPrefs().theme)
watchSystemTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppStateProvider>
      <HoverProvider>
        <App />
      </HoverProvider>
    </AppStateProvider>
  </StrictMode>,
)
