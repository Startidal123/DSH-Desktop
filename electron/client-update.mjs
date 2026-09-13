// Client payload self-update: compare the release repo HEAD against the
// installed payload, shallow-clone, validate, and hot-swap resources/app.
// Renderer-only changes apply via a window reload; main-process changes via
// an app relaunch (decided by the caller from `mainChanged`).
import { exec } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, rmSync, renameSync, mkdirSync, readdirSync, statSync, cpSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const CHANNEL = 'main'

function run(cmd, cwd, timeoutMs = 120000) {
  return new Promise((done) => {
    exec(cmd, {
      cwd, encoding: 'utf8', timeout: timeoutMs, windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      done({ ok: !err, out: (stdout || '').trim(), err: ((stderr || '').trim() || (err?.message ?? '')).slice(0, 400) })
    })
  })
}

const mirrorOf = (url) => (/^https:\/\/github\.com\//.test(url) ? `https://ghfast.top/${url}` : null)

/** Remote HEAD sha via ls-remote; falls back to the mirror when direct fails. */
export async function remoteHead(repoUrl, gitBin = 'git') {
  const urls = [repoUrl, mirrorOf(repoUrl)].filter(Boolean)
  for (const url of urls) {
    const res = await run(`"${gitBin}" ls-remote "${url}" refs/heads/${CHANNEL}`, undefined, 60000)
    const sha = res.ok ? (res.out.split(/\s+/)[0] ?? '') : ''
    if (sha) return { ok: true, sha }
  }
  return { ok: false }
}

/** Installed payload facts for the settings line. */
export function clientStatus(appDir) {
  const versionFile = join(appDir, 'version.json')
  const installed = join(appDir, '.installed-commit')
  let version = {}
  try { version = JSON.parse(readFileSync(versionFile, 'utf8')) } catch { /* absent on old installs */ }
  return {
    builtAt: version.builtAt ?? '',
    commit: existsSync(installed) ? readFileSync(installed, 'utf8').trim() : '',
  }
}

function dirMd5(dir, base = dir, acc = {}) {
  if (!existsSync(dir)) return acc
  for (const f of readdirSync(dir)) {
    const full = join(dir, f)
    if (statSync(full).isDirectory()) dirMd5(full, base, acc)
    else {
      // normalize line endings: a CRLF-mangled clone must not read as a
      // main-process change and force an unnecessary relaunch
      const text = readFileSync(full).toString('latin1').replace(/\r\n/g, '\n')
      acc[full.slice(base.length)] = createHash('md5').update(text).digest('hex')
    }
  }
  return acc
}

/** Whether any file under electron/ differs between the two payloads. */
function mainChanged(oldDir, newDir) {
  const a = dirMd5(join(oldDir, 'electron'))
  const b = dirMd5(join(newDir, 'electron'))
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) if (a[k] !== b[k]) return true
  return false
}

const PAYLOAD_PARTS = ['dist', 'electron', 'patches']
const PAYLOAD_FILES = ['package.json', 'version.json', 'README.md']

/**
 * Full check-and-swap. Returns { updated, mainChanged, head } — the caller
 * decides reload vs relaunch. Throws with a human message on failure; a
 * failed swap never damages the running install.
 */
export async function clientUpdate({ appDir, repoUrl, gitBin = 'git', skipCommit = '', onStep }) {
  appDir = resolve(appDir)
  if (!repoUrl) throw new Error('未配置客户端更新仓库地址')
  onStep?.('检查客户端更新…')
  const remote = await remoteHead(repoUrl, gitBin)
  if (!remote.ok) throw new Error('无法连接客户端发布仓库（直连与镜像均失败）')
  const current = clientStatus(appDir).commit
  if (current === remote.sha) {
    onStep?.('客户端已是最新')
    return { updated: false, mainChanged: false, head: remote.sha }
  }
  if (skipCommit && remote.sha === skipCommit) {
    onStep?.('远端版本此前启动失败已跳过（手动检查可重试）')
    return { updated: false, mainChanged: false, head: remote.sha, skipped: true }
  }

  onStep?.(current ? `拉取客户端更新（${remote.sha.slice(0, 8)}）…` : `拉取客户端（${remote.sha.slice(0, 8)}）…`)
  const tmp = join(tmpdir(), `dsh-client-payload-${Date.now()}`)
  rmSync(tmp, { recursive: true, force: true })
  let cloned = false
  for (const url of [repoUrl, mirrorOf(repoUrl)].filter(Boolean)) {
    const res = await run(`"${gitBin}" clone --depth 1 --branch ${CHANNEL} --single-branch "${url}" "${tmp}"`, tmpdir(), 300000)
    if (res.ok) { cloned = true; break }
    rmSync(tmp, { recursive: true, force: true })
  }
  if (!cloned) throw new Error('克隆发布仓库失败（直连与镜像均失败）')

  // validate payload structure before touching the install
  for (const part of PAYLOAD_PARTS) {
    if (!existsSync(join(tmp, part))) {
      rmSync(tmp, { recursive: true, force: true })
      throw new Error(`发布仓库缺少 ${part}/，已拒绝更新`)
    }
  }
  if (!existsSync(join(tmp, 'electron', 'main.mjs'))) {
    rmSync(tmp, { recursive: true, force: true })
    throw new Error('发布仓库缺少主进程入口，已拒绝更新')
  }

  onStep?.('应用更新…')
  const resources = dirname(appDir)
  const appNext = join(resources, 'app-next')
  rmSync(appNext, { recursive: true, force: true })
  mkdirSync(appNext, { recursive: true })
  for (const part of PAYLOAD_PARTS) {
    cpSync(join(tmp, part), join(appNext, part), { recursive: true })
  }
  for (const file of PAYLOAD_FILES) {
    if (existsSync(join(tmp, file))) cpSync(join(tmp, file), join(appNext, file))
  }
  writeFileSync(join(appNext, '.installed-commit'), remote.sha)
  rmSync(tmp, { recursive: true, force: true })

  const changed = mainChanged(appDir, appNext)

  // swap: app → app-old, app-next → app (retry once for AV/lock hiccups)
  const appOld = join(resources, 'app-old')
  rmSync(appOld, { recursive: true, force: true })
  let swapped = false
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      renameSync(appDir, appOld)
      renameSync(appNext, appDir)
      swapped = true
      break
    } catch {
      await new Promise(r => setTimeout(r, 800))
    }
  }
  if (!swapped) {
    // app-next is disposable; the running app is untouched
    rmSync(appNext, { recursive: true, force: true })
    throw new Error('更新文件交换失败（文件被占用），本次更新已放弃，客户端不受影响')
  }

  onStep?.(changed ? '客户端已更新（主进程变更，即将重启）' : '客户端已更新（界面变更，刷新窗口生效）')
  return { updated: true, mainChanged: changed, head: remote.sha }
}
