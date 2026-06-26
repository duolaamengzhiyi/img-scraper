import AdmZip from 'adm-zip'
import ffmpeg from 'fluent-ffmpeg'
import ffmpegStatic from 'ffmpeg-static'
import { copyFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { UgoiraMode } from '@shared/types'
import { pixivClient } from '../pixiv/client'
import { fetchUgoiraMeta } from '../pixiv/illust'

// 打包后 ffmpeg 二进制在 asar.unpacked 中
function resolveFfmpegPath(): string | null {
  const p = ffmpegStatic as unknown as string | null
  return p ? p.replace('app.asar', 'app.asar.unpacked') : null
}
const ffmpegPath = resolveFfmpegPath()
if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath)

export interface UgoiraOutput {
  filePath: string
  bytes: number
  ext: string
}

/** 从图片/视频首帧生成一张缩放后的 jpg 缩略图（用于删除后保留预览） */
export function generateThumbnail(srcPath: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(srcPath)
      .outputOptions(['-frames:v', '1', '-vf', 'scale=480:-1', '-y'])
      .on('end', () => resolve())
      .on('error', (e: Error) => reject(e))
      .save(destPath)
  })
}

function encode(
  concatPath: string,
  out: string,
  outputOptions: string[],
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg()
      .input(concatPath)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .outputOptions(outputOptions)
      .on('end', () => resolve())
      .on('error', (e: Error) => reject(e))
      .save(out)
    signal?.addEventListener('abort', () => cmd.kill('SIGKILL'), { once: true })
    // 信号在注册前已中止时，addEventListener 不会补发，需主动 kill
    if (signal?.aborted) cmd.kill('SIGKILL')
  })
}

const EVEN_SCALE = 'scale=trunc(iw/2)*2:trunc(ih/2)*2'

function encodeMp4(concatPath: string, out: string, signal?: AbortSignal): Promise<void> {
  return encode(
    concatPath,
    out,
    [
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-vf',
      EVEN_SCALE,
      '-movflags',
      '+faststart',
      '-fps_mode',
      'vfr'
    ],
    signal
  )
}

function encodeGif(concatPath: string, out: string, signal?: AbortSignal): Promise<void> {
  return encode(
    concatPath,
    out,
    [
      '-vf',
      `${EVEN_SCALE}:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`,
      '-fps_mode',
      'vfr'
    ],
    signal
  )
}

/**
 * 处理 ugoira：下载帧 zip → 解压 → 按帧延时合成。
 * targetPathNoExt：输出路径（不含扩展名）。返回产出文件列表（首个作为主文件落库）。
 */
export async function processUgoira(
  illustId: string,
  targetPathNoExt: string,
  mode: UgoiraMode,
  opts: { onProgress?: (received: number, total: number) => void; signal?: AbortSignal } = {}
): Promise<UgoiraOutput[]> {
  const ck = (): void => {
    if (opts.signal?.aborted) throw new Error('aborted')
  }
  const meta = await fetchUgoiraMeta(illustId, opts.signal)
  const tmp = mkdtempSync(join(tmpdir(), `ugoira-${illustId}-`))
  try {
    const zipPath = join(tmp, 'frames.zip')
    await pixivClient.downloadToFile(meta.zipUrl, zipPath, {
      onProgress: opts.onProgress,
      signal: opts.signal
    })
    ck()

    if (mode === 'zip') {
      const dest = `${targetPathNoExt}.zip`
      copyFileSync(zipPath, dest)
      return [{ filePath: dest, bytes: statSync(dest).size, ext: 'zip' }]
    }

    ck()
    new AdmZip(zipPath).extractAllTo(tmp, true)

    // ffconcat 列表（带每帧时长）
    const lines = ['ffconcat version 1.0']
    for (const f of meta.frames) {
      lines.push(`file '${join(tmp, f.file)}'`)
      lines.push(`duration ${(f.delayMs / 1000).toFixed(4)}`)
    }
    if (meta.frames.length) {
      lines.push(`file '${join(tmp, meta.frames[meta.frames.length - 1].file)}'`)
    }
    const concatPath = join(tmp, 'concat.txt')
    writeFileSync(concatPath, lines.join('\n'), 'utf-8')

    const outputs: UgoiraOutput[] = []
    if (mode === 'mp4' || mode === 'mp4+gif') {
      const out = `${targetPathNoExt}.mp4`
      await encodeMp4(concatPath, out, opts.signal)
      outputs.push({ filePath: out, bytes: statSync(out).size, ext: 'mp4' })
    }
    if (mode === 'gif' || mode === 'mp4+gif') {
      const out = `${targetPathNoExt}.gif`
      await encodeGif(concatPath, out, opts.signal)
      outputs.push({ filePath: out, bytes: statSync(out).size, ext: 'gif' })
    }
    return outputs
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}
