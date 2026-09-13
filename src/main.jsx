import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './app.css'

// A failed mount would otherwise leave only the body background; surface the
// error on screen so packaged builds (no devtools) are diagnosable.
try {
  createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
} catch (err) {
  document.getElementById('root').innerHTML =
    `<div style="padding:32px;font-family:Consolas,monospace;color:#ff8078;font-size:13px;white-space:pre-wrap">界面初始化失败：${String(err?.message ?? err)}\n\n${String(err?.stack ?? '').slice(0, 800)}</div>`
}

window.addEventListener('error', (e) => {
  // late (async) render-layer crashes: keep the UI visible instead of blank
  if (document.getElementById('root')?.childElementCount === 0) {
    document.getElementById('root').innerHTML =
      `<div style="padding:32px;font-family:Consolas,monospace;color:#ff8078;font-size:13px;white-space:pre-wrap">运行时错误：${String(e.message ?? e.error)}</div>`
  }
})
