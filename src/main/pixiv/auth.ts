import { BrowserWindow } from 'electron'
import type { AccountStatus, PixivAccount } from '@shared/types'
import { SESSION_PARTITION } from '../config/paths'
import { fetchBookmarkCount } from './bookmarks'
import { pixivClient } from './client'
import { clearSession, getUserId } from './session'

interface UserBody {
  userId: string
  name: string
  image?: string
  imageBig?: string
  premium?: boolean
}

async function fetchAccount(userId: string): Promise<PixivAccount> {
  try {
    const body = await pixivClient.getJson<UserBody>(`/ajax/user/${userId}?full=1`)
    return {
      userId,
      name: body.name || `User ${userId}`,
      account: body.name || userId,
      avatarUrl: body.imageBig || body.image || null,
      isPremium: !!body.premium
    }
  } catch {
    return { userId, name: `User ${userId}`, account: userId, avatarUrl: null, isPremium: false }
  }
}

/** 当前登录态 + 公开/私密收藏计数（计数为尽力而为） */
export async function getAccountStatus(): Promise<AccountStatus> {
  const userId = await getUserId()
  if (!userId) {
    return { loggedIn: false, account: null, publicBookmarkCount: null, privateBookmarkCount: null }
  }
  const account = await fetchAccount(userId)
  let publicBookmarkCount: number | null = null
  let privateBookmarkCount: number | null = null
  try {
    publicBookmarkCount = await fetchBookmarkCount(userId, 'public')
  } catch {
    /* ignore */
  }
  try {
    privateBookmarkCount = await fetchBookmarkCount(userId, 'private')
  } catch {
    /* ignore */
  }
  return { loggedIn: true, account, publicBookmarkCount, privateBookmarkCount }
}

/** 打开登录窗口；检测到 PHPSESSID（登录成功）后关闭并返回账号态 */
export function openLoginWindow(parent?: BrowserWindow): Promise<AccountStatus> {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 480,
      height: 720,
      parent,
      modal: !!parent,
      autoHideMenuBar: true,
      title: '登录 Pixiv',
      webPreferences: { partition: SESSION_PARTITION, sandbox: true, contextIsolation: true }
    })

    let settled = false
    let inFlight = false // 防止多个导航事件并发穿过 await 重复触发账号请求
    const finish = async (): Promise<void> => {
      if (settled || inFlight) return
      inFlight = true
      try {
        const uid = await getUserId()
        if (!uid) return
        settled = true
        if (!win.isDestroyed()) win.close()
        resolve(await getAccountStatus())
      } finally {
        inFlight = false
      }
    }

    win.webContents.on('did-navigate', () => void finish())
    win.webContents.on('did-navigate-in-page', () => void finish())
    win.webContents.on('did-finish-load', () => void finish())
    win.on('closed', () => {
      if (settled) return
      settled = true
      void getAccountStatus().then(resolve)
    })

    void win.loadURL('https://accounts.pixiv.net/login?return_to=https%3A%2F%2Fwww.pixiv.net%2F')
  })
}

/** 退出登录：清空会话 */
export async function logout(): Promise<AccountStatus> {
  await clearSession()
  return { loggedIn: false, account: null, publicBookmarkCount: null, privateBookmarkCount: null }
}
