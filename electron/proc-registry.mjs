// Registry of update-pipeline child processes and download aborters so a
// stuck pipeline can be force-cleared from the settings UI ("强制终止").
// killAll() tree-kills children (grandkids included — exec timeouts only
// kill the direct shell on Windows, leaving pnpm/node orphans behind) and
// aborts in-flight downloads, which unsticks hung fetches immediately.
import { exec } from 'node:child_process'

const children = new Set()
const aborters = new Set()

export function trackChild(child) {
  if (!child) return child
  children.add(child)
  child.once('exit', () => children.delete(child))
  return child
}

export function trackAborter(ctrl) {
  aborters.add(ctrl)
  return ctrl
}

export function untrackAborter(ctrl) {
  aborters.delete(ctrl)
}

/** Kill every tracked child process and abort tracked downloads. Returns the
 *  number of child processes that were targeted. */
export function killAll() {
  const pids = [...children].map(c => c.pid).filter(p => Number.isInteger(p))
  children.clear()
  for (const pid of pids) {
    if (process.platform === 'win32') {
      exec(`taskkill /T /F /PID ${pid}`, { windowsHide: true }, () => { /* best effort */ })
    } else {
      try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    }
  }
  for (const ctrl of aborters) {
    try { ctrl.abort(new Error('更新任务已被强制终止')) } catch { /* already aborted */ }
  }
  aborters.clear()
  return pids.length
}
