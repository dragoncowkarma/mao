import { app, BrowserWindow, shell } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerIpcHandlers } from './ipc.ts'

// Suppress EGL "Bad attribute" noise from Chromium's GPU process.
// eglQueryDeviceAttribEXT is queried during EGL initialisation but the
// extension is not always supported by the host driver, causing a harmless
// but noisy error.  Disabling the GPU sandbox avoids the problematic query
// path without affecting rendering quality on macOS (Metal is used instead).
if (process.platform !== 'darwin') {
  app.commandLine.appendSwitch('disable-gpu-sandbox')
}
app.commandLine.appendSwitch('disable-features', 'UseEcoQoSForBackgroundProcess')
app.commandLine.appendSwitch('log-level', '3') // suppress INFO/WARNING logs from Chromium

const __dirname = path.dirname(fileURLToPath(import.meta.url))

process.env.APP_ROOT = path.join(__dirname, '..')
const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

let win: BrowserWindow | null = null

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  })

  // Board/Queue cards link to GitHub with target="_blank" — Electron denies new-window requests by
  // default, so without this handler those links would silently do nothing. Route them to the OS browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }
}

app.whenReady().then(() => {
  registerIpcHandlers()
  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})
