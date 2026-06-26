import { useEffect, useState } from 'react'
import {
  Download,
  EyeOff,
  Images,
  LayoutDashboard,
  Settings as SettingsIcon,
  Tags as TagsIcon
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useStore } from '@/store'
import { useIpcEvents } from '@/hooks/useIpcEvents'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { TooltipProvider } from '@/components/ui/tooltip'
import Dashboard from '@/pages/Dashboard'
import Tags from '@/pages/Tags'
import Downloads from '@/pages/Downloads'
import Library from '@/pages/Library'
import Ignored from '@/pages/Ignored'
import Settings from '@/pages/Settings'

type PageKey = 'dashboard' | 'tags' | 'downloads' | 'library' | 'ignored' | 'settings'

const NAV: { key: PageKey; label: string; icon: typeof LayoutDashboard }[] = [
  { key: 'dashboard', label: '概览', icon: LayoutDashboard },
  { key: 'tags', label: '标签', icon: TagsIcon },
  { key: 'downloads', label: '下载', icon: Download },
  { key: 'library', label: '图库', icon: Images },
  { key: 'ignored', label: '已忽略', icon: EyeOff },
  { key: 'settings', label: '设置', icon: SettingsIcon }
]

const PAGES: Record<PageKey, () => React.JSX.Element> = {
  dashboard: Dashboard,
  tags: Tags,
  downloads: Downloads,
  library: Library,
  ignored: Ignored,
  settings: Settings
}

/** 主题：跟随系统或按用户设置强制深/浅；并镜像到 localStorage 供下次启动同步应用 */
function useTheme(): void {
  // undefined 表示设置尚未经 IPC 加载完成
  const theme = useStore((s) => s.settings?.theme)
  useEffect(() => {
    // 未加载完成时不动：保留 theme-init.js 在首帧前按 localStorage 应用的主题，避免闪烁/被 system 覆盖
    if (!theme) return
    localStorage.setItem('app-theme', theme)
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => {
      const dark = theme === 'dark' || (theme === 'system' && mq.matches)
      document.documentElement.classList.toggle('dark', dark)
    }
    apply()
    if (theme === 'system') {
      mq.addEventListener('change', apply)
      return () => mq.removeEventListener('change', apply)
    }
    return undefined
  }, [theme])
}

function App(): React.JSX.Element {
  const init = useStore((s) => s.init)
  // 仅订阅派生出的数字（基本类型按值比较）：下载事件高频更新 downloads 数组时，
  // 角标数不变就不会重渲染整个 App 外壳。
  const activeDownloads = useStore((s) =>
    s.downloads.reduce(
      (n, d) => (d.status === 'downloading' || d.status === 'queued' ? n + 1 : n),
      0
    )
  )
  useIpcEvents()
  useTheme()
  const [page, setPage] = useState<PageKey>('dashboard')

  useEffect(() => {
    void init()
  }, [init])

  const ActivePage = PAGES[page]

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full w-full overflow-hidden bg-background text-foreground">
        <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-sidebar">
          <div
            className="flex h-14 items-center px-5"
            style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
          >
            <div className="ml-12 flex items-center gap-2">
              <div className="h-2.5 w-2.5 rounded-full bg-primary" />
              <span className="text-sm font-semibold tracking-tight">Pixiv Archiver</span>
            </div>
          </div>
          <nav className="flex flex-1 flex-col gap-1 px-3 py-2">
            {NAV.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                onClick={() => setPage(key)}
                className={cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                  page === key
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
                )}
              >
                <Icon className="h-4 w-4" />
                <span className="flex-1 text-left">{label}</span>
                {key === 'downloads' && activeDownloads > 0 && (
                  <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground">
                    {activeDownloads}
                  </span>
                )}
              </button>
            ))}
          </nav>
          <div className="px-5 py-4 text-xs text-muted-foreground">v0.1.0 · 本地归档</div>
        </aside>

        <main className="flex flex-1 flex-col overflow-hidden">
          <div
            className="flex h-14 shrink-0 items-center px-8"
            style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
          >
            <h1 className="text-base font-semibold">{NAV.find((n) => n.key === page)?.label}</h1>
          </div>
          <div className="flex-1 overflow-auto px-8 pb-8">
            {/* key=page：切页即重置错误边界，单页崩溃不影响其它页 */}
            <ErrorBoundary key={page}>
              <ActivePage />
            </ErrorBoundary>
          </div>
        </main>
      </div>
    </TooltipProvider>
  )
}

export default App
