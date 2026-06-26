import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { motion } from 'motion/react'
import { EyeOff, Image as ImageIcon, RotateCcw } from 'lucide-react'
import type { IgnoredWork } from '@shared/types'
import { invoke } from '@/lib/ipc'
import { workThumb } from '@/lib/img'
import { useStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { TagChips } from '@/components/TagChips'

const TYPE_LABEL: Record<IgnoredWork['type'], string | null> = {
  illust: null,
  manga: '漫画',
  ugoira: '动图'
}

interface IgnoredCardProps {
  work: IgnoredWork
  index: number
  onRestore: (work: IgnoredWork) => void
  restoring: boolean
}

const IgnoredCard = memo(function IgnoredCard({
  work,
  index,
  onRestore,
  restoring
}: IgnoredCardProps): React.JSX.Element {
  const typeLabel = TYPE_LABEL[work.type]
  // 受控的加载失败态：用 state 渲染回退占位，避免命令式改 DOM 在列表节点复用时污染其它卡片
  const [failed, setFailed] = useState(false)
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, delay: Math.min(index, 12) * 0.015 }}
      className="flex flex-col overflow-hidden rounded-lg border border-border bg-card"
    >
      <div className="relative aspect-square overflow-hidden bg-muted">
        {failed ? (
          <div className="flex h-full w-full items-center justify-center text-muted-foreground">
            <ImageIcon className="size-6" />
          </div>
        ) : (
          <img
            src={workThumb(work.illustId)}
            alt={work.title}
            loading="lazy"
            className="h-full w-full object-cover"
            onError={() => setFailed(true)}
          />
        )}
        <div className="pointer-events-none absolute right-1.5 top-1.5 flex gap-1">
          {typeLabel && (
            <Badge variant="secondary" className="bg-background/80 backdrop-blur-sm">
              {typeLabel}
            </Badge>
          )}
          {work.pageCount > 1 && (
            <Badge variant="secondary" className="bg-background/80 backdrop-blur-sm">
              {work.pageCount} 页
            </Badge>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-2 p-2.5">
        <div className="min-w-0">
          <p className="truncate text-xs font-medium" title={work.title}>
            {work.title}
          </p>
          <p className="truncate text-[11px] text-muted-foreground">{work.authorName}</p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="w-full"
          disabled={restoring}
          onClick={() => onRestore(work)}
        >
          <RotateCcw />
          {restoring ? '恢复中…' : '恢复'}
        </Button>
      </div>
    </motion.div>
  )
})

const Ignored = (): React.JSX.Element => {
  const refreshStats = useStore((s) => s.refreshStats)
  const [works, setWorks] = useState<IgnoredWork[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set())
  const [restoringId, setRestoringId] = useState<string | null>(null)

  useEffect(() => {
    void invoke('library:listIgnored').then((list) => {
      setWorks(list)
      setLoading(false)
    })
  }, [])

  // 「被忽略作品」里出现过的标签（含计数），按计数降序；直接产出 {name,count}[] 供 TagChips 复用
  const tagOptions = useMemo(() => {
    const counts = new Map<string, number>()
    for (const w of works) for (const t of w.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count }))
  }, [works])

  // 多选：选中标签为空 → 全部；否则必须同时具备所有选中标签（交集）
  const shown = useMemo(() => {
    if (selectedTags.size === 0) return works
    const selectedList = [...selectedTags]
    return works.filter((w) => selectedList.every((t) => w.tags.includes(t)))
  }, [works, selectedTags])

  const toggleTag = useCallback((name: string): void => {
    setSelectedTags((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }, [])
  const clearTags = useCallback((): void => setSelectedTags(new Set()), [])

  const handleRestore = useCallback(
    async (work: IgnoredWork): Promise<void> => {
      setRestoringId(work.illustId)
      try {
        await invoke('library:unignore', work.illustId)
        setWorks((prev) => prev.filter((x) => x.illustId !== work.illustId))
        void refreshStats()
      } finally {
        setRestoringId(null)
      }
    },
    [refreshStats]
  )

  return (
    <div className="flex flex-col gap-5">
      {/* 顶部：tag chips 多选筛选 + 说明 */}
      <div className="flex flex-col gap-3">
        <p className="text-xs text-muted-foreground">
          这些作品已从本地删除并标记「不再下载」；恢复后会重新下载并回到图库。可多选标签筛选（需同时具备所有选中标签）。
        </p>
        {tagOptions.length > 0 && (
          <TagChips
            tags={tagOptions}
            selected={selectedTags}
            onToggle={toggleTag}
            onClear={clearTags}
            allCount={works.length}
          />
        )}
      </div>

      {loading ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="aspect-[3/4] animate-pulse rounded-lg bg-muted" />
          ))}
        </div>
      ) : shown.length === 0 ? (
        <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border px-6 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent text-muted-foreground [&_svg]:size-6">
            <EyeOff />
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground">
              {works.length === 0 ? '没有被忽略的作品' : '当前筛选下没有被忽略的作品'}
            </p>
            <p className="text-xs text-muted-foreground">
              在「图库」删除作品并保持「以后不再下载」开启时，会出现在这里。
            </p>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
          {shown.map((w, i) => (
            <IgnoredCard
              key={w.illustId}
              work={w}
              index={i}
              restoring={restoringId === w.illustId}
              onRestore={handleRestore}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export default Ignored
