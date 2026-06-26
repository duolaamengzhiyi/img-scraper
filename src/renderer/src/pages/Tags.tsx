import { memo, useMemo, useState } from 'react'
import { motion } from 'motion/react'
import { RefreshCw, Search, Tag, Play, Pause, Square, LogIn } from 'lucide-react'
import type { BookmarkTag } from '@shared/types'
import { useStore } from '@/store'
import { invoke } from '@/lib/ipc'
import { cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Progress } from '@/components/ui/progress'

/** 单张标签卡片（memo：仅当自身 props 变化时重渲染，避免同步进度 tick 触发整网格重建） */
const TagCard = memo(function TagCard({
  tag,
  syncActive,
  active
}: {
  tag: BookmarkTag
  syncActive: boolean
  active: boolean
}): React.JSX.Element {
  // 同步当前标签：以 quick 模式仅同步该可见性下的此标签
  const handleSync = (): void => {
    void invoke('sync:start', {
      target: 'tag',
      tag: tag.name,
      visibility: tag.visibility,
      mode: 'quick'
    })
  }

  return (
    <Card
      className={cn(
        'flex flex-col transition-colors',
        active ? 'border-primary' : 'hover:border-primary/40'
      )}
    >
      <CardContent className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex items-start gap-2">
          <Tag className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p className="flex-1 truncate font-semibold leading-snug" title={tag.name}>
            {tag.name}
          </p>
        </div>

        <div className="flex items-center justify-between gap-2">
          <span className="text-sm text-muted-foreground">{tag.count} 张</span>
          <Badge variant={tag.visibility === 'public' ? 'default' : 'secondary'}>
            {tag.visibility === 'public' ? '公开' : '私密'}
          </Badge>
        </div>

        <div className="mt-auto pt-1">
          <Button
            variant={active ? 'default' : 'outline'}
            size="sm"
            className="w-full"
            disabled={syncActive}
            title={syncActive && !active ? '有同步正在进行，请等待其完成' : undefined}
            onClick={handleSync}
          >
            <Play className={cn(active && 'animate-pulse')} />
            {active ? '同步中…' : '同步此标签'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
})

const Tags = (): React.JSX.Element => {
  const account = useStore((s) => s.account)
  const tags = useStore((s) => s.tags)
  const ready = useStore((s) => s.ready)
  const refreshTags = useStore((s) => s.refreshTags)
  // 进度直接来自同步引擎（pagesDone/Skipped/Failed 现已是「本次同步」的真实计数），
  // 不再从全局 downloads 派生，故无需订阅整个 downloads 数组。
  const sync = useStore((s) => s.sync)

  const [query, setQuery] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  const loggedIn = account?.loggedIn ?? false

  // 同步状态（用于反馈与进度展示）
  const syncActive =
    !!sync &&
    (sync.phase === 'enumerating' || sync.phase === 'downloading' || sync.phase === 'paused')
  const plannedTotal = sync && sync.pagesTotal > 0 ? sync.pagesTotal : 0
  // 已终结页数（成功+跳过+失败）用于进度条到达 100%；文本另显示「已下载」真实张数
  const settledPages = sync ? sync.pagesDone + sync.pagesSkipped + sync.pagesFailed : 0
  const activeTagKey =
    sync?.scope?.target === 'tag' && sync.scope.tag
      ? `${sync.scope.visibility}:${sync.scope.tag}`
      : null

  // 按名称过滤后，按 count 降序展示
  const visibleTags = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return tags
      .filter((t) => (keyword ? t.name.toLowerCase().includes(keyword) : true))
      .slice()
      .sort((a, b) => b.count - a.count)
  }, [tags, query])

  const handleRefresh = async (): Promise<void> => {
    if (refreshing) return
    setRefreshing(true)
    try {
      await refreshTags()
    } finally {
      setRefreshing(false)
    }
  }

  // 顶部工具栏
  const toolbar = (
    <div className="flex items-center gap-3">
      <div className="relative flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="按名称搜索标签"
          className="pl-9"
          disabled={!loggedIn}
        />
      </div>
      <Button variant="outline" disabled={!loggedIn || refreshing} onClick={handleRefresh}>
        <RefreshCw className={cn(refreshing && 'animate-spin')} />
        刷新标签
      </Button>
    </div>
  )

  // 同步状态条（任意同步进行中都显示，含枚举/下载进度与控制）
  const syncBanner =
    syncActive && sync ? (
      <Card className="border-primary/30">
        <CardContent className="flex flex-col gap-3 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {sync.phase === 'enumerating'
                  ? '正在整理收藏…'
                  : sync.phase === 'paused'
                    ? '已暂停'
                    : '下载中'}
                {sync.currentLabel ? (
                  <span className="text-muted-foreground"> · {sync.currentLabel}</span>
                ) : null}
              </p>
              <p className="text-xs text-muted-foreground">
                {plannedTotal > 0
                  ? `已下载 ${sync.pagesDone} / ${plannedTotal} 页` +
                    (sync.pagesSkipped ? ` · 跳过 ${sync.pagesSkipped}` : '') +
                    (sync.pagesFailed ? ` · 失败 ${sync.pagesFailed}` : '')
                  : `已发现 ${sync.worksDiscovered} 件作品` +
                    (sync.pagesDone ? ` · 已下载 ${sync.pagesDone} 页` : '')}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {sync.phase === 'paused' ? (
                <Button size="sm" variant="outline" onClick={() => void invoke('sync:resume')}>
                  <Play />
                  继续
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={() => void invoke('sync:pause')}>
                  <Pause />
                  暂停
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => void invoke('sync:stop')}>
                <Square />
                停止
              </Button>
            </div>
          </div>
          {plannedTotal > 0 && (
            <Progress value={Math.min(100, Math.round((settledPages / plannedTotal) * 100))} />
          )}
        </CardContent>
      </Card>
    ) : null

  // 加载中骨架
  const renderLoading = (): React.JSX.Element => (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {Array.from({ length: 8 }).map((_, i) => (
        <Skeleton key={i} className="h-[140px] rounded-xl" />
      ))}
    </div>
  )

  // 通用空状态容器
  const renderEmpty = (icon: React.ReactNode, title: string, desc: string): React.JSX.Element => (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border py-20 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-accent text-muted-foreground">
        {icon}
      </div>
      <div className="space-y-1">
        <p className="font-medium text-foreground">{title}</p>
        <p className="text-sm text-muted-foreground">{desc}</p>
      </div>
    </div>
  )

  const renderBody = (): React.JSX.Element => {
    if (!ready) return renderLoading()

    if (!loggedIn) {
      return renderEmpty(
        <LogIn className="size-5" />,
        '尚未登录',
        '请前往「概览」页登录你的 Pixiv 账号后再查看书签标签。'
      )
    }

    if (tags.length === 0) {
      return renderEmpty(
        <Tag className="size-5" />,
        '暂无标签',
        '点击右上角「刷新标签」从 Pixiv 拉取你的书签标签。'
      )
    }

    if (visibleTags.length === 0) {
      return renderEmpty(
        <Search className="size-5" />,
        '没有匹配的标签',
        '换个关键词试试，或清空搜索框查看全部标签。'
      )
    }

    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2 }}
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
      >
        {visibleTags.map((t) => (
          <TagCard
            key={`${t.visibility}:${t.name}`}
            tag={t}
            syncActive={syncActive}
            active={syncActive && activeTagKey === `${t.visibility}:${t.name}`}
          />
        ))}
      </motion.div>
    )
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">标签</h1>
        <p className="text-sm text-muted-foreground">按书签标签浏览与同步你的 Pixiv 收藏。</p>
      </div>

      {toolbar}
      {syncBanner}
      {renderBody()}
    </div>
  )
}

export default Tags
