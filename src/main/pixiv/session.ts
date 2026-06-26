import { session, type Session } from 'electron'
import { SESSION_PARTITION } from '../config/paths'

/** 登录与所有 Pixiv 请求共用的持久化会话（cookie 由 Electron 持久化并经 OS keychain 加密） */
export function pixivSession(): Session {
  return session.fromPartition(SESSION_PARTITION)
}

/** 拼出 Cookie 头（备用；net + useSessionCookies 通常已自动携带） */
export async function getCookieHeader(): Promise<string> {
  const cookies = await pixivSession().cookies.get({ domain: '.pixiv.net' })
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ')
}

/** 从 PHPSESSID（格式 `{userId}_{随机串}`）解析登录用户 ID */
export async function getUserId(): Promise<string | null> {
  const cookies = await pixivSession().cookies.get({ name: 'PHPSESSID' })
  for (const c of cookies) {
    const m = /^(\d+)_/.exec(c.value)
    if (m) return m[1]
  }
  return null
}

export async function isLoggedIn(): Promise<boolean> {
  return (await getUserId()) !== null
}

/** 退出登录：清空会话存储（cookie 等） */
export async function clearSession(): Promise<void> {
  await pixivSession().clearStorageData()
}
