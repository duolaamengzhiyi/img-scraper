/**
 * SQLite schema（本地「记忆库」）。db.ts 在打开连接后执行 SCHEMA_SQL，
 * 并设置 PRAGMA journal_mode=WAL、foreign_keys=ON。
 */
export const SCHEMA_VERSION = 1

export const SCHEMA_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- 作品
CREATE TABLE IF NOT EXISTS works (
  illust_id   TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',
  author_id   TEXT NOT NULL DEFAULT '',
  author_name TEXT NOT NULL DEFAULT '',
  type        TEXT NOT NULL DEFAULT 'illust',
  page_count  INTEGER NOT NULL DEFAULT 1,
  is_r18      INTEGER NOT NULL DEFAULT 0,
  create_date TEXT,
  thumb_url   TEXT,
  raw_json    TEXT,
  first_seen  INTEGER NOT NULL,
  last_synced INTEGER NOT NULL
);

-- 单页（去重与下载状态的核心）
CREATE TABLE IF NOT EXISTS pages (
  illust_id      TEXT NOT NULL,
  page_index     INTEGER NOT NULL,
  pixiv_filename TEXT NOT NULL DEFAULT '',
  original_url   TEXT,
  ext            TEXT NOT NULL DEFAULT '',
  file_name      TEXT,
  library_path   TEXT,
  bytes          INTEGER,
  sha256         TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',
  downloaded_at  INTEGER,
  PRIMARY KEY (illust_id, page_index),
  FOREIGN KEY (illust_id) REFERENCES works(illust_id) ON DELETE CASCADE
);

-- 用户书签 tag（公开 / 私密各一行）
CREATE TABLE IF NOT EXISTS bookmark_tags (
  name       TEXT NOT NULL,
  visibility TEXT NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  last_seen  INTEGER NOT NULL,
  PRIMARY KEY (name, visibility)
);

-- 作品 ↔ 用户书签 tag（多对多）
CREATE TABLE IF NOT EXISTS work_tags (
  illust_id  TEXT NOT NULL,
  tag_name   TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'public',
  PRIMARY KEY (illust_id, tag_name),
  FOREIGN KEY (illust_id) REFERENCES works(illust_id) ON DELETE CASCADE
);

-- 每个 tag 文件夹里的硬链接登记（迁移/修复依据）
CREATE TABLE IF NOT EXISTS tag_links (
  illust_id  TEXT NOT NULL,
  page_index INTEGER NOT NULL,
  tag_name   TEXT NOT NULL,
  link_path  TEXT NOT NULL,
  link_type  TEXT NOT NULL DEFAULT 'hardlink',
  status     TEXT NOT NULL DEFAULT 'pending',
  PRIMARY KEY (illust_id, page_index, tag_name),
  FOREIGN KEY (illust_id) REFERENCES works(illust_id) ON DELETE CASCADE
);

-- 下载队列（持久化，支持重启续传）
CREATE TABLE IF NOT EXISTS download_queue (
  id          TEXT PRIMARY KEY,
  illust_id   TEXT NOT NULL,
  page_index  INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'queued',
  enqueued_at INTEGER NOT NULL,
  error       TEXT
);

-- 同步运行记录
CREATE TABLE IF NOT EXISTS sync_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  scope       TEXT,
  stats_json  TEXT
);

CREATE INDEX IF NOT EXISTS idx_pages_status   ON pages(status);
CREATE INDEX IF NOT EXISTS idx_work_tags_tag  ON work_tags(tag_name);
CREATE INDEX IF NOT EXISTS idx_tag_links_tag  ON tag_links(tag_name);
CREATE INDEX IF NOT EXISTS idx_dlq_status     ON download_queue(status);
-- 覆盖「给定作品找某状态页」的 EXISTS 探测（统计、已下载标签、忽略列表）
CREATE INDEX IF NOT EXISTS idx_pages_illust_status ON pages(illust_id, status);
-- 文件名查重（下载消歧每文件一次，避免全表扫描）
CREATE INDEX IF NOT EXISTS idx_pages_file_name     ON pages(file_name);
`
