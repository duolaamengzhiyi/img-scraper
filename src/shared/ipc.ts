/**
 * 类型化 IPC 契约。preload 桥与渲染层客户端都基于此。
 *  - IpcInvokeMap：渲染进程 → 主进程（请求/响应，ipcRenderer.invoke）
 *  - IpcEventMap： 主进程 → 渲染进程（推送事件，webContents.send）
 */
import type {
  AccountStatus,
  BookmarkTag,
  DownloadItem,
  IgnoredWork,
  LibraryStats,
  LibraryVerifyResult,
  MigrationResult,
  Settings,
  SyncProgress,
  SyncScope,
  WorkRecord
} from './types'

export interface IpcInvokeMap {
  'auth:status': { args: []; result: AccountStatus }
  'auth:login': { args: []; result: AccountStatus }
  'auth:logout': { args: []; result: void }

  'settings:get': { args: []; result: Settings }
  'settings:update': { args: [patch: Partial<Settings>]; result: Settings }
  'settings:pickBaseDir': { args: []; result: string | null }
  'settings:pickOpenApp': { args: []; result: string | null }

  'tags:list': { args: []; result: BookmarkTag[] }
  'tags:refresh': { args: []; result: BookmarkTag[] }

  'library:stats': { args: []; result: LibraryStats }
  'library:listWorks': {
    args: [query: { tags?: string[]; author?: string; offset?: number; limit?: number }]
    result: { works: WorkRecord[]; total: number }
  }
  'library:workFiles': { args: [illustId: string]; result: string[] }
  'library:downloadedTags': { args: []; result: { name: string; count: number }[] }
  'library:openWork': { args: [illustId: string]; result: void }
  'library:showWorkMenu': { args: [illustId: string]; result: void }
  'library:verify': { args: []; result: LibraryVerifyResult }
  'library:restoreMissing': { args: []; result: number }
  'library:ignoreMissing': { args: []; result: number }
  'library:deleteWork': { args: [illustId: string, ignore: boolean]; result: void }
  'library:listIgnored': { args: []; result: IgnoredWork[] }
  'library:unignore': { args: [illustId: string]; result: void }

  'sync:start': { args: [scope: SyncScope]; result: void }
  'sync:pause': { args: []; result: void }
  'sync:resume': { args: []; result: void }
  'sync:stop': { args: []; result: void }
  'sync:status': { args: []; result: SyncProgress }

  'download:list': { args: []; result: DownloadItem[] }
  'download:pause': { args: [id: string]; result: void }
  'download:resume': { args: [id: string]; result: void }
  'download:remove': { args: [id: string]; result: void }
  'download:retry': { args: [id: string]; result: void }
  'download:pauseAll': { args: []; result: void }
  'download:resumeAll': { args: []; result: void }
  'download:clearCompleted': { args: []; result: void }

  'migrate:moveLibrary': { args: [newDir: string]; result: MigrationResult }
  'migrate:repairLinks': { args: []; result: MigrationResult }

  'shell:openPath': { args: [path: string]; result: void }
  'shell:revealInFolder': { args: [path: string]; result: void }
}

export type IpcInvokeChannel = keyof IpcInvokeMap

export interface IpcEventMap {
  'auth:changed': AccountStatus
  'sync:progress': SyncProgress
  'download:added': DownloadItem[]
  'download:update': DownloadItem
  'download:removed': { id: string }
  'tags:updated': BookmarkTag[]
  'library:statsUpdated': LibraryStats
  log: { level: 'info' | 'warn' | 'error'; message: string; at: number }
}

export type IpcEventChannel = keyof IpcEventMap

/** 推送事件白名单（preload 订阅时校验） */
export const EVENT_CHANNELS: IpcEventChannel[] = [
  'auth:changed',
  'sync:progress',
  'download:added',
  'download:update',
  'download:removed',
  'tags:updated',
  'library:statsUpdated',
  'log'
]

/** 自定义协议名：渲染层用 `pixiv-img://thumb/{illustId}/{page}` 加载需 Referer 的图片 */
export const PIXIV_IMG_PROTOCOL = 'pixiv-img'
