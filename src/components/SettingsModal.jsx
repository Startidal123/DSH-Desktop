import { useEffect, useState } from 'react'
import { IconFolder } from './Icons.jsx'

const TABS = [
  { id: 'general', label: '通用' },
  { id: 'keys', label: '模型密钥' },
  { id: 'tools', label: '工具' },
  { id: 'update', label: '更新' },
  { id: 'debug', label: '调试' },
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

function ClientUpdateSection({ lines, onClear }) {
  const status = usePipelineStatus(
    () => window.dsh.clientStatus(),
    lines,
    t => /已是最新|已更新|失败|跳过|终止/.test(t),
  )
  const [running, setRunning] = useState(false)
  useEffect(() => { setRunning(status?.busy === true) }, [status?.busy])
  // any non-terminal line that just arrived means a task is in flight
  useEffect(() => {
    const last = lines[lines.length - 1]
    if (!last) return
    if (/已是最新|已更新|失败|跳过|终止/.test(last)) setRunning(false)
    else if (lines.length > 0) setRunning(true)
  }, [lines.length])

  const act = async () => {
    if (running) return
    onClear?.()
    setRunning(true)
    const res = await window.dsh.clientUpdate()
    if (!res.ok) setRunning(false)
    if (res.devMode) setRunning(false)
  }

  const forceStop = async () => {
    await window.dsh.resetUpdateTasks('client').catch(() => {})
    setRunning(false)
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
        <button className="btn ghost" onClick={forceStop} title="更新卡死时强制终止相关子进程并复位状态，之后可重新点击更新">
          强制终止
        </button>
      </div>
      <ProgressLog lines={lines} />
    </div>
  )
}

function HarnessUpdateSection({ lines, onClear }) {
  const status = usePipelineStatus(
    () => window.dsh.harnessStatus(),
    lines,
    t => /已是最新|更新完成|已确认|失败|终止/.test(t),
  )
  const [running, setRunning] = useState(false)
  useEffect(() => { setRunning(status?.busy === true) }, [status?.busy])
  useEffect(() => {
    const last = lines[lines.length - 1]
    if (!last) return
    if (/已是最新|更新完成|已确认|失败|终止/.test(last)) setRunning(false)
    else setRunning(true)
  }, [lines.length])

  const act = async (fn) => {
    if (running) return
    onClear?.()
    setRunning(true)
    const res = await fn()
    if (!res.ok) setRunning(false)
  }

  const forceStop = async () => {
    await window.dsh.resetUpdateTasks('harness').catch(() => {})
    setRunning(false)
  }

  return (
    <div className="harness-section">
      <h4>Harness 更新</h4>
      <div className="harness-status-line">
        {status === null ? '读取状态中…' : !status.ok
          ? `状态异常：${status.error ?? ''}`
          : `v${status.version} · ${status.head} · ${status.built ? (status.patched ? '补丁已应用' : '补丁缺失') : '未构建'}`}
      </div>
      <div className="field-hint">所需构建工具的状态与预装见「工具」页</div>
      <div className="harness-actions">
        <button className="btn primary" disabled={running} onClick={() => act(() => window.dsh.harnessUpdate())}>
          {running ? '执行中…' : '检查并更新'}
        </button>
        <button className="btn ghost" disabled={running} onClick={() => act(() => window.dsh.applyHarnessPatches())} title="强制重装依赖并重建 harness（修复依赖损坏）">
          重装并重建
        </button>
        <button className="btn ghost" onClick={forceStop} title="更新卡死时强制终止相关子进程并复位状态，之后可重新点击更新">
          强制终止
        </button>
      </div>
      <ProgressLog lines={lines} />
    </div>
  )
}

const TOOL_META = {
  git: { label: 'Git', desc: '克隆与更新 harness 仓库' },
  pnpm: { label: 'pnpm', desc: '安装依赖与构建 harness' },
  node: { label: 'Node.js', desc: '运行 harness；内置版为 Electron 硬链接（ELECTRON_RUN_AS_NODE 模式，无下载）' },
}

function ToolCard({ name, info, busy, onInstall, onStop }) {
  const meta = TOOL_META[name]
  const source = info?.source ?? 'missing'
  const sourceLabel = { system: '系统', bundled: '内置', missing: '缺失' }[source]
  return (
    <div className={`devtool-card ${source}`}>
      <div className="tool-card-head">
        <span className="tool-card-name">{meta.label}</span>
        <span className={`tool-source ${source}`}>{sourceLabel}</span>
      </div>
      <div className="tool-card-desc">{meta.desc}</div>
      {info?.version && <div className="tool-fact">版本 {info.version}</div>}
      {info?.path && <div className="tool-fact tool-path" title={info.path}>{info.path}</div>}
      {source !== 'system' && (
        <div className="harness-actions">
          {busy
            ? <button className="btn ghost" onClick={onStop} title="安装卡死时强制终止并复位状态">强制终止</button>
            : name === 'node'
              ? <button className="btn primary" onClick={() => onInstall(name)}>{source === 'missing' ? '重建 shim' : '重新重建'}</button>
              : <button className="btn primary" onClick={() => onInstall(name)}>{source === 'missing' ? '下载便携版' : '重新下载'}</button>}
        </div>
      )}
    </div>
  )
}

function ToolsSection({ lines, onClear }) {
  const [status, setStatus] = useState(null)
  const [running, setRunning] = useState(false)
  const refresh = () => window.dsh.toolchainStatus().then(setStatus).catch(() => setStatus(null))
  useEffect(() => { refresh() }, [])
  useEffect(() => { setRunning(status?.busy === true) }, [status?.busy])
  useEffect(() => {
    const last = lines[lines.length - 1]
    if (!last) return
    if (/已就绪|失败|终止/.test(last)) { setRunning(false); refresh() }
    else setRunning(true)
  }, [lines.length])

  const install = async (name) => {
    if (running) return
    onClear?.()
    setRunning(true)
    const res = await window.dsh.installTool(name)
    if (!res.ok) setRunning(false)
  }
  const forceStop = async () => {
    await window.dsh.resetUpdateTasks('tools').catch(() => {})
    setRunning(false)
  }

  const tools = status?.tools
  return (
    <div className="harness-section">
      <h4>构建工具</h4>
      <div className="field-hint">harness 部署与构建所需的三个工具；系统已有则直接使用，缺失时在此安装后再去「更新」——更新流程本身只使用、不再自动安装</div>
      {tools
        ? (
            <>
              <ToolCard name="git" info={tools.git} busy={running} onInstall={install} onStop={forceStop} />
              <ToolCard name="pnpm" info={tools.pnpm} busy={running} onInstall={install} onStop={forceStop} />
              <ToolCard name="node" info={tools.node} busy={running} onInstall={install} onStop={forceStop} />
            </>
          )
        : '读取状态中…'}
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

export default function SettingsModal({ config, hasApiKey, harnessLines, clientLines, toolLines, onClearProgress, onClose, onSave, onPickWorkspace }) {
  const [tab, setTab] = useState('general')
  const [saving, setSaving] = useState(false)
  const [workspace, setWorkspace] = useState(config.workspace ?? '')
  const [harnessDir, setHarnessDir] = useState(config.harnessDir ?? '')
  const [locs, setLocs] = useState(null)
  const [dsApiKey, setDsApiKey] = useState(config.dsApiKey ?? '')
  const [dsBaseUrl, setDsBaseUrl] = useState(config.dsBaseUrl ?? '')
  const [debugTools, setDebugTools] = useState(config.showToolActivity === true)
  const officialSelected = !config.activeCustom

  useEffect(() => {
    window.dsh.configLocations().then(setLocs).catch(() => setLocs(null))
  }, [])

  const save = async () => {
    setSaving(true)
    await onSave({
      workspace,
      harnessDir,
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

            {tab === 'tools' && <ToolsSection lines={toolLines} onClear={() => onClearProgress?.('tools')} />}

            {tab === 'update' && (
              <>
                <ClientUpdateSection lines={clientLines} onClear={() => onClearProgress?.('client')} />
                <HarnessUpdateSection lines={harnessLines} onClear={() => onClearProgress?.('harness')} />
                <div className="harness-section">
                  <h4>仓库信息</h4>
                  <div className="cfg-row">
                    <span>Harness 源码仓库</span>
                    <code>{config.harnessRepo || 'https://github.com/deepseek-ai/deepseek-harness'}</code>
                  </div>
                  <div className="field-hint">更新时自动走镜像加速；地址不可修改（如需自定义请编辑 settings.json 中的 harnessRepo）</div>
                </div>
              </>
            )}

            {tab === 'debug' && (
              <div className="harness-section">
                <h4>调试显示</h4>
                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={debugTools}
                    onChange={e => {
                      setDebugTools(e.target.checked)
                      onSave({ showToolActivity: e.target.checked })
                    }}
                  />
                  <span>在对话中显示工具调用与子代理启停消息（缩略标记置于模型气泡左上角，点击标记可展开详情）</span>
                </label>
                <div className="field-hint">默认关闭：对话只显示用户与模型的消息，保持界面纯净；需要排查执行过程或关注工具行为时再开启。错误信息不受此开关影响，始终显示。</div>
              </div>
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
                      <div className="cfg-row"><span>客户端配置</span><code>{locs.settings}</code></div>
                      <div className="cfg-row"><span>多模态模型目录</span><code>{locs.harnessConfig}</code></div>
                      <div className="cfg-row"><span>生成失败日志</span><code>{locs.errorLog}</code></div>
                      <div className="field-hint">图片等多模态模型需在 ~/.dsh/settings.yaml 的 llm-deepseek.models 中登记，条目加 inputModalities: [text, image]；未登记的模型按纯文本处理；errors.log 记录每次生成失败时的时间、生效端点与凭证状态（256KB 轮换）</div>
                      <div className="harness-actions">
                        <button className="btn ghost cfg-open" onClick={() => window.dsh.openConfigFolder()}>
                          打开客户端配置文件夹
                        </button>
                        <button className="btn ghost cfg-open" onClick={() => window.dsh.openConfigFolder('harness')}>
                          打开 harness 配置文件夹
                        </button>
                      </div>
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
