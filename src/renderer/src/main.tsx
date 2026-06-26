import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

// 初始主题已由 index.html 的 theme-init.js 在首帧前同步应用；此处仅负责渲染。
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
