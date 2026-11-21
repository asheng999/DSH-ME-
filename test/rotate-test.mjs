// 壁纸轮换的纯逻辑测试：顺序/随机/关闭，以及 sanitize 的清洗行为。
import { readFileSync } from 'node:fs'

const ROOT = 'D:/Agent/deepseek harness/theme-wallpaper'
let fail = 0
const check = (n, c, e) => {
  if (c) console.log('  PASS', n)
  else { fail++; console.log('  FAIL', n, e === undefined ? '' : JSON.stringify(e)) }
}

// ---------- 1. Host 侧 sanitize ----------
const hostSrc = readFileSync(ROOT + '/lib/index.js', 'utf8')
const sanitizeSrc = hostSrc.slice(hostSrc.indexOf('function sanitize(raw)'), hostSrc.indexOf('async function readState'))
const defaultStateSrc = hostSrc.slice(hostSrc.indexOf('function defaultState()'), hostSrc.indexOf('function clampInt'))
const clampIntSrc = hostSrc.slice(hostSrc.indexOf('function clampInt'), hostSrc.indexOf('/** Keep only absolute'))
const cleanSrc = hostSrc.slice(hostSrc.indexOf('function cleanPlaylist'), hostSrc.indexOf('function clamp01(value)'))
const clamp01Src = hostSrc.slice(hostSrc.indexOf('function clamp01(value)'), hostSrc.indexOf('function guessKind'))

const sanitize = new Function(
  'THEMES', 'FITS', 'VIDEO_EXT', 'extname', 'isAbsolute', 'ROTATE_MODES', 'MIN_ROTATE_MINUTES', 'MAX_ROTATE_MINUTES',
  defaultStateSrc + clampIntSrc + cleanSrc + clamp01Src +
  'function guessKind(p){return /\\.(mp4|webm|mov|mkv)$/i.test(p)?"video":"image"}' +
  sanitizeSrc + '\n; return { sanitize, defaultState }',
)(
  new Set(['system', 'light', 'dark', 'macos']),
  new Set(['cover', 'fill', 'stretch', 'free']),
  new Set(['.mp4', '.webm', '.mov', '.mkv']),
  (p) => '', (p) => /^[A-Za-z]:[\\/]/.test(p),
  new Set(['off', 'sequential', 'random']), 1, 1440,
)

console.log('== 1. 默认值 ==')
const d = sanitize.defaultState()
check('默认不轮换', d.rotate.mode === 'off', d.rotate)
check('默认间隔 30 分钟', d.rotate.minutes === 30, d.rotate.minutes)
check('默认列表为空', Array.isArray(d.rotate.playlist) && d.rotate.playlist.length === 0)

console.log('\n== 2. 轮换模式白名单 ==')
for (const mode of ['off', 'sequential', 'random']) {
  check(`接受 ${mode}`, sanitize.sanitize({ rotate: { mode } }).rotate.mode === mode)
}
check('拒绝非法模式', sanitize.sanitize({ rotate: { mode: 'shuffle' } }).rotate.mode === 'off')

console.log('\n== 3. 间隔钳制 ==')
check('0 分钟 → 1', sanitize.sanitize({ rotate: { minutes: 0 } }).rotate.minutes === 1,
  sanitize.sanitize({ rotate: { minutes: 0 } }).rotate.minutes)
check('负数 → 1', sanitize.sanitize({ rotate: { minutes: -40 } }).rotate.minutes === 1)
check('超过 24 小时 → 1440', sanitize.sanitize({ rotate: { minutes: 99999 } }).rotate.minutes === 1440)
check('小数四舍五入', sanitize.sanitize({ rotate: { minutes: 12.6 } }).rotate.minutes === 13)
check('非数字回落默认 30', sanitize.sanitize({ rotate: { minutes: 'abc' } }).rotate.minutes === 30)

console.log('\n== 4. 列表清洗 ==')
const cleaned = sanitize.sanitize({ rotate: { playlist: ['D:\\a.mp4', 'D:\\a.mp4', '  ', 'relative\\b.jpg', 'D:\\c.png', 123] } }).rotate.playlist
check('去重', cleaned.filter((p) => p === 'D:\\a.mp4').length === 1, cleaned)
check('去掉空白项', !cleaned.includes(''), cleaned)
check('去掉相对路径', !cleaned.some((p) => p === 'relative\\b.jpg'), cleaned)
check('去掉非字符串', cleaned.every((p) => typeof p === 'string'), cleaned)
check('保留合法项', cleaned.length === 2, cleaned)

console.log('\n== 5. cursor 边界 ==')
check('cursor 超界被钳制', sanitize.sanitize({ rotate: { playlist: ['D:\\a.mp4', 'D:\\b.mp4'], cursor: 99 } }).rotate.cursor === 1,
  sanitize.sanitize({ rotate: { playlist: ['D:\\a.mp4', 'D:\\b.mp4'], cursor: 99 } }).rotate.cursor)
check('空列表时 cursor=0', sanitize.sanitize({ rotate: { playlist: [], cursor: 5 } }).rotate.cursor === 0)

// ---------- 2. 客户端轮换算法 ----------
const clientSrc = readFileSync(ROOT + '/lib/client.js', 'utf8')
const cs = clientSrc.indexOf('factory: (require) => {') + 'factory: (require) => {'.length
const ce = clientSrc.lastIndexOf('},')
const body = clientSrc.slice(cs, ce)
// 挂载点必须落在 factory 作用域内：插在 `function apply(ctx)` 定义之前
const marker = '// ---- plugin entry ----'
const at = body.lastIndexOf(marker)
if (at < 0) throw new Error('找不到插入点')
const factoryBody = body.slice(0, at) + `
globalThis.__R = { nextRotationIndex, guessKind, baseName, ROTATE_DEFAULT };
` + body.slice(at)

const fakeReact = { createElement: () => ({}), useState: (v) => [typeof v === 'function' ? v() : v, () => {}], useEffect: () => {}, useRef: () => ({ current: null }) }
const win = { addEventListener() {}, removeEventListener() {}, innerWidth: 1200, innerHeight: 800 }
const el = () => ({ style: {}, dataset: {}, classList: { add() {} }, setAttribute() {}, appendChild() {}, remove() {}, parentElement: null, getContext: () => null })
const doc = { hidden: false, getElementById: () => null, createElement: el, head: { appendChild() {} }, body: { dataset: {}, hasAttribute: () => false, appendChild() {} }, documentElement: {}, addEventListener() {}, removeEventListener() {} }
new Function('require', 'window', 'document', 'fetch', 'setTimeout', 'clearTimeout', factoryBody)(
  (n) => { if (n === 'react') return fakeReact; throw new Error(n) },
  win, doc, () => Promise.resolve({ json: () => ({ ok: true }) }), setTimeout, clearTimeout)
const R = globalThis.__R

console.log('\n== 6. 顺序轮换 ==')
const seq = { playlist: ['a', 'b', 'c'], cursor: 0 }
check('0 → 1', R.nextRotationIndex(seq, 'sequential') === 1, R.nextRotationIndex(seq, 'sequential'))
check('2 → 0（回环）', R.nextRotationIndex({ playlist: ['a', 'b', 'c'], cursor: 2 }, 'sequential') === 0)
check('空列表 → null', R.nextRotationIndex({ playlist: [], cursor: 0 }, 'sequential') === null)
check('单张 → 0', R.nextRotationIndex({ playlist: ['a'], cursor: 0 }, 'sequential') === 0)

console.log('\n== 7. 随机轮换 ==')
const rnd = { playlist: ['a', 'b', 'c', 'd'], cursor: 1 }
let neverSame = true
let allReachable = new Set()
for (let i = 0; i < 500; i++) {
  const idx = R.nextRotationIndex(rnd, 'random')
  if (idx === 1) neverSame = false
  if (idx < 0 || idx >= 4) allReachable.add('越界:' + idx)
  allReachable.add(idx)
}
check('500 次内不会连续抽中同一张（即不等于当前 cursor）', neverSame)
check('下标始终在范围内', ![...allReachable].some((x) => typeof x === 'string'), [...allReachable])
check('除当前以外的所有下标都能抽到', [0, 2, 3].every((i) => allReachable.has(i)), [...allReachable].sort())
check('单张列表时返回 0', R.nextRotationIndex({ playlist: ['only'], cursor: 0 }, 'random') === 0)

console.log('\n== 8. 辅助函数 ==')
check('视频判定', R.guessKind('D:\\a.MP4') === 'video' && R.guessKind('D:\\a.jpg') === 'image')
check('取文件名(反斜杠)', R.baseName('D:\\壁纸\\a.mp4') === 'a.mp4', R.baseName('D:\\壁纸\\a.mp4'))
check('取文件名(正斜杠)', R.baseName('D:/壁纸/b.png') === 'b.png', R.baseName('D:/壁纸/b.png'))
check('无分隔符原样返回', R.baseName('a.mp4') === 'a.mp4')
check('ROTATE_DEFAULT 完整', (() => { const r = R.ROTATE_DEFAULT(); return r.mode === 'off' && r.minutes === 30 && Array.isArray(r.playlist) && r.cursor === 0 })())

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}`)
process.exit(fail === 0 ? 0 : 1)
