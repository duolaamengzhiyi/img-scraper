import { existsSync, rmSync, rmdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { LibraryVerifyResult } from '@shared/types'
import { getSettings } from '../config/store'
import { thumbCacheDir, thumbCachePath } from '../config/paths'
import { downloader } from '../download/downloader'
import { generateThumbnail } from '../download/ugoira'
import { libraryDb } from './db'
import { ensureDir, libraryDir, tagsDir } from './files'

/**
 * 校验本地库：扫描所有「已下载」页，若磁盘上文件已不在，
 * 则回退为 pending（修正统计），并把其 tag 链接标记为 broken。
 */
export function verifyLibrary(): LibraryVerifyResult {
  const db = libraryDb()
  let checked = 0
  let missing = 0
  const pages = db.allDownloadedPages()
  // 存在性检查（只读）在事务外完成，仅把写操作合并进单个事务提交
  const toMark: { illustId: string; pageIndex: number }[] = []
  for (const p of pages) {
    checked++
    if (!p.libraryPath || !existsSync(p.libraryPath)) {
      toMark.push({ illustId: p.illustId, pageIndex: p.pageIndex })
      missing++
    }
  }
  if (toMark.length > 0) {
    db.transaction(() => {
      for (const m of toMark) {
        db.markPageMissing(m.illustId, m.pageIndex)
        for (const link of db.listTagLinksForPage(m.illustId, m.pageIndex)) {
          db.setTagLinkStatus(m.illustId, m.pageIndex, link.tagName, 'broken')
        }
      }
    })
  }
  const message =
    missing > 0
      ? `已检查 ${checked} 张，发现 ${missing} 个文件缺失（已标为待补）`
      : `已检查 ${checked} 张，未发现缺失`
  return { checked, missing, message }
}

/** 把所有 pending 页重新加入下载队列（补下缺失）。返回入队数量。 */
export function restoreMissing(): number {
  const db = libraryDb()
  let count = 0
  // 同一作品多页会重复查 work/tags：按 illustId 缓存，消除 N+1
  const workCache = new Map<string, ReturnType<typeof db.getWork>>()
  const tagsCache = new Map<string, string[]>()
  for (const p of db.listPagesByStatus('pending')) {
    let work = workCache.get(p.illustId)
    if (work === undefined) {
      work = db.getWork(p.illustId)
      workCache.set(p.illustId, work)
    }
    if (!work) continue
    const isUgoira = work.type === 'ugoira'
    if (!p.originalUrl && !isUgoira) continue // 无原图地址且非动图，无法直接补下
    let tagNames = tagsCache.get(p.illustId)
    if (!tagNames) {
      tagNames = db.getWorkTags(p.illustId)
      tagsCache.set(p.illustId, tagNames)
    }
    downloader.enqueue({
      illustId: p.illustId,
      pageIndex: p.pageIndex,
      originalUrl: p.originalUrl,
      ext: p.ext,
      title: work.title,
      authorName: work.authorName,
      tagNames,
      isUgoira,
      pageCount: work.pageCount
    })
    count++
  }
  return count
}

/**
 * 删除某作品的本地文件：移除各标签里的引用 + 中央 Library 原图，
 * 清空其页状态（ignore=true → 标 ignored，同步不再下载；false → pending，下次同步可重下）。
 * 不影响 Pixiv 上的收藏。
 */
export async function deleteWork(illustId: string, ignore: boolean): Promise<void> {
  const db = libraryDb()
  const pages = db.getPagesForWork(illustId)

  // 先取消该作品在下载器中的所有任务：中止进行中/排队、清理内存态、并从下载列表移除。
  // 否则正在进行的下载完成后会把刚删的文件与状态写回（复活），且残留 completed 项会挡住重下。
  for (const page of pages) {
    downloader.remove(`${illustId}_p${page.pageIndex}`)
  }

  // 选「不再下载」时，删除前用首页缓存一张缩略图，便于之后在「已忽略作品」里离线识别
  if (ignore) {
    const page0 = pages.find((p) => p.pageIndex === 0) ?? pages[0]
    if (page0?.libraryPath && existsSync(page0.libraryPath)) {
      try {
        ensureDir(thumbCacheDir())
        await generateThumbnail(page0.libraryPath, thumbCachePath(illustId))
      } catch {
        /* 缩略图缓存失败不阻断删除 */
      }
    }
  }

  // 受保护的根目录：绝不对它们 rmdir（防止删空后误删 Library/Tags/base 根）
  const base = getSettings().baseDir
  const protectedRoots = new Set<string>()
  if (base) {
    protectedRoots.add(base)
    protectedRoots.add(libraryDir(base))
    protectedRoots.add(tagsDir(base))
  }

  const dirs = new Set<string>()
  for (const page of pages) {
    // 先删各标签文件夹里的引用（硬链接/快捷方式）
    for (const link of db.listTagLinksForPage(illustId, page.pageIndex)) {
      try {
        if (existsSync(link.linkPath)) rmSync(link.linkPath, { force: true })
      } catch {
        /* ignore */
      }
    }
    // 再删中央 Library 原图
    if (page.libraryPath) {
      try {
        if (existsSync(page.libraryPath)) rmSync(page.libraryPath, { force: true })
      } catch {
        /* ignore */
      }
      const parent = dirname(page.libraryPath)
      if (!protectedRoots.has(parent)) dirs.add(parent)
    }
    db.clearPageFile(illustId, page.pageIndex, ignore ? 'ignored' : 'pending')
  }
  db.deleteTagLinksForWork(illustId)

  // 仅清理可能变空的「多页作品子目录」（非空会抛错被忽略）；受保护根已被排除
  for (const d of dirs) {
    try {
      rmdirSync(d)
    } catch {
      /* 非空或不可删 → 保留 */
    }
  }
}

/** 取消忽略某作品：ignored 页改回 pending 并立即重新入队下载 */
export function unignoreWork(illustId: string): void {
  const db = libraryDb()
  db.unignoreWorkPages(illustId)
  // 恢复后会重新下载真图，缓存缩略图不再需要
  try {
    rmSync(thumbCachePath(illustId), { force: true })
  } catch {
    /* ignore */
  }
  const work = db.getWork(illustId)
  if (!work) return
  const tagNames = db.getWorkTags(illustId)
  const isUgoira = work.type === 'ugoira'
  for (const p of db.getPagesForWork(illustId)) {
    if (p.status !== 'pending') continue
    if (!p.originalUrl && !isUgoira) continue
    downloader.enqueue({
      illustId,
      pageIndex: p.pageIndex,
      originalUrl: p.originalUrl,
      ext: p.ext,
      title: work.title,
      authorName: work.authorName,
      tagNames,
      isUgoira,
      pageCount: work.pageCount
    })
  }
}

/** 把所有 pending 页标记为 ignored（同步不再下载）。返回数量。 */
export function ignoreMissing(): number {
  const db = libraryDb()
  const pending = db.listPagesByStatus('pending')
  db.transaction(() => {
    for (const p of pending) {
      db.setPageStatus(p.illustId, p.pageIndex, 'ignored')
    }
  })
  return pending.length
}
