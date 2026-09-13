// Workaround packaging: Defender deletes electron.exe during electron-builder's
// rename step, so we run the "dir" target and complete the final steps manually.
import { execSync } from 'node:child_process'
import { existsSync, cpSync, rmSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const out = join(root, 'release', 'win-unpacked')
const electronDist = join(root, 'node_modules', 'electron', 'dist')
const iconFile = join(root, 'build', 'icon.ico')

try {
  rmSync(join(root, 'release'), { recursive: true, force: true })
} catch {
  console.error('release 目录被占用（请先关闭正在运行的 DSH Client.exe）')
  process.exit(1)
}
console.log('1/5 building frontend…')
execSync('npx vite build', { stdio: 'inherit' })
// payload version stamp read by client-update.mjs / settings
writeFileSync(join(root, 'version.json'), JSON.stringify({ builtAt: new Date().toISOString() }, null, 2) + '\n')

console.log('2/5 electron-builder (dir)…')
try {
  execSync('npx electron-builder --win dir', { stdio: 'inherit' })
} catch {
  console.log('(builder stopped at the known rename step — completing manually)')
}

console.log('3/5 completing runtime files…')
const exeName = 'DSH Client.exe'
if (!existsSync(join(out, exeName))) {
  cpSync(join(electronDist, 'electron.exe'), join(out, exeName))
}
// payload version stamp + baseline install marker for client self-update
const appDir = join(out, 'resources', 'app')
if (existsSync(appDir)) {
  cpSync(join(root, 'version.json'), join(appDir, 'version.json'))
  if (!existsSync(join(appDir, '.installed-commit'))) {
    writeFileSync(join(appDir, '.installed-commit'), 'initial-zip\n')
  }
}
for (const f of readdirSync(electronDist)) {
  if (f === 'electron.exe' || f.endsWith('.pdb') || f === 'LICENSE' || f === 'LICENSES.chromium.html') continue
  const dst = join(out, f)
  if (!existsSync(dst)) cpSync(join(electronDist, f), dst, { recursive: true })
}

console.log('4/5 embedding whale icon…')
// rcedit-x64.exe lives in electron-builder's winCodeSign cache; 7zip-bin
// (an electron-builder dependency) unpacks it on first use
const rceditCache = join(process.env.LOCALAPPDATA ?? '', 'electron-builder', 'Cache', 'winCodeSign')
let rceditExe = ''
for (const d of existsSync(rceditCache) ? readdirSync(rceditCache) : []) {
  if (/^\d+$/.test(d) && existsSync(join(rceditCache, d, 'rcedit-x64.exe'))) {
    rceditExe = join(rceditCache, d, 'rcedit-x64.exe')
    break
  }
}
if (!rceditExe) {
  const arch = readdirSync(rceditCache).find(d => /^\d+$/.test(d) && existsSync(join(rceditCache, `${d}.7z`)))
  if (arch) {
    const sevenZip = join(root, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe')
    execSync(`"${sevenZip}" x -y -o"${join(rceditCache, arch)}" "${join(rceditCache, arch + '.7z')}"`, { stdio: 'ignore' })
    rceditExe = join(rceditCache, arch, 'rcedit-x64.exe')
  }
}
if (existsSync(iconFile) && rceditExe) {
  try {
    execSync(`"${rceditExe}" "${join(out, exeName)}" --set-icon "${iconFile}" --set-version-string ProductName "DSH Client" --set-version-string FileDescription "DeepSeek Harness Client"`, { stdio: 'inherit', timeout: 60000 })
    if (!existsSync(join(out, exeName))) {
      // security software may swallow the exe mid-edit; restore a plain one
      cpSync(join(electronDist, 'electron.exe'), join(out, exeName))
      console.log('(图标嵌入被安全软件拦截，已回退默认图标)')
    } else {
      console.log('图标已嵌入')
    }
  } catch {
    if (!existsSync(join(out, exeName))) cpSync(join(electronDist, 'electron.exe'), join(out, exeName))
    console.log('(图标嵌入失败，继续使用默认图标)')
  }
} else {
  console.log('(跳过：icon.ico 或 rcedit 不可用，先运行 node scripts/make-icon.mjs)')
}

console.log('5/5 packaging zip…')
execSync(`powershell -NoProfile -Command "Compress-Archive -Path 'release/win-unpacked/*' -DestinationPath 'release/DSH-Client-0.1.0-win64.zip' -Force"`, { stdio: 'inherit' })
console.log('done: release/win-unpacked (folder) + release/DSH-Client-0.1.0-win64.zip')
