import { useEffect } from 'react'
import type { DownloadItem } from '@shared/types'
import { onEvent } from '@/lib/ipc'
import { useStore } from '@/store'

/** 高频下载事件的合并间隔（ms）：把 update/added/removed 攒一拨再一次性落库 */
const FLUSH_INTERVAL_MS = 120

/** 在应用根组件挂载时订阅主进程推送事件，更新全局 store */
export function useIpcEvents(): void {
  useEffect(() => {
    const s = useStore.getState()

    // ---- 下载事件合并：避免每个进度 tick 都触发一次整页重渲染 ----
    const upserts = new Map<string, DownloadItem>()
    const removes = new Set<string>()
    let timer: ReturnType<typeof setTimeout> | null = null

    const flush = (): void => {
      timer = null
      if (upserts.size === 0 && removes.size === 0) return
      const ups = [...upserts.values()]
      const rms = [...removes]
      upserts.clear()
      removes.clear()
      useStore.getState()._applyDownloadBatch(ups, rms)
    }
    const schedule = (): void => {
      if (timer === null) timer = setTimeout(flush, FLUSH_INTERVAL_MS)
    }
    const bufferUpsert = (d: DownloadItem): void => {
      removes.delete(d.id)
      upserts.set(d.id, d) // 同一 id 的多次进度只保留最后一帧
      schedule()
    }
    const bufferRemove = (id: string): void => {
      upserts.delete(id)
      removes.add(id)
      schedule()
    }

    const unsubs = [
      onEvent('auth:changed', (a) => s._setAccount(a)),
      onEvent('sync:progress', (p) => s._setSync(p)),
      onEvent('download:added', (ds) => ds.forEach(bufferUpsert)),
      onEvent('download:update', (d) => bufferUpsert(d)),
      onEvent('download:removed', ({ id }) => bufferRemove(id)),
      onEvent('tags:updated', (t) => s._setTags(t)),
      onEvent('library:statsUpdated', (st) => s._setStats(st))
    ]
    return () => {
      if (timer !== null) clearTimeout(timer)
      flush() // 卸载前把残留的一批落库
      unsubs.forEach((u) => u())
    }
  }, [])
}
