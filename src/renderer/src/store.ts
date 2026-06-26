import { create } from 'zustand'
import {
  DEFAULT_SETTINGS,
  type AccountStatus,
  type BookmarkTag,
  type DownloadItem,
  type LibraryStats,
  type Settings,
  type SyncProgress
} from '@shared/types'
import { invoke } from './lib/ipc'

interface AppState {
  account: AccountStatus | null
  settings: Settings | null
  tags: BookmarkTag[]
  stats: LibraryStats | null
  downloads: DownloadItem[]
  sync: SyncProgress | null
  ready: boolean
  busy: boolean

  init(): Promise<void>
  login(): Promise<void>
  logout(): Promise<void>
  saveSettings(patch: Partial<Settings>): Promise<void>
  refreshTags(): Promise<void>
  refreshStats(): Promise<void>
  refreshDownloads(): Promise<void>

  // 事件应用
  _setAccount(a: AccountStatus): void
  _setSync(s: SyncProgress): void
  /** 批量应用下载事件（合并后的 upsert + remove），一次 set 降低重渲染频率 */
  _applyDownloadBatch(upserts: DownloadItem[], removeIds: string[]): void
  _setTags(t: BookmarkTag[]): void
  _setStats(s: LibraryStats): void
}

export const useStore = create<AppState>()((set, get) => ({
  account: null,
  settings: null,
  tags: [],
  stats: null,
  downloads: [],
  sync: null,
  ready: false,
  busy: false,

  async init() {
    // 单个 handler 失败不应拖垮整个初始化：各自降级到安全默认值，并始终置 ready
    const safe = async <T>(p: Promise<T>, fallback: T): Promise<T> => {
      try {
        return await p
      } catch {
        return fallback
      }
    }
    const [account, settings, tags, stats, downloads, sync] = await Promise.all([
      safe(invoke('auth:status'), {
        loggedIn: false,
        account: null,
        publicBookmarkCount: null,
        privateBookmarkCount: null
      }),
      safe(invoke('settings:get'), { ...DEFAULT_SETTINGS }),
      safe(invoke('tags:list'), []),
      safe(invoke('library:stats'), null),
      safe(invoke('download:list'), []),
      safe(invoke('sync:status'), null)
    ])
    set({ account, settings, tags, stats, downloads, sync, ready: true })
  },

  async login() {
    set({ busy: true })
    try {
      const a = await invoke('auth:login')
      set({ account: a })
    } finally {
      set({ busy: false })
    }
  },

  async logout() {
    await invoke('auth:logout')
    set({
      account: {
        loggedIn: false,
        account: null,
        publicBookmarkCount: null,
        privateBookmarkCount: null
      }
    })
  },

  async saveSettings(patch) {
    const s = await invoke('settings:update', patch)
    set({ settings: s })
  },

  async refreshTags() {
    const t = await invoke('tags:refresh')
    set({ tags: t })
  },

  async refreshStats() {
    set({ stats: await invoke('library:stats') })
  },

  async refreshDownloads() {
    set({ downloads: await invoke('download:list') })
  },

  _setAccount: (a) => set({ account: a }),
  _setSync: (s) => set({ sync: s }),
  _applyDownloadBatch: (upserts, removeIds) =>
    set((st) => {
      if (upserts.length === 0 && removeIds.length === 0) return st
      // Map 保序：set 已存在 id 时保持原插入位置，新 id 追加到末尾
      const map = new Map(st.downloads.map((d) => [d.id, d]))
      for (const id of removeIds) map.delete(id)
      for (const d of upserts) map.set(d.id, d)
      return { downloads: [...map.values()] }
    }),
  _setTags: (t) => set({ tags: t }),
  _setStats: (s) => set({ stats: s })
}))
