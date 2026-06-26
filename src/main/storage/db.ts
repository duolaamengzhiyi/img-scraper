import Database from 'better-sqlite3'
import { sep } from 'node:path'
import {
  type BookmarkTag,
  type BookmarkVisibility,
  type IgnoredWork,
  type LibraryStats,
  type LinkType,
  type PageRecord,
  type PageStatus,
  type TagLinkRecord,
  type TagLinkStatus,
  type WorkRecord,
  type WorkSummary,
  type WorkType
} from '@shared/types'
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema'

type DB = Database.Database

// ---- 行类型（snake_case，与 schema 对应） ----
interface WorkRow {
  illust_id: string
  title: string
  author_id: string
  author_name: string
  type: string
  page_count: number
  is_r18: number
  create_date: string | null
  thumb_url: string | null
  first_seen: number
  last_synced: number
}

interface PageRow {
  illust_id: string
  page_index: number
  pixiv_filename: string
  original_url: string | null
  ext: string
  file_name: string | null
  library_path: string | null
  bytes: number | null
  sha256: string | null
  status: string
  downloaded_at: number | null
}

interface TagLinkRow {
  illust_id: string
  page_index: number
  tag_name: string
  link_path: string
  link_type: string
  status: string
}

function toWork(r: WorkRow): WorkRecord {
  return {
    illustId: r.illust_id,
    title: r.title,
    authorId: r.author_id,
    authorName: r.author_name,
    type: r.type as WorkType,
    pageCount: r.page_count,
    isR18: r.is_r18 === 1,
    createDate: r.create_date,
    thumbUrl: r.thumb_url,
    firstSeen: r.first_seen,
    lastSynced: r.last_synced
  }
}

function toPage(r: PageRow): PageRecord {
  return {
    illustId: r.illust_id,
    pageIndex: r.page_index,
    pixivFilename: r.pixiv_filename,
    originalUrl: r.original_url,
    ext: r.ext,
    fileName: r.file_name,
    libraryPath: r.library_path,
    bytes: r.bytes,
    status: r.status as PageStatus,
    downloadedAt: r.downloaded_at
  }
}

function toTagLink(r: TagLinkRow): TagLinkRecord {
  return {
    illustId: r.illust_id,
    pageIndex: r.page_index,
    tagName: r.tag_name,
    linkPath: r.link_path,
    linkType: r.link_type as LinkType,
    status: r.status as TagLinkStatus
  }
}

/** 本地「记忆库」仓库。单例，经 initLibraryDb 初始化。 */
export class LibraryDb {
  private db: DB

  constructor(path: string) {
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL') // WAL 下足够安全且更快
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('busy_timeout = 5000') // 并发写入遇锁时等待而非直接抛 SQLITE_BUSY
    this.db.exec(SCHEMA_SQL)
    this.setMeta('schema_version', String(SCHEMA_VERSION))
  }

  // ---- meta ----
  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row ? row.value : null
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = ?')
      .run(key, value, value)
  }

  // ---- works ----
  upsertWorkFromSummary(s: WorkSummary, now: number): void {
    this.db
      .prepare(
        `INSERT INTO works(illust_id, title, author_id, author_name, type, page_count, is_r18, create_date, thumb_url, first_seen, last_synced)
         VALUES(@illust_id, @title, @author_id, @author_name, @type, @page_count, @is_r18, @create_date, @thumb_url, @now, @now)
         ON CONFLICT(illust_id) DO UPDATE SET
           title = excluded.title,
           author_id = excluded.author_id,
           author_name = excluded.author_name,
           type = excluded.type,
           page_count = excluded.page_count,
           is_r18 = excluded.is_r18,
           create_date = excluded.create_date,
           thumb_url = excluded.thumb_url,
           last_synced = excluded.last_synced`
      )
      .run({
        illust_id: s.illustId,
        title: s.title,
        author_id: s.authorId,
        author_name: s.authorName,
        type: s.type,
        page_count: s.pageCount,
        is_r18: s.isR18 ? 1 : 0,
        create_date: s.createDate,
        thumb_url: s.thumbUrl,
        now
      })
  }

  getWork(illustId: string): WorkRecord | undefined {
    const r = this.db.prepare('SELECT * FROM works WHERE illust_id = ?').get(illustId) as
      | WorkRow
      | undefined
    return r ? toWork(r) : undefined
  }

  hasWork(illustId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM works WHERE illust_id = ?').get(illustId)
  }

  listWorks(query: { tags?: string[]; author?: string; offset?: number; limit?: number }): {
    works: WorkRecord[]
    total: number
  } {
    const where: string[] = [
      // 图库只展示「至少有一页已下载」的作品（删除/未下载的不显示）
      "EXISTS (SELECT 1 FROM pages WHERE pages.illust_id = works.illust_id AND pages.status = 'downloaded')"
    ]
    const params: Record<string, unknown> = {}
    if (query.tags && query.tags.length > 0) {
      // 多标签交集：必须同时具备所有选中标签
      const placeholders = query.tags.map((_, i) => `@tag${i}`).join(', ')
      where.push(
        `illust_id IN (SELECT illust_id FROM work_tags WHERE tag_name IN (${placeholders}) GROUP BY illust_id HAVING COUNT(DISTINCT tag_name) = @tagCount)`
      )
      query.tags.forEach((t, i) => {
        params[`tag${i}`] = t
      })
      params.tagCount = query.tags.length
    }
    if (query.author) {
      where.push('author_id = @author')
      params.author = query.author
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS c FROM works ${whereSql}`).get(params) as { c: number }
    ).c
    const limit = query.limit ?? 100
    const offset = query.offset ?? 0
    const rows = this.db
      .prepare(
        `SELECT * FROM works ${whereSql} ORDER BY last_synced DESC, illust_id DESC LIMIT @limit OFFSET @offset`
      )
      .all({ ...params, limit, offset }) as WorkRow[]
    return { works: rows.map(toWork), total }
  }

  /** 已下载作品涉及的标签 + 各标签的已下载作品数，按数量降序（用于图库筛选 chips） */
  listDownloadedTags(): { name: string; count: number }[] {
    return this.db
      .prepare(
        `SELECT wt.tag_name AS name, COUNT(DISTINCT wt.illust_id) AS count
         FROM work_tags wt
         WHERE EXISTS (SELECT 1 FROM pages p WHERE p.illust_id = wt.illust_id AND p.status = 'downloaded')
         GROUP BY wt.tag_name
         ORDER BY count DESC, name`
      )
      .all() as { name: string; count: number }[]
  }

  // ---- pages ----
  upsertPagePlaceholder(illustId: string, pageIndex: number, pixivFilename: string): void {
    this.db
      .prepare(
        `INSERT INTO pages(illust_id, page_index, pixiv_filename)
         VALUES(?, ?, ?)
         ON CONFLICT(illust_id, page_index) DO NOTHING`
      )
      .run(illustId, pageIndex, pixivFilename)
  }

  setPageOriginal(
    illustId: string,
    pageIndex: number,
    fields: { originalUrl: string; ext: string; pixivFilename: string }
  ): void {
    this.db
      .prepare(
        `INSERT INTO pages(illust_id, page_index, original_url, ext, pixiv_filename, status)
         VALUES(@illust_id, @page_index, @original_url, @ext, @pixiv_filename, 'pending')
         ON CONFLICT(illust_id, page_index) DO UPDATE SET
           original_url = excluded.original_url,
           ext = excluded.ext,
           pixiv_filename = excluded.pixiv_filename`
      )
      .run({
        illust_id: illustId,
        page_index: pageIndex,
        original_url: fields.originalUrl,
        ext: fields.ext,
        pixiv_filename: fields.pixivFilename
      })
  }

  setPageDownloaded(
    illustId: string,
    pageIndex: number,
    fields: { fileName: string; libraryPath: string; bytes: number; sha256?: string; at: number }
  ): void {
    this.db
      .prepare(
        `UPDATE pages SET file_name = @file_name, library_path = @library_path, bytes = @bytes,
           sha256 = @sha256, status = 'downloaded', downloaded_at = @at
         WHERE illust_id = @illust_id AND page_index = @page_index`
      )
      .run({
        illust_id: illustId,
        page_index: pageIndex,
        file_name: fields.fileName,
        library_path: fields.libraryPath,
        bytes: fields.bytes,
        sha256: fields.sha256 ?? null,
        at: fields.at
      })
  }

  /** 写盘前同步占位文件名，关闭并发下载产生同名互相覆盖的窗口 */
  reserveFileName(illustId: string, pageIndex: number, fileName: string): void {
    this.db
      .prepare('UPDATE pages SET file_name = ? WHERE illust_id = ? AND page_index = ?')
      .run(fileName, illustId, pageIndex)
  }

  setPageStatus(illustId: string, pageIndex: number, status: PageStatus): void {
    this.db
      .prepare('UPDATE pages SET status = ? WHERE illust_id = ? AND page_index = ?')
      .run(status, illustId, pageIndex)
  }

  getPage(illustId: string, pageIndex: number): PageRecord | undefined {
    const r = this.db
      .prepare('SELECT * FROM pages WHERE illust_id = ? AND page_index = ?')
      .get(illustId, pageIndex) as PageRow | undefined
    return r ? toPage(r) : undefined
  }

  getPagesForWork(illustId: string): PageRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM pages WHERE illust_id = ? ORDER BY page_index')
      .all(illustId) as PageRow[]
    return rows.map(toPage)
  }

  isPageDownloaded(illustId: string, pageIndex: number): boolean {
    const r = this.db
      .prepare(
        "SELECT 1 FROM pages WHERE illust_id = ? AND page_index = ? AND status = 'downloaded'"
      )
      .get(illustId, pageIndex)
    return !!r
  }

  /** 已下载或已忽略：同步时都视为「已处理」，不再入队 */
  isPageSettled(illustId: string, pageIndex: number): boolean {
    const r = this.db
      .prepare(
        "SELECT 1 FROM pages WHERE illust_id = ? AND page_index = ? AND status IN ('downloaded','ignored')"
      )
      .get(illustId, pageIndex)
    return !!r
  }

  /** 文件被手动删除：回退为 pending、清空体积与下载时间（保留 url/文件名以便重下） */
  markPageMissing(illustId: string, pageIndex: number): void {
    this.db
      .prepare(
        "UPDATE pages SET status = 'pending', bytes = NULL, downloaded_at = NULL WHERE illust_id = ? AND page_index = ?"
      )
      .run(illustId, pageIndex)
  }

  /** 主动删除该页本地文件后清理状态：设新状态并清空 library_path/体积/下载时间 */
  clearPageFile(illustId: string, pageIndex: number, status: PageStatus): void {
    this.db
      .prepare(
        'UPDATE pages SET status = ?, library_path = NULL, bytes = NULL, downloaded_at = NULL WHERE illust_id = ? AND page_index = ?'
      )
      .run(status, illustId, pageIndex)
  }

  deleteTagLinksForWork(illustId: string): void {
    this.db.prepare('DELETE FROM tag_links WHERE illust_id = ?').run(illustId)
  }

  /** 把某作品所有 ignored 页改回 pending（取消忽略，便于重新下载） */
  unignoreWorkPages(illustId: string): void {
    this.db
      .prepare("UPDATE pages SET status = 'pending' WHERE illust_id = ? AND status = 'ignored'")
      .run(illustId)
  }

  /** 列出「被忽略」的作品：有 ignored 页且没有任何 downloaded 页（即已从图库消失的删除项） */
  listIgnoredWorks(): IgnoredWork[] {
    const rows = this.db
      .prepare(
        `SELECT w.*,
           (SELECT GROUP_CONCAT(tag_name, char(10)) FROM work_tags wt WHERE wt.illust_id = w.illust_id) AS tags_concat
         FROM works w
         WHERE EXISTS (SELECT 1 FROM pages p WHERE p.illust_id = w.illust_id AND p.status = 'ignored')
           AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.illust_id = w.illust_id AND p.status = 'downloaded')
         ORDER BY last_synced DESC`
      )
      .all() as (WorkRow & { tags_concat: string | null })[]
    return rows.map((r) => ({
      ...toWork(r),
      tags: r.tags_concat ? r.tags_concat.split('\n') : []
    }))
  }

  listPagesByStatus(status: PageStatus): PageRecord[] {
    const rows = this.db.prepare('SELECT * FROM pages WHERE status = ?').all(status) as PageRow[]
    return rows.map(toPage)
  }

  /** 文件名是否已被其他作品占用（冲突检测，用于追加 ID 消歧） */
  isFileNameTaken(fileName: string, exceptIllustId: string): boolean {
    const r = this.db
      .prepare('SELECT 1 FROM pages WHERE file_name = ? AND illust_id <> ? LIMIT 1')
      .get(fileName, exceptIllustId)
    return !!r
  }

  // ---- bookmark_tags ----
  replaceBookmarkTags(visibility: BookmarkVisibility, tags: BookmarkTag[], now: number): void {
    const tx = this.db.transaction((list: BookmarkTag[]) => {
      this.db.prepare('DELETE FROM bookmark_tags WHERE visibility = ?').run(visibility)
      const stmt = this.db.prepare(
        'INSERT INTO bookmark_tags(name, visibility, count, last_seen) VALUES(?, ?, ?, ?)'
      )
      for (const t of list) stmt.run(t.name, visibility, t.count, now)
    })
    tx(tags)
  }

  listBookmarkTags(): BookmarkTag[] {
    const rows = this.db
      .prepare('SELECT name, visibility, count FROM bookmark_tags ORDER BY count DESC, name')
      .all() as { name: string; visibility: BookmarkVisibility; count: number }[]
    return rows.map((r) => ({ name: r.name, visibility: r.visibility, count: r.count }))
  }

  // ---- work_tags ----
  /** 为某作品在某可见性下设置书签 tag 集合（替换该作品该可见性下的旧记录） */
  setWorkTags(illustId: string, visibility: BookmarkVisibility, tagNames: string[]): void {
    const tx = this.db.transaction((names: string[]) => {
      this.db
        .prepare('DELETE FROM work_tags WHERE illust_id = ? AND visibility = ?')
        .run(illustId, visibility)
      const stmt = this.db.prepare(
        `INSERT INTO work_tags(illust_id, tag_name, visibility) VALUES(?, ?, ?)
         ON CONFLICT(illust_id, tag_name) DO UPDATE SET visibility = excluded.visibility`
      )
      for (const name of names) stmt.run(illustId, name, visibility)
    })
    tx(tagNames)
  }

  addWorkTag(illustId: string, tagName: string, visibility: BookmarkVisibility): void {
    this.db
      .prepare(
        `INSERT INTO work_tags(illust_id, tag_name, visibility) VALUES(?, ?, ?)
         ON CONFLICT(illust_id, tag_name) DO NOTHING`
      )
      .run(illustId, tagName, visibility)
  }

  getWorkTags(illustId: string): string[] {
    const rows = this.db
      .prepare('SELECT tag_name FROM work_tags WHERE illust_id = ?')
      .all(illustId) as { tag_name: string }[]
    return rows.map((r) => r.tag_name)
  }

  // ---- tag_links ----
  upsertTagLink(rec: TagLinkRecord): void {
    this.db
      .prepare(
        `INSERT INTO tag_links(illust_id, page_index, tag_name, link_path, link_type, status)
         VALUES(@illust_id, @page_index, @tag_name, @link_path, @link_type, @status)
         ON CONFLICT(illust_id, page_index, tag_name) DO UPDATE SET
           link_path = excluded.link_path,
           link_type = excluded.link_type,
           status = excluded.status`
      )
      .run({
        illust_id: rec.illustId,
        page_index: rec.pageIndex,
        tag_name: rec.tagName,
        link_path: rec.linkPath,
        link_type: rec.linkType,
        status: rec.status
      })
  }

  setTagLinkStatus(
    illustId: string,
    pageIndex: number,
    tagName: string,
    status: TagLinkStatus
  ): void {
    this.db
      .prepare(
        'UPDATE tag_links SET status = ? WHERE illust_id = ? AND page_index = ? AND tag_name = ?'
      )
      .run(status, illustId, pageIndex, tagName)
  }

  listAllTagLinks(): TagLinkRecord[] {
    const rows = this.db.prepare('SELECT * FROM tag_links').all() as TagLinkRow[]
    return rows.map(toTagLink)
  }

  listTagLinksForPage(illustId: string, pageIndex: number): TagLinkRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM tag_links WHERE illust_id = ? AND page_index = ?')
      .all(illustId, pageIndex) as TagLinkRow[]
    return rows.map(toTagLink)
  }

  // ---- 统计 ----
  getLibraryStats(): LibraryStats {
    const works = (
      this.db
        .prepare(
          "SELECT COUNT(*) AS c FROM works WHERE EXISTS (SELECT 1 FROM pages WHERE pages.illust_id = works.illust_id AND pages.status = 'downloaded')"
        )
        .get() as { c: number }
    ).c
    // 统计排除 ignored（已删且不再下载）页，保证与「图库只显示已下载作品」口径一致
    const pageAgg = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status='downloaded' THEN 1 ELSE 0 END) AS downloaded,
           SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
           COALESCE(SUM(bytes), 0) AS bytes
         FROM pages
         WHERE status != 'ignored'`
      )
      .get() as {
      total: number
      downloaded: number
      pending: number
      failed: number
      bytes: number
    }
    const tagCount = (
      this.db.prepare('SELECT COUNT(DISTINCT name) AS c FROM bookmark_tags').get() as { c: number }
    ).c
    const lastSynced = this.getMeta('last_synced_at')
    return {
      totalWorks: works,
      totalPages: pageAgg.total ?? 0,
      downloadedPages: pageAgg.downloaded ?? 0,
      pendingPages: pageAgg.pending ?? 0,
      failedPages: pageAgg.failed ?? 0,
      totalBytes: pageAgg.bytes ?? 0,
      tagCount,
      lastSyncedAt: lastSynced ? Number(lastSynced) : null
    }
  }

  // ---- sync_runs ----
  startSyncRun(scope: string, now: number): number {
    const info = this.db
      .prepare('INSERT INTO sync_runs(started_at, scope) VALUES(?, ?)')
      .run(now, scope)
    return Number(info.lastInsertRowid)
  }

  finishSyncRun(id: number, now: number, statsJson: string): void {
    this.db
      .prepare('UPDATE sync_runs SET finished_at = ?, stats_json = ? WHERE id = ?')
      .run(now, statsJson, id)
    this.setMeta('last_synced_at', String(now))
  }

  // ---- 下载队列（持久化 / 重启续传） ----
  enqueueDownload(id: string, illustId: string, pageIndex: number, now: number): void {
    this.db
      .prepare(
        `INSERT INTO download_queue(id, illust_id, page_index, status, enqueued_at)
         VALUES(?, ?, ?, 'queued', ?)
         ON CONFLICT(id) DO UPDATE SET status='queued', error=NULL`
      )
      .run(id, illustId, pageIndex, now)
  }

  setDownloadStatus(id: string, status: string, error?: string | null): void {
    this.db
      .prepare('UPDATE download_queue SET status = ?, error = ? WHERE id = ?')
      .run(status, error ?? null, id)
  }

  removeDownload(id: string): void {
    this.db.prepare('DELETE FROM download_queue WHERE id = ?').run(id)
  }

  clearCompletedDownloads(): void {
    this.db.prepare("DELETE FROM download_queue WHERE status = 'completed'").run()
  }

  listActiveDownloads(): { id: string; illustId: string; pageIndex: number; status: string }[] {
    const rows = this.db
      .prepare(
        "SELECT id, illust_id, page_index, status FROM download_queue WHERE status IN ('queued','paused','downloading')"
      )
      .all() as { id: string; illust_id: string; page_index: number; status: string }[]
    return rows.map((r) => ({
      id: r.id,
      illustId: r.illust_id,
      pageIndex: r.page_index,
      status: r.status
    }))
  }

  // ---- 迁移辅助 ----
  allDownloadedPages(): { illustId: string; pageIndex: number; libraryPath: string }[] {
    const rows = this.db
      .prepare(
        "SELECT illust_id, page_index, library_path FROM pages WHERE status='downloaded' AND library_path IS NOT NULL"
      )
      .all() as { illust_id: string; page_index: number; library_path: string }[]
    return rows.map((r) => ({
      illustId: r.illust_id,
      pageIndex: r.page_index,
      libraryPath: r.library_path
    }))
  }

  updatePageLibraryPath(illustId: string, pageIndex: number, newPath: string): void {
    this.db
      .prepare('UPDATE pages SET library_path = ? WHERE illust_id = ? AND page_index = ?')
      .run(newPath, illustId, pageIndex)
  }

  updateTagLinkPath(illustId: string, pageIndex: number, tagName: string, newPath: string): void {
    this.db
      .prepare(
        'UPDATE tag_links SET link_path = ? WHERE illust_id = ? AND page_index = ? AND tag_name = ?'
      )
      .run(newPath, illustId, pageIndex, tagName)
  }

  /**
   * 同卷整体移动后，批量替换路径前缀（oldPrefix → newPrefix）。
   * 用「带分隔符的精确前缀比较」而非 LIKE，避免 %/_ 通配符与兄弟目录误匹配。
   */
  rebasePaths(oldPrefix: string, newPrefix: string): void {
    // 统一补分隔符后再比较 / 拼接，索引与匹配串严格对齐，
    // 不依赖入参是否带尾分隔符（否则尾斜杠会拼坏路径）。
    const oldWithSep = oldPrefix.endsWith(sep) ? oldPrefix : oldPrefix + sep
    const newWithSep = newPrefix.endsWith(sep) ? newPrefix : newPrefix + sep
    const matchLen = oldWithSep.length
    const fromIdx = matchLen + 1 // substr 1-indexed：跳过整个「带分隔符前缀」
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          'UPDATE pages SET library_path = ? || substr(library_path, ?) WHERE substr(library_path, 1, ?) = ?'
        )
        .run(newWithSep, fromIdx, matchLen, oldWithSep)
      this.db
        .prepare(
          'UPDATE tag_links SET link_path = ? || substr(link_path, ?) WHERE substr(link_path, 1, ?) = ?'
        )
        .run(newWithSep, fromIdx, matchLen, oldWithSep)
    })
    tx()
  }

  /** 在单个事务内执行一批写操作，合并提交（大批量状态更新用） */
  transaction(fn: () => void): void {
    this.db.transaction(fn)()
  }

  close(): void {
    this.db.close()
  }
}

let instance: LibraryDb | null = null

export function initLibraryDb(path: string): LibraryDb {
  instance = new LibraryDb(path)
  return instance
}

export function libraryDb(): LibraryDb {
  if (!instance) throw new Error('LibraryDb 尚未初始化')
  return instance
}
