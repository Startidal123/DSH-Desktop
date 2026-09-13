import { useEffect, useRef, useState } from 'react'
import { IconPlus, IconSettings, IconRefresh, IconSearch, IconX, IconFolder, IconFolderOpen } from './Icons.jsx'
import { renderMarkdown } from '../markdown.js'
import { WhaleMark } from './WhaleMark.jsx'

/** Relative stamp: 刚刚 → X 分钟前 → HH:mm (<24h) → M/D */
function relTime(ts) {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)} 分钟前`
  const d = new Date(ts)
  if (diff < 24 * 60 * 60_000) return d.toTimeString().slice(0, 5)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function wsLabel(ws) {
  if (!ws) return '默认'
  const parts = ws.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || ws
}

const PinIcon = ({ filled }) => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'}
    stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 17v5" />
    <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z" />
  </svg>
)

function ChangePlanCard() {
  const [plans, setPlans] = useState([])
  const [openDoc, setOpenDoc] = useState(null)

  useEffect(() => {
    let alive = true
    const load = () => {
      window.dsh.listChangePlans()
        .then(list => { if (alive) setPlans(list ?? []) })
        .catch(() => {})
    }
    load()
    const timer = setInterval(load, 15000)
    return () => { alive = false; clearInterval(timer) }
  }, [])

  if (plans.length === 0) return null

  return (
    <div className="stat-card change-plan-card">
      <div className="stat-card-title">变更记录</div>
      {plans.slice(0, 5).map(p => (
        <button key={p.name} className="cp-item" onClick={() => setOpenDoc(p)}>
          <span className="cp-name">{p.title}</span>
          <span className="cp-time">{new Date(p.mtime).toLocaleDateString()}</span>
        </button>
      ))}
      {plans.length > 5 && <div className="cp-more">还有 {plans.length - 5} 条…</div>}
      {openDoc && (
        <div className="lightbox" onClick={() => setOpenDoc(null)}>
          <div className="cp-doc" onClick={e => e.stopPropagation()}>
            <div className="cp-doc-head">
              <span className="cp-doc-title">{openDoc.title}</span>
              <button className="lightbox-close" onClick={() => setOpenDoc(null)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="cp-doc-body markdown-body"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(openDoc.content) }} />
          </div>
        </div>
      )}
    </div>
  )
}

export default function Sidebar({ sessions, activeId, config, onSelect, onNew, onDelete, onRename, onTogglePin, onOpenSettings, runtimeStatus, onRestart, onToggleTheme, theme, updateBadge }) {
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [renaming, setRenaming] = useState(null)
  const [renameText, setRenameText] = useState('')
  const [collapsed, setCollapsed] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('dsh-ws-collapsed') ?? '[]')) } catch { return new Set() }
  })
  const [ctx, setCtx] = useState(null) // { x, y, id, pinned }
  const searchRef = useRef(null)

  useEffect(() => { if (searchOpen) searchRef.current?.focus() }, [searchOpen])

  useEffect(() => {
    if (!ctx) return
    const close = () => setCtx(null)
    const onKey = (e) => { if (e.key === 'Escape') setCtx(null) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [ctx])

  // when the active session sits inside a collapsed workspace group, expand
  // it (covers "新对话 while group collapsed → session invisible")
  useEffect(() => {
    if (!activeId) return
    const active = sessions.find(s => s.id === activeId)
    if (!active) return
    const wsKey = active.workspace || config?.workspace || ''
    if (collapsed.has(wsKey)) {
      setCollapsed(prev => {
        const next = new Set(prev)
        next.delete(wsKey)
        localStorage.setItem('dsh-ws-collapsed', JSON.stringify([...next]))
        return next
      })
    }
  }, [activeId, sessions, config?.workspace])

  const toggleCollapse = (ws) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(ws)) next.delete(ws); else next.add(ws)
      localStorage.setItem('dsh-ws-collapsed', JSON.stringify([...next]))
      return next
    })
  }

  const q = query.trim().toLowerCase()
  const currentWs = config?.workspace ?? ''

  let groups
  if (q) {
    const visible = sessions.filter(s => (s.search ?? s.title).toLowerCase().includes(q))
    groups = visible.length ? [{ key: '__search__', label: `搜索结果（${visible.length}）`, sessions: visible, flat: true }] : []
  } else {
    const map = new Map()
    for (const s of sessions) {
      const key = s.workspace || currentWs
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(s)
    }
    groups = [...map.entries()]
      .map(([key, list]) => ({ key, label: wsLabel(key), sessions: list }))
      .sort((a, b) => {
        if (a.key === currentWs) return -1
        if (b.key === currentWs) return 1
        const ma = Math.max(...a.sessions.map(s => s.updatedAt ?? 0))
        const mb = Math.max(...b.sessions.map(s => s.updatedAt ?? 0))
        return mb - ma
      })
  }

  const commitRename = (id) => {
    if (renameText.trim()) onRename(id, renameText.trim())
    setRenaming(null)
  }

  const closeSearch = () => { setSearchOpen(false); setQuery('') }

  const openMenu = (e, s) => {
    e.preventDefault()
    const x = Math.min(e.clientX, window.innerWidth - 170)
    const y = Math.min(e.clientY, window.innerHeight - 140)
    setCtx({ x, y, id: s.id, pinned: s.pinned === true })
  }

  const renderSession = (s) => (
    <div
      key={s.id}
      className={`session-item ${s.id === activeId ? 'active' : ''}`}
      onClick={() => onSelect(s.id)}
      onContextMenu={e => openMenu(e, s)}
    >
      {s.status === 'running' && <span className="spinner tiny" />}
      <div className="session-meta">
        {renaming === s.id ? (
          <input
            className="rename-input"
            autoFocus
            value={renameText}
            onChange={e => setRenameText(e.target.value)}
            onClick={e => e.stopPropagation()}
            onKeyDown={e => {
              if (e.key === 'Enter') commitRename(s.id)
              if (e.key === 'Escape') setRenaming(null)
            }}
            onBlur={() => commitRename(s.id)}
          />
        ) : (
          <div className="session-title">
            {s.pinned && <span className="pin-mark"><PinIcon filled /></span>}
            {s.title || '新对话'}
          </div>
        )}
      </div>
      <span className="session-time">{relTime(s.updatedAt)}</span>
    </div>
  )

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="brand-whale"><WhaleMark size={40} /></span>
        <span className="brand-name">DeepSeek</span>
        <span className="brand-tag">HARNESS</span>
      </div>

      <button className="new-chat" onClick={onNew}>
        <IconPlus size={15} />
        <span>新对话</span>
      </button>

      <div className="session-mid">
        <div className="session-top-spacer" />
        <ChangePlanCard />
        <div className="history-head">
          <span className="history-title">{q ? '' : '工作区'}</span>
          {searchOpen ? (
            <div className="history-search">
              <IconSearch size={13} />
              <input
                ref={searchRef}
                value={query}
                placeholder="搜索…"
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => { if (e.key === 'Escape') closeSearch() }}
              />
              <button className="icon-btn search-clear" onClick={closeSearch}><IconX size={12} /></button>
            </div>
          ) : (
            <button className="icon-btn history-search-btn" title="搜索对话" onClick={() => setSearchOpen(true)}>
              <IconSearch size={15} />
            </button>
          )}
        </div>

        <div className="session-list">
          {groups.length === 0 && (
            <div className="session-empty">{q ? '没有匹配的对话' : '还没有对话'}<br />{q ? '' : '点击上方「新对话」开始'}</div>
          )}
          {groups.map(g => (
            <div key={g.key} className="ws-group">
              {g.flat ? (
                <div className="ws-group-head static"><span className="ws-name">{g.label}</span></div>
              ) : (
                <div
                  className={`ws-group-head ${collapsed.has(g.key) ? '' : 'ws-open'}`}
                  onClick={() => toggleCollapse(g.key)}
                  title={g.key}
                >
                  {collapsed.has(g.key)
                    ? <IconFolder size={16} />
                    : <IconFolderOpen size={16} />}
                  <span className="ws-name">{g.label}</span>
                  <span className="ws-count">{g.sessions.length}</span>
                </div>
              )}
              {(g.flat || !collapsed.has(g.key)) && g.sessions.map(renderSession)}
            </div>
          ))}
        </div>
      </div>

      <div className="sidebar-foot">
        <button className="icon-btn foot-btn" title="重启运行时" onClick={onRestart}>
          <IconRefresh size={20} />
        </button>
        <button className="icon-btn foot-btn" title={theme === 'light' ? '切换暗色' : '切换亮色'} onClick={onToggleTheme}>
          {theme === 'light' ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
            </svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
            </svg>
          )}
        </button>
        <button className="icon-btn foot-btn" title="设置" onClick={onOpenSettings}>
          <IconSettings size={20} />
          {updateBadge && <span className="foot-badge" />}
        </button>
      </div>

      {ctx && (
        <div
          className="ctx-menu"
          style={{ left: ctx.x, top: ctx.y }}
          onMouseDown={e => e.stopPropagation()}
        >
          <button onClick={() => { onTogglePin(ctx.id); setCtx(null) }}>
            {ctx.pinned ? '取消置顶' : '置顶'}
          </button>
          <button onClick={() => {
            const s = sessions.find(x => x.id === ctx.id)
            setRenaming(ctx.id)
            setRenameText(s?.title ?? '')
            setCtx(null)
          }}>
            重命名
          </button>
          <button className="danger" onClick={() => { onDelete(ctx.id); setCtx(null) }}>
            删除对话
          </button>
        </div>
      )}
    </aside>
  )
}
