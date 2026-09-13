// One-command publish, two outputs:
//   main   — source + payload (clients self-update from this branch)
//   client — bootstrap branch: tiny zip (~3MB) + setup.bat that fetches the
//            Electron runtime from npmmirror, so fresh machines install with
//            zero prerequisites (GitHub's 100MB file limit forbids committing
//            the 189MB exe itself).
//
// Idempotency: a content hash over the shipped payload keeps the branches
// quiet — running publish with no real change writes nothing and pushes
// nothing, so GitHub never shows spurious "branch updated" noise.
import { execSync } from 'node:child_process'
import { writeFileSync, existsSync, mkdirSync, rmSync, cpSync, readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const root = process.cwd()
const args = process.argv.slice(2)
const repoArgIdx = args.indexOf('--repo')
const repoArg = repoArgIdx !== -1 ? args[repoArgIdx + 1] : ''
const originIdx = args.indexOf('--origin')
const originOverride = originIdx !== -1 ? args[originIdx + 1] : ''

const PAYLOAD_PARTS = ['dist', 'electron', 'patches']
const PAYLOAD_FILES = ['package.json', 'version.json', 'README.md']

function git(cmd, opts = {}) {
  return execSync(`git ${cmd}`, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: 'pipe', ...opts }).toString().trim()
}

function pushWithRetry(cwd, spec, label) {
  for (let i = 1; i <= 5; i++) {
    try {
      execSync(`git push ${spec}`, { cwd, windowsHide: true, stdio: 'pipe' })
      console.log(`OK ${label} 已推送`)
      return true
    } catch (err) {
      console.log(`  ${label} 推送失败（第 ${i}/5 次）：${String(err.message ?? '').split('\n')[0]}`)
    }
  }
  console.error(`X ${label} 推送失败：提交已在本地，稍后手动 git push`)
  return false
}

// ---------- content hashing (publish idempotency) ----------
function hashDir(h, dir, prefix) {
  if (!existsSync(dir)) return
  const entries = readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
  for (const e of entries) {
    const full = join(dir, e.name)
    const rel = `${prefix}/${e.name}`
    if (e.isDirectory()) hashDir(h, full, rel)
    else {
      h.update(rel)
      h.update(readFileSync(full))
    }
  }
}

/** md5 over everything the branches ship: payload parts + bootstrap pieces. */
function computeContentHash(setupBat, installNote, electronVersion) {
  const h = createHash('md5')
  for (const part of PAYLOAD_PARTS) hashDir(h, join(root, part), part)
  for (const f of ['package.json', 'README.md']) {
    if (existsSync(join(root, f))) {
      h.update(f)
      h.update(readFileSync(join(root, f)))
    }
  }
  h.update(`electron:${electronVersion}`)
  h.update(`setup:${setupBat}`)
  h.update(`note:${installNote}`)
  for (const f of ['vendor/rcedit-x64.exe', 'build/icon.ico']) {
    if (existsSync(join(root, f))) {
      h.update(f)
      h.update(readFileSync(join(root, f)))
    }
  }
  return h.digest('hex')
}

// ---------- 0. repo must exist ----------
if (!existsSync(join(root, '.git'))) {
  console.log('初始化源码仓库…')
  execSync('git init -b main', { cwd: root, windowsHide: true, stdio: 'inherit' })
}
let remote = ''
try { remote = git('remote get-url origin') } catch { /* none yet */ }
if (repoArg) {
  try { execSync('git remote remove origin', { cwd: root, windowsHide: true, stdio: 'ignore' }) } catch { /* absent */ }
  execSync(`git remote add origin ${repoArg}`, { cwd: root, windowsHide: true, stdio: 'inherit' })
  remote = repoArg
  console.log(`remote 设置为 ${repoArg}`)
}
if (!remote) {
  console.error('未配置远程仓库：首次发布请运行 npm run publish -- --repo https://github.com/<你>/DSH-Desktop')
  process.exit(1)
}
const originUrl = originOverride || remote

// ---------- 1. build ----------
console.log('1/4 构建前端…')
execSync('npx vite build', { cwd: root, windowsHide: true, stdio: 'inherit' })
writeFileSync(join(root, '.gitattributes'), '* -text\n')

const electronVersion = JSON.parse(readFileSync(join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version

const setupBat = `@echo off
setlocal
cd /d "%~dp0"
echo ==================================================
echo   DSH Client 引导安装（首次运行，约 1-3 分钟）
echo ==================================================
if exist "DSH Client.exe" (
  echo 已安装过；如需重装请先删除 DSH Client.exe
  pause
  exit /b 0
)

set ELECTRON_URL=https://npmmirror.com/mirrors/electron/v${electronVersion}/electron-v${electronVersion}-win32-x64.zip
if exist electron-setup.zip del electron-setup.zip

echo [1/3] 下载 Electron 运行时（约 115MB，国内镜像）...
where curl >nul 2>&1
if %errorlevel%==0 (
  curl -L -sS --retry 3 -o electron-setup.zip "%ELECTRON_URL%"
) else (
  powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; [System.Net.WebRequest]::DefaultWebProxy=$null; $ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '%ELECTRON_URL%' -OutFile electron-setup.zip -UseBasicParsing"
)

set ZIPSIZE=0
if exist electron-setup.zip for %%F in (electron-setup.zip) do set ZIPSIZE=%%~zF
if %ZIPSIZE% LSS 50000000 (
  echo 下载失败或不完整（%ZIPSIZE% 字节）：请检查网络后重新运行本脚本
  if exist electron-setup.zip del electron-setup.zip
  pause
  exit /b 1
)

echo [2/3] 解压并组装客户端...
powershell -NoProfile -Command "$ProgressPreference='SilentlyContinue'; Expand-Archive -Path electron-setup.zip -DestinationPath electron-setup -Force"
if not exist electron-setup\\electron.exe (
  echo 解压失败：下载文件可能损坏，请重新运行本脚本
  rd /s /q electron-setup 2>nul
  del electron-setup.zip 2>nul
  pause
  exit /b 1
)
powershell -NoProfile -Command "Copy-Item 'electron-setup\\*' -Destination . -Recurse -Force"
ren electron.exe "DSH Client.exe"
rd /s /q electron-setup
del electron-setup.zip

echo [3/3] 设置应用图标...
if exist rcedit-x64.exe (
  rcedit-x64.exe "DSH Client.exe" --set-icon icon.ico --set-version-string ProductName "DSH Client" --set-version-string FileDescription "DeepSeek Harness Client"
)

echo.
echo 安装完成！双击「DSH Client.exe」启动，
echo 首次使用请在 设置 - Harness 更新 中点「检查并更新」完成部署。
pause
`

const installNote = '新机器安装：直接双击 setup.bat（需联网，自动下载运行时）。\n装好后启动 DSH Client.exe，在 设置 → Harness 更新 点「检查并更新」部署 harness。\n\n已装过客户端的机器无需本分支：应用会从 main 分支自动热更新。\n'

// version.json only bumps when the shipped content actually changed — an
// unconditional builtAt would create a commit (and a client force-push, and a
// GitHub notification) on every run even with zero changes
const contentHash = computeContentHash(setupBat, installNote, electronVersion)
let prevVersion = null
try { prevVersion = JSON.parse(readFileSync(join(root, 'version.json'), 'utf8')) } catch { /* absent */ }
if (!prevVersion || prevVersion.contentHash !== contentHash) {
  writeFileSync(join(root, 'version.json'), JSON.stringify({ builtAt: new Date().toISOString(), contentHash }, null, 2) + '\n')
  console.log('payload 内容有变化，version.json 已刷新')
} else {
  console.log('payload 内容无变化，保持 version.json')
}

// ---------- 2. commit + push main ----------
console.log('2/4 发布 main 分支（源码 + payload）…')
git('add -A')
const changed = (() => {
  try { execSync('git diff --cached --quiet', { cwd: root, windowsHide: true, stdio: 'ignore' }); return false } catch { return true }
})()
if (!changed) {
  console.log('main 无变化，跳过提交')
} else {
  git('commit -m "release: payload build"')
  pushWithRetry(root, '-u origin main', 'main')
}

// ---------- 3. assemble client bootstrap branch ----------
console.log('3/4 组装 client 引导分支…')
const tmp = join(root, '.client-branch-tmp')
rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })
// payload under resources/app
const appDir = join(tmp, 'resources', 'app')
mkdirSync(appDir, { recursive: true })
for (const part of PAYLOAD_PARTS) cpSync(join(root, part), join(appDir, part), { recursive: true })
for (const file of PAYLOAD_FILES) {
  if (existsSync(join(root, file))) cpSync(join(root, file), join(appDir, file))
}
writeFileSync(join(appDir, '.installed-commit'), 'client-branch-bootstrap\n')
// bootstrap pieces at the branch root; setup.bat must be GBK-encoded AND
// CRLF-terminated — cmd.exe's parser (parenthesized blocks especially)
// desyncs on LF-only batch files, and UTF-8 Chinese desyncs its codepage
writeFileSync(join(tmp, 'setup.bat.utf8'), setupBat.replace(/\r?\n/g, '\r\n'))
execSync(
  `powershell -NoProfile -Command "$c = Get-Content -Raw -Encoding UTF8 'setup.bat.utf8'; [System.IO.File]::WriteAllText('setup.bat', $c, [System.Text.Encoding]::GetEncoding(936))"`,
  { cwd: tmp, windowsHide: true, stdio: 'pipe' },
)
rmSync(join(tmp, 'setup.bat.utf8'), { force: true })
writeFileSync(join(tmp, '.gitattributes'), '* -text\n')
if (existsSync(join(root, 'vendor', 'rcedit-x64.exe'))) cpSync(join(root, 'vendor', 'rcedit-x64.exe'), join(tmp, 'rcedit-x64.exe'))
if (existsSync(join(root, 'build', 'icon.ico'))) cpSync(join(root, 'build', 'icon.ico'), join(tmp, 'icon.ico'))
writeFileSync(join(tmp, '安装说明.txt'), installNote)

// ---------- 4. push client branch, but only when content really changed ----------
console.log('4/4 发布 client 引导分支…')
execSync('git init -q -b client', { cwd: tmp, windowsHide: true })
execSync('git add -A', { cwd: tmp, windowsHide: true })
execSync(`git -c user.email=publish@dsh.client -c user.name=dsh-publish commit -q -m "client bootstrap (electron ${electronVersion})"`, { cwd: tmp, windowsHide: true })
execSync(`git remote add origin "${originUrl}"`, { cwd: tmp, windowsHide: true })

let remoteHash = null
try {
  execSync('git fetch -q origin client', { cwd: tmp, windowsHide: true, stdio: 'pipe' })
  const v = execSync('git show FETCH_HEAD:resources/app/version.json', { cwd: tmp, windowsHide: true, stdio: 'pipe' }).toString()
  remoteHash = JSON.parse(v).contentHash ?? null
} catch { /* no remote client branch yet */ }

let clientPushed = false
if (remoteHash === contentHash) {
  console.log('client 分支内容与远端一致，跳过推送（不产生更新提示）')
} else {
  clientPushed = pushWithRetry(tmp, '-f origin client', 'client')
}
rmSync(tmp, { recursive: true, force: true })

console.log('')
console.log('发布完成：')
console.log(changed ? '  main   ← 已更新（源码 + payload）' : '  main   ← 无变化')
console.log(clientPushed ? '  client ← 已更新（新机器引导包）' : (remoteHash === contentHash ? '  client ← 无变化' : '  client ← 推送失败（稍后重跑 publish 即可）'))
