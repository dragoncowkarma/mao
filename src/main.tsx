import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { setElectronApi } from './electron-api'
import './index.css'

// Before the first render, so no effect can run against an unbound bridge.
setElectronApi(window.electronAPI)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
