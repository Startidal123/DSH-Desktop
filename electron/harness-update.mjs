import { exec, spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, dirname } from 'node:path'
import { trackChild } from './proc-registry.mjs'

export const DEFAULT_REPO = 'https://github.com/deepseek-ai/deepseek-harness'

const SERVER_BUNDLE = 'packages/sdk/server/lib/index.js'

/** Portable toolchain injected by the host (bundled git/pnpm when the system
 *  has none); defaults to PATH lookups. */
let toolchain = { git: 'git', pnpm: 'pnpm', env: {} }
export function setToolchain(tc) {
  toolchain = { git: tc?.git ?? 'git', pnpm: tc?.pnpm ?? 'pnpm', env: tc?.env ?? {} }
}

function run(cmd, cwd, timeoutMs = 60000) {
  const resolved = cmd
    .replace(/^git /, `"${toolchain.git}" `)
    .replace(/^pnpm /, `"${toolchain.pnpm}" `)
  return new Promise((done) => {
    trackChild(exec(resolved, {
      cwd, encoding: 'utf8', timeout: timeoutMs, windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, ...toolchain.env },
    }, (err, stdout, stderr) => {
      done({ ok: !err, out: (stdout || '').trim(), err: ((stderr || '').trim() || (err?.message ?? '')).slice(0, 500) })
    }))
  })
}

/** Current harness checkout facts: git head, version, build and patch state. */
export async function harnessStatus(harnessDir) {
  const info = { ok: false, head: '', version: '', branch: '', remote: '', built: false, patched: false }
  if (!existsSync(resolve(harnessDir, '.git'))) return { ...info, error: '目录不是 git 仓库' }
  const head = await run('git rev-parse --short=8 HEAD', harnessDir, 15000)
  if (!head.ok) return { ...info, error: 'git 不可用或仓库损坏' }
  info.ok = true
  info.head = head.out
  const pkg = resolve(harnessDir, 'package.json')
  if (existsSync(pkg)) {
    try { info.version = JSON.parse(readFileSync(pkg, 'utf8')).version ?? '' } catch { /* keep empty */ }
  }
  info.branch = (await run('git rev-parse --abbrev-ref HEAD', harnessDir, 15000)).out
  info.remote = (await run('git remote get-url origin', harnessDir, 15000)).out
  info.built = existsSync(resolve(harnessDir, SERVER_BUNDLE))
  if (info.built) {
    info.patched = readFileSync(resolve(harnessDir, SERVER_BUNDLE), 'utf8').includes('session/approvalDecide')
  }
  return info
}

async function tryFetch(harnessDir, url) {
  const res = await run(`git fetch --no-tags "${url}" HEAD`, harnessDir, 120000)
  if (!res.ok) return null
  const head = await run('git rev-parse FETCH_HEAD', harnessDir, 15000)
  return head.ok ? head.out : null
}

/** Fetch the repo default branch, falling back to a mirror when GitHub is unreachable. */
export async function fetchLatest(harnessDir, repoUrl) {
  const candidates = [repoUrl]
  if (/^https:\/\/github\.com\//.test(repoUrl)) candidates.push(`https://ghfast.top/${repoUrl}`)
  for (const url of candidates) {
    const fetched = await tryFetch(harnessDir, url)
    if (fetched) return { ok: true, head: fetched, via: url }
  }
  return { ok: false }
}

let curlAvailable = null

/** Quick reachability probe through the same proxy env git/pnpm use (curl
 *  ships with Windows 10+; older systems skip the probe). */
async function probeHost(url) {
  const res = await run(`curl -sS -m 8 -o NUL --head "${url}"`, process.cwd(), 15000)
  return res.ok
}

export async function probeNetwork() {
  if (curlAvailable === null) {
    curlAvailable = (await run('curl --version', process.cwd(), 15000)).ok
  }
  if (!curlAvailable) return { ok: true, skipped: true }
  const [registry, github] = await Promise.all([
    probeHost('https://registry.npmmirror.com/'),
    probeHost('https://github.com/'),
  ])
  if (registry === false && github === false) return { ok: false }
  return { ok: true }
}

/** Apply the client patch idempotently; throws when it conflicts upstream. */
async function ensurePatched(harnessDir, patchFile, onStep) {
  const forward = await run(`git apply --check "${patchFile}"`, harnessDir, 30000)
  if (forward.ok) {
    const apply = await run(`git apply "${patchFile}"`, harnessDir, 30000)
    if (!apply.ok) throw new Error('补丁应用失败：' + apply.err)
    onStep?.('patch', '客户端补丁已应用')
    return true
  }
  const reverse = await run(`git apply --reverse --check "${patchFile}"`, harnessDir, 30000)
  if (reverse.ok) {
    onStep?.('patch', '客户端补丁此前已应用，跳过')
    return false
  }
  throw new Error('补丁失败：与上游代码冲突（上游改动了 sdk/server），请手动合并 ' + patchFile)
}

const STAMP_FILE = '.dsh-build-stamp'

/** Build fingerprint: source HEAD + patch content — unchanged means the
 *  existing artifacts are current and install/build can be skipped. */
async function buildUpToDate(harnessDir, patchFile) {
  try {
    const stampPath = resolve(harnessDir, STAMP_FILE)
    if (!existsSync(stampPath)) return false
    const stamp = JSON.parse(readFileSync(stampPath, 'utf8'))
    const head = (await run('git rev-parse HEAD', harnessDir, 15000)).out
    const patchMd5 = createHash('md5').update(readFileSync(patchFile)).digest('hex')
    return stamp.head === head && stamp.patchMd5 === patchMd5
      && existsSync(resolve(harnessDir, SERVER_BUNDLE))
  } catch {
    return false
  }
}

/** Long-running build command with live output: streams lines to onLine
 *  (rate-limited) so the progress log shows liveness, and tree-kills the
 *  whole process on timeout — plain exec only kills the shell, leaving pnpm
 *  grandchildren alive and locking the store for the retry. */
function runStreaming(cmd, cwd, timeoutMs, onLine) {
  const resolved = cmd
    .replace(/^git /, `"${toolchain.git}" `)
    .replace(/^pnpm /, `"${toolchain.pnpm}" `)
  return new Promise((resolve) => {
    const child = trackChild(spawn(resolved, {
      cwd, shell: true, windowsHide: true,
      env: { ...process.env, ...toolchain.env },
    }))
    let pending = ''
    let tail = ''
    let lastEmit = 0
    let timedOut = false
    const feed = (chunk) => {
      pending += chunk
      const parts = pending.split(/[\r\n]+/)
      pending = parts.pop() ?? ''
      for (const line of parts) {
        const text = line.trim()
        if (!text) continue
        tail = text
        const now = Date.now()
        if (now - lastEmit >= 1500) {
          lastEmit = now
          try { onLine?.(text.slice(0, 200)) } catch { /* force-stopped mid-stream */ }
        }
      }
    }
    child.stdout?.on('data', feed)
    child.stderr?.on('data', feed)
    const timer = setTimeout(() => {
      timedOut = true
      if (child.pid) {
        if (process.platform === 'win32') {
          exec(`taskkill /T /F /PID ${child.pid}`, { windowsHide: true }, () => { /* best effort */ })
        } else {
          try { child.kill('SIGKILL') } catch { /* already gone */ }
        }
      }
    }, timeoutMs)
    child.once('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, err: String(err.message ?? err) })
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve({
        ok: !timedOut && code === 0,
        err: timedOut ? '超时（进程树已强制结束）' : (tail || `exit=${code}`),
      })
    })
  })
}

async function installAndBuild(harnessDir, patchFile, onStep) {
  if (await buildUpToDate(harnessDir, patchFile)) {
    onStep?.('build', '源码与补丁均未变化，跳过安装与构建')
    return
  }
  onStep?.('install', '安装依赖（pnpm install，走国内镜像，冷缓存首次可能较久）…')
  for (let attempt = 1; attempt <= 2; attempt++) {
    const install = await runStreaming(
      'pnpm install --prefer-offline --registry=https://registry.npmmirror.com',
      harnessDir, 900000,
      (line) => onStep?.('install', line),
    )
    if (install.ok) break
    if (attempt === 2) throw new Error('依赖安装失败（多为网络/代理不通）：' + install.err + '。请检查系统代理/网络后重试，或手动在 harness 目录执行 pnpm install 排查。')
    onStep?.('install', '安装未完成，重试一次…')
  }
  onStep?.('build', '构建 harness（约 2 分钟，请勿关闭客户端）…')
  const build = await runStreaming('pnpm run build', harnessDir, 600000, (line) => onStep?.('build', line))
  if (!build.ok) throw new Error('构建失败：' + build.err)
  // stamp the successful build so unchanged trees skip this next time
  try {
    const head = (await run('git rev-parse HEAD', harnessDir, 15000)).out
    const patchMd5 = createHash('md5').update(readFileSync(patchFile)).digest('hex')
    writeFileSync(resolve(harnessDir, STAMP_FILE), JSON.stringify({ head, patchMd5, at: Date.now() }))
  } catch { /* stamp is an optimization, never fatal */ }
  onStep?.('build', '构建完成')
}

/** Patch + install + build, without touching git remotes. */
export async function applyPatchOnly({ harnessDir, patchFile, onStep }) {
  await ensurePatched(harnessDir, patchFile, onStep)
  await installAndBuild(harnessDir, patchFile, onStep)
}

/** Verify the external toolchain the pipeline shells out to. */
export async function checkToolchain() {
  // legacy probe kept for the settings status line; the pipeline itself now
  // auto-installs portable pieces via ensureTools instead of failing here
  const tools = [
    { cmd: 'git --version', name: 'git' },
    { cmd: 'node --version', name: 'Node.js 22+' },
    { cmd: 'pnpm --version', name: 'pnpm' },
  ]
  const missing = []
  for (const t of tools) {
    const res = await run(t.cmd, process.cwd(), 20000)
    if (!res.ok) missing.push(`${t.name}（将自动下载便携版）`)
  }
  return { ok: missing.length === 0, missing }
}

/** Clone the repo from scratch (fresh machine / deleted checkout). */
async function cloneHarness({ harnessDir, repoUrl, onStep }) {
  if (existsSync(harnessDir) && readdirSync(harnessDir).length > 0) {
    throw new Error(`目录 ${harnessDir} 已存在且非空，请先清空或换一个路径`)
  }
  mkdirSync(dirname(harnessDir), { recursive: true })
  const candidates = [repoUrl]
  if (/^https:\/\/github\.com\//.test(repoUrl)) candidates.push(`https://ghfast.top/${repoUrl}`)
  let lastErr = ''
  for (const url of candidates) {
    onStep?.('clone', `克隆 harness（${url.includes('ghfast.top') ? '镜像加速' : '直连'}，首次约几分钟）…`)
    const res = await run(`git clone --depth 1 --single-branch "${url}" "${harnessDir}"`, dirname(harnessDir), 900000)
    if (res.ok) {
      onStep?.('clone', '克隆完成')
      return
    }
    lastErr = res.err
    rmSync(harnessDir, { recursive: true, force: true })
  }
  throw new Error('克隆失败：' + lastErr)
}

/**
 * Full update pipeline. Local-first: an existing checkout is patched and
 * built BEFORE any network access, so a machine with the repo on disk keeps
 * a working runtime even when GitHub is unreachable; the remote check is
 * then best-effort and degrades to "keep the local build" on network
 * failure. A missing checkout switches to from-scratch deployment
 * (clone → patch → build), which requires network.
 */
export async function updateHarness({ harnessDir, patchFile, repoUrl, onStep }) {
  const hasGit = existsSync(resolve(harnessDir, '.git'))
  if (!hasGit) {
    await cloneHarness({ harnessDir, repoUrl, onStep })
    await ensurePatched(harnessDir, patchFile, onStep)
    await installAndBuild(harnessDir, patchFile, onStep)
    return { updated: true, head: '', cloned: true }
  }
  const status = await harnessStatus(harnessDir)
  if (!status.ok) throw new Error(status.error ?? 'harness 目录无效')

  // local-first: patch + build what's already on disk (build stamp makes
  // this a fast no-op when the tree is current) so the runtime works with
  // or without network
  onStep?.('patch', '确认本地补丁与构建…')
  await ensurePatched(harnessDir, patchFile, onStep)
  await installAndBuild(harnessDir, patchFile, onStep)

  onStep?.('fetch', `检查更新（${repoUrl}）…`)
  const probe = await probeNetwork()
  const fetch = probe.ok ? await fetchLatest(harnessDir, repoUrl) : { ok: false }
  if (!fetch.ok) {
    onStep?.('fetch', '无法连接仓库（直连与镜像均失败），跳过更新检查，保留当前本地构建')
    return { updated: false, head: '', offline: true }
  }
  const local = (await run('git rev-parse HEAD', harnessDir, 15000)).out
  if (fetch.head === local) {
    onStep?.('merge', '已是最新版本')
    return { updated: false, head: fetch.head }
  }
  onStep?.('merge', `拉取上游更新（${local.slice(0, 8)} → ${fetch.head.slice(0, 8)}）…`)
  // our patches dirty sdk/server; revert those files so ff-merge can proceed
  await run('git checkout -- packages/sdk/server', harnessDir, 30000)
  const dirty = await run('git status --porcelain', harnessDir, 30000)
  if (dirty.out) {
    await run('git stash push -u -m dsh-client-auto-update', harnessDir, 30000)
    onStep?.('merge', '本地改动已暂存（git stash）')
  }
  const merge = await run(`git merge --ff-only ${fetch.head}`, harnessDir, 60000)
  if (!merge.ok) throw new Error('快进合并失败：' + merge.err)
  onStep?.('merge', '已更新到 ' + fetch.head.slice(0, 8))
  await ensurePatched(harnessDir, patchFile, onStep)
  await installAndBuild(harnessDir, patchFile, onStep)
  return { updated: true, head: fetch.head }
}
