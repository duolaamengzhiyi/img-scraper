/** 作品缩略图（优先本地已下载首页，否则远程缩略图，均经主进程带 Referer 代理） */
export function workThumb(illustId: string): string {
  return `pixiv-img://work/${illustId}`
}

/** 本地文件预览（限 baseDir 内） */
export function fileSrc(path: string): string {
  return `pixiv-img://file/?p=${encodeURIComponent(path)}`
}
