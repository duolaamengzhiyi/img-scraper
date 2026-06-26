import { useState } from 'react'
import { motion } from 'motion/react'
import {
  LogIn,
  LogOut,
  RefreshCw,
  Play,
  Pause,
  X,
  Loader2,
  Check,
  AlertCircle,
  User
} from 'lucide-react'
import { useStore } from '@/store'
import { invoke } from '@/lib/ipc'
import { formatBytes, formatDate } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'

/** 同步阶段对应的中文文案 */
const SYNC_PHASE_LABEL: Record<string, string> = {
  enumerating: '枚举收藏中',
  downloading: '已加入下载队列',
  paused: '已暂停'
}

/** 统计卡片：小标题 + 大数字，数字轻微淡入 */
const StatCard = ({ label, value }: { label: string; value: string }): React.JSX.Element => {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1.5 p-5">
        <span className="text-xs text-muted-foreground">{label}</span>
        <motion.span
          // 数值入场：从下方轻微淡入，点到为止
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
          className="text-2xl font-semibold tabular-nums tracking-tight"
        >
          {value}
        </motion.span>
      </CardContent>
    </Card>
  )
}

const Dashboard = (): React.JSX.Element => {
  const account = useStore((s) => s.account)
  const settings = useStore((s) => s.settings)
  const stats = useStore((s) => s.stats)
  const sync = useStore((s) => s.sync)
  const ready = useStore((s) => s.ready)
  const busy = useStore((s) => s.busy)
  const login = useStore((s) => s.login)
  const logout = useStore((s) => s.logout)

  // 同步控制按钮的瞬时禁用，避免连点导致重复 IPC
  const [syncing, setSyncing] = useState(false)

  // 数字格式化：null/undefined 显示占位符
  const fmt = (n: number | null | undefined): string =>
    n == null ? '—' : n.toLocaleString('zh-CN')

  const loggedIn = account?.loggedIn ?? false
  const hasBaseDir = Boolean(settings?.baseDir)

  // 进行中的同步阶段
  const activePhase =
    sync &&
    (sync.phase === 'enumerating' || sync.phase === 'downloading' || sync.phase === 'paused')
      ? sync.phase
      : null
  const isPaused = sync?.phase === 'paused'

  const handleStartSync = async (): Promise<void> => {
    setSyncing(true)
    try {
      await invoke('sync:start', {
        target: 'all',
        visibility: 'both',
        mode: 'quick'
      })
    } finally {
      setSyncing(false)
    }
  }

  const handleTogglePause = async (): Promise<void> => {
    await invoke(isPaused ? 'sync:resume' : 'sync:pause')
  }

  const handleStopSync = async (): Promise<void> => {
    await invoke('sync:stop')
  }

  // 一键同步的禁用原因
  const syncDisabledReason = !loggedIn
    ? '请先登录 Pixiv'
    : !hasBaseDir
      ? '请先到「设置」页指定本地保存目录'
      : null

  // 初始化未完成：骨架占位
  if (!ready) {
    return (
      <div className="flex flex-col gap-6 py-6">
        <Skeleton className="h-20 w-full rounded-xl" />
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6 py-6">
      {/* 1) 账号卡片 */}
      <Card>
        <CardContent className="flex items-center gap-4 p-5">
          {loggedIn && account?.account ? (
            <>
              <Avatar src={account.account.avatarUrl} name={account.account.name} />
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-base font-semibold">{account.account.name}</span>
                  {account.account.isPremium && <Badge variant="warning">Premium</Badge>}
                </div>
                <span className="truncate text-xs text-muted-foreground">
                  @{account.account.account}
                </span>
              </div>
              <Button variant="ghost" size="sm" className="ml-auto" onClick={() => void logout()}>
                <LogOut />
                退出
              </Button>
            </>
          ) : (
            <>
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-accent text-muted-foreground">
                <User className="h-6 w-6" />
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-base font-semibold">尚未登录</span>
                <span className="text-xs text-muted-foreground">
                  登录后即可同步并备份你的 Pixiv 收藏
                </span>
              </div>
              <Button className="ml-auto" disabled={busy} onClick={() => void login()}>
                {busy ? <Loader2 className="animate-spin" /> : <LogIn />}
                {busy ? '登录中…' : '登录 Pixiv'}
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {/* 2) 统计卡片网格 */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-5">
        <StatCard label="公开收藏" value={fmt(account?.publicBookmarkCount)} />
        <StatCard label="私密收藏" value={fmt(account?.privateBookmarkCount)} />
        <StatCard
          label="已下载页"
          value={stats ? `${fmt(stats.downloadedPages)} / ${fmt(stats.totalPages)}` : '—'}
        />
        <StatCard label="占用空间" value={stats ? formatBytes(stats.totalBytes) : '—'} />
        <StatCard label="标签数" value={fmt(stats?.tagCount)} />
      </div>

      {/* 3) 同步控制区 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">同步收藏</CardTitle>
          <CardDescription>
            将你在 Pixiv 上的全部收藏增量备份到本地，并按书签标签归类。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {/* 一键同步按钮 + 禁用提示 */}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              size="lg"
              disabled={!!syncDisabledReason || !!activePhase || syncing}
              onClick={() => void handleStartSync()}
            >
              {syncing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              一键同步全部
            </Button>
            {syncDisabledReason && (
              <span className="text-sm text-muted-foreground">{syncDisabledReason}</span>
            )}
            {!syncDisabledReason && activePhase && (
              <span className="text-sm text-muted-foreground">同步进行中…</span>
            )}
          </div>

          {/* 进行中的同步进度区 */}
          {activePhase && sync && (
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25 }}
              className="flex flex-col gap-4 rounded-lg border border-border bg-background/40 p-4"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  {activePhase === 'paused' ? (
                    <Pause className="h-4 w-4 text-warning" />
                  ) : (
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  )}
                  <span className="text-sm font-medium">{SYNC_PHASE_LABEL[activePhase]}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => void handleTogglePause()}>
                    {isPaused ? <Play /> : <Pause />}
                    {isPaused ? '继续' : '暂停'}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => void handleStopSync()}>
                    <X />
                    停止
                  </Button>
                </div>
              </div>

              {sync.currentLabel && (
                <p className="truncate text-xs text-muted-foreground">{sync.currentLabel}</p>
              )}

              {/* 标签进度条（若有总数） */}
              {sync.tagsTotal > 0 && (
                <Progress value={Math.min(100, (sync.tagsDone / sync.tagsTotal) * 100)} />
              )}

              {/* 计数指标 */}
              <div className="grid grid-cols-3 gap-3 text-center">
                <Metric label="已发现作品" value={sync.worksDiscovered.toLocaleString('zh-CN')} />
                <Metric
                  label="已处理标签"
                  value={`${sync.tagsDone.toLocaleString('zh-CN')} / ${sync.tagsTotal.toLocaleString('zh-CN')}`}
                />
                <Metric label="已入队" value={sync.pagesTotal.toLocaleString('zh-CN')} />
              </div>
            </motion.div>
          )}

          {/* 完成 / 出错提示 */}
          {sync?.phase === 'done' && sync.message && (
            <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/15 px-3 py-2 text-sm text-success">
              <Check className="h-4 w-4 shrink-0" />
              <span>{sync.message}</span>
            </div>
          )}
          {sync?.phase === 'error' && sync.message && (
            <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/15 px-3 py-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{sync.message}</span>
            </div>
          )}

          {/* 上次同步时间 */}
          <p className="text-xs text-muted-foreground">
            上次同步：{formatDate(stats?.lastSyncedAt ?? null)}
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

/** 同步进度区的单个计数指标 */
const Metric = ({ label, value }: { label: string; value: string }): React.JSX.Element => {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-lg font-semibold tabular-nums">{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  )
}

/** 头像：圆形，加载失败时回退到首字母占位 */
const Avatar = ({ src, name }: { src: string | null; name: string }): React.JSX.Element => {
  const [failed, setFailed] = useState(false)
  const showImg = src && !failed

  return (
    <div
      className={cn(
        'flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent'
      )}
    >
      {showImg ? (
        <img
          src={src}
          alt={name}
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="text-base font-semibold text-muted-foreground">
          {name.slice(0, 1).toUpperCase()}
        </span>
      )}
    </div>
  )
}

export default Dashboard
