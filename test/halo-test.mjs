// 验证 wallpaperTone / haloFor 的实际行为（直接跑 client.js 里的真实函数）
import { readFileSync } from 'node:fs'

const src = readFileSync('D:/Agent/deepseek harness/theme-wallpaper/lib/client.js', 'utf8')
const cs = src.indexOf('factory: (require) => {') + 'factory: (require) => {'.length
const ce = src.lastIndexOf('},')
const body = src.slice(cs, ce)
const marker = '// ---- plugin entry ----'
const at = body.lastIndexOf(marker)
const factoryBody = body.slice(0, at) + `
globalThis.__H = { wallpaperTone, haloFor, relativeLuminance, contrastRatio };
` + body.slice(at)

const fakeReact = { createElement: () => ({}), useState: (v) => [typeof v === 'function' ? v() : v, () => {}], useEffect: () => {}, useRef: () => ({ current: null }) }
const win = { addEventListener() {}, removeEventListener() {}, innerWidth: 1200, innerHeight: 800 }
const el = () => ({ style: {}, dataset: {}, classList: { add() {} }, setAttribute() {}, appendChild() {}, remove() {}, parentElement: null, getContext: () => null })
const doc = { hidden: false, getElementById: () => null, createElement: el, head: { appendChild() {} }, body: { dataset: {}, hasAttribute: () => false, appendChild() {} }, documentElement: {}, addEventListener() {}, removeEventListener() {} }
new Function('require', 'window', 'document', 'fetch', 'setTimeout', 'clearTimeout', factoryBody)(
  (n) => { if (n === 'react') return fakeReact; throw new Error(n) },
  win, doc, () => Promise.resolve({ json: () => ({ ok: true }) }), setTimeout, clearTimeout)
const H = globalThis.__H

let fail = 0
const check = (n, c, e) => { if (c) console.log('  PASS', n); else { fail++; console.log('  FAIL', n, JSON.stringify(e)) } }

// 构造均匀亮度样本
const flat = (v) => Array.from({ length: 100 }, () => [v, v, v])

console.log('== 1. 色系判定 ==')
check('纯黑 → dark', H.wallpaperTone(flat(0)).level === 'dark', H.wallpaperTone(flat(0)))
check('纯白 → light', H.wallpaperTone(flat(255)).level === 'light', H.wallpaperTone(flat(255)))
check('纯灰128 → mid', H.wallpaperTone(flat(128)).level === 'mid', H.wallpaperTone(flat(128)))
check('空样本 → mid（保守）', H.wallpaperTone([]).level === 'mid')
check('null 样本 → mid', H.wallpaperTone(null).level === 'mid')

console.log('\n== 2. 中位数抗异常值 ==')
// 99 个黑 + 1 个白：平均会被拉高，中位数仍是黑
const mixed = [...Array(99).fill([0, 0, 0]), [255, 255, 255]]
check('99黑+1白 → dark（不受亮块绑架）', H.wallpaperTone(mixed).level === 'dark', H.wallpaperTone(mixed).level)

console.log('\n== 3. 描边选择：深色主题（浅字）==')
// 浅字压深底：本来清楚，不该加描边
check('dark 壁纸 → 不加描边', H.haloFor({ level: 'dark' }, true, 0, 0.9) === null, H.haloFor({ level: 'dark' }, true, 0, 0.9))
// 浅字压浅底：需要深描边
const onLight = H.haloFor({ level: 'light' }, true, 0, 0.9)
check('light 壁纸 → 深描边', typeof onLight === 'string' && onLight.includes('0,0,0'), onLight)
const onMid = H.haloFor({ level: 'mid' }, true, 0, 0.9)
check('mid 壁纸 → 深描边', typeof onMid === 'string' && onMid.includes('0,0,0'), onMid)

console.log('\n== 4. 描边选择：浅色主题（深字）==')
// 深字压深底：需要浅描边（这是旧版搞错的核心场景）
const darkPaper = H.haloFor({ level: 'dark' }, false, 0, 0.9)
check('dark 壁纸 → 浅描边', typeof darkPaper === 'string' && darkPaper.includes('255,255,255'), darkPaper)
// 深字压浅底：本来清楚
check('light 壁纸 → 不加描边', H.haloFor({ level: 'light' }, false, 0, 0.9) === null)
const midPaper = H.haloFor({ level: 'mid' }, false, 0, 0.9)
check('mid 壁纸 → 浅描边', typeof midPaper === 'string' && midPaper.includes('255,255,255'), midPaper)

console.log('\n== 5. 关键回归：深色壁纸 + 深色主题不再削弱对比度 ==')
// 这正是用户报告的场景：深色主题（浅字）+ 深色壁纸
const sampleDarkPaper = flat(30)   // 深色壁纸
const tone = H.wallpaperTone(sampleDarkPaper)
check('深色壁纸判定为 dark', tone.level === 'dark', tone)
const halo = H.haloFor(tone, true, 0, 0.9)
check('浅字 + 深壁纸 → 不加描边（避免把 13:1 拉低到 1.2:1）', halo === null, halo)

// 若强行加白描边，对比度会掉到多少？
const textLight = [229, 231, 235]
const white = [255, 255, 255]
check('（对照）浅字与白描边对比度极低', H.contrastRatio(textLight, white) < 1.3,
  H.contrastRatio(textLight, white))
check('（对照）浅字与深壁纸对比度很高', H.contrastRatio(textLight, [30, 30, 30]) > 10,
  H.contrastRatio(textLight, [30, 30, 30]))

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}`)
process.exit(fail === 0 ? 0 : 1)
