import { pixivClient } from './client'
import type { PageInfo, UgoiraMeta } from '@shared/types'

interface PagesItem {
  urls: { thumb_mini?: string; small?: string; regular?: string; original: string }
  width: number
  height: number
}

function extFromUrl(url: string): string {
  const clean = url.split('?')[0]
  const dot = clean.lastIndexOf('.')
  return dot >= 0 ? clean.slice(dot + 1).toLowerCase() : 'jpg'
}

/** 取作品每页原图 URL（/ajax/illust/{id}/pages，body 为数组） */
export async function fetchIllustPages(
  illustId: string,
  signal?: AbortSignal
): Promise<PageInfo[]> {
  const body = await pixivClient.getJson<PagesItem[]>(`/ajax/illust/${illustId}/pages`, signal)
  return body.map((p, i) => ({
    illustId,
    pageIndex: i,
    originalUrl: p.urls.original,
    ext: extFromUrl(p.urls.original)
  }))
}

interface UgoiraBody {
  src?: string
  originalSrc?: string
  mime_type?: string
  mimeType?: string
  frames: { file: string; delay: number }[]
}

/** 取 ugoira 元信息（帧 zip + 每帧延时，originalSrc 为原始尺寸帧 zip） */
export async function fetchUgoiraMeta(illustId: string, signal?: AbortSignal): Promise<UgoiraMeta> {
  const body = await pixivClient.getJson<UgoiraBody>(`/ajax/illust/${illustId}/ugoira_meta`, signal)
  const zipUrl = body.originalSrc || body.src
  if (!zipUrl) throw new Error('ugoira_meta 缺少 zip URL')
  return {
    illustId,
    zipUrl,
    mimeType: body.mime_type || body.mimeType || 'image/jpeg',
    frames: (body.frames ?? []).map((f) => ({ file: f.file, delayMs: f.delay }))
  }
}
