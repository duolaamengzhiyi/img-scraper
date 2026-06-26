import { useState } from 'react'
import { motion } from 'motion/react'
import {
  FolderOpen,
  RotateCcw,
  HardDrive,
  Download,
  Palette,
  Gauge,
  Check,
  X,
  Info,
  ExternalLink
} from 'lucide-react'
import type {
  LinkStrategy,
  R18Mode,
  Settings as SettingsType,
  ThemePref,
  UgoiraMode
} from '@shared/types'
import { useStore } from '@/store'
import { invoke } from '@/lib/ipc'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'

/** 应用路径 → 展示名（去目录与 .app/.exe 后缀） */
function appName(p: string): string {
  return (p.split(/[\\/]/).pop() ?? p).replace(/\.(app|exe)$/i, '')
}

/** 单个设置行：左侧标题 + 说明，右侧控件。控件区固定不收缩，保证不同行对齐 */
function SettingRow({
  htmlFor,
  title,
  description,
  control
}: {
  htmlFor?: string
  title: string
  description?: string
  control: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-6 py-4">
      <div className="min-w-0 space-y-1">
        <Label htmlFor={htmlFor} className="block">
          {title}
        </Label>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{control}</div>
    </div>
  )
}

/** 分组卡片：图标 + 标题 + 若干设置行（行间用 Separator 分隔） */
function SettingGroup({
  icon: Icon,
  title,
  children
}: {
  icon: typeof HardDrive
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-muted-foreground" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="divide-y divide-border [&>*:first-child]:pt-0 [&>*:last-child]:pb-0">
          {children}
        </div>
      </CardContent>
    </Card>
  )
}

/** 加载占位：模拟分组卡片骨架 */
function SettingsSkeleton(): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 py-6">
      {[0, 1, 2, 3].map((i) => (
        <Card key={i}>
          <CardHeader>
            <Skeleton className="h-5 w-24" />
          </CardHeader>
          <CardContent className="space-y-4">
            {[0, 1].map((j) => (
              <div key={j} className="flex items-center justify-between gap-6">
                <div className="space-y-2">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3 w-48" />
                </div>
                <Skeleton className="h-9 w-40" />
              </div>
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

/** 限速区数字输入：本地保持字符串态以允许中途清空，失焦/确认时夹紧到合法范围再保存 */
function NumberField({
  id,
  value,
  min,
  max,
  onCommit
}: {
  id: string
  value: number
  min: number
  max: number
  onCommit: (next: number) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<string>(String(value))

  const commit = (): void => {
    const parsed = Number(draft)
    if (!Number.isFinite(parsed)) {
      setDraft(String(value))
      return
    }
    const clamped = Math.min(max, Math.max(min, Math.round(parsed)))
    setDraft(String(clamped))
    if (clamped !== value) onCommit(clamped)
  }

  return (
    <Input
      id={id}
      type="number"
      min={min}
      max={max}
      className="w-28 text-right"
      value={draft}
      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
    />
  )
}

export default function Settings(): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const saveSettings = useStore((s) => s.saveSettings)
  const refreshStats = useStore((s) => s.refreshStats)

  // 目录变更状态：迁移进行中 + 结果文案
  const [dirBusy, setDirBusy] = useState(false)
  const [dirMessage, setDirMessage] = useState<string | null>(null)
  const [dirError, setDirError] = useState(false)
  // 修复链接状态
  const [repairBusy, setRepairBusy] = useState(false)
  const [repairMessage, setRepairMessage] = useState<string | null>(null)
  const [repairError, setRepairError] = useState(false)
  // 校验本地库状态
  const [verifyBusy, setVerifyBusy] = useState(false)
  const [verifyMessage, setVerifyMessage] = useState<string | null>(null)
  const [missingCount, setMissingCount] = useState(0)
  const [actionBusy, setActionBusy] = useState(false)

  if (!settings) return <SettingsSkeleton />

  /** 即时保存单项变更 */
  const update = <K extends keyof SettingsType>(key: K, value: SettingsType[K]): void => {
    void saveSettings({ [key]: value } as Partial<SettingsType>)
  }

  /** 选择/更改保存目录；已有目录时走迁移流程，迁移成功后重新拉取全局状态 */
  const handlePickBaseDir = async (): Promise<void> => {
    setDirMessage(null)
    const dir = await invoke('settings:pickBaseDir')
    if (!dir) return

    const current = settings.baseDir
    if (current && dir !== current) {
      // 已有库 → 迁移到新目录；无论成败都在 finally 用 init() 重新同步真实状态
      setDirBusy(true)
      setDirError(false)
      try {
        const result = await invoke('migrate:moveLibrary', dir)
        setDirMessage(result.message)
        setDirError(result.failed > 0)
      } catch (e) {
        setDirError(true)
        setDirMessage(`迁移失败：${e instanceof Error ? e.message : String(e)}`)
      } finally {
        await useStore.getState().init()
        setDirBusy(false)
      }
    } else if (!current) {
      // 首次设置目录
      await saveSettings({ baseDir: dir })
    }
  }

  /** 选择「默认打开应用」 */
  const handlePickOpenApp = async (): Promise<void> => {
    const app = await invoke('settings:pickOpenApp')
    if (app) await saveSettings({ openWithApp: app })
  }

  /** 修复失效的关联链接 */
  const handleRepairLinks = async (): Promise<void> => {
    setRepairBusy(true)
    setRepairMessage(null)
    setRepairError(false)
    try {
      const result = await invoke('migrate:repairLinks')
      setRepairMessage(result.message)
      setRepairError(result.failed > 0)
    } catch (e) {
      setRepairError(true)
      setRepairMessage(`修复失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setRepairBusy(false)
    }
  }

  /** 校验本地库：扫描磁盘，把被手动删除的文件标为待补并修正统计 */
  const handleVerify = async (): Promise<void> => {
    setVerifyBusy(true)
    try {
      const result = await invoke('library:verify')
      setVerifyMessage(result.message)
      setMissingCount(result.missing)
      await refreshStats()
    } catch (e) {
      setVerifyMessage(`校验失败：${e instanceof Error ? e.message : String(e)}`)
      setMissingCount(0)
    } finally {
      setVerifyBusy(false)
    }
  }

  /** 补下缺失：把待补页重新加入下载队列 */
  const handleRestoreMissing = async (): Promise<void> => {
    setActionBusy(true)
    try {
      const n = await invoke('library:restoreMissing')
      setVerifyMessage(`已将 ${n} 张加入下载队列，去「下载」页查看进度`)
      setMissingCount(0)
      await refreshStats()
    } finally {
      setActionBusy(false)
    }
  }

  /** 全部忽略：缺失页标为 ignored，后续同步不再下载 */
  const handleIgnoreMissing = async (): Promise<void> => {
    setActionBusy(true)
    try {
      const n = await invoke('library:ignoreMissing')
      setVerifyMessage(`已忽略 ${n} 张，后续同步不再下载`)
      setMissingCount(0)
      await refreshStats()
    } finally {
      setActionBusy(false)
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: 'easeOut' }}
      className="mx-auto w-full max-w-2xl space-y-6 py-6"
    >
      {/* 1) 存储 */}
      <SettingGroup icon={HardDrive} title="存储">
        <SettingRow
          title="保存目录"
          description={settings.baseDir ?? '未设置'}
          control={
            <Button variant="outline" onClick={handlePickBaseDir} disabled={dirBusy}>
              <FolderOpen />
              {settings.baseDir ? '更改…' : '选择…'}
            </Button>
          }
        />
        {dirBusy || dirMessage ? (
          <div className="-mt-1 pb-4 pt-0">
            <p
              className={cn(
                'text-xs',
                dirBusy ? 'text-muted-foreground' : dirError ? 'text-destructive' : 'text-success'
              )}
            >
              {dirBusy ? '正在迁移图库到新目录…' : dirMessage}
            </p>
          </div>
        ) : null}

        <SettingRow
          htmlFor="linkStrategy"
          title="关联方式"
          description="按标签归类时如何在标签文件夹内引用原文件"
          control={
            <Select
              value={settings.linkStrategy}
              onValueChange={(v: string) => update('linkStrategy', v as LinkStrategy)}
            >
              <SelectTrigger id="linkStrategy" className="w-52">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">自动（同卷硬链接，跨卷降级）</SelectItem>
                <SelectItem value="hardlink">硬链接</SelectItem>
                <SelectItem value="symlink">符号链接</SelectItem>
                <SelectItem value="shortcut">系统快捷方式</SelectItem>
              </SelectContent>
            </Select>
          }
        />

        <SettingRow
          title="多页作品独立子文件夹"
          description="将多页作品的各页归入以作品命名的子目录"
          control={
            <Switch
              checked={settings.multiPageSubfolder}
              onCheckedChange={(checked: boolean) => update('multiPageSubfolder', checked)}
            />
          }
        />

        <SettingRow
          title="修复链接"
          description="重建失效或丢失的标签关联链接"
          control={
            <Button variant="outline" onClick={handleRepairLinks} disabled={repairBusy}>
              <RotateCcw />
              {repairBusy ? '修复中…' : '修复链接'}
            </Button>
          }
        />
        {repairMessage ? (
          <div className="-mt-1 pb-4 pt-0">
            <p
              className={cn(
                'flex items-center gap-1.5 text-xs',
                repairError ? 'text-destructive' : 'text-success'
              )}
            >
              {repairError ? <X className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
              {repairMessage}
            </p>
          </div>
        ) : null}

        <SettingRow
          title="校验本地库"
          description="扫描磁盘，找出被手动删除的文件并修正记忆与统计"
          control={
            <Button variant="outline" onClick={handleVerify} disabled={verifyBusy}>
              <RotateCcw />
              {verifyBusy ? '校验中…' : '校验'}
            </Button>
          }
        />
        {verifyMessage ? (
          <div className="-mt-1 flex flex-col gap-2 pb-4 pt-0">
            <p className={cn('text-xs', missingCount > 0 ? 'text-warning' : 'text-success')}>
              {verifyMessage}
            </p>
            {missingCount > 0 ? (
              <div className="flex gap-2">
                <Button size="sm" onClick={handleRestoreMissing} disabled={actionBusy}>
                  <Download />
                  补下缺失（{missingCount}）
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleIgnoreMissing}
                  disabled={actionBusy}
                >
                  <X />
                  全部忽略
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </SettingGroup>

      {/* 2) 抓取 */}
      <SettingGroup icon={Download} title="抓取">
        <SettingRow
          title="包含私密收藏"
          description="同时备份你设为「非公開」的收藏"
          control={
            <Switch
              checked={settings.includePrivate}
              onCheckedChange={(checked: boolean) => update('includePrivate', checked)}
            />
          }
        />

        <SettingRow
          htmlFor="r18"
          title="R-18 内容"
          description="是否抓取限制级作品"
          control={
            <Select value={settings.r18} onValueChange={(v: string) => update('r18', v as R18Mode)}>
              <SelectTrigger id="r18" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="include">包含</SelectItem>
                <SelectItem value="exclude">排除</SelectItem>
              </SelectContent>
            </Select>
          }
        />

        <SettingRow
          htmlFor="ugoira"
          title="动图（Ugoira）"
          description="动图作品的保存格式"
          control={
            <Select
              value={settings.ugoira}
              onValueChange={(v: string) => update('ugoira', v as UgoiraMode)}
            >
              <SelectTrigger id="ugoira" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="mp4">MP4</SelectItem>
                <SelectItem value="gif">GIF</SelectItem>
                <SelectItem value="mp4+gif">MP4 + GIF</SelectItem>
                <SelectItem value="zip">仅存 ZIP</SelectItem>
                <SelectItem value="skip">跳过</SelectItem>
              </SelectContent>
            </Select>
          }
        />

        <div className="py-4">
          <Label htmlFor="filenameTemplate" className="block">
            文件名模板
          </Label>
          <p className="mt-1 text-xs text-muted-foreground">
            占位符：{'{title}'} {'{author}'} {'{id}'} {'{page}'}
          </p>
          <Input
            id="filenameTemplate"
            className="mt-3 font-mono text-xs"
            value={settings.filenameTemplate}
            placeholder="{title}-{author}-p{page}"
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              update('filenameTemplate', e.target.value)
            }
          />
          <p className="mt-2 text-xs text-muted-foreground">
            例如：
            <span className="font-mono">{'{title}-{author}-p{page}'}</span>
          </p>
        </div>
      </SettingGroup>

      {/* 3) 限速（反限流） */}
      <SettingGroup icon={Gauge} title="限速（反限流）">
        <SettingRow
          htmlFor="concurrency"
          title="并发数"
          description="同时下载的图片数量（1~8）"
          control={
            <NumberField
              id="concurrency"
              value={settings.concurrency}
              min={1}
              max={8}
              onCommit={(n) => update('concurrency', n)}
            />
          }
        />

        <SettingRow
          htmlFor="minDelayMs"
          title="最小请求间隔"
          description="两次请求之间的随机抖动下限（毫秒）"
          control={
            <NumberField
              id="minDelayMs"
              value={settings.minDelayMs}
              min={0}
              max={60000}
              onCommit={(n) => update('minDelayMs', n)}
            />
          }
        />

        <SettingRow
          htmlFor="maxDelayMs"
          title="最大请求间隔"
          description="两次请求之间的随机抖动上限（毫秒）"
          control={
            <NumberField
              id="maxDelayMs"
              value={settings.maxDelayMs}
              min={0}
              max={60000}
              onCommit={(n) => update('maxDelayMs', n)}
            />
          }
        />

        <div className="flex items-center gap-1.5 py-4 text-xs text-muted-foreground">
          <Info className="h-3.5 w-3.5 shrink-0" />
          每次请求在最小与最大间隔之间随机取值，降低被限流风险。
        </div>
      </SettingGroup>

      {/* 4) 外观 */}
      <SettingGroup icon={Palette} title="外观">
        <SettingRow
          htmlFor="theme"
          title="主题"
          description="跟随系统时随系统深浅色自动切换"
          control={
            <Select
              value={settings.theme}
              onValueChange={(v: string) => {
                // TODO: dark/light 当前仅持久化，实时切换由全局 matchMedia 处理 system 模式
                update('theme', v as ThemePref)
              }}
            >
              <SelectTrigger id="theme" className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="system">跟随系统</SelectItem>
                <SelectItem value="dark">深色</SelectItem>
                <SelectItem value="light">浅色</SelectItem>
              </SelectContent>
            </Select>
          }
        />
      </SettingGroup>

      {/* 打开方式 */}
      <SettingGroup icon={ExternalLink} title="打开方式">
        <SettingRow
          title="默认打开应用"
          description="在「图库」点击作品时用它打开；未设置则用系统默认。多页作品会把整组传给应用以便翻页。"
          control={
            <div className="flex items-center gap-2">
              {settings.openWithApp && (
                <Button variant="ghost" size="sm" onClick={() => update('openWithApp', null)}>
                  清除
                </Button>
              )}
              <Button variant="outline" onClick={handlePickOpenApp}>
                {settings.openWithApp ? appName(settings.openWithApp) : '选择应用…'}
              </Button>
            </div>
          }
        />
      </SettingGroup>
    </motion.div>
  )
}
