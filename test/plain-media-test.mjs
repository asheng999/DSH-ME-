// 普通媒体（非 .mpkg）识别：确保用户直接放进素材目录的图片/视频也能出现在画廊，
// 并且能通过 /file 路由读取。这是「只认 .mpkg」这个 bug 的回归测试。
import http from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdir, rm, writeFile } from 'node:fs/promises'

const DIR = join(tmpdir(), 'twp-plain-' + Date.now())
const STATE = join(DIR, 'state.json')
await mkdir(DIR, { recursive: true })
process.env.THEME_WALLPAPER_STATE = STATE

// 真实的 JPEG 与 MP4 头，让 kind 判定与读取都走正常路径
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]),
  Buffer.alloc(2048, 0x11),
])
const MP4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x20]),
  Buffer.from('ftypisom', 'ascii'),
  Buffer.alloc(4096, 0x22),
])
await writeFile(join(DIR, '【测试】风景.jpg'), JPEG)
await writeFile(join(DIR, '【测试】动画.mp4'), MP4)
await writeFile(join(DIR, '【测试】含中文与空格 的文件.webp'), Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(300)]))
// 不可识别的扩展名，应被忽略而不是报错
await writeFile(join(DIR, 'notes.txt'), 'not a wallpaper')

const plugin = await import('../lib/index.js?t=' + Date.now())
const routes = []
plugin.apply({ effect: (fn) => fn(), webServer: { register: (r) => routes.push(r) } })
const byPath = new Map(routes.map((r) => [r.path, r.handler]))
const server = http.createServer((req, res) => {
  const h = byPath.get(new URL(req.url, 'http://x').pathname)
  if (!h) { res.statusCode = 404; res.end(); return }
  h(req, res)
})
await new Promise((r) => server.listen(0, r))
const base = `http://127.0.0.1:${server.address().port}`

let fail = 0
const check = (n, c, e) => {
  if (c) console.log('  PASS', n)
  else { fail++; console.log('  FAIL', n, JSON.stringify(e)) }
}

// 把 DIR 设为素材目录
let r = await fetch(base + '/theme-wallpaper/mpkg-folder', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ path: DIR }),
})
let j = await r.json()
check('素材目录设置成功', j.ok === true, j)

// 扫描
j = await (await fetch(base + '/theme-wallpaper/we-library')).json()
const items = j.entries || []
const names = items.map((e) => e.title)

console.log('  识别到: ' + JSON.stringify(names))
check('扫描成功', j.ok === true)
check('识别出 jpg', names.some((n) => n.includes('风景')), names)
check('识别出 mp4', names.some((n) => n.includes('动画')), names)
check('识别出 webp（中文+空格文件名）', names.some((n) => n.includes('含中文与空格')), names)
check('忽略 .txt', !names.some((n) => n.endsWith('.txt')), names)
check('普通文件数 = 3', j.fileCount === 3, { fileCount: j.fileCount, count: j.count })
check('压缩包数 = 0', j.packageCount === 0, j.packageCount)

console.log('\n== 类型与预览 ==')
const jpg = items.find((e) => e.title.includes('风景'))
const mp4 = items.find((e) => e.title.includes('动画'))
check('jpg 判定为 image', jpg && jpg.kind === 'image', jpg && jpg.kind)
check('mp4 判定为 video', mp4 && mp4.kind === 'video', mp4 && mp4.kind)
check('图片自带预览', jpg && jpg.preview === jpg.media, jpg && { p: jpg.preview, m: jpg.media })
check('视频无预览（交给前端首帧）', mp4 && mp4.preview === '', mp4 && mp4.preview)
check('普通文件标记 fromMpkg=false', items.every((e) => e.fromMpkg === false), items.map((e) => e.fromMpkg))
check('id 前缀为 file::', items.every((e) => e.id.startsWith('file::')), items.map((e) => e.id))

console.log('\n== 文件可通过 /file 读取（含中文名）==')
for (const e of items) {
  const res = await fetch(base + '/theme-wallpaper/file?path=' + encodeURIComponent(e.media), { headers: { Range: 'bytes=0-99' } })
  check('可读取: ' + e.title, res.status === 206, { status: res.status })
}

console.log('\n== 轮换列表中的路径也在白名单内 ==')
// 造一个 DIR 之外的文件，加进轮换列表后应可读
const OUTSIDE = join(tmpdir(), 'twp-outside-' + Date.now())
await mkdir(OUTSIDE, { recursive: true })
const outsideFile = join(OUTSIDE, 'rotated.jpg')
await writeFile(outsideFile, JPEG)
j = await fetch(base + '/theme-wallpaper/save', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ state: {
    theme: 'system',
    wallpaper: { enabled: true, path: outsideFile, kind: 'image' },
    we: { dir: '', mpkgDir: DIR },
    rotate: { mode: 'sequential', minutes: 5, playlist: [outsideFile], cursor: 0 },
  } }),
}).then((x) => x.json())
check('含外部轮换项的配置保存成功', j.ok === true, j)
let res = await fetch(base + '/theme-wallpaper/file?path=' + encodeURIComponent(outsideFile), { headers: { Range: 'bytes=0-99' } })
check('轮换列表中的外部文件可读取', res.status === 206, { status: res.status })

server.close()
try { await rm(DIR, { recursive: true, force: true }) } catch {}
try { await rm(OUTSIDE, { recursive: true, force: true }) } catch {}
console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}`)
process.exit(fail === 0 ? 0 : 1)
