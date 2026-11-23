// 验证可读性方案的纯逻辑部分：WCAG 对比度算法、安全区阈值、文字保护样式。
// 不依赖浏览器：把 factory 抽出来在 Node 里跑，喂入构造的像素样本。
import { readFileSync } from 'node:fs'

const SRC = 'D:/Agent/deepseek harness/theme-wallpaper/lib/client.js'
const src = readFileSync(SRC, 'utf8')
const start = src.indexOf('factory: (require) => {') + 'factory: (require) => {'.length
const end = src.lastIndexOf('},')
const body = src.slice(start, end)

const fakeReact = {
  createElement: () => ({}),
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
}
const win = { addEventListener() {}, removeEventListener() {}, innerWidth: 1440, innerHeight: 900 }
const el = () => ({
  style: {}, dataset: {}, classList: { add() {} }, setAttribute() {}, appendChild() {},
  remove() {}, parentElement: null,
})
const doc = {
  hidden: false, getElementById: () => null, createElement: el,
  head: { appendChild() {} },
  body: { dataset: {}, hasAttribute: () => false, appendChild() {} },
  documentElement: {}, addEventListener() {}, removeEventListener() {},
  defaultView: null,
}

// factory 体内已经有 `return module.exports;`，插到它之前，否则不可达。
const marker = 'exports.apply = apply;'
const at = body.lastIndexOf(marker)
if (at < 0) throw new Error('找不到插入点 exports.apply = apply;')

const factoryBody = body.slice(0, at) + `
globalThis.__twpTest = {
  worstContrast, safePanelPercent, contrastRatio, relativeLuminance,
  panelOver, shaded, safeZoneStyle, panelSafeTitle, ensureStyle, WCAG_AA,
};
` + body.slice(at)

const fn = new Function('require', 'window', 'document', 'fetch', 'setTimeout', 'clearTimeout',
  factoryBody)

fn((n) => {
  if (n === 'react') return fakeReact
  throw new Error('unexpected require ' + n)
}, win, doc, () => Promise.resolve({ json: () => ({ ok: true, state: {} }) }), setTimeout, clearTimeout)

const M = globalThis.__twpTest
if (!M) throw new Error('工具函数未挂载——插入点可能不在 factory 作用域内')

let fail = 0
const check = (name, cond, extra) => {
  if (cond) console.log('  PASS', name)
  else { fail++; console.log('  FAIL', name, extra === undefined ? '' : JSON.stringify(extra)) }
}

console.log('== 1. WCAG 对比度算法正确性 ==')
// 已知值：黑 vs 白 = 21:1
check('黑/白 = 21:1', Math.abs(M.contrastRatio([0, 0, 0], [255, 255, 255]) - 21) < 0.01,
  M.contrastRatio([0, 0, 0], [255, 255, 255]))
// 同色 = 1:1
check('同色 = 1:1', Math.abs(M.contrastRatio([128, 128, 128], [128, 128, 128]) - 1) < 0.001)
// 对称性
const a = M.contrastRatio([30, 60, 90], [200, 210, 220])
const b = M.contrastRatio([200, 210, 220], [30, 60, 90])
check('对比度对称', Math.abs(a - b) < 1e-9, { a, b })
// 亮度：白=1，黑=0
check('亮度 白=1', Math.abs(M.relativeLuminance([255, 255, 255]) - 1) < 1e-6)
check('亮度 黑=0', Math.abs(M.relativeLuminance([0, 0, 0])) < 1e-6)

console.log('\n== 2. 面板叠加与暗化 ==')
// 面板不透明度 1.0 时，背景完全等于面板色
check('panelOpacity=1 完全遮蔽壁纸',
  M.panelOver([255, 0, 0], 1, [17, 17, 20]).every((v, i) => v === [17, 17, 20][i]),
  M.panelOver([255, 0, 0], 1, [17, 17, 20]))
// panelOpacity 0 时保持壁纸色
check('panelOpacity=0 保持壁纸',
  M.panelOver([255, 0, 0], 0, [17, 17, 20]).join() === '255,0,0')
// dim=1 全黑
check('dim=1 变黑', M.shaded([200, 100, 50], 1).join() === '0,0,0')

console.log('\n== 3. worstContrast 单调性 ==')
// 白色壁纸最险恶：对浅色文字对比度极低
const white = [[255, 255, 255]]
const lowPanel = M.worstContrast(white, 0, 0.0)
const highPanel = M.worstContrast(white, 0, 0.95)
check('提高面板不透明度 → 对比度上升', highPanel > lowPanel, { lowPanel, highPanel })
check('白壁纸 + 无遮罩 → 浅字几乎不可读', lowPanel < 1.5, lowPanel)
// 加大暗化也应提升（深色主题下浅字遇到被压暗的白壁纸）
const dimHigh = M.worstContrast(white, 0.8, 0.0)
check('加大暗化 → 对比度上升', dimHigh > lowPanel, { dimHigh, lowPanel })

console.log('\n== 4. 安全区阈值 ==')
const samples = [[255, 255, 255], [10, 10, 10]]
const safe = M.safePanelPercent(samples, 0, M.WCAG_AA)
check('混合样本能算出安全阈值', typeof safe === 'number' && safe >= 0 && safe <= 100, safe)
const style = M.safeZoneStyle(samples, 0, M.WCAG_AA)
check('安全区样式含渐变', typeof style.background === 'string' && style.background.includes('linear-gradient'), style)
check('安全区样式标出分界', style.background.includes(safe + '%'), style.background?.slice(0, 90))
check('未测到样本时不给样式', Object.keys(M.safeZoneStyle(null, 0, M.WCAG_AA)).length === 0)
// 面板不透明度到 100% 时背景完全等于面板色，因此对任何壁纸都存在安全阈值：
// 白黑同框这种最恶劣的样本，阈值落在 60~70% 区间。
const extreme = [[255, 255, 255], [0, 0, 0]]
const extremeSafe = M.safePanelPercent(extreme, 0, M.WCAG_AA)
check('白黑同框仍有安全阈值（收敛到面板色）', typeof extremeSafe === 'number' && extremeSafe > 50,
  extremeSafe)
check('白黑同框的阈值确实能让对比度达标',
  M.worstContrast(extreme, 0, extremeSafe / 100) >= M.WCAG_AA,
  M.worstContrast(extreme, 0, extremeSafe / 100))
check('阈值之下一格确实不达标',
  M.worstContrast(extreme, 0, (extremeSafe - 1) / 100) < M.WCAG_AA,
  M.worstContrast(extreme, 0, (extremeSafe - 1) / 100))

console.log('\n== 5. 提示文案 ==')
check('测量中', M.panelSafeTitle(null, 0).includes('测量'), M.panelSafeTitle(null, 0))
check('能测出阈值时给出百分比', /\d+%/.test(M.panelSafeTitle(samples, 0)), M.panelSafeTitle(samples, 0))
check('测不出时说明原因而非误导', M.panelSafeTitle(false, 0).includes('无法测量'), M.panelSafeTitle(false, 0))

console.log('\n== 6. 文字保护样式生成 ==')
// 用假的 style 元素捕获写入的 CSS
let captured = null
const fakeStyleEl = { id: '', dataset: {}, textContent: '' }
doc.getElementById = (id) => (captured ? fakeStyleEl : null)
doc.createElement = () => { captured = true; return fakeStyleEl }
doc.head = { appendChild() {} }

M.ensureStyle({
  theme: 'system',
  wallpaper: { enabled: true, path: 'D:/x.mp4', kind: 'video', fit: 'cover', dim: 0, panelOpacity: 0.8, autopause: true, textProtect: true },
})
const css = fakeStyleEl.textContent
check('生成了样式表', typeof css === 'string' && css.length > 0)
check('含 text-shadow 规则或未测量时按 mid 保守输出', css.includes('text-shadow') || !css.includes('--dsh-twp-halo'),
  css?.slice(0, 120))
check('作用域限定到对话区', css.includes('[data-chat-flow]') || css.length === 0, '')
check('未用全局 * 选择器', !/body\[data-dsh-twp-protect\]\s*\*/.test(css), '')

// 描边颜色现在的取向由壁纸明暗决定（见 halo-test.mjs），
// 这里只验证：开启保护时，若发射描边则一定带 --dsh-twp-halo 变量。
if (css.includes('text-shadow')) {
  check('发射描边时带光晕变量', css.includes('var(--dsh-twp-halo)'), css.slice(0, 200))
}

// 关闭保护后不应出现光晕
captured = null
fakeStyleEl.textContent = ''
M.ensureStyle({
  theme: 'system',
  wallpaper: { enabled: true, path: 'D:/x.mp4', kind: 'video', fit: 'cover', dim: 0, panelOpacity: 0.8, autopause: true, textProtect: false },
})
check('关闭保护后无 text-shadow', !fakeStyleEl.textContent.includes('text-shadow'),
  fakeStyleEl.textContent?.slice(0, 80))
check('关闭保护后仍有壁纸层规则', fakeStyleEl.textContent.includes('position:fixed'),
  '')

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}`)
process.exit(fail === 0 ? 0 : 1)
