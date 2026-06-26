import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { EVENT_CHANNELS, type IpcEventChannel } from '@shared/ipc'

/**
 * 通用、类型在渲染层施加（见 renderer/src/lib/ipc.ts）的桥。
 *  - invoke：请求/响应
 *  - on：    订阅主进程推送事件，返回取消订阅函数
 */
const bridge = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    return ipcRenderer.invoke(channel, ...args)
  },
  on(channel: string, listener: (payload: unknown) => void): () => void {
    if (!EVENT_CHANNELS.includes(channel as IpcEventChannel)) {
      throw new Error(`拒绝订阅未知事件通道: ${channel}`)
    }
    const handler = (_e: IpcRendererEvent, payload: unknown): void => listener(payload)
    ipcRenderer.on(channel, handler)
    return () => {
      ipcRenderer.removeListener(channel, handler)
    }
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('bridge', bridge)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-expect-error 非隔离环境回退
  window.bridge = bridge
}

export type Bridge = typeof bridge
