// One-command publish, two outputs:
//   main   — source + payload (clients self-update from this branch)
//   client — bootstrap branch: tiny zip (~3MB) + setup.bat that fetches the
//            Electron runtime from npmmirror, so fresh machines install with
//            zero prerequisites and zero manual zip copying (GitHub's 100MB
//            file limit forbids committing the 189MB exe itself).
import { execSync } from 'node:child_process'
import { writeFileSync, existsSync, mkdirSync, rmSync, cpSync, readFileSync } from 'node:fs'
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
writeFileSync(join(root, 'version.json'), JSON.stringify({ builtAt: new Date().toISOString() }, null, 2) + '\n')
writeFileSync(join(root, '.gitattributes'), '* -text\n')

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
const electronVersion = JSON.parse(readFileSync(join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version
const tmp = join(root, '.client-branch-tmp')
rmSync(tmp, { recursive: true, force: true })

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
echo [1/3] 下载 Electron 运行时（约 115MB，国内镜像）...
powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '%ELECTRON_URL%' -OutFile electron-setup.zip -UseBasicParsing"
if not exist electron-setup.zip (
  echo 下载失败：请检查网络后重新运行本脚本
  pause
  exit /b 1
)

echo [2/3] 解压并组装客户端...
powershell -NoProfile -Command "$ProgressPreference='SilentlyContinue'; Expand-Archive -Path electron-setup.zip -DestinationPath electron-setup -Force"
if not exist electron-setup\electron.exe (
  echo 解压失败：electron-setup.zip 可能不完整，请删除后重试
  pause
  exit /b 1
)
powershell -NoProfile -Command "Copy-Item 'electron-setup\*' -Destination . -Recurse -Force"
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

mkdirSync(tmp, { recursive: true })
// payload under resources/app
const appDir = join(tmp, 'resources', 'app')
mkdirSync(appDir, { recursive: true })
for (const part of PAYLOAD_PARTS) cpSync(join(root, part), join(appDir, part), { recursive: true })
for (const file of PAYLOAD_FILES) {
  if (existsSync(join(root, file))) cpSync(join(root, file), join(appDir, file))
}
writeFileSync(join(appDir, '.installed-commit'), 'client-branch-bootstrap\n')
// bootstrap pieces at the branch root
writeFileSync(join(tmp, 'setup.bat'), setupBat)
writeFileSync(join(tmp, '.gitattributes'), '* -text\n')
if (existsSync(join(root, 'vendor', 'rcedit-x64.exe'))) cpSync(join(root, 'vendor', 'rcedit-x64.exe'), join(tmp, 'rcedit-x64.exe'))
if (existsSync(join(root, 'build', 'icon.ico'))) cpSync(join(root, 'build', 'icon.ico'), join(tmp, 'icon.ico'))
// README pointer so the branch zip is self-explanatory
writeFileSync(join(tmp, '安装说明.txt'), '新机器安装：直接双击 setup.bat（需联网，自动下载运行时）。\n装好后启动 DSH Client.exe，在 设置 → Harness 更新 点「检查并更新」部署 harness。\n\n已装过客户端的机器无需本分支：应用会从 main 分支自动热更新。\n')

// ---------- 4. push client branch (independent one-commit repo) ----------
console.log('4/4 发布 client 引导分支…')
execSync('git init -q -b client', { cwd: tmp, windowsHide: true })
execSync('git add -A', { cwd: tmp, windowsHide: true })
execSync(`git -c user.email=publish@dsh.client -c user.name=dsh-publish commit -q -m "client bootstrap (electron ${electronVersion})"`, { cwd: tmp, windowsHide: true })
execSync(`git remote add origin "${originUrl}"`, { cwd: tmp, windowsHide: true })
const okClient = pushWithRetry(tmp, '-f origin client', 'client')
rmSync(tmp, { recursive: true, force: true })
if (!okClient) process.exit(1)
console.log('')
console.log('发布完成：')
console.log('  main   ← 源码 + payload（已装客户端的机器自动更新）')
console.log('  client ← 引导安装（新机器：仓库切到 client 分支 → Download ZIP → 双击 setup.bat）')
