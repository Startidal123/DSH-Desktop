// Boot loader: tiny on purpose — it must never fail to load itself.
// Responsibilities: (1) roll back a broken self-update before main loads,
// (2) clear stale rollback dirs from healthy boots, (3) import main.mjs and
// heal the install if that import itself throws.
// IMPORTANT: main.mjs must be imported at the TOP LEVEL (not inside
// whenReady) — it calls protocol.registerSchemesAsPrivileged, which is only
// legal before app 'ready'.
import { app } from 'electron'
import { existsSync, rmSync, renameSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

const electronDir = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const appDir = join(electronDir, '..')
const appOld = join(appDir, '..', 'app-old')
const appNext = join(appDir, '..', 'app-next')
const bootFlag = join(app.getPath('userData'), 'client-boot-ok')

function rollback() {
  try {
    renameSync(appDir, join(appDir, '..', 'app-broken'))
    renameSync(appOld, appDir)
    rmSync(join(appDir, '..', 'app-broken'), { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

// pre-main hygiene: resolve any half-finished update state synchronously.
// boot-ok is only trusted when it names THIS payload's commit — a flag left
// by the previous install must not clear the rollback dir for a newer,
// never-booted payload.
let bootOkForThisPayload = false
try {
  const installed = readFileSync(join(appDir, '.installed-commit'), 'utf8').trim()
  bootOkForThisPayload = existsSync(bootFlag) && readFileSync(bootFlag, 'utf8').trim() === installed
} catch { /* absent markers = first boot */ }
try { rmSync(bootFlag, { force: true }) } catch { /* absent is fine */ }
if (existsSync(appNext)) rmSync(appNext, { recursive: true, force: true })
if (existsSync(appOld)) {
  if (!bootOkForThisPayload) {
    // this payload never booted successfully — the update was bad, undo it
    rollback()
  } else {
    rmSync(appOld, { recursive: true, force: true })
  }
}

try {
  await import('./main.mjs')
} catch (err) {
  console.error('[loader] main.mjs failed to load:', err)
  // blacklist the poisoned commit so silent updates never retry it in a loop
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    const bad = readFileSync(join(appDir, '.installed-commit'), 'utf8').trim()
    writeFileSync(join(app.getPath('userData'), 'client-bad-commit'), bad)
  } catch { /* best effort */ }
  if (existsSync(appOld) && rollback()) {
    app.relaunch()
    app.quit()
  } else {
    // nothing to roll back to — surface the error on screen once ready
    app.whenReady().then(async () => {
      const { BrowserWindow } = await import('electron')
      const win = new BrowserWindow({ width: 520, height: 260, backgroundColor: '#0d1117' })
      win.loadURL('data:text/html,<body style="background:%230d1117;color:%23ff8078;font-family:Consolas,monospace;padding:24px;font-size:13px;white-space:pre-wrap">客户端主进程加载失败：' + encodeURIComponent(String(err?.message ?? err)) + '</body>')
    })
  }
}
