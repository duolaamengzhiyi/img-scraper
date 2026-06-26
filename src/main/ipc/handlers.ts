import { BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { realpathSync } from 'node:fs'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import type { IpcInvokeMap } from '@shared/ipc'
import { getSettings, updateSettings } from '../config/store'
import { openWithConfiguredApp } from '../shell-open'
import { libraryDb } from '../storage/db'
import { downloader } from '../download/downloader'
import { syncEngine } from '../sync/sync'
import { moveLibrary, repairLinks } from '../storage/migrate'
import { getAccountStatus, logout, openLoginWindow } from '../pixiv/auth'
import {
  deleteWork,
  ignoreMissing,
  restoreMissing,
  unignoreWork,
  verifyLibrary
} from '../storage/audit'
import { fetchBookmarkTags } from '../pixiv/bookmarks'
import { getUserId } from '../pixiv/session'

function handle<K extends keyof IpcInvokeMap>(
  channel: K,
  fn: (
    ...args: IpcInvokeMap[K]['args']
  ) => IpcInvokeMap[K]['result'] | Promise<IpcInvokeMap[K]['result']>
): void {
  ipcMain.handle(channel, (_e, ...args) => fn(...(args as IpcInvokeMap[K]['args'])))
}

/** 某作品所有已下载页的本地路径 */
function workFilePaths(illustId: string): string[] {
  return libraryDb()
    .getPagesForWork(illustId)
    .map((p) => p.libraryPath)
    .filter((x): x is string => !!x)
}

/**
 * 渲染端传入的路径是否在保存目录之内（含 baseDir 自身）。
 * 用 realpath 解析符号链接后再做边界判断，杜绝渲染层诱导用系统程序打开库外任意文件。
 */
function isWithinBaseDir(p: string): boolean {
  const base = getSettings().baseDir
  if (!base || !p) return false
  try {
    const realBase = realpathSync(resolve(base))
    const real = realpathSync(resolve(p))
    if (real === realBase) return true
    const rel = relative(realBase, real)
    return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
  } catch {
    return false
  }
}

export function registerIpcHandlers(getMainWindow: () => BrowserWindow | null): void {
  // 账号
  handle('auth:status', () => getAccountStatus())
  handle('auth:login', () => openLoginWindow(getMainWindow() ?? undefined))
  handle('auth:logout', async () => {
    await logout()
  })

  // 设置
  handle('settings:get', () => getSettings())
  handle('settings:update', (patch) => updateSettings(patch))
  handle('settings:pickBaseDir', async () => {
    const win = getMainWindow()
    const options: Electron.OpenDialogOptions = {
      properties: ['openDirectory', 'createDirectory']
    }
    const res = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    return res.canceled || !res.filePaths[0] ? null : res.filePaths[0]
  })
  handle('settings:pickOpenApp', async () => {
    const win = getMainWindow()
    const isMac = process.platform === 'darwin'
    const options: Electron.OpenDialogOptions = isMac
      ? {
          properties: ['openFile'],
          defaultPath: '/Applications',
          filters: [{ name: '应用程序', extensions: ['app'] }]
        }
      : { properties: ['openFile'], filters: [{ name: '程序', extensions: ['exe'] }] }
    const res = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    return res.canceled || !res.filePaths[0] ? null : res.filePaths[0]
  })

  // 标签
  handle('tags:list', () => libraryDb().listBookmarkTags())
  handle('tags:refresh', async () => {
    const uid = await getUserId()
    if (!uid) return []
    const resp = await fetchBookmarkTags(uid)
    const now = Date.now()
    libraryDb().replaceBookmarkTags('public', resp.public, now)
    libraryDb().replaceBookmarkTags('private', resp.private, now)
    return libraryDb().listBookmarkTags()
  })

  // 图库
  handle('library:stats', () => libraryDb().getLibraryStats())
  handle('library:listWorks', (query) => libraryDb().listWorks(query))
  handle('library:workFiles', (illustId) =>
    libraryDb()
      .getPagesForWork(illustId)
      .map((p) => p.libraryPath)
      .filter((x): x is string => !!x)
  )
  handle('library:downloadedTags', () => libraryDb().listDownloadedTags())
  handle('library:openWork', (illustId) => openWithConfiguredApp(workFilePaths(illustId)))
  handle('library:showWorkMenu', (illustId) => {
    const files = workFilePaths(illustId)
    if (files.length === 0) return
    const app = getSettings().openWithApp
    const openLabel = app ? `用「${basename(app).replace(/\.(app|exe)$/i, '')}」打开` : '打开'
    const menu = Menu.buildFromTemplate([
      { label: openLabel, click: () => openWithConfiguredApp(files) },
      { label: '打开所在位置', click: () => shell.showItemInFolder(files[0]) }
    ])
    const win = getMainWindow()
    menu.popup(win ? { window: win } : {})
  })
  handle('library:verify', () => verifyLibrary())
  handle('library:restoreMissing', () => restoreMissing())
  handle('library:ignoreMissing', () => ignoreMissing())
  handle('library:deleteWork', (illustId, ignore) => deleteWork(illustId, ignore))
  handle('library:listIgnored', () => libraryDb().listIgnoredWorks())
  handle('library:unignore', (illustId) => unignoreWork(illustId))

  // 同步
  handle('sync:start', (scope) => {
    void syncEngine.start(scope)
  })
  handle('sync:pause', () => syncEngine.pause())
  handle('sync:resume', () => syncEngine.resume())
  handle('sync:stop', () => syncEngine.stop())
  handle('sync:status', () => syncEngine.status())

  // 下载队列
  handle('download:list', () => downloader.list())
  handle('download:pause', (id) => downloader.pause(id))
  handle('download:resume', (id) => downloader.resume(id))
  handle('download:remove', (id) => downloader.remove(id))
  handle('download:retry', (id) => downloader.retry(id))
  handle('download:pauseAll', () => downloader.pauseAll())
  handle('download:resumeAll', () => downloader.resumeAll())
  handle('download:clearCompleted', () => downloader.clearCompleted())

  // 迁移
  handle('migrate:moveLibrary', (newDir) => moveLibrary(newDir))
  handle('migrate:repairLinks', () => repairLinks())

  // 系统（仅允许操作保存目录内的路径，防止渲染层诱导打开库外任意文件）
  handle('shell:openPath', async (p) => {
    if (!isWithinBaseDir(p)) return
    await shell.openPath(p)
  })
  handle('shell:revealInFolder', (p) => {
    if (!isWithinBaseDir(p)) return
    shell.showItemInFolder(p)
  })
}
