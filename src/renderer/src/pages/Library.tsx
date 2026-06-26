import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { FolderOpen, Image as ImageIcon, Trash2 } from 'lucide-react'
import type { WorkRecord } from '@shared/types'
import { useStore } from '@/store'
import { invoke } from '@/lib/ipc'
import { workThumb } from '@/lib/img'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { TagChips } from '@/components/TagChips'

/** 一页拉取的作品数量 */
const PAGE_SIZE = 60

/** 作品类型对应的中文角标文案；illust 不展示 */
const TYPE_LABEL: Record<WorkRecord['type'], string | null> = {
  illust: null,
  manga: '漫画',
  ugoira: '动图'
}

/** 单张作品卡片 */
interface WorkCardProps {
  work: WorkRecord
  index: number
  onOpen: (work: WorkRecord) => void
  onContextMenu: (work: WorkRecord) => void
  onDelete: (work: WorkRecord) => void
}

const WorkCard = memo(function WorkCard({
  work,
  index,
  onOpen,
  onContextMenu,
  onDelete
}: WorkCardProps): React.JSX.Element {
  const typeLabel = TYPE_LABEL[work.type]

  return (
    <motion.div
      onClick={() => onOpen(work)}
      onContextMenu={(e) => {
        e.preventDefault()
        onContextMenu(work)
      }}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      // 入场略带错位，最多延迟到约第 12 张，避免长列表整体延迟过久
      transition={{ duration: 0.2, delay: Math.min(index, 12) * 0.015 }}
      className="group relative aspect-square cursor-pointer overflow-hidden rounded-lg border border-border bg-muted"
      title={work.title}
    >
      <img
        src={workThumb(work.illustId)}
        alt={work.title}
        loading="lazy"
        className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
      />

      {/* 右上角角标：类型 + 多页页数 */}
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

      {/* 左上角删除按钮（hover 显示） */}
      <button
        type="button"
        aria-label="删除"
        onClick={(e) => {
          e.stopPropagation()
          onDelete(work)
        }}
        className="absolute left-1.5 top-1.5 hidden items-center justify-center rounded-md bg-black/55 p-1.5 text-white backdrop-blur-sm transition-colors hover:bg-destructive group-hover:flex [&_svg]:size-3.5"
      >
        <Trash2 />
      </button>

      {/* hover 浮现的底部信息遮罩 */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 via-black/35 to-transparent px-2.5 pb-2 pt-6 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
        <p className="truncate text-xs font-medium text-white">{work.title}</p>
        <p className="truncate text-[11px] text-white/70">{work.authorName}</p>
      </div>
    </motion.div>
  )
})

/** 缩略图网格占位骨架 */
const GridSkeleton = (): React.JSX.Element => (
  <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
    {Array.from({ length: 18 }).map((_, i) => (
      <Skeleton key={i} className="aspect-square rounded-lg" />
    ))}
  </div>
)

/** 居中的空 / 提示状态 */
interface EmptyStateProps {
  icon: React.ReactNode
  title: string
  description: string
}

const EmptyState = ({ icon, title, description }: EmptyStateProps): React.JSX.Element => (
  <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border px-6 text-center">
    <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent text-muted-foreground [&_svg]:size-6">
      {icon}
    </div>
    <div className="space-y-1">
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  </div>
)

const Library = (): React.JSX.Element => {
  const settings = useStore((s) => s.settings)
  const refreshStats = useStore((s) => s.refreshStats)

  // 多选标签（交集筛选：需同时具备所有选中标签）；为空表示全部
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set())
  const [works, setWorks] = useState<WorkRecord[]>([])
  const [total, setTotal] = useState<number>(0)
  const [loading, setLoading] = useState<boolean>(true)
  const [loadingMore, setLoadingMore] = useState<boolean>(false)
  // 删除确认
  const [deleteTarget, setDeleteTarget] = useState<WorkRecord | null>(null)
  const [ignoreOnDelete, setIgnoreOnDelete] = useState(true)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // 图库标签 chips：来自「本地已下载作品」的标签，按已下载量降序
  const [tagOptions, setTagOptions] = useState<{ name: string; count: number }[]>([])
  const loadTags = useCallback((): void => {
    void invoke('library:downloadedTags').then(setTagOptions)
  }, [])
  useEffect(() => loadTags(), [loadTags])

  const toggleTag = useCallback((name: string): void => {
    setSelectedTags((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }, [])
  const clearTags = useCallback((): void => setSelectedTags(new Set()), [])

  const hasBaseDir = Boolean(settings?.baseDir)

  // 自增请求号：切换标签 / 重新加载会使在途的旧请求作废，避免过期响应错误追加
  const reqIdRef = useRef(0)

  /** 拉取作品；offset=0 视为重新加载，其余为追加 */
  const fetchWorks = useCallback(
    async (offset: number, append: boolean): Promise<void> => {
      const reqId = ++reqIdRef.current
      if (append) setLoadingMore(true)
      else {
        setLoading(true)
        setLoadingMore(false)
      }
      try {
        const res = await invoke('library:listWorks', {
          tags: selectedTags.size > 0 ? [...selectedTags] : undefined,
          offset,
          limit: PAGE_SIZE
        })
        if (reqId !== reqIdRef.current) return // 已被更新的请求取代，丢弃过期响应
        setTotal(res.total)
        setWorks((prev) => (append ? [...prev, ...res.works] : res.works))
      } finally {
        if (reqId === reqIdRef.current) {
          if (append) setLoadingMore(false)
          else setLoading(false)
        }
      }
    },
    [selectedTags]
  )

  // 标签变化（含首次挂载）时重置并重查
  useEffect(() => {
    void fetchWorks(0, false)
  }, [fetchWorks])

  /** 左键点击：用设定的应用打开（单图开单张，多页把整组传给应用） */
  const handleOpenWork = useCallback((work: WorkRecord): void => {
    void invoke('library:openWork', work.illustId)
  }, [])

  /** 右键：弹出原生菜单（打开 / 打开所在位置） */
  const handleContextMenu = useCallback((work: WorkRecord): void => {
    void invoke('library:showWorkMenu', work.illustId)
  }, [])

  /** 定位保存目录 */
  const handleRevealBaseDir = useCallback((): void => {
    if (settings?.baseDir) void invoke('shell:revealInFolder', settings.baseDir)
  }, [settings?.baseDir])

  /** 加载更多 */
  const handleLoadMore = useCallback((): void => {
    void fetchWorks(works.length, true)
  }, [fetchWorks, works.length])

  const canLoadMore = works.length < total

  /** 打开删除弹窗：每次都把开关复位为默认（以后不再下载），并清空上次错误 */
  const openDelete = useCallback((work: WorkRecord): void => {
    setIgnoreOnDelete(true)
    setDeleteError(null)
    setDeleteTarget(work)
  }, [])

  /** 确认删除：删本地文件，从列表移除并修正统计；失败保留弹窗并提示 */
  const handleConfirmDelete = async (): Promise<void> => {
    if (!deleteTarget) return
    const target = deleteTarget
    setDeleting(true)
    setDeleteError(null)
    try {
      await invoke('library:deleteWork', target.illustId, ignoreOnDelete)
      setWorks((prev) => prev.filter((w) => w.illustId !== target.illustId))
      setTotal((t) => Math.max(0, t - 1))
      void refreshStats()
      loadTags()
      setDeleteTarget(null)
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {/* 顶部过滤条 */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {tagOptions.length > 0 && (
            <TagChips
              tags={tagOptions}
              selected={selectedTags}
              onToggle={toggleTag}
              onClear={clearTags}
            />
          )}
        </div>
        <Button
          variant="outline"
          disabled={!hasBaseDir}
          onClick={handleRevealBaseDir}
          className="shrink-0"
        >
          <FolderOpen />
          定位保存目录
        </Button>
      </div>

      {/* 主体 */}
      {!hasBaseDir ? (
        <EmptyState
          icon={<FolderOpen />}
          title="尚未设置保存目录"
          description="请先在「设置」中选择本地保存目录，再开始备份你的收藏。"
        />
      ) : loading ? (
        <GridSkeleton />
      ) : works.length === 0 ? (
        <EmptyState
          icon={<ImageIcon />}
          title={selectedTags.size > 0 ? '所选标签下暂无已下载作品' : '图库还是空的'}
          description={
            selectedTags.size > 0
              ? '换个标签看看，或前往「概览」发起一次同步。'
              : '前往「概览」发起一次同步，把你的 Pixiv 收藏备份到本地。'
          }
        />
      ) : (
        <>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
            {works.map((work, i) => (
              <WorkCard
                key={work.illustId}
                work={work}
                index={i}
                onOpen={handleOpenWork}
                onContextMenu={handleContextMenu}
                onDelete={openDelete}
              />
            ))}
          </div>

          {/* 数量提示 + 加载更多 */}
          <div className="flex flex-col items-center gap-3 pt-1">
            <p className="text-xs text-muted-foreground">
              已显示 {works.length} / {total} 件作品
            </p>
            {canLoadMore && (
              <Button
                variant="outline"
                onClick={handleLoadMore}
                disabled={loadingMore}
                className={cn(loadingMore && 'opacity-70')}
              >
                {loadingMore ? '加载中…' : '加载更多'}
              </Button>
            )}
          </div>
        </>
      )}

      {/* 删除确认 */}
      <Dialog
        open={!!deleteTarget}
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null)
        }}
      >
        <DialogContent>
          <DialogTitle>删除本地文件</DialogTitle>
          <DialogDescription>
            将删除「{deleteTarget?.title}」的本地图片与各标签中的引用，不影响你在 Pixiv 上的收藏。
          </DialogDescription>
          <label className="mt-4 flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
            <span className="text-sm">
              以后同步不再下载此作品
              <span className="mt-0.5 block text-xs text-muted-foreground">
                关闭则仅清理本地，下次同步会重新下载
              </span>
            </span>
            <Switch checked={ignoreOnDelete} onCheckedChange={setIgnoreOnDelete} />
          </label>
          {deleteError ? (
            <p className="mt-3 text-xs text-destructive">删除失败：{deleteError}</p>
          ) : null}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              取消
            </Button>
            <Button variant="destructive" onClick={handleConfirmDelete} disabled={deleting}>
              {deleting ? '删除中…' : '删除'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default Library
