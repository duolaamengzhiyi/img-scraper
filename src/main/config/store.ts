import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  DEFAULT_SETTINGS,
  type LinkStrategy,
  type R18Mode,
  type Settings,
  type ThemePref,
  type UgoiraMode
} from '@shared/types'
import { settingsPath } from './paths'

let cache: Settings | null = null

/** 读取设置（缺省合并 DEFAULT_SETTINGS） */
export function getSettings(): Settings {
  if (cache) return cache
  try {
    const raw = readFileSync(settingsPath(), 'utf-8')
    cache = { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) }
  } catch {
    cache = { ...DEFAULT_SETTINGS }
  }
  return cache
}

const LINK_STRATEGIES: LinkStrategy[] = ['auto', 'hardlink', 'symlink', 'shortcut']
const UGOIRA_MODES: UgoiraMode[] = ['mp4', 'gif', 'mp4+gif', 'zip', 'skip']
const R18_MODES: R18Mode[] = ['include', 'exclude']
const THEMES: ThemePref[] = ['system', 'dark', 'light']

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/**
 * 仅接受已知字段并做枚举 / 范围 / 类型校验，丢弃非法输入。
 * 渲染端传入的 patch 不可信：baseDir/openWithApp 是「用设定应用打开」与协议边界的信任根，
 * concurrency/delay 直接驱动下载器，必须在落盘前收口。
 */
function sanitizePatch(patch: Partial<Settings>, current: Settings): Partial<Settings> {
  const out: Partial<Settings> = {}
  if ('baseDir' in patch) out.baseDir = patch.baseDir == null ? null : String(patch.baseDir)
  if ('openWithApp' in patch)
    out.openWithApp = patch.openWithApp == null ? null : String(patch.openWithApp)
  if ('linkStrategy' in patch && LINK_STRATEGIES.includes(patch.linkStrategy as LinkStrategy))
    out.linkStrategy = patch.linkStrategy
  if ('ugoira' in patch && UGOIRA_MODES.includes(patch.ugoira as UgoiraMode))
    out.ugoira = patch.ugoira
  if ('r18' in patch && R18_MODES.includes(patch.r18 as R18Mode)) out.r18 = patch.r18
  if ('theme' in patch && THEMES.includes(patch.theme as ThemePref)) out.theme = patch.theme
  if ('includePrivate' in patch) out.includePrivate = !!patch.includePrivate
  if ('multiPageSubfolder' in patch) out.multiPageSubfolder = !!patch.multiPageSubfolder
  if (
    'filenameTemplate' in patch &&
    typeof patch.filenameTemplate === 'string' &&
    patch.filenameTemplate.trim()
  )
    out.filenameTemplate = patch.filenameTemplate
  if ('concurrency' in patch)
    out.concurrency = clampInt(patch.concurrency, 1, 16, current.concurrency)
  if ('minDelayMs' in patch)
    out.minDelayMs = clampInt(patch.minDelayMs, 0, 600_000, current.minDelayMs)
  if ('maxDelayMs' in patch)
    out.maxDelayMs = clampInt(patch.maxDelayMs, 0, 600_000, current.maxDelayMs)
  return out
}

/** 合并更新并持久化（校验后写入；非法字段被忽略） */
export function updateSettings(patch: Partial<Settings>): Settings {
  const current = getSettings()
  const next: Settings = { ...current, ...sanitizePatch(patch, current) }
  // 保证下载间隔区间自洽
  if (next.maxDelayMs < next.minDelayMs) next.maxDelayMs = next.minDelayMs
  cache = next
  const p = settingsPath()
  if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(next, null, 2), 'utf-8')
  return next
}
