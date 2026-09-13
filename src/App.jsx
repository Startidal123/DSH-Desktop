import { useCallback, useEffect, useRef, useState } from 'react'
import Sidebar from './components/Sidebar.jsx'
import ChatPanel from './components/ChatPanel.jsx'
import StatsPanel from './components/StatsPanel.jsx'
import SettingsModal from './components/SettingsModal.jsx'
import { WhaleMark } from './components/WhaleMark.jsx'

const initial = {
  sessions: [],
  active: null,
  activeId: null,
}

export default function App() {
  const [state, setState] = useState(initial)
  const [runtimeStatus, setRuntimeStatus] = useState('stopped')
  const [error, setError] = useState('')
  const [patchWarn, setPatchWarn] = useState('')
  const [config, setConfig] = useState(null)
  const [hasApiKey, setHasApiKey] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [theme, setTheme] = useState(() => localStorage.getItem('dsh-theme') ?? 'dark')

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('dsh-theme', theme)
    window.dsh.setNativeTheme?.(theme).catch?.(() => {})
  }, [theme])

  useEffect(() => {
    const offSnapshot = window.dsh.onSnapshot(s => setState(s))
    const offRuntime = window.dsh.onRuntime(({ status, info }) => {
      setRuntimeStatus(status)
      if (status === 'dead') {
        setError(`运行时已退出${info?.code !== undefined ? `（代码 ${info.code}）` : ''}${info?.stderr ? `\n${info.stderr.slice(-500)}` : ''}`)
      }
      if (status === 'ready') setError('')
    })
    window.dsh.getState().then(s => {
      setConfig(s.config)
      setHasApiKey(s.hasApiKey)
      // seed the runtime badge from the live process state; notifications alone
      // miss the current status after a renderer reload (HMR) or silent start
      if (s.runtime === 'ready') setRuntimeStatus('ready')
      setState(prev => ({
        ...prev,
        sessions: s.sessions,
        activeId: null,
        active: null,
      }))
    })

    // reconcile the runtime badge every few seconds: a missed notification
    // (renderer reload, transient ipc hiccup) must not leave a stale "未连接"
    window.dsh.checkHarnessPatches().then(res => {
      setPatchWarn(res?.ok ? '' : (res?.reason ?? ''))
    }).catch(() => {})

    // harness pipeline results (manual or silent auto-update) refresh the
    // patch warning; failures surface in the warn bar
    const offHarness = window.dsh.onHarnessProgress(({ step, text }) => {
      if (step === 'done') {
        window.dsh.checkHarnessPatches().then(res => setPatchWarn(res?.ok ? '' : (res?.reason ?? ''))).catch(() => {})
      } else if (step === 'error') {
        setPatchWarn(`Harness 更新失败：${text}`)
      }
    })

    const statusTimer = setInterval(async () => {
      try {
        const s = await window.dsh.getState()
        setRuntimeStatus(prev => (prev === s.runtime ? prev : s.runtime))
      } catch { /* renderer tearing down */ }
    }, 5000)
    return () => { offSnapshot(); offRuntime(); offHarness(); clearInterval(statusTimer) }
  }, [])

  const refreshConfig = useCallback(async () => {
    const s = await window.dsh.getState()
    setConfig(s.config)
    setHasApiKey(s.hasApiKey)
  }, [])

  const send = useCallback(async (text, images, mode) => {
    setError('')
    const res = await window.dsh.sendPrompt(text, images, mode)
    if (!res.ok) setError(res.error)
  }, [])

  const saveConfig = useCallback(async draft => {
    const res = await window.dsh.updateConfig(draft)
    setConfig(draft)
    if (!res.ok) setError(res.error)
  }, [])

  const dsEffortRef = useRef(null)

  const switchModel = useCallback(async (provider, model) => {
    setError('')
    const isDS = provider === 'deepseek-official'
    const wasDS = !config.activeCustom
    const patch = { provider, model }
    if (!isDS) {
      if (wasDS) dsEffortRef.current = config.reasoningEffort || 'high'
      if ((config.reasoningEffort || 'high') !== 'off') patch.reasoningEffort = 'off'
    } else if (!wasDS && dsEffortRef.current) {
      patch.reasoningEffort = dsEffortRef.current
    }
    const res = await window.dsh.updateConfig(patch)
    if (res.ok) {
      await refreshConfig()
    } else {
      setError(res.error)
    }
  }, [config, refreshConfig])

  const switchWorkspace = useCallback(async () => {
    const dir = await window.dsh.pickWorkspace()
    if (!dir || dir === config?.workspace) return
    setError('')
    const res = await window.dsh.updateConfig({ workspace: dir })
    if (res.ok) {
      await refreshConfig()
    } else {
      setError(res.error)
    }
  }, [config?.workspace, refreshConfig])

  const switchEffort = useCallback(async reasoningEffort => {
    setError('')
    const res = await window.dsh.updateConfig({ reasoningEffort })
    if (res.ok) {
      setConfig(c => ({ ...c, reasoningEffort }))
    } else {
      setError(res.error)
    }
  }, [])

  if (!config) return <div className="boot">正在初始化…</div>

  return (
    <div className="app-shell">
      <div className="titlebar">
        <span className="titlebar-whale"><WhaleMark size={15} /></span>
        <span className="titlebar-name">DeepSeek Harness</span>
      </div>
      <div className="layout">
      <Sidebar
        sessions={state.sessions}
        activeId={state.activeId}
        runtimeStatus={runtimeStatus}
        onSelect={id => window.dsh.selectSession(id)}
        onNew={() => window.dsh.newSession()}
        onDelete={id => window.dsh.deleteSession(id)}
        onRename={(id, title) => window.dsh.renameSession(id, title)}
        onTogglePin={id => window.dsh.togglePinSession(id)}
        onToggleTheme={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
        theme={theme}
        onOpenSettings={() => setShowSettings(true)}
        onRestart={async () => {
          setError('')
          const res = await window.dsh.restart()
          if (!res.ok) setError(res.error)
        }}
      />
      <ChatPanel
        session={state.active}
        runtimeStatus={runtimeStatus}
        error={error}
        patchWarn={patchWarn}
        config={config}
        onSwitchModel={switchModel}
        onSwitchEffort={switchEffort}
        onConfigChanged={refreshConfig}
        onSwitchWorkspace={switchWorkspace}
        onSend={send}
      />
      <StatsPanel session={state.active} />
      {showSettings && (
        <SettingsModal
          config={config}
          hasApiKey={hasApiKey}
          onClose={() => setShowSettings(false)}
          onSave={saveConfig}
          onPickWorkspace={() => window.dsh.pickWorkspace()}
        />
      )}
      </div>
    </div>
  )
}
