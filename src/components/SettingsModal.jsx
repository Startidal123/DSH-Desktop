import { useEffect, useState } from 'react'
import { IconFolder } from './Icons.jsx'

function ClientUpdateSection({ config }) {
  const [status, setStatus] = useState(null)
  const [running, setRunning] = useState(false)
  const [lines, setLines] = useState([])

  useEffect(() => {
    window.dsh.clientStatus().then(setStatus).catch(() => setStatus(null))
  }, [])

  useEffect(() => {
    const off = window.dsh.onClientProgress(({ text }) => {
      setLines(prev => [...prev.slice(-6), text])
      if (/已是最新|已更新|失败/.test(text)) setRunning(false)
    })
    return off
  }, [])

  const act = async () => {
    if (running) return
    setRunning(true)
    setLines(['开始…'])
    const res = await window.dsh.clientUpdate()
    if (!res.ok) {
      setLines(prev => [...prev, '失败：' + (res.error ?? '未知错误')])
      setRunning(false)
    } else if (res.devMode) {
      setLines(['开发模式不适用客户端自更新'])
      setRunning(false)
    }
  }

  return (
    <>
      <div className="harness-status-line">
        {status === null ? '读取状态中…' : status.devMode
          ? '开发模式（源码运行）'
          : status.commit
            ? `已装 ${status.commit.slice(0, 8)} · 构建 ${status.builtAt ? new Date(status.builtAt).toLocaleString() : '—'}`
            : '初始安装（未记录版本）'}
      </div>
      <div className="harness-actions">
        <button className="btn primary" disabled={running} onClick={act}>
          {running ? '检查中…' : '检查客户端更新'}
        </button>
      </div>
      {lines.length > 0 && <pre className="harness-log">{lines.join('\n')}</pre>}
    </>
  )
}

function HarnessUpdateSection({ repo, auto }) {
  const [status, setStatus] = useState(null)
  const [running, setRunning] = useState(false)
  const [lines, setLines] = useState([])

  useEffect(() => {
    window.dsh.harnessStatus().then(setStatus).catch(() => setStatus(null))
  }, [])

  useEffect(() => {
    const off = window.dsh.onHarnessProgress(({ step, text }) => {
      setLines(prev => [...prev.slice(-8), text])
      if (step === 'done' || step === 'error') {
        setRunning(false)
        if (step === 'done') window.dsh.harnessStatus().then(setStatus).catch(() => {})
      }
    })
    return off
  }, [])

  const act = async (fn) => {
    if (running) return
    setRunning(true)
    setLines(['开始…'])
    const res = await fn()
    if (!res.ok) {
      setLines(prev => [...prev, '失败：' + (res.error ?? '未知错误')])
      setRunning(false)
    }
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
        <button className="btn ghost" disabled={running} onClick={() => act(() => window.dsh.applyHarnessPatches())}>
          仅应用补丁
        </button>
      </div>

      {lines.length > 0 && (
        <pre className="harness-log">{lines.join('\n')}</pre>
      )}
    </div>
  )
}

function ContextMenuButton() {
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(false)

  const refresh = () => window.dsh.contextMenuStatus().then(setStatus).catch(() => setStatus(null))
  useEffect(() => { refresh() }, [])

  const act = async (fn) => {
    setBusy(true)
    const res = await fn()
    setBusy(false)
    if (!res.ok) alert('操作失败：' + (res.error ?? ''))
    refresh()
  }

  return (
    <div className="ctx-menu-wrap">
      <button
        className={`ctx-menu-btn ${status?.registered ? 'on' : ''}`}
        disabled={busy}
        title={status?.registered
          ? '已注册文件夹右键菜单（点击移除）'
          : '注册到文件夹右键菜单：右键任意文件夹 →「用 DSH Client 打开」即以该文件夹为工作区启动'}
        onClick={() => act(() => status?.registered
          ? window.dsh.unregisterContextMenu()
          : window.dsh.registerContextMenu())}
      >
        {busy ? '…' : status?.registered ? '右键菜单 ✓' : '右键菜单'}
      </button>
      <div className="ctx-menu-hint">
        {status?.registered ? '右键文件夹可直接启动' : '注册后可右键文件夹启动'}
      </div>
    </div>
  )
}

export default function SettingsModal({ config, hasApiKey, onClose, onSave, onPickWorkspace }) {
  const [saving, setSaving] = useState(false)
  const [workspace, setWorkspace] = useState(config.workspace ?? '')
  const [harnessDir, setHarnessDir] = useState(config.harnessDir ?? '')
  const [repo, setRepo] = useState(config.harnessRepo ?? '')
  const [auto, setAuto] = useState(config.harnessAutoUpdate === true)
  const [locs, setLocs] = useState(null)

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
    })
    setSaving(false)
    onClose()
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="settings-head">
          <h3>设置</h3>
          <ContextMenuButton />
        </div>

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
          <span>Harness 仓库路径（不存在时由下方“检查并更新”自动克隆部署）</span>
          <div className="field-row">
            <input value={harnessDir} onChange={e => setHarnessDir(e.target.value)} />
            <button className="icon-btn" onClick={async () => {
              const dir = await onPickWorkspace()
              if (dir) setHarnessDir(dir)
            }}>
              <IconFolder />
            </button>
          </div>
          <div className="field-hint">默认为客户端目录下 harness</div>
        </div>

        <div className="harness-section">
          <h4>客户端更新</h4>
          <ClientUpdateSection config={config} />
        </div>

        <div className="harness-section">
          <h4>Harness 更新</h4>
          <label className="field">
            <span>仓库地址（GitHub，网络不通时自动走镜像加速）</span>
            <input value={repo} onChange={e => setRepo(e.target.value)} placeholder="https://github.com/deepseek-ai/deepseek-harness" />
          </label>
          <label className="checkbox-field">
            <input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)} />
            <span>启动时自动检测并应用更新（含补丁与重建）</span>
          </label>
          <HarnessUpdateSection repo={repo} auto={auto} />
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

        <div className={`api-key-note ${hasApiKey ? 'ok' : 'warn'}`}>
          {hasApiKey
            ? 'API 密钥已配置（自定义模型携带或 .env）'
            : '未配置 API 密钥（三种方式任选）：① 模型下拉 → 添加自定义模型时填写 Key；② 在客户端目录（exe 同级）创建 .env 写入 DEEPSEEK_API_KEY=sk-...；③ 在 harness 目录的 .env 中写入后重启'}
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
