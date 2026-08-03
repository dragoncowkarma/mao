import os from 'node:os'
import path from 'node:path'

/**
 * Platform-appropriate per-user data directory, mirroring Electron's `app.getPath('userData')`
 * convention without depending on Electron. Used by the CLI, which has no BrowserWindow/app to ask.
 */
export function defaultDataDir(appName = 'mao'): string {
  switch (process.platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', appName)
    case 'win32':
      return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), appName)
    default:
      return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), appName)
  }
}
