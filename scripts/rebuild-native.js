// 跨平台重建原生模块（better-sqlite3）以匹配已安装的 Electron ABI。
// 关键：buildFromSource=true —— 预编译包常抓成 Node 的 ABI，必须按 Electron 头文件从源码编译。
const path = require('node:path')

async function main() {
  const electronVersion = require('electron/package.json').version
  const { rebuild } = await import('@electron/rebuild')
  await rebuild({
    buildPath: path.resolve(__dirname, '..'),
    electronVersion,
    force: true,
    onlyModules: ['better-sqlite3'],
    buildFromSource: true
  })
  console.log(`native rebuild done for Electron ${electronVersion}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
