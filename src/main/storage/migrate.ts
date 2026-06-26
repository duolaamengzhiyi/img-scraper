import { copyFileSync, existsSync, renameSync, rmSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { MigrationResult } from '@shared/types'
import { getSettings, updateSettings } from '../config/store'
import { libraryDb } from '../storage/db'
import { createLink, ensureDir, isLinkHealthy, libraryDir, sameVolume, tagsDir } from './files'

/**
 * 移动 Library 到新基础目录。
 *  - 同卷：整体 rename（硬链接保持有效），仅改写 DB 路径前缀；随后 repair 一次以重建
 *    可能失效的 symlink/shortcut（其目标是绝对路径，rename 后会断；硬链接健康则跳过）。
 *  - 跨卷：复制原图到新卷，按 tag_links 重建链接，更新 DB；仅在「全部成功」时才删除旧目录，
 *    任一失败则保留旧数据，避免备份丢失。
 */
export function moveLibrary(newBaseDir: string): MigrationResult {
  const settings = getSettings()
  const oldBase = settings.baseDir

  if (!oldBase) {
    updateSettings({ baseDir: newBaseDir })
    ensureDir(libraryDir(newBaseDir))
    ensureDir(tagsDir(newBaseDir))
    return { moved: 0, relinked: 0, failed: 0, sameVolume: true, message: '已设置基础目录' }
  }
  if (oldBase === newBaseDir) {
    return { moved: 0, relinked: 0, failed: 0, sameVolume: true, message: '目录未变化' }
  }

  ensureDir(newBaseDir)
  const db = libraryDb()
  const same = sameVolume(oldBase, newBaseDir)

  if (same) {
    let moved = 0
    try {
      if (existsSync(libraryDir(oldBase))) renameSync(libraryDir(oldBase), libraryDir(newBaseDir))
      if (existsSync(tagsDir(oldBase))) renameSync(tagsDir(oldBase), tagsDir(newBaseDir))
      db.rebasePaths(oldBase, newBaseDir)
      moved = db.allDownloadedPages().length
      updateSettings({ baseDir: newBaseDir })
    } catch (e) {
      return {
        moved,
        relinked: 0,
        failed: 1,
        sameVolume: true,
        message: `同卷移动失败：${(e as Error).message}`
      }
    }
    // 硬链接随 inode 自动有效；symlink/shortcut 的绝对目标已断，统一修复一次
    const repair = repairLinks()
    return {
      moved,
      relinked: repair.relinked,
      failed: repair.failed,
      sameVolume: true,
      message:
        repair.relinked > 0
          ? `同卷移动完成，重建 ${repair.relinked} 个软链接/快捷方式`
          : '同卷移动完成，硬链接关联完好，无需重建'
    }
  }

  // 跨卷：复制原图 + 重建链接
  const oldLib = libraryDir(oldBase)
  const oldTags = tagsDir(oldBase)
  const newLib = libraryDir(newBaseDir)
  const newTags = tagsDir(newBaseDir)
  ensureDir(newLib)
  ensureDir(newTags)

  let moved = 0
  let relinked = 0
  let failed = 0

  for (const p of db.allDownloadedPages()) {
    try {
      const rel = relative(oldLib, p.libraryPath)
      const dest = join(newLib, rel)
      ensureDir(join(dest, '..'))
      copyFileSync(p.libraryPath, dest)
      // 校验复制完整（字节数一致）后才改写 DB 路径；不一致则视为失败、保留旧路径，
      // 避免「磁盘满/截断」时把 DB 指向残缺新文件，进而误删旧目录丢图。
      if (statSync(dest).size !== statSync(p.libraryPath).size) {
        throw new Error('复制后大小不一致')
      }
      db.updatePageLibraryPath(p.illustId, p.pageIndex, dest)
      moved++
    } catch {
      failed++
    }
  }

  for (const link of db.listAllTagLinks()) {
    try {
      const page = db.getPage(link.illustId, link.pageIndex)
      if (!page?.libraryPath) {
        failed++
        continue
      }
      const rel = relative(oldTags, link.linkPath)
      const newLinkPath = join(newTags, rel)
      const { path } = createLink(page.libraryPath, newLinkPath, settings.linkStrategy)
      db.updateTagLinkPath(link.illustId, link.pageIndex, link.tagName, path)
      db.setTagLinkStatus(link.illustId, link.pageIndex, link.tagName, 'ok')
      relinked++
    } catch {
      failed++
    }
  }

  updateSettings({ baseDir: newBaseDir })

  // 仅在全部成功时删除旧目录；否则保留旧数据以免不可恢复地丢失原图
  if (failed === 0) {
    try {
      if (existsSync(oldLib)) rmSync(oldLib, { recursive: true, force: true })
      if (existsSync(oldTags)) rmSync(oldTags, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    return {
      moved,
      relinked,
      failed,
      sameVolume: false,
      message: `跨卷迁移完成：复制 ${moved} 张原图，重建 ${relinked} 个链接`
    }
  }

  return {
    moved,
    relinked,
    failed,
    sameVolume: false,
    message: `跨卷迁移部分失败：成功复制 ${moved} 张、重建 ${relinked} 个链接，${failed} 项失败。已保留原目录 ${oldBase}，请核对后手动清理。`
  }
}

/** 修复失效的 tag 链接（按 DB 中 library_path 重建） */
export function repairLinks(): MigrationResult {
  const settings = getSettings()
  const db = libraryDb()
  let relinked = 0
  let failed = 0

  for (const link of db.listAllTagLinks()) {
    if (isLinkHealthy(link.linkPath)) continue
    const page = db.getPage(link.illustId, link.pageIndex)
    if (page?.libraryPath && existsSync(page.libraryPath)) {
      try {
        const { path } = createLink(page.libraryPath, link.linkPath, settings.linkStrategy)
        if (path !== link.linkPath) {
          db.updateTagLinkPath(link.illustId, link.pageIndex, link.tagName, path)
        }
        db.setTagLinkStatus(link.illustId, link.pageIndex, link.tagName, 'ok')
        relinked++
      } catch {
        db.setTagLinkStatus(link.illustId, link.pageIndex, link.tagName, 'broken')
        failed++
      }
    } else {
      db.setTagLinkStatus(link.illustId, link.pageIndex, link.tagName, 'broken')
      failed++
    }
  }

  return {
    moved: 0,
    relinked,
    failed,
    sameVolume: true,
    message: `修复完成：重建 ${relinked} 个链接${failed ? `，${failed} 个无法修复` : ''}`
  }
}
