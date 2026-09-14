// Registry of update-pipeline child processes and download aborters so a
// stuck pipeline can be force-cleared from the settings UI ("强制终止").
// Entries are tagged per pipeline ('client' | 'harness'); killAll(tag)
// tree-kills only that pipeline's children (grandkids included — exec
// timeouts only kill the direct shell on Windows, leaving pnpm/node orphans
// behind) and aborts its in-flight downloads, so stopping one pipeline never
// disturbs the other.
import { exec } from 'node:child_process'

const children = new Map()
const aborters = new Map()

export function trackChild(child, tag = 'shared') {
  if (!child) return child
  children.set(child, tag)
  child.once('exit', () => children.delete(child))
  return child
}

export function trackAborter(ctrl, tag = 'shared') {
  aborters.set(ctrl, tag)
  return ctrl
}

export function untrackAborter(ctrl) {
  aborters.delete(ctrl)
}

/** Kill the tracked children and downloads of one pipeline. Returns the
 *  number of child processes that were targeted. */
export function killAll(tag) {
  const kidPids = []
  for (const [c, t] of children) {
    if (t !== tag) continue
    if (Number.isInteger(c.pid)) kidPids.push(c.pid)
    children.delete(c)
  }
  for (const pid of kidPids) {
    if (process.platform === 'win32') {
      exec(`taskkill /T /F /PID ${pid}`, { windowsHide: true }, () => { /* best effort */ })
    } else {
      try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    }
  }
  let aborted = 0
  for (const [ctrl, t] of aborters) {
    if (t !== tag) continue
    aborters.delete(ctrl)
    aborted += 1
    try { ctrl.abort(new Error('更新任务已被强制终止')) } catch { /* already aborted */ }
  }
  return kidPids.length + aborted
}
