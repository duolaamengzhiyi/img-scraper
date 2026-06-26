/** 渲染层可见的 window.bridge 类型（结构化声明，不引入 preload 实现，避免跨 program 类型检查耦合） */
declare global {
  interface Window {
    bridge: {
      invoke(channel: string, ...args: unknown[]): Promise<unknown>
      on(channel: string, listener: (payload: unknown) => void): () => void
    }
  }
}

export {}
