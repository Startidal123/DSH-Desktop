import { useCallback, useEffect, useRef, useState } from 'react'
import Sidebar from './components/Sidebar.jsx'
import ChatPanel from './components/ChatPanel.jsx'
import StatsPanel from './components/StatsPanel.jsx'
import SettingsModal from './components/SettingsModal.jsx'

const initial = {
  sessions: [],
  active: null,
  activeId: null,
}

// progress lines for the two update pipelines live at App level: the settings
// modal can be closed and reopened mid-run without losing the log
const MAX_PROGRESS_LINES = 60

export default function App() {
  const [state, setState] = useState(initial)
  const [runtimeStatus, setRuntimeStatus] = useState('stopped')
  const [error, setError] = useState('')
  const [patchWarn, setPatchWarn] = useState('')
  const [config, setConfig] = useState(null)
  const [hasApiKey, setHasApiKey] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [theme, setTheme] = useState(() => localStorage.getItem('dsh-theme') ?? 'light')
  const [harnessLines, setHarnessLines] = useState([])
  const [clientLines, setClientLines] = useState([])
  const [updateBadge, setUpdateBadge] = useState(false)
  const [maximized, setMaximized] = useState(false)
  const [statsOpen, setStatsOpen] = useState(() => localStorage.getItem('dsh-stats-open') !== 'false')

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('dsh-theme', theme)
    window.dsh.updateConfig?.({ theme }).catch?.(() => {})
  }, [theme])

  useEffect(() => {
    window.dsh.winIsMaximized().then(setMaximized).catch(() => {})
    return window.dsh.onMaximized(setMaximized)
  }, [])

  useEffect(() => {
    const offSnapshot = window.dsh.onSnapshot(s => setState(s))
    const offRuntime = window.dsh.onRuntime(({ status, info }) => {
      setRuntimeStatus(status)
      if (status === 'dead') {
        const head = (info?.stderrHead ?? '').trim()
        const tail = (info?.stderr ?? '').slice(-400).trim()
        setError(`运行时已退出${info?.code !== undefined ? `（代码 ${info.code}）` : ''}${head ? `\n${head}` : ''}${tail && tail !== head ? `\n…\n${tail}` : ''}`)
      }
      if (status === 'ready') setError('')
    })
    window.dsh.getState().then(s => {
      setConfig(s.config)
      setHasApiKey(s.hasApiKey)
      // theme may also live in settings.json (main reads it for the native
      // buttons); if the renderer localStorage disagrees, settings wins
      if (s.config?.theme && s.config.theme !== theme) setTheme(s.config.theme)
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

    // both update pipelines report into App-level line buffers so the log
    // survives closing the settings modal mid-run
    const offHarness = window.dsh.onHarnessProgress(({ step, text }) => {
      setHarnessLines(prev => [...prev.slice(-(MAX_PROGRESS_LINES - 1)), text])
      if (step === 'done') {
        window.dsh.checkHarnessPatches().then(res => setPatchWarn(res?.ok ? '' : (res?.reason ?? ''))).catch(() => {})
      } else if (step === 'error') {
        setPatchWarn(`Harness 更新失败：${text}`)
      }
    })

    const offClient = window.dsh.onClientProgress(({ step, text }) => {
      setClientLines(prev => [...prev.slice(-(MAX_PROGRESS_LINES - 1)), text])
      // silent check found a newer payload: badge the settings button until
      // the user opens settings (the update tab is one click away)
      if (step === 'available') setUpdateBadge(true)
    })

    const statusTimer = setInterval(async () => {
      try {
        const s = await window.dsh.getState()
        setRuntimeStatus(prev => (prev === s.runtime ? prev : s.runtime))
      } catch { /* renderer tearing down */ }
    }, 5000)
    return () => { offSnapshot(); offRuntime(); offHarness(); offClient(); clearInterval(statusTimer) }
  }, [])

  const toggleStats = useCallback(() => {
    setStatsOpen(prev => {
      localStorage.setItem('dsh-stats-open', String(!prev))
      return !prev
    })
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
        <div className="titlebar-drag" onDoubleClick={() => window.dsh.winControl('maximize')} />
        <div className="titlebar-controls">
          <button className="win-btn" onClick={() => window.dsh.winControl('minimize')} title="最小化">
            <svg width="10" height="10" viewBox="0 0 10 10"><rect x="1" y="4.5" width="8" height="1" fill="currentColor" /></svg>
          </button>
          <button className="win-btn" onClick={() => window.dsh.winControl('maximize')} title={maximized ? '还原' : '最大化'}>
            {maximized ? (
              <svg width="10" height="10" viewBox="0 0 10 10">
                <rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
                <rect x="2.5" y="0.5" width="7" height="7" fill="var(--bg-panel)" stroke="currentColor" strokeWidth="1" />
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" /></svg>
            )}
          </button>
          <button className="win-btn win-close" onClick={() => window.dsh.winControl('close')} title="关闭">
            <svg width="10" height="10" viewBox="0 0 10 10"><path d="M0.5 0.5 9.5 9.5M9.5 0.5 0.5 9.5" stroke="currentColor" strokeWidth="1" fill="none" /></svg>
          </button>
        </div>
      </div>
      <div className={`layout ${state.active?.messages?.length && statsOpen ? '' : 'no-stats'}`}>
      <Sidebar
        sessions={state.sessions}
        activeId={state.activeId}
        config={config}
        runtimeStatus={runtimeStatus}
        updateBadge={updateBadge}
        onSelect={id => window.dsh.selectSession(id)}
        onNew={() => window.dsh.newSession()}
        onDelete={id => window.dsh.deleteSession(id)}
        onRename={(id, title) => window.dsh.renameSession(id, title)}
        onTogglePin={id => window.dsh.togglePinSession(id)}
        onToggleTheme={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
        theme={theme}
        onOpenSettings={() => { setUpdateBadge(false); setShowSettings(true) }}
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
      {state.active?.messages?.length > 0 && statsOpen && <StatsPanel session={state.active} />}
      {state.active?.messages?.length > 0 && (
        <div
          className="stats-edge"
          style={{ right: statsOpen ? 'var(--stats-w)' : '0' }}
        >
          <button className="stats-toggle" onClick={toggleStats} title={statsOpen ? '隐藏统计栏' : '显示统计栏'}>
            {statsOpen ? (
              <svg width="14" height="16" viewBox="0 0 12 16" fill="none" stroke="currentColor"
                strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 2l4 6-4 6" />
              </svg>
            ) : (
              <svg width="14" height="16" viewBox="0 0 12 16" fill="none" stroke="currentColor"
                strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 2 4 8l4 6" />
              </svg>
            )}
          </button>
        </div>
      )}
      {showSettings && (
        <SettingsModal
          config={config}
          hasApiKey={hasApiKey}
          harnessLines={harnessLines}
          clientLines={clientLines}
          onClose={() => setShowSettings(false)}
          onSave={saveConfig}
          onPickWorkspace={() => window.dsh.pickWorkspace()}
        />
      )}
      </div>
    </div>
  )
}
