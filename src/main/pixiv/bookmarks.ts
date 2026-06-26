import { pixivClient } from './client'
import type { BookmarkTag, BookmarkVisibility, WorkSummary, WorkType } from '@shared/types'

// ---------------------------------------------------------------------------
// 书签 tag 列表（字段名容错：tag|name、cnt|count）
// ---------------------------------------------------------------------------
interface RawTag {
  tag?: string
  name?: string
  cnt?: number | string
  count?: number | string
}
interface BookmarkTagsBody {
  public?: RawTag[]
  private?: RawTag[]
}

function parseTags(arr: RawTag[] | undefined, visibility: BookmarkVisibility): BookmarkTag[] {
  if (!Array.isArray(arr)) return []
  return arr
    .map((t) => ({
      name: String(t.tag ?? t.name ?? ''),
      visibility,
      count: Number(t.cnt ?? t.count ?? 0) || 0
    }))
    .filter((t) => t.name.length > 0)
}

/** 取用户全部书签 tag（公开 + 私密一并返回） */
export async function fetchBookmarkTags(
  userId: string,
  signal?: AbortSignal
): Promise<{ public: BookmarkTag[]; private: BookmarkTag[] }> {
  const body = await pixivClient.getJson<BookmarkTagsBody>(
    `/ajax/user/${userId}/illusts/bookmark/tags?lang=ja`,
    signal
  )
  return {
    public: parseTags(body.public, 'public'),
    private: parseTags(body.private, 'private')
  }
}

// ---------------------------------------------------------------------------
// 收藏分页
// ---------------------------------------------------------------------------
interface BookmarkWork {
  id: string | number
  title: string
  illustType: number
  xRestrict: number
  pageCount: number
  url: string | null
  userId: string
  userName: string
  createDate: string | null
  isMasked?: boolean
  bookmarkData?: { id: string; private: boolean } | null
}
interface BookmarksBody {
  works: BookmarkWork[]
  total: number
}

function illustTypeToWorkType(t: number): WorkType {
  return t === 2 ? 'ugoira' : t === 1 ? 'manga' : 'illust'
}

function toSummary(w: BookmarkWork, visibility: BookmarkVisibility): WorkSummary | null {
  const id = String(w.id)
  if (!id || id === 'undefined' || w.isMasked) return null
  return {
    illustId: id,
    title: w.title || '',
    authorId: w.userId || '',
    authorName: w.userName || '',
    type: illustTypeToWorkType(w.illustType),
    pageCount: w.pageCount || 1,
    thumbUrl: w.url || null,
    isR18: (w.xRestrict || 0) >= 1,
    isMasked: !!w.isMasked,
    createDate: w.createDate || null,
    visibility
  }
}

/** 遍历某 tag（''=全部）某可见性下的所有收藏作品摘要 */
export async function* iterateBookmarks(
  userId: string,
  params: { tag: string; visibility: BookmarkVisibility; signal?: AbortSignal }
): AsyncGenerator<WorkSummary> {
  const rest = params.visibility === 'public' ? 'show' : 'hide'
  const limit = 48
  let offset = 0
  for (;;) {
    const url = `/ajax/user/${userId}/illusts/bookmarks?tag=${encodeURIComponent(
      params.tag
    )}&offset=${offset}&limit=${limit}&rest=${rest}`
    const body = await pixivClient.getJson<BookmarksBody>(url, params.signal)
    const works = body.works ?? []
    for (const w of works) {
      const s = toSummary(w, params.visibility)
      if (s) yield s
    }
    offset += limit
    if (works.length === 0 || offset >= (body.total || 0)) break
  }
}

/** 取某可见性总收藏数（limit=1 的 body.total） */
export async function fetchBookmarkCount(
  userId: string,
  visibility: BookmarkVisibility,
  signal?: AbortSignal
): Promise<number> {
  const rest = visibility === 'public' ? 'show' : 'hide'
  const body = await pixivClient.getJson<BookmarksBody>(
    `/ajax/user/${userId}/illusts/bookmarks?tag=&offset=0&limit=1&rest=${rest}`,
    signal
  )
  return body.total || 0
}
