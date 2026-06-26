import { net } from 'electron'
import { createWriteStream, rmSync } from 'node:fs'
import { getSettings } from '../config/store'
import { pixivSession } from './session'

export const PIXIV_BASE = 'https://www.pixiv.net'
const APP_REFERER = 'https://www.pixiv.net/'
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const MAX_RETRIES = 5
const BACKOFF_BASE_MS = 2000
const BACKOFF_CAP_MS = 60_000

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 可被 AbortSignal 提前中断的等待 */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new Error('aborted'))
      },
      { once: true }
    )
  })
}

// ---- 串行节流：保证 AJAX 请求之间存在随机最小间隔（反限流抖动） ----
let lastRequestAt = 0
let throttleChain: Promise<void> = Promise.resolve()

function throttle(): Promise<void> {
  const run = throttleChain.then(async () => {
    const { minDelayMs, maxDelayMs } = getSettings()
    const gap = minDelayMs + Math.random() * Math.max(0, maxDelayMs - minDelayMs)
    const wait = lastRequestAt + gap - Date.now()
    if (wait > 0) await delay(wait)
    lastRequestAt = Date.now()
  })
  throttleChain = run.catch(() => undefined)
  return run
}

interface RawResponse {
  status: number
  body: Buffer
}

function rawRequest(
  url: string,
  opts: { headers?: Record<string, string>; signal?: AbortSignal } = {}
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = net.request({
      method: 'GET',
      url,
      session: pixivSession(),
      useSessionCookies: true
    })
    req.setHeader('User-Agent', USER_AGENT)
    req.setHeader('Referer', APP_REFERER)
    for (const [k, v] of Object.entries(opts.headers ?? {})) req.setHeader(k, v)

    const onAbort = (): void => req.abort()
    if (opts.signal) {
      if (opts.signal.aborted) {
        req.abort()
        reject(new Error('aborted'))
        return
      }
      opts.signal.addEventListener('abort', onAbort, { once: true })
    }

    const chunks: Buffer[] = []
    req.on('response', (res) => {
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        opts.signal?.removeEventListener('abort', onAbort)
        resolve({ status: res.statusCode, body: Buffer.concat(chunks) })
      })
      res.on('error', (e: Error) => reject(e))
    })
    req.on('error', (e: Error) => reject(e))
    req.end()
  })
}

interface PixivEnvelope<T> {
  error: boolean
  message: string
  body: T
}

/** GET Pixiv AJAX 接口，返回 envelope.body；带节流 + 指数退避 */
async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const url = path.startsWith('http') ? path : `${PIXIV_BASE}${path}`
  let lastErr: unknown
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await throttle()
    let status: number
    let body: Buffer
    try {
      ;({ status, body } = await rawRequest(url, {
        headers: { Accept: 'application/json' },
        signal
      }))
    } catch (e) {
      // 传输层错误：可重试
      lastErr = e
      if (signal?.aborted) throw e
      const backoff = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt)
      await abortableDelay(backoff + Math.random() * 500, signal)
      continue
    }

    if (status === 200) {
      const json = JSON.parse(body.toString('utf-8')) as PixivEnvelope<T>
      // 业务错误（作品已删除/无权限等）不可重试，直接抛出
      if (json.error) throw new Error(json.message || 'Pixiv API 返回错误')
      return json.body
    }
    // 仅限流 / 临时故障可重试；其余 4xx 直接抛出
    if (status === 429 || status === 403 || status >= 500) {
      lastErr = new Error(`HTTP ${status}`)
      if (signal?.aborted) throw new Error('aborted')
      const backoff = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt)
      await abortableDelay(backoff + Math.random() * 500, signal)
      continue
    }
    throw new Error(`HTTP ${status}`)
  }
  throw lastErr instanceof Error ? lastErr : new Error('请求失败')
}

/**
 * 下载二进制到文件（带 Referer，i.pximg.net 必需）。
 * onProgress(received, total)。支持 AbortSignal 取消。
 */
function downloadToFile(
  url: string,
  destPath: string,
  opts: { onProgress?: (received: number, total: number) => void; signal?: AbortSignal } = {}
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = net.request({
      method: 'GET',
      url,
      session: pixivSession(),
      useSessionCookies: true
    })
    req.setHeader('User-Agent', USER_AGENT)
    req.setHeader('Referer', APP_REFERER)

    let out: ReturnType<typeof createWriteStream> | null = null
    let settled = false

    const onAbort = (): void => {
      req.abort()
      fail(new Error('aborted'))
    }

    const finish = (received: number): void => {
      if (settled) return
      settled = true
      opts.signal?.removeEventListener('abort', onAbort)
      resolve(received)
    }

    // 任何失败/中止：销毁写流、删除半成品 .part、仅 reject 一次
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      opts.signal?.removeEventListener('abort', onAbort)
      if (out) {
        try {
          out.destroy()
        } catch {
          /* ignore */
        }
      }
      try {
        rmSync(destPath, { force: true })
      } catch {
        /* ignore */
      }
      reject(err)
    }

    if (opts.signal) {
      if (opts.signal.aborted) {
        fail(new Error('aborted'))
        return
      }
      opts.signal.addEventListener('abort', onAbort, { once: true })
    }

    req.on('response', (res) => {
      if (res.statusCode !== 200) {
        fail(new Error(`HTTP ${res.statusCode}`))
        return
      }
      const lenHeader = res.headers['content-length']
      const total = Number(Array.isArray(lenHeader) ? lenHeader[0] : lenHeader) || 0
      let received = 0
      out = createWriteStream(destPath)
      out.on('error', (e: Error) => fail(e))
      // 背压：写流满时暂停读，drain 后恢复，避免慢盘 / 大文件时未刷盘数据在内存无界堆积。
      // 用 typeof 守卫以兼容不支持 pause/resume 的响应流（不支持则退化为无背压，行为同旧版）。
      const pausable = res as unknown as { pause?: () => void; resume?: () => void }
      res.on('data', (chunk: Buffer) => {
        received += chunk.length
        const ok = out?.write(chunk)
        opts.onProgress?.(received, total)
        if (ok === false && typeof pausable.pause === 'function') {
          pausable.pause()
          out?.once('drain', () => {
            if (typeof pausable.resume === 'function') pausable.resume()
          })
        }
      })
      res.on('aborted', () => fail(new Error('aborted')))
      res.on('error', (e: Error) => fail(e))
      res.on('end', () => {
        if (settled) return
        const stream = out
        if (!stream) {
          finish(received)
          return
        }
        stream.end(() => finish(received))
      })
    })
    req.on('error', (e: Error) => fail(e))
    req.end()
  })
}

export const pixivClient = { getJson, downloadToFile }
