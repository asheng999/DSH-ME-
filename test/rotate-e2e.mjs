// 端到端：轮换配置能否经 save → 磁盘 → 回读 完整往返，且旧状态能平滑升级。
import http from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'

const STATE = join(tmpdir(), 'twp-rot-' + Date.now() + '.json')
process.env.THEME_WALLPAPER_STATE = STATE

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
const save = async (state) => (await fetch(base + '/theme-wallpaper/save', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state }),
})).json()
const load = async () => (await fetch(base + '/theme-wallpaper/state')).json()

console.log('== 1. 旧状态升级（无 rotate 字段）==')
writeFileSync(STATE, JSON.stringify({ theme: 'system', wallpaper: { enabled: true, path: 'D:/a.mp4' }, we: { dir: '', mpkgDir: '' } }))
let j = await load()
check('旧状态自动补出 rotate', j.state.rotate !== undefined && j.state.rotate.mode === 'off', j.state.rotate)
check('旧状态补出 textProtect=true', j.state.wallpaper.textProtect === true, j.state.wallpaper)
check('旧壁纸路径保留', j.state.wallpaper.path === 'D:/a.mp4')

console.log('\n== 2. 轮换配置往返 ==')
const playlist = ['D:\\壁纸\\a.mp4', 'D:\\壁纸\\b.jpg', 'D:\\壁纸\\c.png']
j = await save({
  theme: 'system',
  wallpaper: { enabled: true, path: playlist[0], kind: 'video' },
  rotate: { mode: 'sequential', minutes: 15, playlist, cursor: 1 },
})
check('模式保存', j.state.rotate.mode === 'sequential', j.state.rotate)
check('间隔保存', j.state.rotate.minutes === 15, j.state.rotate)
check('列表保存', j.state.rotate.playlist.length === 3, j.state.rotate.playlist)
check('cursor 保存', j.state.rotate.cursor === 1, j.state.rotate)

console.log('\n== 3. 磁盘持久化 ==')
const disk = JSON.parse(readFileSync(STATE, 'utf8'))
check('磁盘含 rotate', disk.rotate !== undefined, Object.keys(disk))
check('磁盘含 playlist', Array.isArray(disk.rotate.playlist) && disk.rotate.playlist.length === 3, disk.rotate)
check('磁盘含 textProtect', typeof disk.wallpaper.textProtect === 'boolean', disk.wallpaper)

console.log('\n== 4. 随机模式 ==')
j = await save({
  theme: 'system',
  wallpaper: { enabled: true, path: playlist[0], kind: 'video' },
  rotate: { mode: 'random', minutes: 5, playlist, cursor: 2 },
})
check('随机模式保存', j.state.rotate.mode === 'random', j.state.rotate.mode)
check('cursor 保留', j.state.rotate.cursor === 2, j.state.rotate.cursor)

console.log('\n== 5. 关闭轮换后配置仍在 ==')
j = await save({
  theme: 'system',
  wallpaper: { enabled: true, path: playlist[0], kind: 'video' },
  rotate: { mode: 'off', minutes: 5, playlist, cursor: 2 },
})
check('关闭后模式为 off', j.state.rotate.mode === 'off')
check('关闭后列表不丢', j.state.rotate.playlist.length === 3, j.state.rotate.playlist)

console.log('\n== 6. 组合：文字保护与轮换共存 ==')
j = await save({
  theme: 'system',
  wallpaper: { enabled: true, path: playlist[0], kind: 'video', textProtect: false },
  rotate: { mode: 'sequential', minutes: 60, playlist, cursor: 0 },
})
check('两个新功能可同时保存', j.state.wallpaper.textProtect === false && j.state.rotate.mode === 'sequential',
  { tp: j.state.wallpaper.textProtect, mode: j.state.rotate.mode })

server.close()
try { unlinkSync(STATE) } catch {}
console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}`)
process.exit(fail === 0 ? 0 : 1)
