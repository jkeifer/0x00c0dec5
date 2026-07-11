// MUST be the first import: flips react-dom's dev-only perf-track gate
// before react-dom initializes (see the module's doc comment).
import './devDisableReactPerfTrack.ts'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { App } from './components/layout/App.tsx'
import { AppStateProvider } from './state/useAppState.ts'
import { HoverProvider } from './hooks/useHover.ts'
import { loadUiPrefs, applyTheme, watchSystemTheme } from './state/uiPrefs.ts'
import { BUILD_INFO } from './build-info.js'

// index.html's blocking script already set data-theme pre-paint; re-applying
// here keeps a single source of truth (uiPrefs) once the app is running, and
// the watcher re-resolves on OS theme changes while the pref is 'system'.
applyTheme(loadUiPrefs().theme)
watchSystemTheme()

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js?v=${BUILD_INFO.commit}`)
      .catch((err: unknown) => console.warn('Service worker registration failed:', err))
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppStateProvider>
      <HoverProvider>
        <App />
      </HoverProvider>
    </AppStateProvider>
  </StrictMode>,
)
