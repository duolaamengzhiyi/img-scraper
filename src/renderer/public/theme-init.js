// 首帧绘制前同步应用上次持久化的主题，避免开屏闪白。
// 作为 <head> 中的经典脚本：会阻塞解析、在 body 渲染与首帧绘制前执行，
// 因此能在 CSS 按浅色绘制之前就给 <html> 打上 .dark。
;(function () {
  try {
    var saved = localStorage.getItem('app-theme')
    var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    var dark = saved === 'dark' || ((saved === null || saved === 'system') && prefersDark)
    document.documentElement.classList.toggle('dark', dark)
  } catch (e) {
    /* localStorage 不可用时忽略，交由后续 React 主题逻辑兜底 */
  }
})()
