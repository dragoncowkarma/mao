import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { primeDocumentAppearance } from './appearance-cache'
import { setElectronApi } from './electron-api'
import './index.css'

// Before the first render, so no effect can run against an unbound bridge or unstyled frame.
setElectronApi(window.electronAPI)
primeDocumentAppearance()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
