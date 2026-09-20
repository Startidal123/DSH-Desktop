import { app, BrowserWindow, ipcMain, dialog, protocol, net, shell } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, renameSync } from 'node:fs'
import { execSync, exec } from 'node:child_process'
import { resolve, join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { DshRuntime } from './dsh-runtime.mjs'
import { DEFAULT_REPO, harnessStatus, updateHarness, applyPatchOnly, setToolchain, probeNetwork } from './harness-update.mjs'
import { resolveTools, toolchainStatus, installTool } from './toolchain.mjs'
import { clientStatus, clientUpdate } from './client-update.mjs'
import { killAll } from './proc-registry.mjs'

const isDev = process.argv.includes('--dev')
const forceSoftwareGpu = process.argv.includes('--disable-gpu')
if (forceSoftwareGpu) app.disableHardwareAcceleration()
let win = null
let runtime = null

/** Client root: project dir in dev, the exe's folder when packaged — harness
 *  and workspace default to siblings of the executable for portability. */
const appRoot = app.isPackaged ? dirname(app.getPath('exe')) : resolve(app.getAppPath())
const DEFAULT_HARNESS_DIR = join(appRoot, 'harness')
const DEFAULT_WORKSPACE = join(appRoot, 'workspace')

/** `--workspace <dir>` (context-menu launch) overrides the saved workspace. */
function workspaceFromArgv(argv = process.argv) {
  const i = argv.indexOf('--workspace')
  if (i === -1 || i + 1 >= argv.length) return ''
  const v = argv[i + 1]
  return v && !v.startsWith('--') ? v : ''
}

const attachmentsDir = () => resolve(app.getPath('userData'), 'attachments')

protocol.registerSchemesAsPrivileged([
  { scheme: 'dshimg', privileges: { standard: false, stream: true, supportFetchAPI: true } },
])

// A force-killed Electron leaves its SDK runtime subprocess orphaned; an
// orphan holds the cross-process write lease of its sessions, and any later
// resume of those ids fails with "already owned". We are the only legitimate
// parent of these processes, so reap leftovers before spawning our own.
function killOrphanRuntimes() {
  try {
    const out = execSync(
      'wmic process where "name=\'node.exe\'" get ProcessId,CommandLine /format:csv',
      { encoding: 'utf8', windowsHide: true },
    )
    for (const line of out.split('\n')) {
      if (!line.includes('bin.js') || !line.includes('--profile sdk')) continue
      const cells = line.trim().split(',')
      const pid = Number(cells[cells.length - 1])
      if (Number.isInteger(pid) && pid > 0) {
        try { execSync(`taskkill /F /PID ${pid}`, { windowsHide: true }) } catch { /* already gone */ }
      }
    }
  } catch { /* best effort */ }
}

const settingsFile = () => resolve(app.getPath('userData'), 'settings.json')
const settingsBak = () => resolve(app.getPath('userData'), 'settings.json.bak')

/** Read + parse a settings file. Hand-edited files commonly carry a BOM or
 *  trailing commas (JSON forbids both) — retry leniently so the edit is
 *  recovered instead of the config resetting to defaults. Returns
 *  { data, from } with from describing the source. */
function readSettingsFile() {
  for (const [file, from] of [[settingsFile(), 'main'], [settingsBak(), 'bak']]) {
    try {
      if (!existsSync(file)) continue
      const text = readFileSync(file, 'utf8')
      try {
        return { data: JSON.parse(text), from }
      } catch {
        try {
          const fixed = JSON.parse(text.replace(/^\uFEFF/, '').replace(/,(\s*[}\]])/g, '$1'))
          console.warn(`[settings] ${file} 严格 JSON 解析失败，已宽松恢复（BOM/尾逗号容错）`)
          return { data: fixed, from: `${from}-lenient` }
        } catch { /* genuinely broken — try the backup */ }
      }
    } catch { /* unreadable */ }
  }
  return { data: {}, from: null }
}

function loadSettings() {
  return readSettingsFile().data
}

/** Atomic settings write: serialize to a temp file, then rename over the
 *  target — a truncated settings.json can never exist on disk. The previous
 *  version rotates into .bak, but only when it is parseable (a broken
 *  hand-edit goes to .bad for inspection instead of clobbering the good
 *  backup). */
function saveSettings(patch) {
  const { data, from } = readSettingsFile()
  const next = { ...data, ...patch }
  const target = settingsFile()
  const tmp = `${target}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(next, null, 2))
    if (existsSync(target)) {
      if (from === 'main' || from === 'main-lenient') {
        try { renameSync(target, settingsBak()) } catch { /* absent is fine */ }
      } else {
        console.warn(`[settings] settings.json 无法解析，已转存 ${target}.bad 供检查（本次写入基于备份/默认值）`)
        try { renameSync(target, `${target}.bad`) } catch { /* absent is fine */ }
      }
    }
    renameSync(tmp, target)
  } catch { /* best effort */ }
  return next
}

/** The freshest on-disk config (hand-edited settings.json survives), with
 *  critical fields falling back to the runtime's current values. Absorb it
 *  before applying any patch so fields we are not touching are never
 *  overwritten with stale in-memory values. */
function freshDiskConfig(rt) {
  const disk = { ...(loadSettings().config ?? {}) }
  if (!disk.harnessDir) disk.harnessDir = rt.config.harnessDir
  if (!disk.workspace) disk.workspace = rt.config.workspace
  if (!disk.provider) disk.provider = rt.config.provider
  if (!disk.model) disk.model = rt.config.model
  return disk
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

/**
 * Our five harness patches stamp a marker constant into the built server
 * bundle; if it is absent the harness build predates the patches (fresh
 * upstream pull without re-running patches/apply-patches.sh) and the client
 * degrades — surface that instead of failing silently.
 */
function checkHarnessPatches() {
  try {
    const bundle = resolve(ensureRuntime().config.harnessDir, 'packages/sdk/server/lib/index.js')
    if (!existsSync(bundle)) return { ok: false, reason: 'harness 未构建（缺少 packages/sdk/server/lib/index.js）' }
    const text = readFileSync(bundle, 'utf8')
    const ok = text.includes('session/approvalDecide') && text.includes('session/interrupt')
    return ok
      ? { ok: true }
      : { ok: false, reason: 'harness 缺少客户端补丁：在 dsh-client/patches 下运行 bash apply-patches.sh 并重建 harness' }
  } catch (err) {
    return { ok: false, reason: `检测失败：${err.message}` }
  }
}

function ensureRuntime() {
  if (runtime) return runtime
  runtime = new DshRuntime(
    snapshot => send('dsh:snapshot', snapshot),
    (status, info) => {
      send('dsh:runtime', { status, info })
      if (status === 'ready') reconnectAttempt = 0
      if (status === 'dead') handleRuntimeDeath(info)
    },
    resolve(app.getPath('userData'), 'sessions.json'),
    attachmentsDir(),
    { harnessDir: DEFAULT_HARNESS_DIR, workspace: DEFAULT_WORKSPACE },
  )
  const saved = loadSettings()
  const argWorkspace = workspaceFromArgv()
  if (saved.config) {
    const cfg = { ...saved.config }
    // sanitize legacy dirty values: a custom-model id once leaked into the
    // runtime provider route and was persisted; recover it into activeCustom
    if (typeof cfg.provider === 'string' && cfg.provider.startsWith('custom-')) {
      cfg.activeCustom = cfg.activeCustom || cfg.provider
      cfg.provider = 'deepseek-official'
    }
    // empty fields fall back to the portable defaults (fresh copy or cleaned)
    if (!cfg.harnessDir) cfg.harnessDir = DEFAULT_HARNESS_DIR
    if (!cfg.workspace) cfg.workspace = DEFAULT_WORKSPACE
    const wsChanged = !!argWorkspace && cfg.workspace !== argWorkspace
    if (argWorkspace) cfg.workspace = argWorkspace
    runtime.updateConfig(cfg)
    saveSettings({ config: runtime.config })
    // context-menu launch into a different workspace focuses a fresh
    // conversation there — same behavior as switching workspaces in-app
    if (wsChanged) runtime.focusWorkspaceSession()
  } else if (argWorkspace) {
    runtime.updateConfig({ workspace: argWorkspace })
    saveSettings({ config: runtime.config })
    runtime.focusWorkspaceSession()
  }
  try { mkdirSync(runtime.config.workspace, { recursive: true }) } catch { /* read-only media */ }
  return runtime
}

let reconnectAttempt = 0
let reconnectTimer = null

/** Auto-revive the runtime subprocess after unexpected exits, capped and back-off. */
function scheduleReconnect() {
  if (reconnectAttempt >= 5 || !runtime || runtime.restarting) return
  const delay = Math.min(2000 * 2 ** reconnectAttempt, 30000)
  reconnectAttempt += 1
  clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(async () => {
    try {
      await runtime.restart()
      reconnectAttempt = 0
    } catch {
      scheduleReconnect()
    }
  }, delay)
}

function createWindow() {
  let savedTheme = 'light'
  try { savedTheme = loadSettings().config?.theme ?? 'light' } catch { /* defaults */ }

  const devIcon = join(appRoot, 'build', 'icon.ico')
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: savedTheme === 'light' ? '#f6f8fa' : '#0d1117',
    title: 'DeepSeek Harness',
    autoHideMenuBar: true,
    // hidden titlebar WITHOUT overlay = no native caption buttons at all;
    // the window frame (shadow, resize borders) stays. We draw our own HTML
    // buttons in the titlebar — native ones proved uncontrollable on some
    // systems (stuck dark regardless of titleBarOverlay/nativeTheme).
    titleBarStyle: 'hidden',
    ...(existsSync(devIcon) ? { icon: devIcon } : {}),
    webPreferences: {
      preload: resolve(import.meta.dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  if (isDev) {
    win.webContents.session.clearCache().catch(() => {})
    win.loadURL('http://localhost:5173')
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(resolve(import.meta.dirname, '../dist/index.html'))
  }
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) {
      const text = `[renderer] ${message} (${source}:${line})`
      console.log(text)
      logCrash(text)
    }
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    const text = `[renderer-gone] ${details.reason} ${details.exitCode}`
    console.log(text)
    logCrash(text)
  })
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    const text = `[did-fail-load] ${code} ${desc} ${url}`
    console.log(text)
    logCrash(text)
  })
  win.webContents.on('preload-error', (_e, preloadPath, err) => {
    const text = `[preload-error] ${preloadPath}: ${err}`
    console.log(text)
    logCrash(text)
  })
  // boot health flag consumed by loader.mjs on the next launch: it must name
  // THIS payload's commit, so a flag left by the previous install never
  // clears the rollback dir for a newer never-booted payload
  win.once('ready-to-show', () => {
    try {
      mkdirSync(app.getPath('userData'), { recursive: true })
      const installed = readFileSync(join(app.getAppPath(), '.installed-commit'), 'utf8').trim()
      writeFileSync(join(app.getPath('userData'), 'client-boot-ok'), installed)
      rmSync(join(app.getPath('userData'), 'client-boot-attempt'), { force: true })
    } catch { /* best effort */ }
  })

  // forward maximize state so the HTML titlebar can swap ─/□ icons
  win.on('maximize', () => send('dsh:win-maximized', true))
  win.on('unmaximize', () => send('dsh:win-maximized', false))
  // warm the runtime up in the background so the first prompt is instant
  const rt = ensureRuntime()
  rt.ensureStarted().catch(() => { /* surfaced via prompt errors */ })
}

// Single instance: two concurrent processes each hold their own in-memory
// config and the last writer wins — the stale one silently wipes whatever
// the other saved (e.g. custom models). The second launch quits instead;
// a --workspace launch (context menu) is forwarded to the running instance.
const gotSingleInstance = app.requestSingleInstanceLock()
if (!gotSingleInstance) {
  app.quit()
}

app.on('second-instance', (_e, argv) => {
  const ws = workspaceFromArgv(argv)
  if (ws) {
    ;(async () => {
      try {
        const rt = ensureRuntime()
        if (rt.config.workspace !== ws) {
          rt.updateConfig({ ...freshDiskConfig(rt), workspace: ws })
          saveSettings({ config: rt.config })
          rt.focusWorkspaceSession()
          if (rt.child) await rt.restart().catch(() => {})
        }
      } catch { /* surfaced via runtime status */ }
    })()
  }
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.whenReady().then(() => {
  if (!gotSingleInstance) return // losing instance: quitting
  killOrphanRuntimes()
  protocol.handle('dshimg', (request) => {
    const name = decodeURIComponent(request.url.replace(/^dshimg:\/\//, ''))
    if (!/^[A-Za-z0-9-]+\.[a-z0-9]+$/i.test(name)) {
      return new Response(null, { status: 404 })
    }
    return net.fetch(pathToFileURL(resolve(attachmentsDir(), name)).toString())
  })
  createWindow()
  // silent client-version check (badge only; the user applies updates from
  // 设置 → 更新). Harness updates are strictly manual — silent patch+build
  // pipelines proved too fragile on flaky networks.
  const savedCfg = loadSettings().config ?? {}
  if (savedCfg.clientAutoUpdate !== false) {
    setTimeout(() => scheduleSilentUpdate(), 8000)
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

let moduleNotFoundRepaired = false

/** Runtime death triage: a broken harness install (missing node_modules entry
 *  — partial install, AV quarantine, store corruption) fails with
 *  ERR_MODULE_NOT_FOUND; clear the build stamp and force a full reinstall +
 *  rebuild once, then the pipeline restarts the runtime itself. */
function handleRuntimeDeath(info) {
  const text = `${info?.stderrHead ?? ''}\n${info?.stderr ?? ''}`
  try {
    logCrash(`runtime exit code=${info?.code ?? '?'} head=${(info?.stderrHead ?? '').replace(/\n/g, ' | ').slice(0, 400)}`)
  } catch { /* best effort */ }
  if (!moduleNotFoundRepaired && /ERR_MODULE_NOT_FOUND|Cannot find (module|package)/.test(text)) {
    moduleNotFoundRepaired = true
    send('dsh:runtime', { status: 'starting', info: { autoRepair: true } })
    ;(async () => {
      try {
        const rt = ensureRuntime()
        try { rmSync(join(rt.config.harnessDir, '.dsh-build-stamp'), { force: true }) } catch { /* absent */ }
        send('dsh:harnessProgress', { step: 'repair', text: '运行时依赖损坏（模块缺失），自动重装依赖并重建 harness…' })
        const res = await runHarnessPipeline({ patchesOnly: true })
        if (res.ok) reconnectAttempt = 0
        else scheduleReconnect()
      } catch {
        scheduleReconnect()
      }
    })()
    return
  }
  scheduleReconnect()
}

function scheduleSilentUpdate(attempt = 0) {
  if (attempt > 20) return // ~10 min cap, next launch retries
  const rt = ensureRuntime()
  const busy = [...rt.sessions.values()].some(s => s.status === 'running')
  console.log(`[silent-update] attempt=${attempt} busy=${busy}`)
  if (busy) {
    setTimeout(() => scheduleSilentUpdate(attempt + 1), 30000)
    return
  }
  silentSelfUpdate().catch(e => console.log('[silent-update] error', e?.message ?? e))
}

/** Detect-only client version check: notify the renderer (badge on the
 *  settings button) when a newer payload exists; the user applies it from
 *  设置 → 更新. */
async function silentSelfUpdate() {
  const cfg = ensureRuntime().config
  if (cfg.clientAutoUpdate !== false && cfg.clientUpdateRepo) {
    const tc = await resolveTools(appRoot)
    const { remoteHead } = await import('./client-update.mjs')
    const { clientStatus } = await import('./client-update.mjs')
    const remote = await remoteHead(cfg.clientUpdateRepo, tc.git)
    const current = clientStatus(app.getAppPath())
    if (remote.ok && remote.sha !== current.commit) {
      send('dsh:clientProgress', {
        step: 'available',
        text: `发现新版本（${remote.sha.slice(0, 8)}）`,
      })
    }
  }
}

/** Bumped by the force-reset IPC (per pipeline); pipelines capture their own
 *  counter at start and abort at the next step boundary (onStep) when it
 *  moves — so a stuck task can be killed and re-launched without restarting
 *  the client, and stopping one pipeline leaves the other untouched. */
let clientGen = 0
let harnessGen = 0
let toolsGen = 0

let updatingClient = false

async function runClientUpdate() {
  if (updatingClient) return { ok: false, error: '已有客户端更新任务在进行中' }
  if (!app.isPackaged) return { ok: true, updated: false, devMode: true }
  updatingClient = true
  const myGen = clientGen
  try {
    const rt = ensureRuntime()
    // a manual run clears the loader's rollback blacklist so the user can
    // force another attempt at a commit that once failed to boot
    const badFile = join(app.getPath('userData'), 'client-bad-commit')
    const badCommit = existsSync(badFile) ? readFileSync(badFile, 'utf8').trim() : ''
    if (badCommit) {
      try { rmSync(badFile, { force: true }) } catch { /* best effort */ }
    }
    // reuse the resolved (possibly bundled) git
    const tc = await resolveTools(appRoot)
    const res = await clientUpdate({
      appDir: app.getAppPath(),
      repoUrl: rt.config.clientUpdateRepo,
      gitBin: tc.git,
      userDataDir: app.getPath('userData'),
      ...(badCommit ? { skipCommit: badCommit } : {}),
      onStep: (step, text) => {
        if (myGen !== clientGen) throw new Error('更新任务已被强制终止')
        send('dsh:clientProgress', { step, text })
      },
    })
    if (res.updated) {
      if (res.mainChanged) {
        send('dsh:clientProgress', { step: 'relaunch', text: '主进程已更新，重启生效…' })
        setTimeout(() => { app.relaunch(); app.quit() }, 1200)
        return { ok: true, ...res, relaunch: true }
      }
      // renderer-only: reload the window to pick up new dist instantly
      if (win && !win.isDestroyed()) win.webContents.reload()
    }
    return { ok: true, ...res }
  } catch (err) {
    const msg = String(err.message ?? err)
    if (msg !== '更新任务已被强制终止') send('dsh:clientProgress', { step: 'error', text: `客户端更新失败：${msg}` })
    return { ok: false, error: msg }
  } finally {
    updatingClient = false
  }
}

ipcMain.handle('dsh:clientStatus', () => {
  if (!app.isPackaged) return { devMode: true, busy: updatingClient, ...clientStatus(app.getAppPath()) }
  return { busy: updatingClient, ...clientStatus(app.getAppPath()) }
})

ipcMain.handle('dsh:clientUpdate', () => runClientUpdate())

// A GPU crash on incompatible drivers renders as a silent black window; retry
// once with hardware acceleration disabled, which always works.
let gpuRetryDone = false
app.on('render-process-gone', (_e, _wc, details) => {
  logCrash(`render-process-gone: ${details.reason} ${details.exitCode}`)
  if (gpuRetryDone || details.reason === 'clean-exit') return
  gpuRetryDone = true
  app.disableHardwareAcceleration()
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  createWindow()
})

app.on('child-process-gone', (_e, details) => {
  if (details.type === 'GPU') logCrash(`gpu-process-gone: ${details.reason} ${details.exitCode}`)
})

/** Append crash diagnostics next to userData so black screens are diagnosable. */
function logCrash(message) {
  try {
    const file = resolve(app.getPath('userData'), 'crash.log')
    writeFileSync(file, `${new Date().toISOString()} ${message}\n`, { flag: 'a' })
  } catch { /* best effort */ }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async (event) => {
  if (runtime && !runtime.dead) {
    event.preventDefault()
    try { await runtime.stop() } catch { /* already gone */ }
    runtime = null
    app.quit()
  }
})

ipcMain.handle('dsh:checkHarnessPatches', () => checkHarnessPatches())

/** Copy the bundled patch out of the app (asar) so git can read a real file. */
function materializePatch() {
  const src = resolve(app.getAppPath(), 'patches/sdk-server.patch')
  if (!existsSync(src)) return null
  const dst = resolve(app.getPath('userData'), 'sdk-server.patch')
  writeFileSync(dst, readFileSync(src, 'utf8'))
  return dst
}

let updatingHarness = false

async function runHarnessPipeline({ patchesOnly = false } = {}) {
  if (updatingHarness) return { ok: false, error: '已有 harness 更新任务在进行中' }
  updatingHarness = true
  const myGen = harnessGen
  try {
    const rt = ensureRuntime()
    const onStep = (step, text) => {
      if (myGen !== harnessGen) throw new Error('更新任务已被强制终止')
      send('dsh:harnessProgress', { step, text })
    }
    // tools are managed solely by the settings 工具页 — the pipeline only
    // RESOLVES them (system command wins, bundled copy otherwise); missing
    // tools throw with guidance to 设置 → 工具
    setToolchain(await resolveTools(appRoot))
    const patch = materializePatch()
    if (!patch) return { ok: false, error: '补丁文件缺失（patches/sdk-server.patch）' }
    const repoUrl = rt.config.harnessRepo || DEFAULT_REPO
    // no local checkout means a from-scratch clone — that genuinely needs
    // network, so fail fast with guidance instead of a long clone timeout.
    // An existing checkout is handled local-first inside updateHarness and
    // degrades gracefully when offline.
    if (!patchesOnly && !existsSync(resolve(rt.config.harnessDir, '.git'))) {
      const probe = await probeNetwork()
      if (!probe.ok) {
        onStep('error', '网络检测失败（npm 镜像与 GitHub 均无响应），已终止更新。首次部署 harness 需要联网克隆仓库：请检查系统代理/VPN 与网络，处理好后再点「检查并更新」。')
        return { ok: false, error: '网络检测失败（npm 镜像与 GitHub 均无响应）' }
      }
    }
    const result = patchesOnly
      ? await applyPatchOnly({ harnessDir: rt.config.harnessDir, patchFile: patch, onStep })
      : await updateHarness({
        harnessDir: rt.config.harnessDir,
        patchFile: patch,
        repoUrl,
        onStep,
      })
    // reload the rebuilt artifacts (or boot a freshly deployed one)
    if (rt.child) {
      onStep('runtime', '重启运行时…')
      await rt.restart().catch(() => {})
    } else {
      onStep('runtime', '启动运行时…')
      await rt.ensureStarted().catch(() => {})
    }
    onStep('done', result.updated ? '更新完成' : result.offline ? '已是最新（网络不通未检查远端更新，当前为可用的本地构建）' : '已是最新（补丁与构建已确认）')
    return { ok: true, ...result }
  } catch (err) {
    const msg = String(err.message ?? err)
    // the reset IPC already told the user; don't double-report
    if (msg !== '更新任务已被强制终止') send('dsh:harnessProgress', { step: 'error', text: msg })
    return { ok: false, error: msg }
  } finally {
    updatingHarness = false
  }
}

ipcMain.handle('dsh:harnessStatus', async () => {
  const rt = ensureRuntime()
  const status = await harnessStatus(rt.config.harnessDir)
  return { ...status, busy: updatingHarness }
})

let installingTool = false

ipcMain.handle('dsh:toolchainStatus', async () => {
  return { tools: await toolchainStatus(appRoot), busy: installingTool }
})

ipcMain.handle('dsh:installTool', async (_e, name) => {
  if (installingTool) return { ok: false, error: '已有工具安装任务在进行中' }
  if (!['git', 'pnpm', 'node'].includes(name)) return { ok: false, error: `未知工具：${name}` }
  installingTool = true
  const myGen = toolsGen
  try {
    const { path } = await installTool(name, appRoot, process.execPath, (text) => {
      if (myGen !== toolsGen) throw new Error('更新任务已被强制终止')
      send('dsh:toolsProgress', { step: name, text })
    })
    send('dsh:toolsProgress', { step: 'done', text: `${name} 已就绪（${path}）` })
    return { ok: true, path }
  } catch (err) {
    const msg = String(err.message ?? err)
    if (msg !== '更新任务已被强制终止') send('dsh:toolsProgress', { step: 'error', text: `安装失败：${msg}` })
    return { ok: false, error: msg }
  } finally {
    installingTool = false
  }
})

/** Force-clear a stuck update task, scoped to one pipeline ('client' |
 *  'harness'): tree-kill that pipeline's children, abort its downloads,
 *  release its busy flag and invalidate it at the next step boundary —
 *  without disturbing the other pipeline. Lets the user re-launch the
 *  update without restarting the client. */
ipcMain.handle('dsh:resetUpdateTasks', (_e, target) => {
  const scope = target === 'client' || target === 'harness' || target === 'tools' ? target : 'all'
  let killed = 0
  if (scope === 'client' || scope === 'all') {
    killed += killAll('client')
    clientGen += 1
    updatingClient = false
  }
  if (scope === 'harness' || scope === 'all') {
    killed += killAll('harness')
    harnessGen += 1
    updatingHarness = false
  }
  if (scope === 'tools' || scope === 'all') {
    killed += killAll('tools')
    toolsGen += 1
    installingTool = false
  }
  const label = scope === 'client' ? '客户端更新任务' : scope === 'harness' ? 'harness 更新任务' : scope === 'tools' ? '工具安装任务' : '更新任务'
  const text = `已强制终止${label}${killed ? `（结束 ${killed} 个子进程/下载）` : ''}，可重新点击更新按钮`
  if (scope === 'client' || scope === 'all') send('dsh:clientProgress', { step: 'error', text })
  if (scope === 'harness' || scope === 'all') send('dsh:harnessProgress', { step: 'error', text })
  if (scope === 'tools' || scope === 'all') send('dsh:toolsProgress', { step: 'error', text })
  return { ok: true, killed }
})

ipcMain.handle('dsh:harnessUpdate', () => runHarnessPipeline())
ipcMain.handle('dsh:applyHarnessPatches', async () => {
  // manual invocation means "repair": force a full reinstall+rebuild instead
  // of letting a matching build stamp skip the work
  const rt = ensureRuntime()
  moduleNotFoundRepaired = false
  try { rmSync(join(rt.config.harnessDir, '.dsh-build-stamp'), { force: true }) } catch { /* absent */ }
  return runHarnessPipeline({ patchesOnly: true })
})

ipcMain.handle('dsh:configLocations', () => {
  const userData = app.getPath('userData')
  return {
    settings: resolve(userData, 'settings.json'),
    sessions: resolve(userData, 'sessions.json'),
    attachments: attachmentsDir(),
    crashLog: resolve(userData, 'crash.log'),
    errorLog: resolve(userData, 'errors.log'),
    folder: userData,
    // harness global config — the llm-deepseek model catalog where image
    // (multimodal) models are declared via inputModalities
    harnessConfig: resolve(homedir(), '.dsh', 'settings.yaml'),
    harnessConfigDir: resolve(homedir(), '.dsh'),
  }
})

ipcMain.handle('dsh:openConfigFolder', (_e, target) => {
  if (target === 'harness') {
    const dir = resolve(homedir(), '.dsh')
    mkdirSync(dir, { recursive: true })
    shell.openPath(dir)
  } else {
    shell.openPath(app.getPath('userData'))
  }
  return { ok: true }
})

ipcMain.handle('dsh:winControl', (_e, action) => {
  if (!win || win.isDestroyed()) return { ok: false }
  if (action === 'minimize') win.minimize()
  else if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize()
  else if (action === 'close') win.close()
  return { ok: true, maximized: win.isMaximized() }
})

ipcMain.handle('dsh:winIsMaximized', () => {
  return win && !win.isDestroyed() ? win.isMaximized() : false
})

// ---------- Explorer context-menu integration ----------
const MENU_KEY = 'HKCU\\Software\\Classes\\Directory\\shell\\DSHClient'
const MENU_TITLE = '用 DSH Client 打开'

/** Launch command: packaged exe directly; dev registers electron + app dir. */
function contextMenuCommand() {
  const exe = process.execPath
  return app.isPackaged
    ? `"${exe}" --workspace "%V"`
    : `"${exe}" "${appRoot}" --workspace "%V"`
}

ipcMain.handle('dsh:contextMenuStatus', () => {
  try {
    const out = execSync(`reg query "${MENU_KEY}\\command" /ve`, { encoding: 'utf8', windowsHide: true })
    return { registered: true, ours: out.includes(process.execPath) }
  } catch {
    return { registered: false, ours: false }
  }
})

ipcMain.handle('dsh:registerContextMenu', () => {
  try {
    const cmd = contextMenuCommand()
    for (const root of ['Directory\\shell', 'Directory\\Background\\shell']) {
      const key = `HKCU\\Software\\Classes\\${root}\\DSHClient`
      execSync(`reg add "${key}" /ve /d "${MENU_TITLE}" /f`, { windowsHide: true })
      execSync(`reg add "${key}" /ve /d "${MENU_TITLE}" /f /t REG_SZ`, { windowsHide: true })
      execSync(`reg add "${key}\\command" /ve /d "${cmd.replace(/"/g, '\\"')}" /f`, { windowsHide: true })
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err.message ?? err) }
  }
})

ipcMain.handle('dsh:unregisterContextMenu', () => {
  try {
    for (const root of ['Directory\\shell', 'Directory\\Background\\shell']) {
      execSync(`reg delete "HKCU\\Software\\Classes\\${root}\\DSHClient" /f`, { windowsHide: true })
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err.message ?? err) }
  }
})

ipcMain.handle('dsh:getState', () => {
  const rt = ensureRuntime()
  const hasApiKey = Boolean(
    (Array.isArray(rt.config.customModels) && rt.config.customModels.some(m => m.apiKey))
    || rt.config.dsApiKey
    || process.env.DEEPSEEK_API_KEY
    || (existsSync(resolve(process.cwd(), '.env'))
      && readFileSync(resolve(process.cwd(), '.env'), 'utf8').includes('DEEPSEEK_API_KEY'))
    || (existsSync(resolve(rt.config.harnessDir, '.env'))
      && readFileSync(resolve(rt.config.harnessDir, '.env'), 'utf8').includes('DEEPSEEK_API_KEY=')),
  )
  return {
    ...rt.getState(),
    hasApiKey,
  }
})

ipcMain.handle('dsh:newSession', () => ensureRuntime().newSession())
ipcMain.handle('dsh:selectSession', (_e, id) => ensureRuntime().selectSession(id))
ipcMain.handle('dsh:deleteSession', (_e, id) => ensureRuntime().deleteSession(id))
ipcMain.handle('dsh:subagentSession', (_e, id) => {
  const rt = ensureRuntime()
  const s = rt.sessions.get(String(id ?? ''))
  return s ? rt.snapshot(s) : null
})
ipcMain.handle('dsh:deleteSubagent', (_e, id) => ensureRuntime().deleteSubagent(String(id ?? '')))
ipcMain.handle('dsh:markSubagentViewed', (_e, id) => {
  ensureRuntime().markSubagentViewed(String(id ?? ''))
  return { ok: true }
})
ipcMain.handle('dsh:renameSession', (_e, id, title) => ensureRuntime().renameSession(id, title))
ipcMain.handle('dsh:togglePinSession', (_e, id) => ensureRuntime().togglePinSession(id))

ipcMain.handle('dsh:sendPrompt', async (_e, text, images, mode) => {
  const rt = ensureRuntime()
  try {
    const res = await rt.prompt(text, images, { plan: mode === 'plan' })
    return { ok: true, messageId: res?.messageId }
  } catch (err) {
    return { ok: false, error: err.message ?? String(err) }
  }
})

ipcMain.handle('dsh:interrupt', async () => {
  const rt = ensureRuntime()
  try {
    await rt.interrupt()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message ?? String(err) }
  }
})

ipcMain.handle('dsh:decideApproval', async (_e, approvalId, outcome) => {
  const rt = ensureRuntime()
  try {
    await rt.decideApproval(approvalId, outcome)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message ?? String(err) }
  }
})

ipcMain.handle('dsh:restart', async () => {
  const rt = ensureRuntime()
  moduleNotFoundRepaired = false
  try {
    await rt.restart()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message ?? String(err) }
  }
})

ipcMain.handle('dsh:updateConfig', async (_e, partial) => {
  const rt = ensureRuntime()
  const oldConfig = { ...rt.config }
  const patch = { ...partial }
  // custom models ride the deepseek-official route (the adapter honors
  // DEEPSEEK_BASE_URL for OpenAI-compatible endpoints); activeCustom keeps
  // the client-side identity
  if (typeof patch.provider === 'string' && patch.provider.startsWith('custom-')) {
    patch.activeCustom = patch.provider
    patch.provider = 'deepseek-official'
  } else if (patch.provider === 'deepseek-official') {
    patch.activeCustom = ''
  }
  rt.updateConfig({ ...freshDiskConfig(rt), ...patch })
  saveSettings({ config: rt.config })
  if (typeof patch.workspace === 'string' && patch.workspace && oldConfig.workspace !== rt.config.workspace) {
    rt.focusWorkspaceSession()
  }
  const needsRestart = ['provider', 'model', 'workspace', 'harnessDir', 'reasoningEffort', 'maxTokens', 'activeCustom', 'dsApiKey', 'dsBaseUrl']
    .some(k => oldConfig[k] !== rt.config[k])
  if (needsRestart && rt.child) {
    try {
      await rt.restart()
      return { ok: true, restarted: true }
    } catch (err) {
      return { ok: false, error: err.message ?? String(err) }
    }
  }
  return { ok: true, restarted: false }
})

ipcMain.handle('dsh:addCustomModel', async (_e, entry) => {
  const label = String(entry?.label ?? '').trim()
  const baseURL = String(entry?.baseURL ?? '').trim()
  const apiKey = String(entry?.apiKey ?? '').trim()
  const model = String(entry?.model ?? '').trim()
  if (!baseURL || !model) return { ok: false, error: 'baseURL 和模型 ID 必填' }
  const maxTokens = Number(entry?.maxTokens)
  const rt = ensureRuntime()
  const disk = freshDiskConfig(rt)
  const list = Array.isArray(disk.customModels) ? [...disk.customModels] : []
  const item = {
    label: label || model,
    baseURL,
    apiKey,
    model,
    provider: `custom-${Math.random().toString(36).slice(2, 8)}`,
    ...(Number.isInteger(maxTokens) && maxTokens > 0 ? { maxTokens } : {}),
  }
  list.push(item)
  rt.updateConfig({ ...disk, customModels: list })
  saveSettings({ config: rt.config })
  return { ok: true, item }
})

ipcMain.handle('dsh:removeCustomModel', async (_e, provider) => {
  const rt = ensureRuntime()
  const disk = freshDiskConfig(rt)
  const list = (Array.isArray(disk.customModels) ? disk.customModels : [])
    .filter(m => m.provider !== provider)
  const patch = { customModels: list }
  if (disk.activeCustom === provider) {
    patch.activeCustom = ''
    patch.provider = 'deepseek-official'
    patch.model = 'deepseek-v4-flash'
  }
  rt.updateConfig({ ...disk, ...patch })
  saveSettings({ config: rt.config })
  if (patch.activeCustom === '' && rt.child) {
    try { await rt.restart() } catch { /* surfaced via runtime status */ }
  }
  return { ok: true }
})

ipcMain.handle('dsh:listChangePlans', async () => {
  const rt = ensureRuntime()
  const dir = join(rt.config.workspace ?? process.cwd(), '.dsh-changes')
  const { promises: fsp } = await import('node:fs')
  if (!existsSync(dir)) return []
  try {
    const names = (await fsp.readdir(dir)).filter(f => f.toLowerCase().endsWith('.md'))
    const entries = await Promise.all(names.map(async (f) => {
      const full = join(dir, f)
      const [st, text] = await Promise.all([fsp.stat(full), fsp.readFile(full, 'utf8')])
      return {
        name: f,
        mtime: st.mtimeMs,
        title: (text.match(/^#\s+(.+)$/m)?.[1] ?? f.replace(/\.md$/i, '')),
        content: text,
      }
    }))
    return entries.sort((a, b) => b.mtime - a.mtime).slice(0, 20)
  } catch {
    return []
  }
})

ipcMain.handle('dsh:saveImage', async (_e, { base64, attachmentName, suggestedName }) => {
  let buffer = null
  let name = suggestedName || ''
  if (base64) {
    buffer = Buffer.from(base64, 'base64')
  } else if (attachmentName) {
    // validated like the dshimg:// protocol handler — no path traversal
    if (!/^[A-Za-z0-9-]+\.[a-z0-9]+$/i.test(attachmentName)) {
      return { ok: false, error: 'invalid attachment name' }
    }
    const full = resolve(attachmentsDir(), attachmentName)
    if (!existsSync(full)) return { ok: false, error: 'attachment not found' }
    buffer = readFileSync(full)
    if (!name) name = attachmentName
  }
  if (!buffer) return { ok: false, error: 'no image data' }
  if (!name) name = `dsh-image-${Date.now()}.png`
  const result = await dialog.showSaveDialog(win, {
    defaultPath: join(app.getPath('downloads'), name),
    filters: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
    ],
  })
  if (result.canceled || !result.filePath) return { ok: true, canceled: true }
  try {
    writeFileSync(result.filePath, buffer)
    return { ok: true, path: result.filePath }
  } catch (err) {
    return { ok: false, error: String(err.message ?? err) }
  }
})

ipcMain.handle('dsh:pickWorkspace', async () => {
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
  return result.canceled ? null : result.filePaths[0]
})
