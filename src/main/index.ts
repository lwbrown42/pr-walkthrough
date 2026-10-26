import { app, shell, BrowserWindow, safeStorage } from 'electron'
import { readFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerIpc } from './ipc'
import { createReviewStore } from './reviews/store'
import { createSettingsStore } from './settings'
import { setClaudeExecutablePath, toUnpackedPath } from './agent/options'
import { withHomebrewPath } from './git/run'
import type { Walkthrough } from '../shared/walkthrough'

/** Dev aid: `--fixture <file.json>` loads a Walkthrough and opens straight onto it. */
function loadFixture(): Walkthrough | null {
  const i = process.argv.indexOf('--fixture')
  if (i < 0 || !process.argv[i + 1]) return null
  return JSON.parse(readFileSync(process.argv[i + 1], 'utf8')) as Walkthrough
}

/** Point the Agent SDK at the Claude Code binary outside app.asar (packaged apps can't spawn it from inside). */
function configureClaudeExecutable(): void {
  try {
    const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`
    setClaudeExecutablePath(toUnpackedPath(createRequire(__filename).resolve(pkg)))
  } catch (err) {
    console.error('Could not locate the bundled Claude Code binary:', err)
  }
}

// Finder/Dock launches get launchd's minimal PATH; make Homebrew's gh (and git) findable.
process.env.PATH = withHomebrewPath(process.env.PATH)

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    title: 'Code Review Helper',
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  const win = mainWindow
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
  win.on('ready-to-show', () => {
    win.show()
  })

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  configureClaudeExecutable()

  const userData = app.getPath('userData')
  const settings = createSettingsStore(userData, {
    encrypt: (s) => safeStorage.encryptString(s),
    decrypt: (b) => safeStorage.decryptString(b),
    available: () => safeStorage.isEncryptionAvailable()
  })
  registerIpc({
    settings,
    worktreesDir: join(userData, 'worktrees'),
    reviews: createReviewStore(join(userData, 'reviews')),
    getWindow: () => mainWindow,
    fixture: loadFixture()
  })

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
