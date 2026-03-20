import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { App } from './components/layout/App.tsx'
import { AppStateProvider } from './state/useAppState.ts'
import { HoverProvider } from './hooks/useHover.ts'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppStateProvider>
      <HoverProvider>
        <App />
      </HoverProvider>
    </AppStateProvider>
  </StrictMode>,
)
