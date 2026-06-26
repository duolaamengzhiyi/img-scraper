import { existsSync, renameSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { DownloadItem } from '@shared/types'
import type { IpcEventChannel, IpcEventMap } from '@shared/ipc'
import { getSettings } from '../config/store'
import { libraryDb } from '../storage/db'
import {
  buildBaseName,
  createLink,
  disambiguate,
  ensureDir,
  libraryDir,
  sanitize,
  tagsDir
} from '../storage/files'
import { pixivClient } from '../pixiv/client'
import { processUgoira } from './ugoira'

export interface EnqueueInput {
  illustId: string
  pageIndex: number
  originalUrl: string | null
  ext: string
  title: string
  authorName: string
  tagNames: string[]
  isUgoira: boolean
  pageCount: number
}

interface Job extends DownloadItem {
  originalUrl: string | null
  ext: string
  pageCount: number
}

type EmitFn = <K extends IpcEventChannel>(channel: K, payload: IpcEventMap[K]) => void

/**
 * 任务终结/离队状态（供同步引擎统计本次同步的真实进度）。
 * 'paused' 表示用户对单项暂停（任务离开活动队列、但可恢复）——同步引擎据此推进完成判定，避免无限等待。
 */
export type SettleStatus = 'completed' | 'skipped' | 'failed' | 'removed' | 'paused'
type SettleListener = (id: string, status: SettleStatus) => void

function toItem(j: Job): DownloadItem {
  return {
    id: j.id,
    illustId: j.illustId,
    pageIndex: j.pageIndex,
    title: j.title,
    authorName: j.authorName,
    tagNames: j.tagNames,
    fileName: j.fileName,
    status: j.status,
    progress: j.progress,
    receivedBytes: j.receivedBytes,
    totalBytes: j.totalBytes,
    speedBps: j.speedBps,
    etaSec: j.etaSec,
    error: j.error,
    isUgoira: j.isUgoira,
    filePath: j.filePath
  }
}

class Downloader {
  private items = new Map<string, Job>()
  private pending: string[] = []
  private active = new Map<string, AbortController>()
  private globallyPaused = false
  private emitFn: EmitFn | null = null
  private progressMeta = new Map<string, { lastTime: number; lastBytes: number }>()
  private lastEmit = new Map<string, number>()
  private lastStatsEmit = 0
  private settleListeners = new Set<SettleListener>()
  private globalPauseListeners = new Set<(paused: boolean) => void>()

  setEmitter(fn: EmitFn): void {
    this.emitFn = fn
  }

  /** 订阅任务终结/离队事件（completed/skipped/failed/removed/paused），返回取消订阅函数。 */
  onSettle(fn: SettleListener): () => void {
    this.settleListeners.add(fn)
    return () => this.settleListeners.delete(fn)
  }

  private notifySettle(id: string, status: SettleStatus): void {
    for (const fn of this.settleListeners) fn(id, status)
  }

  /** 订阅「全局暂停」状态变化（供同步引擎据此保持等待/恢复推进），返回取消订阅函数。 */
  onGlobalPauseChange(fn: (paused: boolean) => void): () => void {
    this.globalPauseListeners.add(fn)
    return () => this.globalPauseListeners.delete(fn)
  }

  /** 唯一改写 globallyPaused 的入口：仅在真正变化时通知订阅者 */
  private setGlobalPaused(v: boolean): void {
    if (this.globallyPaused === v) return
    this.globallyPaused = v
    for (const fn of this.globalPauseListeners) fn(v)
  }

  /** 这些 id 中仍处于「排队/下载中」（即会自行 settle）的数量；用于同步判断是否还有在跑的任务。 */
  activeTrackedCount(ids: Set<string>): number {
    let n = 0
    for (const id of ids) {
      const job = this.items.get(id)
      if (job && (job.status === 'queued' || job.status === 'downloading')) n += 1
    }
    return n
  }

  private emit<K extends IpcEventChannel>(channel: K, payload: IpcEventMap[K]): void {
    this.emitFn?.(channel, payload)
  }

  private emitUpdate(job: Job): void {
    this.emit('download:update', toItem(job))
  }

  private emitStats(force = false): void {
    const now = Date.now()
    if (!force && now - this.lastStatsEmit < 1000) return
    this.lastStatsEmit = now
    try {
      this.emit('library:statsUpdated', libraryDb().getLibraryStats())
    } catch {
      /* ignore */
    }
  }

  list(): DownloadItem[] {
    return [...this.items.values()].map(toItem)
  }

  enqueue(input: EnqueueInput): void {
    this.enqueueBatch([input])
  }

  /**
   * 批量入队：仅发一个 download:added 事件、只 pump 一次，避免大量入队时的事件风暴。
   * 返回「实际新入队」的 id 列表（已存在且非失败的会被跳过，不在返回里），供同步引擎精确追踪。
   */
  enqueueBatch(inputs: EnqueueInput[]): string[] {
    const added: DownloadItem[] = []
    const addedIds: string[] = []
    const at = Date.now()
    for (const input of inputs) {
      const id = `${input.illustId}_p${input.pageIndex}`
      const existing = this.items.get(id)
      if (existing && existing.status !== 'failed') continue
      const job: Job = {
        id,
        illustId: input.illustId,
        pageIndex: input.pageIndex,
        title: input.title,
        authorName: input.authorName,
        tagNames: input.tagNames,
        fileName: '',
        status: 'queued',
        progress: 0,
        receivedBytes: 0,
        totalBytes: 0,
        speedBps: 0,
        etaSec: null,
        error: null,
        isUgoira: input.isUgoira,
        filePath: null,
        originalUrl: input.originalUrl,
        ext: input.ext,
        pageCount: input.pageCount
      }
      this.items.set(id, job)
      if (!this.pending.includes(id)) this.pending.push(id)
      libraryDb().enqueueDownload(id, input.illustId, input.pageIndex, at)
      added.push(toItem(job))
      addedIds.push(id)
    }
    if (added.length) this.emit('download:added', added)
    this.pump()
    return addedIds
  }

  /** 清除全局暂停标志并尝试调度（仅启动 queued 项，不动用户单独暂停的历史任务）。 */
  clearGlobalPause(): void {
    if (!this.globallyPaused) return
    this.setGlobalPaused(false)
    this.pump()
  }

  private pump(): void {
    if (this.globallyPaused) return
    const concurrency = Math.max(1, getSettings().concurrency)
    while (this.active.size < concurrency && this.pending.length) {
      const id = this.pending.shift()
      if (!id) break
      const job = this.items.get(id)
      if (!job || job.status !== 'queued') continue
      void this.run(id)
    }
  }

  /**
   * 立即启动单个已 queued 的任务（用户显式恢复/重试），绕过全局暂停门控、不改全局暂停标志。
   * 这样「全部暂停」后单独恢复一项只会启动该项，其余仍暂停，且不会误把整体（含同步）解除暂停。
   * 满载时留在 pending，待有空位由 pump 调度。
   */
  private maybeStart(id: string): void {
    const job = this.items.get(id)
    if (!job || job.status !== 'queued') return
    const concurrency = Math.max(1, getSettings().concurrency)
    if (this.active.size >= concurrency) return
    this.pending = this.pending.filter((x) => x !== id)
    void this.run(id)
  }

  private async run(id: string): Promise<void> {
    const job = this.items.get(id)
    if (!job) return
    const ac = new AbortController()
    this.active.set(id, ac)
    job.status = 'downloading'
    job.error = null
    libraryDb().setDownloadStatus(id, 'downloading')
    this.emitUpdate(job)
    try {
      const outcome = await this.process(job, ac.signal)
      // 与 catch 分支对称：若本次下载在完成的同一时刻被 pause/remove 中止或被新 run 取代，
      // 丢弃这次成功结果，状态完全交由 pause/remove 接管，避免「已删除项被完成结果复活」成僵尸行。
      if (ac.signal.aborted || this.active.get(id) !== ac) return
      job.status = outcome
      job.progress = 1
      job.speedBps = 0
      job.etaSec = null
      libraryDb().setDownloadStatus(id, job.status)
      libraryDb().removeDownload(id)
      this.emitUpdate(job)
      this.emitStats()
      this.notifySettle(id, outcome)
    } catch (e) {
      if (ac.signal.aborted) {
        // 暂停/删除导致的中止：状态已在 pause/remove 中设置；
        // 不发 settle（暂停将恢复后重跑；删除已在 remove 中发过 removed）
      } else {
        job.status = 'failed'
        job.error = e instanceof Error ? e.message : String(e)
        job.speedBps = 0
        job.etaSec = null
        libraryDb().setDownloadStatus(id, 'failed', job.error)
        this.emitUpdate(job)
        this.notifySettle(id, 'failed')
      }
    } finally {
      // 仅当 active[id] 仍是本次 run 的控制器时才删除，避免误删 pause→resume 后新 run 的控制器
      if (this.active.get(id) === ac) this.active.delete(id)
      this.progressMeta.delete(id)
      this.pump()
    }
  }

  private onProgress(job: Job, received: number, total: number): void {
    job.receivedBytes = received
    if (total) job.totalBytes = total
    job.progress = total ? Math.min(1, received / total) : 0
    const now = Date.now()
    const meta = this.progressMeta.get(job.id) ?? { lastTime: now, lastBytes: 0 }
    const dt = (now - meta.lastTime) / 1000
    if (dt >= 0.5) {
      const speed = (received - meta.lastBytes) / dt
      job.speedBps = Math.max(0, speed)
      job.etaSec = speed > 0 && total ? Math.max(0, (total - received) / speed) : null
      this.progressMeta.set(job.id, { lastTime: now, lastBytes: received })
    }
    const last = this.lastEmit.get(job.id) ?? 0
    if (now - last >= 200) {
      this.lastEmit.set(job.id, now)
      this.emitUpdate(job)
    }
  }

  private async process(job: Job, signal: AbortSignal): Promise<'skipped' | 'completed'> {
    const settings = getSettings()
    const base = settings.baseDir
    if (!base) throw new Error('未设置保存目录')
    const db = libraryDb()

    if (job.isUgoira && settings.ugoira === 'skip') {
      db.setPageStatus(job.illustId, job.pageIndex, 'skipped')
      return 'skipped'
    }

    // 已下载且文件仍在 → 跳过
    if (db.isPageDownloaded(job.illustId, job.pageIndex)) {
      const page = db.getPage(job.illustId, job.pageIndex)
      if (page?.libraryPath && existsSync(page.libraryPath)) {
        return 'skipped'
      }
    }

    const work = db.getWork(job.illustId)
    const title = work?.title ?? job.title
    const authorName = work?.authorName ?? job.authorName
    const authorId = work?.authorId ?? ''

    let dir = libraryDir(base)
    if (settings.multiPageSubfolder && job.pageCount > 1) {
      dir = join(dir, sanitize(`${title}-${authorName}-${job.illustId}`))
    }
    ensureDir(dir)

    const baseName = buildBaseName(
      settings.filenameTemplate,
      { title, authorName, authorId, illustId: job.illustId },
      job.pageIndex,
      job.ext
    )
    const fileName = disambiguate(baseName, job.illustId, (n) =>
      db.isFileNameTaken(n, job.illustId)
    )
    job.fileName = fileName
    // 写盘前同步占位文件名，关闭并发下载产生同名互相覆盖的竞态窗口
    db.reserveFileName(job.illustId, job.pageIndex, fileName)
    let libraryPath = join(dir, fileName)
    let bytes = 0

    if (job.isUgoira) {
      const noExt = join(dir, fileName.replace(/\.[^.]+$/, ''))
      const outs = await processUgoira(job.illustId, noExt, settings.ugoira, {
        signal,
        onProgress: (r, t) => this.onProgress(job, r, t)
      })
      if (!outs.length) throw new Error('ugoira 转码无输出')
      libraryPath = outs[0].filePath
      job.fileName = basename(libraryPath)
      bytes = outs[0].bytes
    } else {
      if (!job.originalUrl) throw new Error('缺少原图 URL')
      const tmpPath = `${libraryPath}.part`
      bytes = await pixivClient.downloadToFile(job.originalUrl, tmpPath, {
        signal,
        onProgress: (r, t) => this.onProgress(job, r, t)
      })
      if (existsSync(libraryPath)) rmSync(libraryPath)
      renameSync(tmpPath, libraryPath)
    }

    job.filePath = libraryPath
    db.setPageDownloaded(job.illustId, job.pageIndex, {
      fileName: job.fileName,
      libraryPath,
      bytes,
      at: Date.now()
    })

    // 为每个 tag 建立硬链接（失败标记 broken，不阻断）
    for (const tag of job.tagNames) {
      const linkPath = join(tagsDir(base), sanitize(tag), job.fileName)
      try {
        const { type, path } = createLink(libraryPath, linkPath, settings.linkStrategy)
        db.upsertTagLink({
          illustId: job.illustId,
          pageIndex: job.pageIndex,
          tagName: tag,
          linkPath: path,
          linkType: type,
          status: 'ok'
        })
      } catch {
        db.upsertTagLink({
          illustId: job.illustId,
          pageIndex: job.pageIndex,
          tagName: tag,
          linkPath,
          linkType: 'hardlink',
          status: 'broken'
        })
      }
    }

    job.receivedBytes = bytes
    if (bytes) job.totalBytes = bytes
    return 'completed'
  }

  // ---- 控制 ----
  pause(id: string): void {
    const job = this.items.get(id)
    if (!job) return
    if (job.status === 'completed' || job.status === 'skipped') return // 已终结不可暂停
    const ac = this.active.get(id)
    if (ac) {
      ac.abort()
      this.active.delete(id)
    }
    this.pending = this.pending.filter((x) => x !== id)
    job.status = 'paused'
    job.speedBps = 0
    job.etaSec = null
    libraryDb().setDownloadStatus(id, 'paused')
    this.emitUpdate(job)
    // 通知同步引擎：该任务已离开活动队列（可恢复），使其完成判定能推进、不致无限等待。
    // 注意：整组暂停 pauseAll 不发此事件，从而保留「同步暂停=继续等待」语义。
    this.notifySettle(id, 'paused')
    this.pump()
  }

  resume(id: string): void {
    const job = this.items.get(id)
    if (!job || job.status === 'downloading' || job.status === 'completed') return
    job.status = 'queued'
    job.error = null
    if (!this.pending.includes(id)) this.pending.push(id)
    libraryDb().setDownloadStatus(id, 'queued')
    this.emitUpdate(job)
    // 仅启动这一项（绕过全局暂停门控），不清全局暂停标志：避免「全部暂停」期间单独恢复一项
    // 误把整体/同步解除暂停，从而造成同步提前误判完成。
    this.maybeStart(id)
  }

  remove(id: string): void {
    const ac = this.active.get(id)
    if (ac) {
      ac.abort()
      this.active.delete(id)
    }
    this.pending = this.pending.filter((x) => x !== id)
    this.items.delete(id)
    libraryDb().removeDownload(id)
    this.emit('download:removed', { id })
    // 通知同步引擎：被移除的任务视为已终结，避免同步永远等待它
    this.notifySettle(id, 'removed')
  }

  retry(id: string): void {
    const job = this.items.get(id)
    if (!job || job.status !== 'failed') return
    job.status = 'queued'
    job.error = null
    job.progress = 0
    job.receivedBytes = 0
    if (!this.pending.includes(id)) this.pending.push(id)
    libraryDb().setDownloadStatus(id, 'queued')
    this.emitUpdate(job)
    // 同 resume：仅启动这一项，不清全局暂停标志
    this.maybeStart(id)
  }

  pauseAll(): void {
    this.setGlobalPaused(true)
    for (const [id, ac] of this.active) {
      ac.abort()
      const job = this.items.get(id)
      if (job) {
        job.status = 'paused'
        job.speedBps = 0
        job.etaSec = null
        if (!this.pending.includes(id)) this.pending.unshift(id)
        libraryDb().setDownloadStatus(id, 'paused')
        this.emitUpdate(job)
      }
    }
    this.active.clear()
    for (const job of this.items.values()) {
      if (job.status === 'queued') {
        job.status = 'paused'
        libraryDb().setDownloadStatus(job.id, 'paused')
        this.emitUpdate(job)
      }
    }
  }

  resumeAll(): void {
    // 必须「先把全部 paused 改回 queued、再解除全局暂停」：setGlobalPaused 会同步回调同步引擎，
    // 若此时任务尚未恢复为 queued，正在等待的同步会误判「已全部完成」并提前结束、丢失后续计数。
    for (const job of this.items.values()) {
      if (job.status === 'paused') {
        job.status = 'queued'
        libraryDb().setDownloadStatus(job.id, 'queued')
        if (!this.pending.includes(job.id)) this.pending.push(job.id)
        this.emitUpdate(job)
      }
    }
    this.setGlobalPaused(false)
    this.pump()
  }

  clearCompleted(): void {
    for (const [id, job] of [...this.items]) {
      if (job.status === 'completed' || job.status === 'skipped') {
        this.items.delete(id)
        this.emit('download:removed', { id })
      }
    }
    libraryDb().clearCompletedDownloads()
  }

  /** 启动时从持久化队列恢复未完成任务并续传 */
  restore(): void {
    const db = libraryDb()
    for (const row of db.listActiveDownloads()) {
      const page = db.getPage(row.illustId, row.pageIndex)
      const work = db.getWork(row.illustId)
      if (!page || !work) {
        db.removeDownload(row.id)
        continue
      }
      const job: Job = {
        id: row.id,
        illustId: row.illustId,
        pageIndex: row.pageIndex,
        title: work.title,
        authorName: work.authorName,
        tagNames: db.getWorkTags(row.illustId),
        fileName: page.fileName ?? '',
        status: 'queued',
        progress: 0,
        receivedBytes: 0,
        totalBytes: 0,
        speedBps: 0,
        etaSec: null,
        error: null,
        isUgoira: work.type === 'ugoira',
        filePath: page.libraryPath ?? null,
        originalUrl: page.originalUrl,
        ext: page.ext,
        pageCount: work.pageCount
      }
      this.items.set(job.id, job)
      this.pending.push(job.id)
    }
    this.pump()
  }
}

export const downloader = new Downloader()
