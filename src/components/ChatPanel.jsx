import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { renderMarkdown, firstText, reasoningText, formatTokens } from '../markdown.js'
import { IconSend, IconTool, IconChevron, IconImage, IconX, IconFolder, IconHammer, IconPlan, IconDownload, IconSearch, IconCopy, IconCheck } from './Icons.jsx'

/** Timestamp for messages: HH:mm today, M/D HH:mm otherwise */
function fmtMsgTime(t) {
  if (!t) return ''
  const d = new Date(t)
  const sameDay = d.toDateString() === new Date().toDateString()
  const hm = d.toTimeString().slice(0, 5)
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

const StopIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="stop-icon" aria-hidden>
    <rect x="6" y="6" width="12" height="12" rx="2.5" />
  </svg>
)

function Lightbox({ image, onClose }) {
  // capture the theme at mount so unmount restores exactly what was there
  const themeAtOpen = typeof document !== 'undefined' ? document.documentElement.dataset.theme : 'light'
  useLayoutEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
    }
  }, [])
  if (!image) return null

  const save = async () => {
    const res = await window.dsh.saveImage({
      ...(image.data ? { base64: image.data } : { attachmentName: image.path }),
      suggestedName: image.name || `dsh-image.${image.mimeType?.split('/')[1] ?? 'png'}`,
    })
    if (res.ok && !res.canceled && !res.path?.endsWith?.('.')) { /* saved */ }
  }

  return (
    <div className="lightbox" onClick={onClose}>
      <div className="lightbox-frame" onClick={e => e.stopPropagation()}>
        <img src={image.src} alt="查看图片" />
        <button className="lightbox-save" title="保存到本地" onClick={save}>
          <IconDownload size={17} />
        </button>
        <button className="lightbox-close" title="关闭" onClick={onClose}>
          <IconX size={16} />
        </button>
      </div>
    </div>
  )
}
import ModelDropdown from './ModelDropdown.jsx'
import EffortControl from './EffortControl.jsx'
import { WhaleMark } from './WhaleMark.jsx'
import { modelDisplayName } from '../models.js'

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

function readImageFile(file) {
  return new Promise((resolve, reject) => {
    if (!IMAGE_TYPES.includes(file.type)) {
      reject(new Error(`不支持的图片格式：${file.type || '未知'}（支持 PNG/JPEG/WebP/GIF）`))
      return
    }
    if (file.size > MAX_IMAGE_BYTES) {
      reject(new Error(`图片超过 8MB 上限：${file.name}`))
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result)
      const base64 = result.slice(result.indexOf(',') + 1)
      resolve({ data: base64, mimeType: file.type, name: file.name })
    }
    reader.onerror = () => reject(new Error(`读取图片失败：${file.name}`))
    reader.readAsDataURL(file)
  })
}

function UsageTag({ usage }) {
  if (!usage) return null
  return <span className="usage-tag" title="本次请求 token 用量">
    {formatTokens((usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0))} in
    {' / '}{formatTokens(usage.outputTokens ?? 0)} out
  </span>
}

function ReasoningBlock({ text }) {
  const [open, setOpen] = useState(false)
  if (!text) return null
  return (
    <div className={`reasoning ${open ? 'open' : ''}`}>
      <button className="reasoning-toggle" onClick={() => setOpen(!open)}>
        <IconChevron size={14} />
        <span>思考过程</span>
      </button>
      {open && <div className="reasoning-body">{text}</div>}
    </div>
  )
}

function summarizeArgs(raw) {
  try {
    const obj = JSON.parse(raw)
    const keys = Object.keys(obj)
    if (keys.length === 0) return ''
    const main = keys
      .slice(0, 3)
      .map(k => {
        const v = typeof obj[k] === 'string' ? obj[k] : JSON.stringify(obj[k])
        const short = v.length > 60 ? v.slice(0, 59) + '…' : v
        return `${k}: ${short}`
      })
      .join(', ')
    return keys.length > 3 ? `${main} …` : main
  } catch {
    return raw.length > 80 ? raw.slice(0, 79) + '…' : raw
  }
}

function resultText(blocks) {
  if (!Array.isArray(blocks)) return ''
  const text = blocks.filter(b => b?.type === 'text').map(b => b.text).join('\n')
  return text.length > 400 ? text.slice(0, 399) + '…' : text
}

function ToolCard({ msg, hit, current, idx }) {
  const [open, setOpen] = useState(false)
  const running = msg.status === 'running'
  return (
    <div
      className={`tool-card ${running ? 'running' : ''} ${msg.isError ? 'error' : ''} ${hit ? 'search-hit' : ''} ${current ? 'search-current' : ''}`}
      id={`msg-${idx}`}
    >
      <button className="tool-head" onClick={() => setOpen(!open)}>
        {running
          ? <span className="spinner tiny" />
          : <IconTool size={14} />}
        <span className="tool-name">{msg.name || 'tool'}</span>
        <span className="tool-args">{summarizeArgs(msg.arguments || '')}</span>
        <span className={`tool-status ${running ? 'running' : msg.isError ? 'error' : 'ok'}`}>
          {running ? '运行中' : msg.isError ? '出错' : '完成'}
        </span>
        <IconChevron size={14} />
      </button>
      {open && (
        <div className="tool-detail">
          <div className="tool-section">参数</div>
          <pre>{msg.arguments || '（无）'}</pre>
          <div className="tool-section">结果</div>
          <pre>{resultText(msg.result) || '（无）'}</pre>
        </div>
      )}
    </div>
  )
}

function LiveThinking({ live }) {
  const bodyRef = useRef(null)
  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [live?.reasoning])
  if (!live?.reasoning) return null
  return (
    <div className="live-thinking">
      <div className="live-tag">思考中…</div>
      <div className="live-reasoning" ref={bodyRef}>{live.reasoning}</div>
    </div>
  )
}

function CopyButton({ getText, title }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className="copy-btn"
      title={title ?? '复制'}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(getText())
          setDone(true)
          setTimeout(() => setDone(false), 1200)
        } catch { /* clipboard unavailable */ }
      }}
    >
      {done ? <IconCheck size={15} /> : <IconCopy size={15} />}
    </button>
  )
}

const COLLAPSE_THRESHOLD = 600

function CollapsibleText({ html }) {
  const [collapsed, setCollapsed] = useState(false)
  const [overflow, setOverflow] = useState(false)
  const bodyRef = useRef(null)
  useEffect(() => {
    const el = bodyRef.current
    if (el) setOverflow(el.scrollHeight > COLLAPSE_THRESHOLD)
  }, [html])
  if (!overflow) return <div className="markdown-body" ref={bodyRef} dangerouslySetInnerHTML={{ __html: html }} />
  return (
    <div className="collapse-wrap">
      <div
        className={`markdown-body collapse-target ${collapsed ? 'collapsed' : ''}`}
        ref={bodyRef}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <button className="collapse-btn" onClick={() => setCollapsed(c => !c)}>
        {collapsed ? '展开全文' : '收起'}
      </button>
    </div>
  )
}

function AssistantMessage({ msg, onImageClick, idx, hit, current }) {
  const reasoning = reasoningText(msg.content)
  const html = useMemo(() => renderMarkdown(firstText(msg.content)), [msg.content])
  const cls = `msg-row assistant ${hit ? 'search-hit' : ''} ${current ? 'search-current' : ''}`
  return (
    <div className={cls} id={`msg-${idx}`}>
      <ReasoningBlock text={reasoning} />
      {html
        ? <CollapsibleText html={html} />
        : <div className="bubble placeholder">{msg.interrupted ? '（回复被中断）' : '（无文本输出）'}</div>}
      <div className="msg-meta">
        <span className="msg-time">{fmtMsgTime(msg.time)}</span>
        <UsageTag usage={msg.usage} />
        <CopyButton getText={() => firstText(msg.content)} title="复制回复原文" />
      </div>
    </div>
  )
}

function Message({ msg, onImageClick, idx, hit, current }) {
  const searchCls = `${hit ? 'search-hit' : ''} ${current ? 'search-current' : ''}`.trim()
  if (msg.kind === 'note') {
    return <div className={`note-row ${searchCls}`} id={`msg-${idx}`}>{msg.note}</div>
  }
  if (msg.kind === 'note-error') {
    return <div className={`note-row error ${searchCls}`} id={`msg-${idx}`}>{msg.note}</div>
  }
  if (msg.kind === 'tool') {
    return <ToolCard msg={msg} hit={hit} current={current} idx={idx} />
  }
  if (msg.kind === 'user' || msg.kind === 'user-local') {
    const injected = msg.source?.kind !== undefined && msg.source.kind !== 'user'
    if (injected) return null
    const imageBlocks = (msg.content ?? []).filter(b => b?.type === 'image')
    const inlineImages = imageBlocks.filter(b => (b.data || b.path) && b.mimeType)
    const remoteImages = imageBlocks.filter(b => !(b.data || b.path) || !b.mimeType)
    const srcOf = (img) => (img.data ? `data:${img.mimeType};base64,${img.data}` : `dshimg://${img.path}`)
    const body = (msg.content ?? [])
      .filter(b => b?.type === 'text' && b.text)
      .map(b => b.text)
      .join('\n')
    return (
      <div className={`msg-row user ${searchCls}`} id={`msg-${idx}`}>
        <div className="user-bubble-group">
          {inlineImages.length > 0 && (
            <div className="msg-image-row">
              {inlineImages.map((img, i) => (
                <img
                  key={i}
                  className="msg-image clickable"
                  src={srcOf(img)}
                  alt="用户图片"
                  onClick={() => onImageClick?.({
                    src: srcOf(img),
                    data: img.data,
                    path: img.path,
                    mimeType: img.mimeType,
                  })}
                />
              ))}
            </div>
          )}
          {remoteImages.length > 0 && (
            <div className="msg-image-row">
              {remoteImages.map((_, i) => <span key={i} className="image-chip">图片</span>)}
            </div>
          )}
          {(body || inlineImages.length === 0) && (
            <div className="bubble user-bubble">{body || '（非文本内容）'}</div>
          )}
          <div className="msg-time user-msg-time">{fmtMsgTime(msg.time)}</div>
        </div>
      </div>
    )
  }
  if (msg.kind === 'assistant') {    return <AssistantMessage msg={msg} idx={idx} hit={hit} current={current} />
  }
  return null
}

export default function ChatPanel({ session, runtimeStatus, error, patchWarn, onSend, config, onSwitchModel, onSwitchEffort, onConfigChanged, onSwitchWorkspace }) {
  const [text, setText] = useState('')
  const [images, setImages] = useState([])
  const [imageError, setImageError] = useState('')
  const [sending, setSending] = useState(false)
  const [lightbox, setLightbox] = useState(null)
  const [mode, setMode] = useState('build')
  const [showJump, setShowJump] = useState(false)
  const [pendingPlan, setPendingPlan] = useState(null)
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findIdx, setFindIdx] = useState(0)
  const lastAssistantRef = useRef(null)

  // in-conversation search: message indices whose text contains the query
  const findMatches = useMemo(() => {
    const q = findQuery.trim().toLowerCase()
    if (!q || !session?.messages) return []
    const hits = []
    session.messages.forEach((m, i) => {
      let text = ''
      if (m.kind === 'note' || m.kind === 'note-error') text = m.note ?? ''
      else if (m.kind === 'tool') text = `${m.name ?? ''} ${typeof m.arguments === 'string' ? m.arguments : ''}`
      else text = (m.content ?? []).map(b => b?.text ?? '').join(' ')
      if (text.toLowerCase().includes(q)) hits.push(i)
    })
    return hits
  }, [findQuery, session?.messages])

  useEffect(() => {
    if (findIdx >= findMatches.length) setFindIdx(0)
  }, [findMatches.length, findIdx])

  const jumpFind = (delta) => {
    if (findMatches.length === 0) return
    const next = (findIdx + delta + findMatches.length) % findMatches.length
    setFindIdx(next)
  }

  useEffect(() => {
    if (!findOpen || findMatches.length === 0) return
    document.getElementById(`msg-${findMatches[findIdx]}`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [findIdx, findQuery, findOpen])

  // Ctrl+F opens the conversation finder (overrides browser find)
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault()
        setFindOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const closeFind = () => { setFindOpen(false); setFindQuery(''); setFindIdx(0) }

  // in plan mode, remember the latest settled assistant message as the plan
  useEffect(() => {
    if (mode !== 'plan' || !session) return
    const last = session.messages.at(-1)
    if (last?.kind === 'assistant') {
      const text = (last.content ?? []).filter(b => b?.type === 'text').map(b => b.text).join('\n')
      if (text.trim()) lastAssistantRef.current = text
    }
  }, [session?.messages?.length, mode, session])

  const applyPlan = () => {
    const plan = lastAssistantRef.current
    if (!plan) return
    const extra = text.trim()
    const combined = `[EXECUTE PLAN] 请执行以下此前在计划模式中制定的方案（必要时按用户补充调整）：\n\n${plan}\n\n${extra ? `用户补充：${extra}` : '请按计划执行。'}`
    setPendingPlan(null)
    lastAssistantRef.current = null
    if (running) window.dsh.interrupt().catch(() => {})
    setText('')
    onSend(combined, [], 'build')
  }
  const fileRef = useRef(null)
  const listRef = useRef(null)
  const taRef = useRef(null)
  const autoScroll = useRef(true)

  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight
      autoScroll.current = distance < 40
      setShowJump(distance > 240)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  const jumpToBottom = () => {
    const el = listRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }
  const running = session?.status === 'running'
  const messageCount = session?.messages?.length ?? 0
  const badge = running ? 'running'
    : runtimeStatus === 'ready' ? 'ready'
      : runtimeStatus === 'starting' ? 'starting' : 'stopped'
  const activeEntry = (config.customModels ?? []).find(m => m.provider === config.activeCustom)
  const modelLabel = activeEntry?.label ?? modelDisplayName(config.provider, config.model)
  const effort = config.reasoningEffort || 'high'
  const effortLocked = running || runtimeStatus === 'starting'

  const addImages = async (files) => {
    const picks = [...files].filter(f => f.type.startsWith('image/'))
    if (picks.length === 0) return
    setImageError('')
    try {
      const loaded = await Promise.all(picks.map(readImageFile))
      setImages(prev => [...prev, ...loaded])
    } catch (err) {
      setImageError(err.message)
    }
  }

  useEffect(() => {
    const el = listRef.current
    if (el && autoScroll.current) el.scrollTop = el.scrollHeight
  }, [session?.messages?.length, session?.id, running, session?.livePreview?.updatedAt])

  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 220) + 'px'
  }, [text])

  // surface the remembered plan when back in build mode
  useEffect(() => {
    if (mode === 'build' && lastAssistantRef.current) {
      setPendingPlan(lastAssistantRef.current)
    } else {
      setPendingPlan(null)
    }
  }, [mode])

  const submit = () => {
    const value = text.trim()
    if ((!value && images.length === 0) || sending) return
    // sending while the agent works interrupts the active turn first, then the
    // new message starts a fresh turn on the same session
    if (running) {
      window.dsh.interrupt().catch(() => {})
    }
    setSending(true)
    setText('')
    // image-only messages need no placeholder text — the wire protocol accepts
    // a bare image block, and the UI renders the image itself
    onSend(value, images, mode)
    setImages([])
    setTimeout(() => setSending(false), 800)
  }

  const stop = () => {
    window.dsh.interrupt().catch(() => {})
  }

  // welcome mode: no messages yet → centered hero + input, no chat header
  const hasData = session && Array.isArray(session.messages) && session.messages.length > 0

  return (
    <section className={`chat ${hasData ? '' : 'welcome-mode'}`}>
      {hasData && (
        <header className="chat-head">
          <div className="chat-head-info">
            <div className="chat-title">{session?.title || '新对话'}</div>
            <div className="chat-meta-line">
              <span className={`meta-dot ${badge}`} />
              <span className="meta-state">
                {badge === 'running' ? '工作中' : badge === 'ready' ? '就绪' : badge === 'starting' ? '启动中' : '未连接'}
              </span>
              {messageCount > 0 && (
                <>
                  <span className="meta-sep">·</span>
                  <span>{messageCount} 条消息</span>
                </>
              )}
              <span className="meta-sep">·</span>
              <span className="meta-model">{modelLabel}</span>
            </div>
          </div>
          <ModelDropdown
            provider={config.provider}
            model={config.model}
            activeCustom={config.activeCustom}
            running={running}
            runtimeStatus={runtimeStatus}
            customModels={config.customModels}
            onSwitch={onSwitchModel}
            onChanged={onConfigChanged}
          />
        </header>
      )}

      {findOpen && (
        <div className="find-bar">
          <IconSearch size={13} />
          <input
            autoFocus
            value={findQuery}
            placeholder="搜索对话内容…"
            onChange={e => { setFindQuery(e.target.value); setFindIdx(0) }}
            onKeyDown={e => {
              if (e.key === 'Enter') jumpFind(e.shiftKey ? -1 : 1)
              if (e.key === 'Escape') closeFind()
            }}
          />
          <span className="find-count">
            {findMatches.length > 0 ? `${findIdx + 1}/${findMatches.length}` : findQuery.trim() ? '无结果' : ''}
          </span>
          <button className="find-nav" onClick={() => jumpFind(-1)} disabled={findMatches.length === 0} title="上一处">↑</button>
          <button className="find-nav" onClick={() => jumpFind(1)} disabled={findMatches.length === 0} title="下一处">↓</button>
          <button className="icon-btn find-close" onClick={closeFind}><IconX size={13} /></button>
        </div>
      )}

      <div className="message-list" ref={listRef}>
        {!hasData ? (
          <div className="welcome">
            <div className="welcome-brand">
              <WhaleMark size={64} />
              <span className="welcome-title">探索未知之境</span>
            </div>
          </div>
        ) : (
          session.messages.map((m, i) => (
            <Message
              key={i}
              msg={m}
              onImageClick={setLightbox}
              idx={i}
              hit={findMatches.includes(i)}
              current={findMatches[findIdx] === i}
            />
          ))
        )}
        {running && <LiveThinking live={session?.livePreview} />}
        {running && session?.livePreview?.text && (
          <div className="msg-row assistant live-output">
            <div className="markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(session.livePreview.text) }} />
          </div>
        )}
      </div>

      {showJump && (
        <button className="jump-bottom" title="回到底部" onClick={jumpToBottom}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 5v14" />
            <path d="m19 12-7 7-7-7" />
          </svg>
          {running && <span className="jump-live-dot" />}
        </button>
      )}

      {error && <div className="error-bar">{error}</div>}
      {patchWarn && <div className="error-bar warn-bar">{patchWarn}</div>}
      {imageError && <div className="error-bar">{imageError}</div>}

      <footer className="composer">
        {pendingPlan && (
          <div className="plan-ready">
            <span className="plan-ready-text">已有计划待执行</span>
            <button className="plan-ready-apply" onClick={applyPlan}>引用计划并执行</button>
            <button className="plan-ready-dismiss" onClick={() => { setPendingPlan(null); lastAssistantRef.current = null }}>忽略</button>
          </div>
        )}
        {running && (
          <div className="work-dots" title="agent 正在工作">
            {Array.from({ length: 12 }, (_, i) => <span key={i} className="work-dot" />)}
          </div>
        )}
        <div className={`input-card mode-${mode}`}>
          {images.length > 0 && (
            <div className="image-preview-row">
              {images.map((img, i) => (
                <div key={i} className="image-preview">
                  <img src={`data:${img.mimeType};base64,${img.data}`} alt={img.name} />
                  <button
                    className="image-preview-save"
                    title={`保存 ${img.name}`}
                    onClick={() => window.dsh.saveImage({
                      base64: img.data,
                      suggestedName: img.name || `dsh-image.${img.mimeType?.split('/')[1] ?? 'png'}`,
                    })}
                  >
                    <IconDownload size={11} />
                  </button>
                  <button
                    className="image-preview-del"
                    title={`移除 ${img.name}`}
                    onClick={() => setImages(prev => prev.filter((_, j) => j !== i))}
                  >
                    <IconX size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={taRef}
            value={text}
            placeholder={running ? '直接发送可打断当前回复…' : '描述你想要构建的内容'}
            onChange={e => setText(e.target.value)}
            onPaste={e => {
              const files = [...(e.clipboardData?.files ?? [])]
              if (files.length > 0) {
                e.preventDefault()
                addImages(files)
              }
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                e.preventDefault()
                submit()
              }
              if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
                e.preventDefault()
                setMode(m => m === 'build' ? 'plan' : 'build')
              }
            }}
          />
          <div className="input-card-foot">
            <div className="input-foot-left">
              {!hasData && (
                <ModelDropdown
                  provider={config.provider}
                  model={config.model}
                  activeCustom={config.activeCustom}
                  running={running}
                  runtimeStatus={runtimeStatus}
                  customModels={config.customModels}
                  onSwitch={onSwitchModel}
                  onChanged={onConfigChanged}
                />
              )}
              <button
                className={`mode-toggle ${mode}`}
                title={mode === 'build' ? '构建模式：可读写与执行（点击切换为计划模式）' : '计划模式：只读调研，输出计划不执行（点击切换为构建模式）'}
                onClick={() => setMode(m => m === 'build' ? 'plan' : 'build')}
              >
                {mode === 'build' ? <IconHammer size={14} /> : <IconPlan size={14} />}
                <span>{mode === 'build' ? '构建' : '计划'}</span>
              </button>
              <button
                className="image-pick-btn"
                title="添加图片（PNG/JPEG/WebP/GIF，也可直接粘贴）"
                onClick={() => fileRef.current?.click()}
                disabled={running}
              >
                <IconImage size={15} />
              </button>
              <button
                className="workspace-chip"
                title="点击切换工作目录（agent 的文件操作范围）"
                disabled={running || runtimeStatus === 'starting'}
                onClick={onSwitchWorkspace}
              >
                <IconFolder size={13} />
                <span className="workspace-path">{config.workspace}</span>
              </button>
            </div>
            <div className="input-foot-right">
              {!config.activeCustom && (
                <EffortControl effort={effort} locked={effortLocked} onCommit={onSwitchEffort} />
              )}
              <button
                className={`send-btn ${running ? 'stopping' : ''}`}
                onClick={() => (running ? stop() : submit())}
                disabled={(!text.trim() && images.length === 0 && !running) || sending}
                title={running ? '停止生成' : '发送'}
              >
                {running ? <StopIcon /> : <IconSend size={19} />}
              </button>
            </div>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            hidden
            onChange={e => {
              addImages(e.target.files ?? [])
              e.target.value = ''
            }}
          />
        </div>
        <div className="composer-hint">
          Enter 发送 · Shift+Enter 换行 · Tab 切换模式{images.length > 0 ? ` · ${images.length} 张图片` : ''}
        </div>
      </footer>
      <Lightbox image={lightbox} onClose={() => setLightbox(null)} />
    </section>
  )
}
