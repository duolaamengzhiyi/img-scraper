import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

/**
 * 渲染错误兜底：任一页面渲染期抛错时显示降级 UI 而非整窗白屏。
 * 类组件是错误边界的必要例外（无对应 Hook）。
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('页面渲染出错：', error, info.componentStack)
  }

  private handleReset = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-8 text-center">
        <div className="space-y-1">
          <p className="text-base font-semibold text-foreground">页面出错了</p>
          <p className="max-w-md text-sm text-muted-foreground">{error.message}</p>
        </div>
        <button
          type="button"
          onClick={this.handleReset}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          重试
        </button>
      </div>
    )
  }
}
