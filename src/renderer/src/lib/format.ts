export function formatBytes(n: number): string {
  if (!n || n < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`
}

export function formatSpeed(bps: number): string {
  return bps > 0 ? `${formatBytes(bps)}/s` : '—'
}

export function formatEta(sec: number | null): string {
  if (sec == null || !isFinite(sec)) return '—'
  if (sec < 60) return `${Math.ceil(sec)} 秒`
  if (sec < 3600) return `${Math.floor(sec / 60)} 分 ${Math.ceil(sec % 60)} 秒`
  return `${Math.floor(sec / 3600)} 时 ${Math.floor((sec % 3600) / 60)} 分`
}

export function formatDate(ms: number | null): string {
  if (!ms) return '从未'
  return new Date(ms).toLocaleString('zh-CN', { hour12: false })
}
