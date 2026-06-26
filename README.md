# Pixiv Collection Archiver

把你**自己 Pixiv 账号下的收藏（ブックマーク）**备份到本地的跨平台桌面应用。按你保存时打的**书签 tag** 分类存放；一图多 tag 时只存一份原图，其余 tag 文件夹用**硬链接**引用（无主次之分）；本地维护「已爬/未爬」记忆，再次同步增量、不重复下载。

> 仅供个人对自己账号收藏的归档使用，内置尊重式限速（随机化间隔 + 低并发 + 指数退避），请遵守 Pixiv 服务条款。

## 技术栈

Electron + React 19 + TypeScript + Vite（electron-vite）+ Tailwind v4 + Radix/shadcn 风格基元 + Framer Motion；`better-sqlite3` 作本地记忆库；`ffmpeg-static` 转码 ugoira 动图。纯 TypeScript，无 Python。

## 目录结构（保存目录下）

```
<保存目录>/
  Library/            # 所有原图唯一副本（{标题}-{作者}-p{页}.{ext}）
  Tags/<书签tag>/     # 指向 Library 的硬链接（一图多 tag → 多个硬链接）
```

数据库与设置位于应用数据目录（`app.getPath('userData')`），与保存目录解耦，便于迁移。

## 开发

```bash
pnpm install        # 自动下载 Electron 二进制，并按其 ABI 从源码重建 better-sqlite3
pnpm dev            # 启动开发（首次会弹出应用窗口）
pnpm typecheck      # 类型检查（node + web）
pnpm build          # 三端打包到 out/
pnpm run rebuild    # 切换 Electron 版本后若原生模块 ABI 不符，手动重建 better-sqlite3
pnpm dist:mac       # 打 macOS dmg
pnpm dist:win       # 打 Windows nsis
```

## 工作流

1. 在「设置」选择本地保存目录。
2. 在「概览」点「登录 Pixiv」（内嵌浏览器手动登录，自动处理验证码/2FA）。
3. 「一键同步全部」或在「标签」页按 tag 同步。
4. 「下载」页查看网盘式队列（进度/速度/暂停/继续/删除/重试）。
5. 更改保存目录时用「设置」里的迁移：同卷自动保持硬链接，跨卷自动重建。

## 待真机验证（需登录态）

- `bookmark/tags` 接口的确切字段名（已做 `tag|name`、`cnt|count` 容错），登录后核对。
- 未分類书签的 `tag=未分類` 过滤是否符合预期。
- ugoira 转码在真实样本上的效果。
