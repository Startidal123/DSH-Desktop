// Generate build/icon.ico from the whale mark in src/components/WhaleMark.jsx.
// The path is extracted from the component so icon and UI never drift apart.
import sharp from 'sharp'
import pngToIco from 'png-to-ico'
import { readFileSync, mkdirSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const outDir = join(root, 'build')

const component = readFileSync(join(root, 'src/components/WhaleMark.jsx'), 'utf8')
const dAttr = /d="([^"]+)"/.exec(component)?.[1]
if (!dAttr) throw new Error('WhaleMark.jsx 里找不到 path d 属性')

// whale native box: 27 x 22 → scale onto a square canvas with padding
const W = 27, H = 22
const SIZES = [256, 128, 64, 48, 32, 16]
const svgFor = (size, color) => {
  const k = (size * 0.84) / W
  const tx = (size - W * k) / 2
  const ty = (size - H * k) / 2
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<g transform="translate(${tx} ${ty}) scale(${k})"><path d="${dAttr}" fill="${color}"/></g></svg>`
}

mkdirSync(outDir, { recursive: true })
const pngs = []
for (const s of SIZES) {
  const buf = await sharp(Buffer.from(svgFor(s, '#4D6BFE'))).png().toBuffer()
  pngs.push(buf)
  writeFileSync(join(outDir, `icon-${s}.png`), buf)
}
const ico = await pngToIco(pngs)
writeFileSync(join(outDir, 'icon.ico'), ico)

// keep only the ico in build/ to stay tidy
for (const f of readdirSync(outDir)) {
  if (f.endsWith('.png')) unlinkSync(join(outDir, f))
}
console.log(`icon.ico written (${ico.length} bytes, sizes ${SIZES.join('/')})`)
