import { useEffect, useState } from 'react'
import { IconFolder } from './Icons.jsx'

const TABS = [
  { id: 'general', label: '通用' },
  { id: 'keys', label: '模型密钥' },
  { id: 'update', label: '更新' },
  { id: 'system', label: '系统' },
]

/** busy = busy reported by main (task already running, e.g. renderer reloaded
 *  mid-pipeline or the modal was closed when it started) */
function usePipelineStatus(fetch, lines, terminalTest) {
  const [status, setStatus] = useState(null)
  useEffect(() => {
    fetch().then(setStatus).catch(() => setStatus(null))
  }, [])
  // refresh when the log settles so version/commit info is current
  useEffect(() => {
    const last = lines[lines.length - 1]
    if (last && terminalTest(last)) fetch().then(setStatus).catch(() => {})
  }, [lines.length])
  return status
}

function ProgressLog({ lines }) {
  if (lines.length === 0) return null
  return <pre className="harness-log">{lines.join('\n')}</pre>
}

function ClientUpdateSection({ lines }) {
  const status = usePipelineStatus(
    () => window.dsh.clientStatus(),
    lines,
    t => /已是最新|已更新|失败|跳过/.test(t),
  )
  const [running, setRunning] = useState(false)
  useEffect(() => { setRunning(status?.busy === true) }, [status?.busy])
  // any non-terminal line that just arrived means a task is in flight
  useEffect(() => {
    const last = lines[lines.length - 1]
    if (!last) return
    if (/已是最新|已更新|失败|跳过/.test(last)) setRunning(false)
    else if (lines.length > 0) setRunning(true)
  }, [lines.length])

  const act = async () => {
    if (running) return
    setRunning(true)
    const res = await window.dsh.clientUpdate()
    if (!res.ok) setRunning(false)
    if (res.devMode) setRunning(false)
  }

  return (
    <div className="harness-section">
      <h4>客户端更新</h4>
      <div className="harness-status-line">
        {status === null ? '读取状态中…' : status.devMode
          ? '开发模式（源码运行）'
          : status.commit
            ? `已装 ${status.commit.slice(0, 8)} · 构建 ${status.builtAt ? new Date(status.builtAt).toLocaleString() : '—'}`
            : '初始安装（未记录版本）'}
      </div>
      <div className="harness-actions">
        <button className="btn primary" disabled={running} onClick={act}>
          {running ? '更新中…' : '检查客户端更新'}
        </button>
      </div>
      <ProgressLog lines={lines} />
    </div>
  )
}

function HarnessUpdateSection({ lines }) {
  const status = usePipelineStatus(
    () => window.dsh.harnessStatus(),
    lines,
    t => /已是最新|更新完成|已确认|失败/.test(t),
  )
  const [running, setRunning] = useState(false)
  useEffect(() => { setRunning(status?.busy === true) }, [status?.busy])
  useEffect(() => {
    const last = lines[lines.length - 1]
    if (!last) return
    if (/已是最新|更新完成|已确认|失败/.test(last)) setRunning(false)
    else setRunning(true)
  }, [lines.length])

  const act = async (fn) => {
    if (running) return
    setRunning(true)
    const res = await fn()
    if (!res.ok) setRunning(false)
  }

  return (
    <div className="harness-section">
      <h4>Harness 更新</h4>
      <div className="harness-status-line">
        {status === null ? '读取状态中…' : !status.ok
          ? `状态异常：${status.error ?? ''}`
          : `v${status.version} · ${status.head} · ${status.built ? (status.patched ? '补丁已应用' : '补丁缺失') : '未构建'} · 工具 ${['git', 'node', 'pnpm'].map(t => `${t}:${status.tools?.[t] === 'system' ? '系统' : status.tools?.[t] === 'bundled' ? '内置' : '待装'}`).join(' ')}`}
      </div>
      <div className="harness-actions">
        <button className="btn primary" disabled={running} onClick={() => act(() => window.dsh.harnessUpdate())}>
          {running ? '执行中…' : '检查并更新'}
        </button>
        <button className="btn ghost" disabled={running} onClick={() => act(() => window.dsh.applyHarnessPatches())} title="强制重装依赖并重建 harness（修复依赖损坏）">
          重装并重建
        </button>
      </div>
      <ProgressLog lines={lines} />
    </div>
  )
}

function ContextMenuToggle() {
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(false)

  const refresh = () => window.dsh.contextMenuStatus().then(setStatus).catch(() => setStatus(null))
  useEffect(() => { refresh() }, [])

  const act = async () => {
    setBusy(true)
    const res = await (status?.registered
      ? window.dsh.unregisterContextMenu()
      : window.dsh.registerContextMenu())
    setBusy(false)
    if (!res.ok) alert('操作失败：' + (res.error ?? ''))
    refresh()
  }

  return (
    <div className="sys-row">
      <div>
        <div className="sys-label">文件夹右键菜单</div>
        <div className="ctx-menu-hint">右键文件夹 →「用 DSH Client 打开」即以该目录为工作区</div>
      </div>
      <button
        className={`ctx-menu-btn ${status?.registered ? 'on' : ''}`}
        disabled={busy}
        onClick={act}
      >
        {busy ? '…' : status?.registered ? '已注册 ✓' : '注册'}
      </button>
    </div>
  )
}

export default function SettingsModal({ config, hasApiKey, harnessLines, clientLines, onClose, onSave, onPickWorkspace }) {
  const [tab, setTab] = useState('general')
  const [saving, setSaving] = useState(false)
  const [workspace, setWorkspace] = useState(config.workspace ?? '')
  const [harnessDir, setHarnessDir] = useState(config.harnessDir ?? '')
  const [repo, setRepo] = useState(config.harnessRepo ?? '')
  const [auto, setAuto] = useState(config.harnessAutoUpdate === true)
  const [locs, setLocs] = useState(null)
  const [dsApiKey, setDsApiKey] = useState(config.dsApiKey ?? '')
  const [dsBaseUrl, setDsBaseUrl] = useState(config.dsBaseUrl ?? '')
  const officialSelected = !config.activeCustom

  useEffect(() => {
    window.dsh.configLocations().then(setLocs).catch(() => setLocs(null))
  }, [])

  const save = async () => {
    setSaving(true)
    await onSave({
      workspace,
      harnessDir,
      harnessRepo: repo.trim(),
      harnessAutoUpdate: auto,
      dsApiKey: dsApiKey.trim(),
      dsBaseUrl: dsBaseUrl.trim(),
    })
    setSaving(false)
    onClose()
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal settings-modal" onClick={e => e.stopPropagation()}>
        <div className="settings-head">
          <h3>设置</h3>
        </div>

        <div className="settings-body">
          <nav className="settings-nav">
            {TABS.map(t => (
              <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ))}
          </nav>

          <div className="settings-content">
            {tab === 'general' && (
              <>
                <div className="field">
                  <span>工作区目录</span>
                  <div className="field-row">
                    <input value={workspace} onChange={e => setWorkspace(e.target.value)} />
                    <button className="icon-btn" onClick={async () => {
                      const dir = await onPickWorkspace()
                      if (dir) setWorkspace(dir)
                    }}>
                      <IconFolder />
                    </button>
                  </div>
                  <div className="field-hint">agent 在此目录读写文件；默认为客户端目录下 workspace</div>
                </div>

                <div className="field">
                  <span>Harness 仓库路径</span>
                  <div className="field-row">
                    <input value={harnessDir} onChange={e => setHarnessDir(e.target.value)} />
                    <button className="icon-btn" onClick={async () => {
                      const dir = await onPickWorkspace()
                      if (dir) setHarnessDir(dir)
                    }}>
                      <IconFolder />
                    </button>
                  </div>
                  <div className="field-hint">默认为客户端目录下 harness；不存在时由「更新」页自动克隆部署</div>
                </div>
              </>
            )}

            {tab === 'keys' && (
              <>
                <div className="harness-section">
                  <h4>DeepSeek 官方模型密钥</h4>
                  <label className="field">
                    <span>API Key</span>
                    <input
                      type="password"
                      value={dsApiKey}
                      onChange={e => setDsApiKey(e.target.value)}
                      placeholder="sk-..."
                      autocomplete="off"
                    />
                  </label>
                  <label className="field">
                    <span>Base URL（可选，留空用官方默认）</span>
                    <input
                      value={dsBaseUrl}
                      onChange={e => setDsBaseUrl(e.target.value)}
                      placeholder="https://api.deepseek.com"
                      autocomplete="off"
                    />
                    <div className="field-hint">也可指向任意 OpenAI 兼容端点（配合模型下拉的官方目录使用）</div>
                  </label>
                  {!officialSelected && (
                    <div className="field-hint">当前使用自定义模型（密钥在主界面模型下拉中管理），以下官方密钥暂不生效但会保存</div>
                  )}
                </div>

                <div className={`api-key-note ${hasApiKey ? 'ok' : 'warn'}`}>
                  {hasApiKey
                    ? 'API 密钥已配置（官方设置、自定义模型或 .env 任一来源）'
                    : officialSelected
                      ? '未配置 API 密钥：在上方填入 DeepSeek 官方 API Key 即可使用官方模型'
                      : '未配置 API 密钥：当前为自定义模型，Key 在模型下拉的「添加自定义模型」里填写'}
                </div>
              </>
            )}

            {tab === 'update' && (
              <>
                <ClientUpdateSection lines={clientLines} />
                <HarnessUpdateSection lines={harnessLines} />
                <div className="harness-section">
                  <h4>自动更新</h4>
                  <label className="field">
                    <span>发布仓库地址（GitHub，网络不通时自动走镜像加速）</span>
                    <input value={repo} onChange={e => setRepo(e.target.value)} placeholder="https://github.com/<你>/DSH-Desktop" />
                  </label>
                  <label className="checkbox-field">
                    <input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)} />
                    <span>启动时自动检测并应用 harness 更新（含补丁与重建，空闲时静默执行）</span>
                  </label>
                </div>
              </>
            )}

            {tab === 'system' && (
              <>
                <div className="harness-section">
                  <h4>系统集成</h4>
                  <ContextMenuToggle />
                </div>

                <div className="harness-section">
                  <h4>配置文件</h4>
                  {locs ? (
                    <>
                      <div className="cfg-row"><span>模型配置</span><code>{locs.settings}</code></div>
                      <button className="btn ghost cfg-open" onClick={() => window.dsh.openConfigFolder()}>
                        打开配置文件夹
                      </button>
                    </>
                  ) : '读取中…'}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={save} disabled={saving}>
            {saving ? '保存中…' : '保存（必要时重启运行时）'}
          </button>
        </div>
      </div>
    </div>
  )
}
