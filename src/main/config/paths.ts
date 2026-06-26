import { app } from 'electron'
import { join } from 'node:path'

/** 应用数据目录（跨 baseDir 变更保持稳定，故 DB/设置/会话都放这里） */
export function userDataDir(): string {
  return app.getPath('userData')
}

export function dbPath(): string {
  return join(userDataDir(), 'library.db')
}

export function settingsPath(): string {
  return join(userDataDir(), 'settings.json')
}

/** 缩略图缓存目录：删除作品时保留一张小图，供「已忽略作品」离线预览 */
export function thumbCacheDir(): string {
  return join(userDataDir(), 'thumb-cache')
}

export function thumbCachePath(illustId: string): string {
  return join(thumbCacheDir(), `${illustId}.jpg`)
}

/** 登录会话使用的持久化分区名（cookie 由 Electron 持久化并经 OS keychain 加密） */
export const SESSION_PARTITION = 'persist:pixiv'
