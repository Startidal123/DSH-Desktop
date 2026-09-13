// One-command publish: build the payload into dist/, stamp version.json,
// commit everything and push to the release repo. Clients pick it up on
// their next silent check.
import { execSync } from 'node:child_process'
import { writeFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'

const root = process.cwd()
const args = process.argv.slice(2)
const repoArgIdx = args.indexOf('--repo')
const repoArg = repoArgIdx !== -1 ? args[repoArgIdx + 1] : ''

function git(cmd, opts = {}) {
  return execSync(`git ${cmd}`, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: 'pipe', ...opts }).toString().trim()
}

// 0. repo must exist
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

// 1. clean frontend build
console.log('1/3 构建前端…')
execSync('npx vite build', { cwd: root, windowsHide: true, stdio: 'inherit' })

// 2. stamp version.json + binary-faithful git attrs (no CRLF mangling so
//    client-side md5 comparison of electron/ stays exact)
writeFileSync(join(root, 'version.json'), JSON.stringify({ builtAt: new Date().toISOString() }, null, 2) + '\n')
writeFileSync(join(root, '.gitattributes'), '* -text\n')
console.log('2/3 生成 version.json + .gitattributes')

// 3. commit + push
console.log('3/3 提交并推送…')
git('add -A')
const changed = (() => {
  try { execSync('git diff --cached --quiet', { cwd: root, windowsHide: true, stdio: 'ignore' }); return false } catch { return true }
})()
if (!changed) {
  console.log('没有变化，无需发布')
  process.exit(0)
}
git('commit -m "release: payload build"')
try {
  git('push -u origin main')
} catch (err) {
  console.error('推送失败（检查网络/GitHub 凭证）：' + err.message)
  console.error('提交已完成，稍后可手动 git push')
  process.exit(1)
}
console.log('发布完成，客户端将在下次检查时自动更新')
