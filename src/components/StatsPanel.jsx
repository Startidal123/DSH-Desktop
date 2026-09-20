import { useEffect, useState } from 'react'
import { formatTokens } from '../markdown.js'

function Ring({ percent }) {
  const radius = 46
  const circumference = 2 * Math.PI * radius
  const clamped = Math.max(0, Math.min(100, percent))
  const offset = circumference * (1 - clamped / 100)
  return (
    <svg className="ring" viewBox="0 0 120 120" aria-hidden>
      <circle cx="60" cy="60" r={radius} className="ring-track" />
      <circle
        cx="60" cy="60" r={radius}
        className="ring-value"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
      />
      <text x="60" y="57" className="ring-num">{clamped.toFixed(0)}%</text>
      <text x="60" y="74" className="ring-label">缓存命中</text>
    </svg>
  )
}

function Row({ label, value, accent }) {
  return (
    <div className="stat-row">
      <span className="stat-label">{label}</span>
      <span className={`stat-value ${accent ?? ''}`}>{value}</span>
    </div>
  )
}

const TODO_LABELS = { pending: '待办', in_progress: '进行中', completed: '已完成' }

const SUBAGENT_LABELS = { running: '工作中', ok: '待命', failed: '已关闭' }
const subagentState = (sa) => SUBAGENT_LABELS[sa.status] ?? '已关闭'

export default function StatsPanel({ session, onOpenSubagent }) {
  const hasData = session && Array.isArray(session.messages) && session.messages.length > 0
  const todos = session?.todos ?? []
  const subagents = session?.subagents ?? []
  const [taskTab, setTaskTab] = useState(
    () => todos.length === 0 && subagents.length > 0 ? 'subagents' : 'todos',
  )
  const [ctx, setCtx] = useState(null)

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

  // no conversation yet: collapse the whole right column instead of showing
  // empty placeholders
  if (!hasData) return null

  const usage = session?.usage ?? {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
    cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0, requests: 0,
  }
  const billedInput = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
  const total = billedInput + usage.outputTokens
  const hitRate = billedInput > 0 ? (usage.cacheReadTokens / billedInput) * 100 : 0
  const approvals = session?.approvals ?? []
  const runningCount = subagents.filter(sa => sa.status === 'running').length
  const standbyCount = subagents.filter(sa => sa.status === 'ok').length
  const closedCount = subagents.length - runningCount - standbyCount

  return (
    <aside className="stats">
      {approvals.length > 0 && (
        <div className="stat-card approval-card">
          <div className="stat-card-title">待审操作</div>
          {approvals.map(a => (
            <div key={a.id} className="approval-item">
              <div className="approval-tool">{a.toolName}</div>
              {a.reason && <div className="approval-reason">{a.reason}</div>}
              <div className="approval-actions">
                <button className="approval-btn allow" onClick={() => window.dsh.decideApproval(a.id, 'allowed')}>批准</button>
                <button className="approval-btn reject" onClick={() => window.dsh.decideApproval(a.id, 'rejected')}>拒绝</button>
              </div>
            </div>
          ))}
          <div className="approval-hint">agent 正在等待审批；大改动应有 .dsh-changes/ 变更说明</div>
        </div>
      )}

      <div className="stat-card">
        <div className="stat-card-title">Token 使用量</div>
        <div className="stat-hero">{formatTokens(total)}</div>
        <div className="stat-hero-sub">总 tokens · {usage.requests} 次请求</div>
        <div className="stat-rows">
          <Row label="输入（未缓存）" value={formatTokens(usage.inputTokens)} />
          <Row label="缓存命中" value={formatTokens(usage.cacheReadTokens)} accent="good" />
          <Row label="缓存写入" value={formatTokens(usage.cacheWriteTokens)} />
          <Row label="输出" value={formatTokens(usage.outputTokens)} />
          {usage.reasoningTokens > 0 && <Row label="其中推理" value={formatTokens(usage.reasoningTokens)} />}
        </div>
      </div>

      <div className="stat-card">
        <div className="stat-card-title">缓存命中率</div>
        <div className="ring-wrap">
          <Ring percent={hitRate} />
          <div className="ring-side">
            <Row label="命中" value={formatTokens(usage.cacheReadTokens)} accent="good" />
            <Row label="未命中" value={formatTokens(usage.inputTokens + usage.cacheWriteTokens)} />
          </div>
        </div>
      </div>

      <div className="stat-card todo-card">
        <div className="task-card-head">
          <div className="task-card-tabs">
            <button
              className={`task-tab ${taskTab === 'todos' ? 'active' : ''}`}
              onClick={() => setTaskTab('todos')}
            >
              任务列表
            </button>
            <button
              className={`task-tab ${taskTab === 'subagents' ? 'active' : ''}`}
              onClick={() => setTaskTab('subagents')}
            >
              子代理列表{subagents.length > 0 ? ` ${subagents.length}` : ''}
            </button>
          </div>
        </div>
        {taskTab === 'todos' ? (
          <>
            {todos.length === 0 && <div className="todo-empty">暂无任务，agent 创建计划后显示在这里</div>}
            <ul className="todo-list">
              {todos.map((t, i) => (
                <li key={i} className={`todo-item ${t.status}`}>
                  <span className={`todo-check ${t.status}`}>
                    {t.status === 'completed' && (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                        strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                    )}
                    {t.status === 'in_progress' && <span className="spinner tiny" />}
                  </span>
                  <span className={`todo-text ${t.status}`}>{t.content}</span>
                  <span className="todo-state">{TODO_LABELS[t.status] ?? t.status}</span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <div className="subagent-summary" title="正在工作 / 待命 / 已关闭">
              <span className="subagent-sum-item"><span className="subagent-status-dot running" />{runningCount}</span>
              <span className="subagent-sum-item"><span className="subagent-status-dot ok" />{standbyCount}</span>
              <span className="subagent-sum-item"><span className="subagent-status-dot failed" />{closedCount}</span>
            </div>
            {subagents.length === 0 && <div className="todo-empty">暂无子代理，主代理派生子任务后显示在这里</div>}
            {subagents.map(sa => (
              <button
                key={sa.id}
                className="subagent-item"
                onClick={() => onOpenSubagent?.(sa.id)}
                onContextMenu={e => {
                  e.preventDefault()
                  setCtx({
                    x: Math.min(e.clientX, window.innerWidth - 150),
                    y: Math.min(e.clientY, window.innerHeight - 90),
                    id: sa.id,
                  })
                }}
                title="点击查看子代理对话，右键可删除"
              >
                {sa.status === 'ok' && !sa.viewed && <span className="unread-dot" />}
                <span className="subagent-index">{sa.index}</span>
                <span className="subagent-status-dot mini running-check">
                  {sa.status === 'running'
                    ? <span className="spinner tiny" />
                    : <span className={`dot-fill ${sa.status === 'ok' ? 'ok' : 'failed'}`} />}
                </span>
                <span className="subagent-item-title">{sa.title || sa.id.slice(0, 8)}</span>
                <span className="subagent-item-state">{subagentState(sa)}</span>
              </button>
            ))}
          </>
        )}
      </div>

      {ctx && (
        <div
          className="ctx-menu"
          style={{ left: ctx.x, top: ctx.y }}
          onMouseDown={e => e.stopPropagation()}
        >
          <button className="danger" onClick={() => { window.dsh.deleteSubagent(ctx.id); setCtx(null) }}>
            删除子代理
          </button>
        </div>
      )}
    </aside>
  )
}
