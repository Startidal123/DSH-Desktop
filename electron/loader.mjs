// Boot loader: tiny on purpose — it must never fail to load itself.
// Update hygiene before main loads:
//   success flag (client-boot-ok) names the payload that last reached ready
//   attempt flag (client-boot-attempt) names the payload currently booting
// Rollback happens ONLY when the same payload was attempted before and never
// reached ready — a fresh update's first boot (attempt recorded now) always
// gets a clean chance, and a crash between import and ready triggers the
// rollback on the NEXT boot.
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
const userDataDir = app.getPath('userData')
const bootFlag = join(userDataDir, 'client-boot-ok')
const attemptFlag = join(userDataDir, 'client-boot-attempt')

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

function readFlag(path) {
  try { return readFileSync(path, 'utf8').trim() } catch { return null }
}

let currentCommit = null
try { currentCommit = readFileSync(join(appDir, '.installed-commit'), 'utf8').trim() } catch { /* dev / edge */ }

if (currentCommit !== null) {
  if (existsSync(appNext)) rmSync(appNext, { recursive: true, force: true })

  const provedHealthy = readFlag(bootFlag) === currentCommit
  if (existsSync(appOld)) {
    if (provedHealthy) {
      // this payload already reached ready before; the old dir is stale
      rmSync(appOld, { recursive: true, force: true })
    } else {
      const attemptedBefore = readFlag(attemptFlag) === currentCommit
      if (attemptedBefore) {
        // same payload tried and never reached ready — bad update, undo it
        try {
          mkdirSync(userDataDir, { recursive: true })
          writeFileSync(join(userDataDir, 'client-bad-commit'), currentCommit)
        } catch { /* best effort */ }
        if (rollback()) {
          app.relaunch()
          app.quit()
        } else {
          rmSync(appOld, { recursive: true, force: true })
        }
      }
      // else: first boot of a fresh update — fall through and give it a chance
    }
  }
  // record the attempt; ready-to-show (main.mjs) replaces it with the
  // success flag if this boot makes it
  try {
    mkdirSync(userDataDir, { recursive: true })
    writeFileSync(attemptFlag, currentCommit)
  } catch { /* best effort */ }
}

try {
  await import('./main.mjs')
} catch (err) {
  console.error('[loader] main.mjs failed to load:', err)
  // blacklist the poisoned commit so silent updates never retry it in a loop
  try {
    mkdirSync(userDataDir, { recursive: true })
    writeFileSync(join(userDataDir, 'client-bad-commit'), currentCommit ?? 'unknown')
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
