/**
 * 跨进程共享的领域类型。主进程与渲染进程都从这里导入，作为统一契约。
 */

/** 用户书签可见性（公开 / 私密非公開） */
export type BookmarkVisibility = 'public' | 'private'

/** 作品类型（Pixiv illustType: 0=illust, 1=manga, 2=ugoira） */
export type WorkType = 'illust' | 'manga' | 'ugoira'

/** 未分類书签的占位 tag 名 */
export const UNCATEGORIZED = '未分類'

/** 登录用户资料 */
export interface PixivAccount {
  userId: string
  name: string
  account: string
  avatarUrl: string | null
  isPremium: boolean
}

/** 账号登录态 + 收藏计数 */
export interface AccountStatus {
  loggedIn: boolean
  account: PixivAccount | null
  publicBookmarkCount: number | null
  privateBookmarkCount: number | null
}

/** 用户自定义书签 tag（含未分類） */
export interface BookmarkTag {
  name: string
  visibility: BookmarkVisibility
  count: number
}

/** 作品摘要（来自收藏列表分页） */
export interface WorkSummary {
  illustId: string
  title: string
  authorId: string
  authorName: string
  type: WorkType
  pageCount: number
  thumbUrl: string | null
  isR18: boolean
  /** 受限/已删除/不可见 */
  isMasked: boolean
  createDate: string | null
  visibility: BookmarkVisibility
}

/** 单页原图信息（来自 /ajax/illust/{id}/pages） */
export interface PageInfo {
  illustId: string
  pageIndex: number
  originalUrl: string
  ext: string
}

/** Ugoira 元信息（来自 /ajax/illust/{id}/ugoira_meta） */
export interface UgoiraMeta {
  illustId: string
  zipUrl: string
  mimeType: string
  frames: { file: string; delayMs: number }[]
}

// ---------------------------------------------------------------------------
// DB 行类型（与 schema.ts 对应）
// ---------------------------------------------------------------------------

/** ignored = 用户手动删除且选择不再下载（同步会跳过） */
export type PageStatus = 'pending' | 'downloaded' | 'failed' | 'skipped' | 'ignored'

export interface WorkRecord {
  illustId: string
  title: string
  authorId: string
  authorName: string
  type: WorkType
  pageCount: number
  isR18: boolean
  createDate: string | null
  thumbUrl: string | null
  firstSeen: number
  lastSynced: number
}

export interface PageRecord {
  illustId: string
  pageIndex: number
  pixivFilename: string
  originalUrl: string | null
  ext: string
  fileName: string | null
  libraryPath: string | null
  bytes: number | null
  status: PageStatus
  downloadedAt: number | null
}

export type LinkType = 'hardlink' | 'symlink' | 'shortcut'
export type TagLinkStatus = 'ok' | 'broken' | 'pending'

export interface TagLinkRecord {
  illustId: string
  pageIndex: number
  tagName: string
  linkPath: string
  linkType: LinkType
  status: TagLinkStatus
}

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

/** ugoira 处理：转 mp4 / gif / 两者 / 仅存 zip / 跳过 */
export type UgoiraMode = 'mp4' | 'gif' | 'mp4+gif' | 'zip' | 'skip'
/** 关联策略；auto = 同卷硬链接，跨卷自动降级 symlink/shortcut */
export type LinkStrategy = 'auto' | 'hardlink' | 'symlink' | 'shortcut'
export type ThemePref = 'system' | 'dark' | 'light'
export type R18Mode = 'include' | 'exclude'

export interface Settings {
  /** 本地保存根目录；为空表示尚未选择 */
  baseDir: string | null
  linkStrategy: LinkStrategy
  includePrivate: boolean
  ugoira: UgoiraMode
  r18: R18Mode
  /** 图片下载并发数 */
  concurrency: number
  /** 请求间隔随机区间（毫秒），用于反限流抖动 */
  minDelayMs: number
  maxDelayMs: number
  /** 多页作品是否归入独立子文件夹 */
  multiPageSubfolder: boolean
  theme: ThemePref
  /** 文件名模板，占位符：{title} {author} {id} {page} {ext} */
  filenameTemplate: string
  /** 图库打开作品所用的应用（macOS 为 .app 路径 / Windows 为 .exe 路径）；null = 系统默认 */
  openWithApp: string | null
}

export const DEFAULT_SETTINGS: Settings = {
  baseDir: null,
  linkStrategy: 'auto',
  includePrivate: true,
  ugoira: 'mp4',
  r18: 'include',
  concurrency: 4,
  minDelayMs: 1000,
  maxDelayMs: 3000,
  multiPageSubfolder: false,
  theme: 'system',
  filenameTemplate: '{title}-{author}-p{page}',
  openWithApp: null
}

// ---------------------------------------------------------------------------
// 下载队列（网盘式 UI）
// ---------------------------------------------------------------------------

export type DownloadStatus =
  | 'queued'
  | 'downloading'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'skipped'

export interface DownloadItem {
  /** `${illustId}_p${pageIndex}` */
  id: string
  illustId: string
  pageIndex: number
  title: string
  authorName: string
  tagNames: string[]
  fileName: string
  status: DownloadStatus
  /** 0..1 */
  progress: number
  receivedBytes: number
  totalBytes: number
  speedBps: number
  etaSec: number | null
  error: string | null
  isUgoira: boolean
  /** 完成后填充：本地文件绝对路径（用于打开/定位） */
  filePath: string | null
}

// ---------------------------------------------------------------------------
// 同步
// ---------------------------------------------------------------------------

/** quick = 遇连续已知作品即停；full = 完整重扫 */
export type SyncMode = 'quick' | 'full'

export interface SyncScope {
  target: 'all' | 'tag'
  tag?: string
  visibility: 'public' | 'private' | 'both'
  mode: SyncMode
}

export type SyncPhase = 'idle' | 'enumerating' | 'downloading' | 'done' | 'error' | 'paused'

export interface SyncProgress {
  phase: SyncPhase
  scope: SyncScope | null
  tagsTotal: number
  tagsDone: number
  worksDiscovered: number
  pagesTotal: number
  pagesDone: number
  pagesSkipped: number
  pagesFailed: number
  currentLabel: string | null
  startedAt: number | null
  message: string | null
}

// ---------------------------------------------------------------------------
// 图库统计 & 迁移
// ---------------------------------------------------------------------------

export interface LibraryStats {
  totalWorks: number
  totalPages: number
  downloadedPages: number
  pendingPages: number
  failedPages: number
  totalBytes: number
  tagCount: number
  lastSyncedAt: number | null
}

export interface MigrationResult {
  moved: number
  relinked: number
  failed: number
  sameVolume: boolean
  message: string
}

/** 校验本地库结果：检查了多少已下载页、其中多少文件已缺失 */
export interface LibraryVerifyResult {
  checked: number
  missing: number
  message: string
}

/** 被忽略（已删除且不再下载）的作品，附带其书签 tag 以便分类 */
export interface IgnoredWork extends WorkRecord {
  tags: string[]
}
