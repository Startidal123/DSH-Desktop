// Portable toolchain for from-scratch machines: bundled MinGit + standalone
// pnpm + an "electron-as-node" shim, downloaded on demand into <appRoot>/tools.
// Nothing here requires a system-wide git/node/pnpm install.
import { exec } from 'node:child_process'
import { existsSync, mkdirSync, createWriteStream, unlinkSync, rmSync, linkSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { trackChild, trackAborter, untrackAborter } from './proc-registry.mjs'

const MINGIT_URL = 'https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.1/MinGit-2.47.1-64-bit.zip'
const PNPM_META = 'https://registry.npmmirror.com/@pnpm/win-x64/latest'

function run(cmd, cwd, timeoutMs = 60000) {
  return new Promise((done) => {
    trackChild(exec(cmd, {
      cwd, encoding: 'utf8', timeout: timeoutMs, windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      done({ ok: !err, out: (stdout || '').trim(), err: ((stderr || '').trim() || (err?.message ?? '')).slice(0, 300) })
    }))
  })
}

/** Stream a download to disk with MB progress reporting. Fails fast when the
 *  network stalls (broken proxy: 30s without bytes) or the total exceeds 5 min. */
async function download(url, dest, onProgress) {
  const ctrl = new AbortController()
  trackAborter(ctrl)
  let lastByte = Date.now()
  const overall = setTimeout(() => ctrl.abort(new Error('下载超时（超过 5 分钟）')), 300000)
  const watchdog = setInterval(() => {
    if (Date.now() - lastByte > 30000) ctrl.abort(new Error('下载停滞（30 秒无数据，多为网络/代理不通）'))
  }, 5000)
  try {
    const res = await fetch(url, { redirect: 'follow', signal: ctrl.signal })
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
    const total = Number(res.headers.get('content-length') ?? 0)
    const reader = res.body.getReader()
    const out = createWriteStream(dest)
    let received = 0
    let lastReport = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      lastByte = Date.now()
      out.write(value)
      received += value.length
      if (received - lastReport >= 5 * 1024 * 1024) {
        lastReport = received
        const totalText = total ? ` / ${(total / 1048576).toFixed(0)}MB` : ''
        onProgress?.(`${(received / 1048576).toFixed(0)}MB${totalText}`)
      }
    }
    await new Promise((r) => out.end(r))
    if (received < 1024 * 1024) {
      unlinkSync(dest)
      throw new Error('下载内容异常（过小）')
    }
    return received
  } catch (err) {
    try { unlinkSync(dest) } catch { /* nothing written */ }
    throw err
  } finally {
    clearTimeout(overall)
    clearInterval(watchdog)
    untrackAborter(ctrl)
  }
}

async function unzip(zipPath, destDir) {
  const res = await run(`powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`, dirname(destDir), 300000)
  if (!res.ok) throw new Error('解压失败：' + res.err)
}

const hasCmd = async (cmd) => (await run(`"${cmd}" --version`, process.cwd(), 15000)).ok

/** Install a portable MinGit under tools/. */
async function installGit(toolsDir, onStep) {
  const gitRoot = join(toolsDir, 'git')
  for (const url of [MINGIT_URL, `https://ghfast.top/${MINGIT_URL}`]) {
    const tmp = join(toolsDir, 'mingit.zip')
    try {
      onStep?.(`下载便携版 git（${url.includes('ghfast.top') ? '镜像' : '直连'}，约 45MB）…`)
      await download(url, tmp, p => onStep?.(`下载 git… ${p}`))
      onStep?.('解压 git…')
      await unzip(tmp, gitRoot)
      unlinkSync(tmp)
      if (existsSync(join(gitRoot, 'cmd', 'git.exe'))) return join(gitRoot, 'cmd', 'git.exe')
    } catch { /* try the mirror */ }
  }
  throw new Error('便携版 git 下载失败（直连与镜像均不可达），请检查网络')
}

/** Install standalone pnpm.exe (bundles its own Node) under tools/. */
async function installPnpm(toolsDir, onStep) {
  const dest = join(toolsDir, 'pnpm.exe')
  const meta = await fetch(PNPM_META, { redirect: 'follow' }).then(r => r.json()).catch(() => null)
  const tarball = meta?.dist?.tarball
  if (!tarball) throw new Error('无法获取 pnpm 下载地址')
  const tmpTgz = join(toolsDir, 'pnpm.tgz')
  const tmpDir = join(toolsDir, 'pnpm-tmp')
  onStep?.('下载独立版 pnpm（约 80MB，走国内镜像）…')
  await download(tarball, tmpTgz, p => onStep?.(`下载 pnpm… ${p}`))
  mkdirSync(tmpDir, { recursive: true })
  const extract = await run(`tar -xzf "${tmpTgz}" -C "${tmpDir}"`, toolsDir, 300000)
  unlinkSync(tmpTgz)
  if (!extract.ok) throw new Error('解压 pnpm 失败：' + extract.err)
  const inner = join(tmpDir, 'package', 'pnpm.exe')
  if (!existsSync(inner)) throw new Error('pnpm 包结构异常')
  // move via copy-free rename within the same volume
  const move = await run(`move /Y "${inner}" "${dest}"`, toolsDir, 30000)
  rmSync(tmpDir, { recursive: true, force: true })
  if (!move.ok && !existsSync(dest)) throw new Error('安装 pnpm 失败：' + move.err)
  return dest
}

/** Hard-link the running Electron binary as tools/node.exe; with
 *  ELECTRON_RUN_AS_NODE=1 in the env it is a fully functional Node. */
function ensureNodeShim(toolsDir, electronExe) {
  const nodeExe = join(toolsDir, 'node.exe')
  if (existsSync(nodeExe)) return nodeExe
  try {
    linkSync(electronExe, nodeExe)
    return nodeExe
  } catch {
    // cross-volume or FS without links: copy as a fallback
    const cp = run(`copy /Y "${electronExe}" "${nodeExe}"`, toolsDir, 120000)
    return null // checked by caller via existsSync
  }
}

let ensuring = null

/**
 * Resolve the toolchain, downloading portable pieces on first need.
 * Returns { git, pnpm, env } where env must be merged into every pnpm call.
 */
export function ensureTools(appRoot, electronExe, onStep) {
  if (ensuring) return ensuring
  ensuring = (async () => {
    const toolsDir = join(appRoot, 'tools')
    mkdirSync(toolsDir, { recursive: true })

    let git = 'git'
    if (!(await hasCmd(git))) {
      const bundled = join(toolsDir, 'git', 'cmd', 'git.exe')
      git = existsSync(bundled) ? bundled : await installGit(toolsDir, onStep)
    }

    let pnpm = 'pnpm'
    if (!(await hasCmd(pnpm))) {
      const bundled = join(toolsDir, 'pnpm.exe')
      pnpm = existsSync(bundled) ? bundled : await installPnpm(toolsDir, onStep)
    }

    const env = {}
    // pnpm run scripts (tsc/tsdown/…) need a node on PATH; the shim provides it
    if (!(await hasCmd('node'))) {
      ensureNodeShim(toolsDir, electronExe)
      if (existsSync(join(toolsDir, 'node.exe'))) {
        env.PATH = `${toolsDir};${process.env.PATH ?? ''}`
        env.ELECTRON_RUN_AS_NODE = '1'
      }
    }
    return { git, pnpm, env }
  })().finally(() => { ensuring = null })
  return ensuring
}

/** Read-only toolchain facts for the settings page. */
export async function toolchainStatus(appRoot) {
  const toolsDir = join(appRoot, 'tools')
  return {
    git: (await hasCmd('git')) ? 'system' : existsSync(join(toolsDir, 'git', 'cmd', 'git.exe')) ? 'bundled' : 'missing',
    pnpm: (await hasCmd('pnpm')) ? 'system' : existsSync(join(toolsDir, 'pnpm.exe')) ? 'bundled' : 'missing',
    node: (await hasCmd('node')) ? 'system' : existsSync(join(toolsDir, 'node.exe')) ? 'bundled' : 'missing',
  }
}
