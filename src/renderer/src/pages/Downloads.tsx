import * as React from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  Pause,
  Play,
  RotateCcw,
  Trash2,
  FolderOpen,
  Image as ImageIcon,
  PauseCircle,
  PlayCircle,
  CheckCircle2,
  ChevronRight,
  Download
} from 'lucide-react'
import type { DownloadItem } from '@shared/types'
import { useStore } from '@/store'
import { invoke } from '@/lib/ipc'
import { formatBytes, formatSpeed, formatEta } from '@/lib/format'
import { workThumb } from '@/lib/img'
import { cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'

type DownloadStatus = DownloadItem['status']

/** 状态 -> 中文标签 + Badge 变体 */
const STATUS_META: Record<
  DownloadStatus,
  { label: string; variant: React.ComponentProps<typeof Badge>['variant'] }
> = {
  downloading: { label: '下载中', variant: 'default' },
  queued: { label: '排队中', variant: 'secondary' },
  paused: { label: '已暂停', variant: 'warning' },
  completed: { label: '已完成', variant: 'success' },
  failed: { label: '失败', variant: 'destructive' },
  skipped: { label: '已跳过', variant: 'outline' }
}

/** 顶部汇总条里展示的状态及其语义点色 */
const SUMMARY_STATUSES: { status: DownloadStatus; dotClass: string }[] = [
  { status: 'downloading', dotClass: 'bg-primary' },
  { status: 'queued', dotClass: 'bg-muted-foreground' },
  { status: 'paused', dotClass: 'bg-warning' },
  { status: 'completed', dotClass: 'bg-success' },
  { status: 'failed', dotClass: 'bg-destructive' },
  { status: 'skipped', dotClass: 'bg-muted-foreground/50' }
]

/** 缩略图：加载失败时回退为占位图标 */
const Thumb = ({ illustId }: { illustId: string }): React.JSX.Element => {
  const [failed, setFailed] = React.useState(false)
  if (failed) {
    return (
      <div className="flex size-11 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <ImageIcon className="size-4" />
      </div>
    )
  }
  return (
    <img
      src={workThumb(illustId)}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      className="size-11 shrink-0 rounded-md object-cover"
    />
  )
}

/** 单个图标操作按钮（带 Tooltip） */
const ActionButton = ({
  label,
  onClick,
  children,
  variant = 'ghost',
  className
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
  variant?: React.ComponentProps<typeof Button>['variant']
  className?: string
}): React.JSX.Element => (
  <Tooltip>
    <TooltipTrigger asChild>
      <Button
        variant={variant}
        size="icon"
        className={className}
        onClick={onClick}
        aria-label={label}
      >
        {children}
      </Button>
    </TooltipTrigger>
    <TooltipContent>{label}</TooltipContent>
  </Tooltip>
)

const MAX_TAGS = 3

/** 列表中的单个下载任务（memo：仅当 item 引用变化时重渲染） */
const DownloadRow = React.memo(function DownloadRow({
  item,
  onRefresh
}: {
  item: DownloadItem
  onRefresh: () => void
}): React.JSX.Element {
  const status = item.status
  const meta = STATUS_META[status]
  const percent = Math.round(Math.min(1, Math.max(0, item.progress)) * 100)
  const visibleTags = item.tagNames.slice(0, MAX_TAGS)
  const extraTags = item.tagNames.length - visibleTags.length

  const handlePause = (): void => {
    void invoke('download:pause', item.id).then(onRefresh)
  }
  const handleResume = (): void => {
    void invoke('download:resume', item.id).then(onRefresh)
  }
  const handleRetry = (): void => {
    void invoke('download:retry', item.id).then(onRefresh)
  }
  const handleRemove = (): void => {
    void invoke('download:remove', item.id).then(onRefresh)
  }
  const handleOpen = (): void => {
    if (item.filePath) void invoke('shell:openPath', item.filePath)
  }
  const handleReveal = (): void => {
    if (item.filePath) void invoke('shell:revealInFolder', item.filePath)
  }

  return (
    <div className="flex items-start gap-3 rounded-lg px-2 py-3 transition-colors hover:bg-accent">
      <Thumb illustId={item.illustId} />

      <div className="min-w-0 flex-1">
        {/* 文件名 + 状态徽章 */}
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {item.fileName}
          </span>
          <Badge variant={meta.variant} className="shrink-0">
            {meta.label}
          </Badge>
        </div>

        {/* tag / 动图 徽章 */}
        {(visibleTags.length > 0 || item.isUgoira) && (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {item.isUgoira && (
              <Badge variant="secondary" className="font-normal">
                动图
              </Badge>
            )}
            {visibleTags.map((tag) => (
              <Badge key={tag} variant="outline" className="max-w-[10rem] truncate font-normal">
                {tag}
              </Badge>
            ))}
            {extraTags > 0 && (
              <Badge variant="outline" className="font-normal">
                +{extraTags}
              </Badge>
            )}
          </div>
        )}

        {/* 进度条 + 百分比 */}
        <div className="mt-2 flex items-center gap-2">
          <Progress value={percent} className="flex-1" />
          <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
            {percent}%
          </span>
        </div>

        {/* 字节 / 速度 / 剩余时间 或 错误信息 */}
        {status === 'failed' && item.error ? (
          <p className="mt-1 truncate text-xs text-destructive" title={item.error}>
            {item.error}
          </p>
        ) : (
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {formatBytes(item.receivedBytes)} / {formatBytes(item.totalBytes)}
            {status === 'downloading' && (
              <>
                {' · '}
                {formatSpeed(item.speedBps)}
                {' · 剩 '}
                {formatEta(item.etaSec)}
              </>
            )}
          </p>
        )}
      </div>

      {/* 右侧操作 */}
      <div className="flex shrink-0 items-center gap-0.5">
        {status === 'downloading' && (
          <ActionButton label="暂停" onClick={handlePause}>
            <Pause />
          </ActionButton>
        )}
        {(status === 'paused' || status === 'queued') && (
          <ActionButton label="继续" onClick={handleResume}>
            <Play />
          </ActionButton>
        )}
        {status === 'failed' && (
          <ActionButton label="重试" onClick={handleRetry}>
            <RotateCcw />
          </ActionButton>
        )}
        {status === 'completed' && item.filePath && (
          <>
            <ActionButton label="打开文件" onClick={handleOpen}>
              <FolderOpen />
            </ActionButton>
            <ActionButton label="在文件夹中定位" onClick={handleReveal}>
              <ImageIcon />
            </ActionButton>
          </>
        )}
        <ActionButton label="删除" onClick={handleRemove}>
          <Trash2 />
        </ActionButton>
      </div>
    </div>
  )
})

/** 组内的单页：紧凑样式（页号 + 细进度条 + 小号信息），配合左侧导引线呈现层级 */
const DownloadPageRow = React.memo(function DownloadPageRow({
  item,
  onRefresh
}: {
  item: DownloadItem
  onRefresh: () => void
}): React.JSX.Element {
  const status = item.status
  const meta = STATUS_META[status]
  const percent = Math.round(Math.min(1, Math.max(0, item.progress)) * 100)
  const act =
    (channel: 'download:pause' | 'download:resume' | 'download:retry' | 'download:remove') =>
    (): void => {
      void invoke(channel, item.id).then(onRefresh)
    }
  const handleOpen = (): void => {
    if (item.filePath) void invoke('shell:openPath', item.filePath)
  }
  const iconBtn = 'size-7 [&_svg]:size-3.5'

  return (
    <div className="flex items-center gap-3 py-2">
      <span className="w-8 shrink-0 text-center font-mono text-[11px] text-muted-foreground">
        p{item.pageIndex}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Progress value={percent} className="h-1.5 flex-1" />
          <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
            {percent}%
          </span>
        </div>
        {status === 'failed' && item.error ? (
          <p className="mt-0.5 truncate text-[11px] text-destructive" title={item.error}>
            {item.error}
          </p>
        ) : (
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {formatBytes(item.receivedBytes)} / {formatBytes(item.totalBytes)}
            {status === 'downloading' && <> · {formatSpeed(item.speedBps)}</>}
          </p>
        )}
      </div>
      <Badge variant={meta.variant} className="shrink-0">
        {meta.label}
      </Badge>
      <div className="flex shrink-0 items-center">
        {status === 'downloading' && (
          <ActionButton label="暂停" onClick={act('download:pause')} className={iconBtn}>
            <Pause />
          </ActionButton>
        )}
        {(status === 'paused' || status === 'queued') && (
          <ActionButton label="继续" onClick={act('download:resume')} className={iconBtn}>
            <Play />
          </ActionButton>
        )}
        {status === 'failed' && (
          <ActionButton label="重试" onClick={act('download:retry')} className={iconBtn}>
            <RotateCcw />
          </ActionButton>
        )}
        {status === 'completed' && item.filePath && (
          <ActionButton label="打开文件" onClick={handleOpen} className={iconBtn}>
            <FolderOpen />
          </ActionButton>
        )}
        <ActionButton label="删除" onClick={act('download:remove')} className={iconBtn}>
          <Trash2 />
        </ActionButton>
      </div>
    </div>
  )
})

/** 套图（多页作品）折叠为一组：聚合进度 + 可展开看每页 + 整组操作（memo：items 引用稳定时跳过） */
const DownloadGroup = React.memo(function DownloadGroup({
  items,
  onRefresh
}: {
  items: DownloadItem[]
  onRefresh: () => void
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  const head = items[0]
  const pageCount = items.length
  const donePages = items.filter((i) => i.status === 'completed' || i.status === 'skipped').length
  const speed = items.reduce((s, i) => (i.status === 'downloading' ? s + i.speedBps : s), 0)
  const failed = items.filter((i) => i.status === 'failed').length
  const allDone = donePages === pageCount
  // 父行展示「按页」的总进度：已完成页 + 正在下载页的小数进度，再除以总页数（稳定、与「X/Y 页」一致）
  const inProgress = items.reduce((s, i) => (i.status === 'downloading' ? s + i.progress : s), 0)
  const percent = pageCount > 0 ? Math.round(((donePages + inProgress) / pageCount) * 100) : 0

  const aggLabel = allDone
    ? '已完成'
    : failed > 0
      ? `${failed} 个失败`
      : items.some((i) => i.status === 'downloading')
        ? '下载中'
        : items.some((i) => i.status === 'paused')
          ? '已暂停'
          : '排队中'
  const aggVariant: React.ComponentProps<typeof Badge>['variant'] = allDone
    ? 'success'
    : failed > 0
      ? 'destructive'
      : items.some((i) => i.status === 'paused')
        ? 'warning'
        : 'default'

  const visibleTags = head.tagNames.slice(0, MAX_TAGS)
  const extraTags = head.tagNames.length - visibleTags.length
  const canPause = items.some((i) => i.status === 'downloading' || i.status === 'queued')
  const canResume = items.some(
    (i) => i.status === 'paused' || i.status === 'queued' || i.status === 'failed'
  )

  const pauseGroup = (): void => {
    void Promise.all(
      items
        .filter((i) => i.status === 'downloading' || i.status === 'queued')
        .map((i) => invoke('download:pause', i.id))
    ).then(onRefresh)
  }
  const resumeGroup = (): void => {
    void Promise.all(
      items
        .filter((i) => i.status === 'paused' || i.status === 'queued' || i.status === 'failed')
        .map((i) => invoke(i.status === 'failed' ? 'download:retry' : 'download:resume', i.id))
    ).then(onRefresh)
  }
  const removeGroup = (): void => {
    void Promise.all(items.map((i) => invoke('download:remove', i.id))).then(onRefresh)
  }
  const reveal = (): void => {
    const f = items.find((i) => i.filePath)?.filePath
    if (f) void invoke('shell:revealInFolder', f)
  }

  return (
    <div>
      <div
        className="flex cursor-pointer items-start gap-3 rounded-lg px-2 py-3 transition-colors hover:bg-accent"
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronRight
          className={cn(
            'mt-3 size-4 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90'
          )}
        />
        <Thumb illustId={head.illustId} />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
              {head.title}
            </span>
            <Badge variant="secondary" className="shrink-0 font-normal">
              套图 {pageCount} 页
            </Badge>
            <Badge variant={aggVariant} className="shrink-0">
              {aggLabel}
            </Badge>
          </div>

          {(visibleTags.length > 0 || head.isUgoira) && (
            <div className="mt-1 flex flex-wrap items-center gap-1">
              {head.isUgoira && (
                <Badge variant="secondary" className="font-normal">
                  动图
                </Badge>
              )}
              {visibleTags.map((tag) => (
                <Badge key={tag} variant="outline" className="max-w-[10rem] truncate font-normal">
                  {tag}
                </Badge>
              ))}
              {extraTags > 0 && (
                <Badge variant="outline" className="font-normal">
                  +{extraTags}
                </Badge>
              )}
            </div>
          )}

          <div className="mt-2 flex items-center gap-2">
            <Progress value={percent} className="flex-1" />
            <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
              {percent}%
            </span>
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            已完成 {donePages}/{pageCount} 页{speed > 0 && <> · {formatSpeed(speed)}</>}
          </p>
        </div>

        {/* 整组操作：阻止冒泡，避免触发折叠 */}
        <div className="flex shrink-0 items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
          {canPause && (
            <ActionButton label="暂停整组" onClick={pauseGroup}>
              <Pause />
            </ActionButton>
          )}
          {canResume && (
            <ActionButton label="继续整组" onClick={resumeGroup}>
              <Play />
            </ActionButton>
          )}
          {allDone && (
            <ActionButton label="在文件夹中定位" onClick={reveal}>
              <FolderOpen />
            </ActionButton>
          )}
          <ActionButton label="移除整组" onClick={removeGroup}>
            <Trash2 />
          </ActionButton>
        </div>
      </div>

      {open && (
        <div className="pb-1 pl-12 pr-1">
          {items.map((i) => (
            <DownloadPageRow key={i.id} item={i} onRefresh={onRefresh} />
          ))}
        </div>
      )}
    </div>
  )
})

const Downloads = (): React.JSX.Element => {
  const downloads = useStore((s) => s.downloads)
  const ready = useStore((s) => s.ready)
  const sync = useStore((s) => s.sync)
  const refreshDownloads = useStore((s) => s.refreshDownloads)

  const refresh = React.useCallback((): void => {
    void refreshDownloads()
  }, [refreshDownloads])

  // 按状态计数
  const counts = React.useMemo(() => {
    const c: Record<DownloadStatus, number> = {
      downloading: 0,
      queued: 0,
      paused: 0,
      completed: 0,
      failed: 0,
      skipped: 0
    }
    for (const d of downloads) c[d.status] += 1
    return c
  }, [downloads])

  // 当前总速度（仅下载中）
  const totalSpeed = React.useMemo(
    () => downloads.reduce((sum, d) => (d.status === 'downloading' ? sum + d.speedBps : sum), 0),
    [downloads]
  )

  // 按作品(illustId)分组：套图折叠为一组，单图为只含 1 项的组。
  // 复用上一次渲染中「内容未变」的组数组引用，让 memo 的 DownloadGroup/DownloadRow 能跳过重渲染。
  const groupCacheRef = React.useRef(new Map<string, DownloadItem[]>())
  const groups = React.useMemo(() => {
    const fresh = new Map<string, DownloadItem[]>()
    for (const d of downloads) {
      const arr = fresh.get(d.illustId)
      if (arr) arr.push(d)
      else fresh.set(d.illustId, [d])
    }
    const cache = groupCacheRef.current
    const next = new Map<string, DownloadItem[]>()
    const result: DownloadItem[][] = []
    for (const [id, arr] of fresh) {
      const prev = cache.get(id)
      // 逐项按引用比较：若与上次完全一致则复用旧数组引用（item 对象在 store 中按 id 复用）
      const same =
        prev !== undefined && prev.length === arr.length && prev.every((p, i) => p === arr[i])
      const chosen = same ? prev : arr
      next.set(id, chosen)
      result.push(chosen)
    }
    groupCacheRef.current = next
    return result
  }, [downloads])

  // 组聚合状态：全部完成/跳过 → 已完成，否则进行中
  const isGroupDone = (g: DownloadItem[]): boolean =>
    g.every((i) => i.status === 'completed' || i.status === 'skipped')
  const activeGroups = React.useMemo(() => groups.filter((g) => !isGroupDone(g)), [groups])
  const doneGroups = React.useMemo(() => groups.filter((g) => isGroupDone(g)), [groups])

  const [tab, setTab] = React.useState<'active' | 'done'>('active')
  const shownGroups = tab === 'active' ? activeGroups : doneGroups

  // 列表虚拟化：仅渲染可视区域内的组，DOM 节点数与队列规模解耦（支持展开后的动态高度）
  const parentRef = React.useRef<HTMLDivElement>(null)
  const rowVirtualizer = useVirtualizer({
    count: shownGroups.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 84,
    overscan: 8,
    getItemKey: (i) => shownGroups[i][0].illustId
  })

  // 整体进度：同步进行中用「同步引擎的精确计数」（分母=计划总数，分子=已终结页），
  // 二者作用域一致、稳定不随入队增长；非同步时按下载队列自身统计。
  const settled = counts.completed + counts.skipped + counts.failed
  const syncing =
    !!sync &&
    (sync.phase === 'enumerating' || sync.phase === 'downloading' || sync.phase === 'paused')
  const plannedTotal = syncing && sync && sync.pagesTotal > 0 ? sync.pagesTotal : 0
  // 仍在整理且未暂停、总数未定；暂停态不算「整理中」以免与已暂停状态矛盾
  const discovering = syncing && plannedTotal === 0 && sync?.phase !== 'paused'
  const total = plannedTotal || downloads.length
  const overallDone =
    plannedTotal > 0 && sync
      ? Math.min(sync.pagesDone + sync.pagesSkipped + sync.pagesFailed, plannedTotal)
      : Math.min(settled, total)
  const overallPercent = total > 0 ? Math.round((overallDone / total) * 100) : 0

  const hasCompleted = counts.completed > 0
  const hasActive = counts.downloading > 0 || counts.queued > 0
  const hasPausable = counts.downloading > 0 || counts.queued > 0
  const hasResumable = counts.paused > 0 || counts.queued > 0

  const handlePauseAll = (): void => {
    void invoke('download:pauseAll').then(refresh)
  }
  const handleResumeAll = (): void => {
    void invoke('download:resumeAll').then(refresh)
  }
  const handleClearCompleted = (): void => {
    void invoke('download:clearCompleted').then(refresh)
  }

  // 加载中骨架
  if (!ready) {
    return (
      <div className="flex h-full flex-col gap-4 p-6">
        <Card>
          <CardContent className="p-5">
            <div className="h-16 animate-pulse rounded-lg bg-muted" />
          </CardContent>
        </Card>
        <Card className="flex-1">
          <CardContent className="space-y-3 p-5">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-16 animate-pulse rounded-lg bg-muted" />
            ))}
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      {/* 顶部汇总条 */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-4 p-5">
          {/* 状态计数 */}
          <div className="flex flex-wrap items-center gap-4">
            {SUMMARY_STATUSES.map(({ status, dotClass }) => (
              <div key={status} className="flex items-center gap-2">
                <span className={cn('size-2 shrink-0 rounded-full', dotClass)} />
                <span className="text-sm text-muted-foreground">{STATUS_META[status].label}</span>
                <span className="text-sm font-semibold tabular-nums text-foreground">
                  {counts[status]}
                </span>
              </div>
            ))}
          </div>

          <Separator orientation="vertical" className="hidden h-8 sm:block" />

          {/* 当前总速度 */}
          <div className="flex items-center gap-2">
            <Download className="size-4 text-muted-foreground" />
            <span className="text-sm font-semibold tabular-nums text-foreground">
              {formatSpeed(totalSpeed)}
            </span>
          </div>

          {/* 整体进度 */}
          <div className="flex min-w-[10rem] flex-1 items-center gap-3">
            <Progress value={overallPercent} className="flex-1" />
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {discovering
                ? `整理中…${sync && sync.pagesDone > 0 ? ` · 已下载 ${sync.pagesDone} 页` : ''}`
                : `${overallDone}/${total} · ${overallPercent}%`}
            </span>
          </div>

          {/* 批量操作 */}
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handlePauseAll} disabled={!hasPausable}>
              <PauseCircle />
              全部暂停
            </Button>
            <Button variant="outline" size="sm" onClick={handleResumeAll} disabled={!hasResumable}>
              <PlayCircle />
              全部继续
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleClearCompleted}
              disabled={!hasCompleted}
            >
              <CheckCircle2 />
              清除已完成
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* tab 切换：进行中 / 已完成 */}
      <div className="flex items-center gap-1 self-start rounded-lg bg-muted p-1">
        <button
          onClick={() => setTab('active')}
          className={cn(
            'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
            tab === 'active'
              ? 'bg-card text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          进行中 {activeGroups.length}
        </button>
        <button
          onClick={() => setTab('done')}
          className={cn(
            'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
            tab === 'done'
              ? 'bg-card text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          已完成 {doneGroups.length}
        </button>
      </div>

      {/* 列表 */}
      <Card className="flex min-h-0 flex-1 flex-col">
        {shownGroups.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center">
            <div className="flex size-14 items-center justify-center rounded-full bg-muted text-muted-foreground">
              {tab === 'active' ? (
                <Download className="size-6" />
              ) : (
                <CheckCircle2 className="size-6" />
              )}
            </div>
            <p className="text-sm font-medium text-foreground">
              {tab === 'active' ? '没有进行中的任务' : '还没有已完成的项目'}
            </p>
            <p className="max-w-xs text-xs text-muted-foreground">
              {tab === 'active'
                ? '去「概览」或「标签」页开始同步，下载任务会实时出现在这里。'
                : '完成的下载会归档到这里。'}
            </p>
          </div>
        ) : (
          <div ref={parentRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-1">
            <div
              className="relative w-full"
              style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
            >
              {rowVirtualizer.getVirtualItems().map((vi) => {
                const g = shownGroups[vi.index]
                return (
                  <div
                    key={vi.key}
                    data-index={vi.index}
                    ref={rowVirtualizer.measureElement}
                    className="absolute left-0 top-0 w-full"
                    style={{ transform: `translateY(${vi.start}px)` }}
                  >
                    {g.length === 1 ? (
                      <DownloadRow item={g[0]} onRefresh={refresh} />
                    ) : (
                      <DownloadGroup items={g} onRefresh={refresh} />
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </Card>
    </div>
  )
}

export default Downloads
