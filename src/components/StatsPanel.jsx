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

export default function StatsPanel({ session }) {
  const hasData = session && Array.isArray(session.messages) && session.messages.length > 0

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
  const todos = session?.todos ?? []
  const approvals = session?.approvals ?? []

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
        <div className="stat-card-title">任务清单</div>
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
      </div>
    </aside>
  )
}
