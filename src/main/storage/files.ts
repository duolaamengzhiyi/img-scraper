import { existsSync, linkSync, mkdirSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { shell } from 'electron'
import type { LinkStrategy, LinkType } from '@shared/types'

const ILLEGAL = /[\\/:*?"<>|\x00-\x1f]/g

/** 清洗为合法文件/文件夹名片段 */
export function sanitize(name: string, maxLen = 80): string {
  let s = name.replace(ILLEGAL, '_').replace(/\s+/g, ' ').trim()
  s = s.replace(/[. ]+$/g, '') // Windows 不允许以点/空格结尾
  if (s.length > maxLen) s = s.slice(0, maxLen).trim()
  return s || '_'
}

export function libraryDir(baseDir: string): string {
  return join(baseDir, 'Library')
}
export function tagsDir(baseDir: string): string {
  return join(baseDir, 'Tags')
}

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

/** 按模板生成文件名（不含冲突消歧）。占位符：{title} {author} {id} {page} */
export function buildBaseName(
  template: string,
  work: { title: string; authorName: string; authorId: string; illustId: string },
  pageIndex: number,
  ext: string
): string {
  const title = sanitize(work.title || '無題')
  const author = sanitize(work.authorName || work.authorId || 'unknown')
  const body = template
    .replace(/\{title\}/g, title)
    .replace(/\{author\}/g, author)
    .replace(/\{id\}/g, work.illustId)
    .replace(/\{page\}/g, String(pageIndex))
  return `${sanitize(body, 120)}.${ext}`
}

/** 冲突消歧：若 baseName 已被其他作品占用，在扩展名前追加 -{illustId}，绝不覆盖 */
export function disambiguate(
  baseName: string,
  illustId: string,
  isTaken: (name: string) => boolean
): string {
  if (!isTaken(baseName)) return baseName
  const dot = baseName.lastIndexOf('.')
  const stem = dot >= 0 ? baseName.slice(0, dot) : baseName
  const ext = dot >= 0 ? baseName.slice(dot) : ''
  return `${stem}-${illustId}${ext}`
}

function nearestExisting(p: string): string {
  let cur = p
  while (cur && cur !== dirname(cur) && !existsSync(cur)) cur = dirname(cur)
  return cur || p
}

/** 两路径是否在同一卷（硬链接可行性） */
export function sameVolume(a: string, b: string): boolean {
  try {
    return statSync(nearestExisting(a)).dev === statSync(nearestExisting(b)).dev
  } catch {
    return false
  }
}

/**
 * 在 tag 文件夹建立指向 library 文件的链接。
 * 返回实际使用的链接类型（auto 会在跨卷时降级）。
 */
export function createLink(
  libraryPath: string,
  linkPath: string,
  strategy: LinkStrategy
): { type: LinkType; path: string } {
  ensureDir(dirname(linkPath))
  const rm = (p: string): void => {
    if (existsSync(p)) {
      try {
        rmSync(p, { force: true })
      } catch {
        /* ignore */
      }
    }
  }

  const preferHard = strategy === 'hardlink' || strategy === 'auto'
  if (preferHard && sameVolume(libraryPath, linkPath)) {
    try {
      rm(linkPath)
      linkSync(libraryPath, linkPath)
      return { type: 'hardlink', path: linkPath }
    } catch (e) {
      if (strategy === 'hardlink') throw e
      // auto：降级到下方
    }
  }

  if (strategy === 'shortcut' && process.platform === 'win32') {
    // 实际落盘路径带 .lnk，返回给调用方登记，保证健康检查/迁移路径一致
    const lnk = linkPath.endsWith('.lnk') ? linkPath : `${linkPath}.lnk`
    rm(lnk)
    shell.writeShortcutLink(lnk, 'create', { target: libraryPath })
    return { type: 'shortcut', path: lnk }
  }

  // 其余情况（显式 symlink / auto 跨卷降级 / 非 Windows 的 shortcut）一律 symlink
  rm(linkPath)
  symlinkSync(libraryPath, linkPath)
  return { type: 'symlink', path: linkPath }
}

/** 链接是否有效（存在且目标可达） */
export function isLinkHealthy(linkPath: string): boolean {
  try {
    return existsSync(linkPath) && statSync(linkPath).size >= 0
  } catch {
    return false
  }
}
