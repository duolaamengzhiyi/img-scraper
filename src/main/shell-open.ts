import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { shell } from 'electron'
import { getSettings } from './config/store'

/**
 * 用「设定的应用」打开作品（paths 已按页序排列，paths[0] 为首页）。
 * 只打开首页一张：看图软件（如 Pixea）默认「一个文件一个窗口」，传整组会弹出 N 个窗口；
 * 而打开单张后，主流看图器可用方向键在同一文件夹内翻到同系列的其它页
 * （配合「多页独立子文件夹」体验最佳）。
 */
export function openWithConfiguredApp(paths: string[]): void {
  // 仅接受绝对路径：库内文件均为基于 baseDir 的绝对路径，绝不会以 '-' 开头，
  // 从而杜绝把文件名当作目标程序的命令行选项（argument injection）。
  const first = paths.find((p) => p && isAbsolute(p) && existsSync(p))
  if (!first) return

  const app = getSettings().openWithApp
  if (!app) {
    void shell.openPath(first)
    return
  }

  try {
    if (process.platform === 'darwin') {
      spawn('open', ['-a', app, first], { detached: true, stdio: 'ignore' }).unref()
    } else {
      // Windows / Linux：直接以该可执行文件打开首页
      spawn(app, [first], { detached: true, stdio: 'ignore' }).unref()
    }
  } catch {
    void shell.openPath(first)
  }
}
