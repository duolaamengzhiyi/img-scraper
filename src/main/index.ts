import { app, BrowserWindow, protocol, shell } from 'electron'
import { join } from 'node:path'
import type { IpcEventChannel, IpcEventMap } from '@shared/ipc'
import { PIXIV_IMG_PROTOCOL } from '@shared/ipc'
import { dbPath } from './config/paths'
import { initLibraryDb } from './storage/db'
import { registerPixivImgProtocol } from './protocol'
import { registerIpcHandlers } from './ipc/handlers'
import { downloader } from './download/downloader'
import { syncEngine } from './sync/sync'

const isDev = !app.isPackaged

// 自定义协议需在 app ready 前声明为特权
protocol.registerSchemesAsPrivileged([
  {
    scheme: PIXIV_IMG_PROTOCOL,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])

let mainWindow: BrowserWindow | null = null

function emit<K extends IpcEventChannel>(channel: K, payload: IpcEventMap[K]): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0a0a0b',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // 新窗口一律拒绝；仅对 http/https 链接交给系统浏览器打开，过滤 file:/ 自定义协议等
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const proto = new URL(url).protocol
      if (proto === 'http:' || proto === 'https:') void shell.openExternal(url)
    } catch {
      /* 非法 URL 忽略 */
    }
    return { action: 'deny' }
  })

  // 阻止顶层导航离开应用自身 origin（外链应走上面的 openExternal）
  mainWindow.webContents.on('will-navigate', (e, url) => {
    const current = mainWindow?.webContents.getURL() ?? ''
    try {
      if (new URL(url).origin !== new URL(current).origin) e.preventDefault()
    } catch {
      e.preventDefault()
    }
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  initLibraryDb(dbPath())
  registerPixivImgProtocol()

  downloader.setEmitter(emit)
  syncEngine.setEmitter(emit)

  registerIpcHandlers(() => mainWindow)
  downloader.restore()

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
