import { useEffect, useState } from 'react'
import { Message, ActivityChips, groupForDisplay } from './ChatPanel.jsx'

const STATUS_META = {
  running: { label: '运行中', cls: 'running' },
  ok: { label: '待命', cls: 'ok' },
  failed: { label: '已关闭', cls: 'failed' },
}

/** Read-only viewer for a subagent session: opened from the stats panel's
 *  subagent list; shows the child session's conversation (its own prompts,
 *  reasoning, output and tool calls). Live-refreshes while the subagent
 *  runs — App refetches on every snapshot and passes fresh data in. */
export default function SubagentModal({ data, showToolActivity, onClose }) {
  const [lightbox, setLightbox] = useState(null)

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!data) return null
  const meta = STATUS_META[data.subagentStatus] ?? { label: data.status, cls: '' }
  const entries = groupForDisplay(data.messages, showToolActivity === true)

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal subagent-modal" onClick={e => e.stopPropagation()}>
        <div className="subagent-head">
          <div className="subagent-head-title">
            <span className={`subagent-status-dot ${meta.cls}`} />
            <span>子代理 · {(data.title || data.id.slice(0, 8))}</span>
            <span className="subagent-status-label">{meta.label}</span>
          </div>
          <button className="icon-btn" onClick={onClose} title="关闭">✕</button>
        </div>
        <div className="subagent-messages">
          {entries.length === 0
            ? <div className="subagent-empty">子代理尚未产生输出…</div>
            : entries.map(e => (
              <Message
                key={e.idx}
                msg={e.msg}
                idx={e.idx}
                onImageClick={setLightbox}
                showInjected
                activity={e.activity}
              />
            ))}
          {entries.length === 0 && showToolActivity !== true && data.messages.length > 0 && (
            <div className="subagent-empty">（工具与活动消息已隐藏，可在 设置 → 调试 中开启）</div>
          )}
        </div>
        {lightbox && (
          <div className="lightbox" onClick={() => setLightbox(null)}>
            <img src={lightbox.src} alt="图片" />
          </div>
        )}
      </div>
    </div>
  )
}

