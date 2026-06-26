import {
  UNCATEGORIZED,
  type BookmarkVisibility,
  type SyncPhase,
  type SyncProgress,
  type SyncScope
} from '@shared/types'
import type { IpcEventChannel, IpcEventMap } from '@shared/ipc'
import { getSettings } from '../config/store'
import { libraryDb } from '../storage/db'
import { downloader, type EnqueueInput, type SettleStatus } from '../download/downloader'
import { fetchBookmarkTags, iterateBookmarks } from '../pixiv/bookmarks'
import { fetchIllustPages } from '../pixiv/illust'
import { getUserId } from '../pixiv/session'

type EmitFn = <K extends IpcEventChannel>(channel: K, payload: IpcEventMap[K]) => void

const QUICK_STOP_STREAK = 48 // quick 模式下连续已下载作品达到一页量即停止该 tag

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function idleProgress(): SyncProgress {
  return {
    phase: 'idle',
    scope: null,
    tagsTotal: 0,
    tagsDone: 0,
    worksDiscovered: 0,
    pagesTotal: 0,
    pagesDone: 0,
    pagesSkipped: 0,
    pagesFailed: 0,
    currentLabel: null,
    startedAt: null,
    message: null
  }
}

class SyncEngine {
  private progress: SyncProgress = idleProgress()
  private ac: AbortController | null = null
  private paused = false
  private prevPhase: SyncPhase = 'idle'
  private emitFn: EmitFn | null = null
  private lastEmit = 0

  // ---- 本次同步追踪的下载任务（用于精确进度：等待真实下载完成）----
  private trackedIds = new Set<string>()
  // id -> 最近一次计入的「终结状态」（completed/skipped/failed/removed），用于计数升级修正
  private settledStatus = new Map<string, SettleStatus>()
  private unsubSettle: (() => void) | null = null
  private unsubPause: (() => void) | null = null
  private resolveWait: (() => void) | null = null
  private clearWaitAbort: (() => void) | null = null

  setEmitter(fn: EmitFn): void {
    this.emitFn = fn
  }

  status(): SyncProgress {
    return this.progress
  }

  private emitProgress(force = true): void {
    const now = Date.now()
    if (!force && now - this.lastEmit < 200) return
    this.lastEmit = now
    this.emitFn?.('sync:progress', this.progress)
  }

  private async checkPause(signal: AbortSignal): Promise<void> {
    while (this.paused && !signal.aborted) await delay(300)
    if (signal.aborted) throw new Error('aborted')
  }

  isRunning(): boolean {
    return this.progress.phase === 'enumerating' || this.progress.phase === 'downloading'
  }

  /** 终结状态归入的计数桶（仅 completed/skipped/failed/removed；'paused' 不在此处理） */
  private bucketOf(status: SettleStatus): 'done' | 'skipped' | 'failed' {
    if (status === 'completed') return 'done'
    if (status === 'skipped') return 'skipped'
    return 'failed' // failed | removed
  }

  private applyDelta(bucket: 'done' | 'skipped' | 'failed', delta: number): void {
    if (bucket === 'done') this.progress.pagesDone += delta
    else if (bucket === 'skipped') this.progress.pagesSkipped += delta
    else this.progress.pagesFailed += delta
  }

  /**
   * 下载器回报某任务终结/离队：更新本次同步的真实计数，并重新判断是否已全部结束。
   * - 终结(completed/skipped/failed/removed)：计入对应桶，支持「升级」（失败后重试成功 → 从 failed 改记 done）；
   *   一旦计为成功(done)不再被回退。
   * - 'paused'（单项暂停）：仅触发一次完成判定（暂停项不计入任何数字，也不阻塞完成——见 maybeResolveWait）。
   */
  private handleSettle(id: string, status: SettleStatus): void {
    if (!this.trackedIds.has(id)) return
    if (status !== 'paused') {
      const prev = this.settledStatus.get(id)
      if (prev !== status) {
        const prevBucket = prev ? this.bucketOf(prev) : null
        const bucket = this.bucketOf(status)
        if (prevBucket === 'done' && bucket !== 'done') return // 已成功不回退
        if (prevBucket) this.applyDelta(prevBucket, -1)
        this.applyDelta(bucket, +1)
        this.settledStatus.set(id, status)
        this.emitProgress(false)
      }
    }
    this.maybeResolveWait()
  }

  /** 下载器全局暂停状态变化：同步镜像之，使横幅与等待行为与下载实际状态一致 */
  private handleGlobalPause(paused: boolean): void {
    if (this.ac?.signal.aborted) return // 停止流程中，忽略
    if (paused) {
      if (!this.paused && this.isRunning()) {
        this.paused = true
        this.prevPhase = this.progress.phase
        this.progress.phase = 'paused'
        this.emitProgress()
      }
    } else if (this.paused) {
      this.paused = false
      this.progress.phase = this.prevPhase === 'paused' ? 'enumerating' : this.prevPhase
      this.emitProgress()
      this.maybeResolveWait()
    }
  }

  /**
   * 结束下载等待的条件：未处于暂停态，且本次同步追踪的任务中已没有「在跑（排队/下载中）」的项。
   * 用「无在跑任务」而非「精确 settle 计数」判断，可在任意暂停组合下避免无限挂起。
   */
  private maybeResolveWait(): void {
    if (this.resolveWait && !this.paused && downloader.activeTrackedCount(this.trackedIds) === 0) {
      const r = this.resolveWait
      this.resolveWait = null
      this.clearWaitAbort?.()
      this.clearWaitAbort = null
      r()
    }
  }

  /** 等待本次同步入队的全部下载终结（被 stop 中止时拒绝） */
  private waitForDownloads(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.paused && downloader.activeTrackedCount(this.trackedIds) === 0) {
        resolve()
        return
      }
      if (signal.aborted) {
        reject(new Error('aborted'))
        return
      }
      this.resolveWait = resolve
      const onAbort = (): void => {
        this.resolveWait = null
        this.clearWaitAbort = null
        reject(new Error('aborted'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.clearWaitAbort = (): void => signal.removeEventListener('abort', onAbort)
    })
  }

  async start(scope: SyncScope): Promise<void> {
    // 拒绝在「未结束」（含暂停）期间再次启动，确保任一时刻只有一个 run 循环
    if (
      this.progress.phase !== 'idle' &&
      this.progress.phase !== 'done' &&
      this.progress.phase !== 'error'
    ) {
      return
    }
    const userId = await getUserId()
    if (!userId) {
      this.progress = { ...idleProgress(), phase: 'error', message: '未登录' }
      this.emitProgress()
      return
    }
    const settings = getSettings()
    if (!settings.baseDir) {
      this.progress = { ...idleProgress(), phase: 'error', message: '未设置保存目录' }
      this.emitProgress()
      return
    }

    this.ac = new AbortController()
    this.paused = false
    this.trackedIds.clear()
    this.settledStatus.clear()
    // 解除可能残留的全局暂停（如用户曾在「下载」页点过全部暂停），否则本次同步入队的任务
    // 会因 pump 早退而永不启动，导致等待无限挂起。
    downloader.clearGlobalPause()
    this.progress = {
      ...idleProgress(),
      phase: 'enumerating',
      scope,
      startedAt: Date.now()
    }
    this.emitProgress()

    // 订阅下载终结事件（必须在任何入队之前注册，以免漏计早早完成的任务）
    this.unsubSettle = downloader.onSettle((id, s) => this.handleSettle(id, s))
    // 订阅全局暂停变化：无论暂停来自同步横幅还是「下载」页的全部暂停，都镜像到同步状态，
    // 使同步在下载被全局暂停时保持等待（不挂死）、恢复后继续推进。
    this.unsubPause = downloader.onGlobalPauseChange((p) => this.handleGlobalPause(p))

    const runId = libraryDb().startSyncRun(JSON.stringify(scope), Date.now())
    try {
      await this.run(userId, scope, this.ac.signal)
      this.progress.phase = 'done'
      this.progress.currentLabel = null
      const { pagesDone, pagesSkipped, pagesFailed, pagesTotal } = this.progress
      // 完成判据是「无在跑任务」，未终结的差额即用户中途暂停未恢复的项
      const paused = Math.max(0, pagesTotal - pagesDone - pagesSkipped - pagesFailed)
      this.progress.message =
        `同步完成：下载 ${pagesDone} 张` +
        (pagesSkipped ? `，跳过 ${pagesSkipped}` : '') +
        (pagesFailed ? `，失败 ${pagesFailed}` : '') +
        (paused ? `，${paused} 项已暂停` : '')
    } catch (e) {
      if (this.ac.signal.aborted) {
        this.progress.phase = 'idle'
        this.progress.message = '已停止'
      } else {
        this.progress.phase = 'error'
        this.progress.message = e instanceof Error ? e.message : String(e)
      }
    } finally {
      this.unsubSettle?.()
      this.unsubSettle = null
      this.unsubPause?.()
      this.unsubPause = null
      this.resolveWait = null
      this.clearWaitAbort?.()
      this.clearWaitAbort = null
      libraryDb().finishSyncRun(runId, Date.now(), JSON.stringify(this.progress))
      this.emitFn?.('tags:updated', libraryDb().listBookmarkTags())
      this.emitFn?.('library:statsUpdated', libraryDb().getLibraryStats())
      this.emitProgress()
    }
  }

  private async run(userId: string, scope: SyncScope, signal: AbortSignal): Promise<void> {
    const settings = getSettings()
    const db = libraryDb()
    const now = Date.now()

    const visibilities: BookmarkVisibility[] =
      scope.visibility === 'both'
        ? settings.includePrivate
          ? ['public', 'private']
          : ['public']
        : [scope.visibility]

    // ---- 阶段一：枚举所有 tag，构建完整「作品↔tag」映射 ----
    const candidates = new Set<string>()

    // 一次请求即返回 public+private 两个完整列表，循环外取一次（避免重复请求与私密 tag 静默丢失）
    let tagResp: Awaited<ReturnType<typeof fetchBookmarkTags>> | null = null
    try {
      tagResp = await fetchBookmarkTags(userId, signal)
    } catch {
      tagResp = null // 获取失败：各可见性退化为只抓「全部」
    }

    for (const vis of visibilities) {
      let tagList: { name: string }[] = []
      if (tagResp) {
        const list = vis === 'public' ? tagResp.public : tagResp.private
        db.replaceBookmarkTags(vis, list, now)
        tagList = list
      }

      const tagsToIterate =
        scope.target === 'tag' && scope.tag
          ? [scope.tag]
          : [...tagList.map((t) => t.name), UNCATEGORIZED]

      this.progress.tagsTotal += tagsToIterate.length
      this.emitProgress()

      for (const tag of tagsToIterate) {
        await this.checkPause(signal)
        this.progress.currentLabel = `${vis === 'public' ? '公开' : '私密'} · ${tag || '全部'}`
        this.emitProgress()

        let knownStreak = 0
        for await (const w of iterateBookmarks(userId, { tag, visibility: vis, signal })) {
          await this.checkPause(signal)

          if (scope.mode === 'quick') {
            const pages = db.getPagesForWork(w.illustId)
            const fully =
              pages.length >= w.pageCount &&
              pages.length > 0 &&
              pages.every((p) => p.status === 'downloaded' || p.status === 'ignored')
            knownStreak = fully ? knownStreak + 1 : 0
          }

          db.upsertWorkFromSummary(w, now)
          db.addWorkTag(w.illustId, tag, vis)
          candidates.add(w.illustId)
          this.progress.worksDiscovered = candidates.size
          this.emitProgress(false)

          if (scope.mode === 'quick' && knownStreak >= QUICK_STOP_STREAK) break
        }
        this.progress.tagsDone += 1
        this.emitProgress()
      }
    }

    // ---- 阶段二：取每个候选作品的原图 URL 并入队（仍属「整理」阶段，phase 保持 enumerating）----
    for (const illustId of candidates) {
      await this.checkPause(signal)
      const work = db.getWork(illustId)
      if (!work) continue
      if (work.isR18 && settings.r18 === 'exclude') continue

      this.progress.currentLabel = work.title
      const tagNames = db.getWorkTags(illustId)

      if (work.type === 'ugoira') {
        if (settings.ugoira === 'skip') continue
        if (db.isPageSettled(illustId, 0)) continue
        db.upsertPagePlaceholder(illustId, 0, `${illustId}_ugoira`)
        const ids = downloader.enqueueBatch([
          {
            illustId,
            pageIndex: 0,
            originalUrl: null,
            ext: settings.ugoira === 'gif' ? 'gif' : 'mp4',
            title: work.title,
            authorName: work.authorName,
            tagNames,
            isUgoira: true,
            pageCount: 1
          }
        ])
        for (const id of ids) this.trackedIds.add(id)
        this.emitProgress(false)
        continue
      }

      // 全部页已下载 → 跳过取 pages
      const existing = db.getPagesForWork(illustId)
      const fully =
        existing.length >= work.pageCount &&
        existing.length > 0 &&
        existing.every((p) => p.status === 'downloaded' || p.status === 'ignored')
      if (fully) continue

      let pages
      try {
        pages = await fetchIllustPages(illustId, signal)
      } catch {
        continue
      }

      const toEnqueue: EnqueueInput[] = []
      for (const p of pages) {
        db.setPageOriginal(illustId, p.pageIndex, {
          originalUrl: p.originalUrl,
          ext: p.ext,
          pixivFilename: `${illustId}_p${p.pageIndex}.${p.ext}`
        })
        if (db.isPageSettled(illustId, p.pageIndex)) continue
        toEnqueue.push({
          illustId,
          pageIndex: p.pageIndex,
          originalUrl: p.originalUrl,
          ext: p.ext,
          title: work.title,
          authorName: work.authorName,
          tagNames,
          isUgoira: false,
          pageCount: work.pageCount
        })
      }
      // 整个作品的页一次性入队，仅触发一次 download:added；记录实际入队 id 供精确追踪
      if (toEnqueue.length) {
        const ids = downloader.enqueueBatch(toEnqueue)
        for (const id of ids) this.trackedIds.add(id)
      }
      this.emitProgress(false)
    }

    // ---- 入队完毕：计划总数 = 实际入队数（固定，不再增长）；进入下载阶段并等待真实下载完成 ----
    this.progress.currentLabel = null
    this.progress.pagesTotal = this.trackedIds.size
    if (this.trackedIds.size === 0) {
      this.emitProgress()
      return
    }
    this.progress.phase = 'downloading'
    this.emitProgress()
    await this.waitForDownloads(signal)
  }

  pause(): void {
    if (!this.isRunning()) return
    // 暂停 = 全局暂停下载（与「下载」页的全部暂停统一）；同步状态由 onGlobalPauseChange 回调镜像
    downloader.pauseAll()
  }

  resume(): void {
    if (!this.paused) return
    // 恢复 = 全局恢复下载；同步状态由 onGlobalPauseChange 回调镜像并重判完成
    downloader.resumeAll()
  }

  stop(): void {
    // 中止同步编排；已入队的下载保留在队列中（用户可在「下载」页自行管理）。
    // 先 abort 让 run 结束；再清全局暂停标志避免残留卡住后续下载（abort 后 handleGlobalPause 自会忽略）。
    this.ac?.abort()
    this.paused = false
    downloader.clearGlobalPause()
  }
}

export const syncEngine = new SyncEngine()
