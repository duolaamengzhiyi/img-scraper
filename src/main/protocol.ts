import { net, protocol } from 'electron'
import { createReadStream, existsSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { PIXIV_IMG_PROTOCOL } from '@shared/ipc'
import { getSettings } from './config/store'
import { thumbCachePath } from './config/paths'
import { libraryDb } from './storage/db'

const APP_REFERER = 'https://www.pixiv.net/'
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

function contentType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'png':
      return 'image/png'
    case 'gif':
      return 'image/gif'
    case 'webp':
      return 'image/webp'
    case 'mp4':
      return 'video/mp4'
    default:
      return 'image/jpeg'
  }
}

function fileResponse(path: string): Response {
  // 流式读盘：避免把整张原图/视频一次性读进内存并阻塞主线程（图库瀑布流会并发请求大量图片）
  const stream = Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>
  return new Response(stream, { headers: { 'Content-Type': contentType(path) } })
}

function remoteThumb(url: string): Promise<Response> {
  return net.fetch(url, { headers: { Referer: APP_REFERER, 'User-Agent': USER_AGENT } })
}

/**
 * 注册 pixiv-img:// 协议（渲染层加载需 Referer 的图片）。
 *  - pixiv-img://work/{illustId}：优先本地已下载首页，否则远程缩略图
 *  - pixiv-img://thumb/{illustId}：远程缩略图
 *  - pixiv-img://file/?p={encodedPath}：本地文件（限 baseDir 内）
 */
export function registerPixivImgProtocol(): void {
  protocol.handle(PIXIV_IMG_PROTOCOL, async (request) => {
    try {
      const url = new URL(request.url)
      const kind = url.hostname

      if (kind === 'work' || kind === 'thumb') {
        const illustId = url.pathname.replace(/^\//, '')
        if (!/^\d+$/.test(illustId)) return new Response('bad id', { status: 400 })
        const work = libraryDb().getWork(illustId)
        if (!work) return new Response('not found', { status: 404 })
        if (kind === 'work') {
          const page = libraryDb().getPage(illustId, 0)
          if (page?.libraryPath && existsSync(page.libraryPath))
            return fileResponse(page.libraryPath)
          // 已删除作品：用删除时缓存的缩略图（离线可用、清晰）
          const cached = thumbCachePath(illustId)
          if (existsSync(cached)) return fileResponse(cached)
        }
        if (work.thumbUrl) return await remoteThumb(work.thumbUrl)
        return new Response('no thumb', { status: 404 })
      }

      if (kind === 'file') {
        // searchParams.get 已做一次百分号解码，勿二次 decode
        const raw = url.searchParams.get('p') ?? ''
        const base = getSettings().baseDir
        if (!raw || !base) return new Response('forbidden', { status: 403 })
        // 用 realpath 解析符号链接后再做边界判断：本应用会在 Tags 目录建符号链接，
        // 仅用 resolve 不解析 symlink 会被自身功能绕过、读到 baseDir 之外的文件。
        let realBase: string
        let real: string
        try {
          realBase = realpathSync(resolve(base))
          real = realpathSync(resolve(raw))
        } catch {
          return new Response('forbidden', { status: 403 })
        }
        const rel = relative(realBase, real)
        if (rel.startsWith('..') || isAbsolute(rel)) {
          return new Response('forbidden', { status: 403 })
        }
        return fileResponse(real)
      }

      return new Response('bad request', { status: 400 })
    } catch (e) {
      return new Response(`error: ${(e as Error).message}`, { status: 500 })
    }
  })
}
