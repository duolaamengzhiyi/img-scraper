import type { IpcEventMap, IpcInvokeMap } from '@shared/ipc'

interface Bridge {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, listener: (payload: unknown) => void): () => void
}

const bridge = (window as unknown as { bridge?: Bridge }).bridge

function requireBridge(): Bridge {
  if (!bridge) {
    throw new Error('preload bridge 未注入：请检查 preload 脚本与 contextIsolation 配置')
  }
  return bridge
}

/** 类型化的 IPC 请求/响应 */
export function invoke<K extends keyof IpcInvokeMap>(
  channel: K,
  ...args: IpcInvokeMap[K]['args']
): Promise<IpcInvokeMap[K]['result']> {
  return requireBridge().invoke(channel, ...args) as Promise<IpcInvokeMap[K]['result']>
}

/** 订阅主进程推送事件，返回取消订阅函数 */
export function onEvent<K extends keyof IpcEventMap>(
  channel: K,
  listener: (payload: IpcEventMap[K]) => void
): () => void {
  return requireBridge().on(channel, listener as (payload: unknown) => void)
}
