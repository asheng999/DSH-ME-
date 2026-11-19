// host-test.mjs — standalone smoke test of the theme-wallpaper host routes.
// Runs the plugin's real apply() against a real node:http server, so the
// req/res are genuine IncomingMessage/ServerResponse just like in production.
// The plugin's persisted state is redirected to a temp file so this test can
// NEVER touch (or wipe) the user's real theme-wallpaper/state.json.
import http from 'node:http'
import { unlink, mkdir, rm } from 'node:fs/promises'
import { existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TEST_STATE = join(tmpdir(), 'dsh-theme-wallpaper-test-state.json')
process.env.THEME_WALLPAPER_STATE = TEST_STATE

// These two temp dirs double as the "export folder" and the "desktop" that
// WE drops .mpkg files onto, so they must exist before any route is exercised.
const MPKG_TMP = join(tmpdir(), 'dsh-twp-mpkg-test')
const COLLECT_SRC = join(tmpdir(), 'dsh-twp-collect-src')
await mkdir(MPKG_TMP, { recursive: true })
await mkdir(COLLECT_SRC, { recursive: true })
// The collect route only moves .mpkg out of the desktop/downloads roots; point
// it at the fixture dir so the test never touches the real Desktop.
process.env.THEME_WALLPAPER_COLLECT_ROOTS = COLLECT_SRC

const plugin = await import('../lib/index.js')

const WE_VIDEO = 'D:/GAME/steam/steamapps/workshop/content/431960/2003005131/SSOA.mp4'

// Mock ctx: effect() runs immediately; webServer.register collects routes.
const routes = []
const ctx = {
  effect: (fn) => fn(),
  webServer: { register: (route) => routes.push(route) },
}
plugin.apply(ctx)

const byPath = new Map(routes.map((r) => [r.path, r.handler]))
const server = http.createServer((req, res) => {
  const handler = byPath.get(new URL(req.url, 'http://x').pathname)
  if (!handler) { res.statusCode = 404; res.end('no route'); return }
  handler(req, res)
})
await new Promise((r) => server.listen(0, r))
const base = `http://127.0.0.1:${server.address().port}`

let pass = 0, fail = 0
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS', name) }
  else { fail++; console.log('  FAIL', name, extra !== undefined ? JSON.stringify(extra) : '') }
}

// 1. GET state (no file yet → default state)
let r = await fetch(base + '/theme-wallpaper/state')
let j = await r.json()
check('GET state 200+ok', r.status === 200 && j.ok === true, j)
check('default theme=system', j.state.theme === 'system', j.state)

// 2. POST save (sanitize + guess kind + persist)
r = await fetch(base + '/theme-wallpaper/save', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ state: { theme: 'macos', wallpaper: { enabled: true, path: WE_VIDEO, dim: 0.5, panelOpacity: 0.7, autopause: false, kind: 'image' } } }),
})
j = await r.json()
check('POST save 200+ok', r.status === 200 && j.ok === true, j)
check('theme=macos', j.state.theme === 'macos', j.state)
check('kind guessed video (overrode image)', j.state.wallpaper.kind === 'video', j.state.wallpaper)
check('dim=0.5 kept', j.state.wallpaper.dim === 0.5, j.state.wallpaper)

// 3. GET state reflects persisted file
r = await fetch(base + '/theme-wallpaper/state')
j = await r.json()
check('state persisted to disk', j.state.theme === 'macos' && j.state.wallpaper.path === WE_VIDEO, j.state)

// 4. GET file: real WE video streams with correct content-type
r = await fetch(base + '/theme-wallpaper/file?path=' + encodeURIComponent(WE_VIDEO))
const buf = Buffer.from(await r.arrayBuffer())
check('file 200 video/mp4 non-empty', r.status === 200 && (r.headers.get('content-type') || '').includes('video/mp4') && buf.length > 1000, { status: r.status, ct: r.headers.get('content-type'), len: buf.length })

// 4b. Range request → 206 partial content (what <video> requires to play)
r = await fetch(base + '/theme-wallpaper/file?path=' + encodeURIComponent(WE_VIDEO), { headers: { Range: 'bytes=0-1023' } })
const rbuf = Buffer.from(await r.arrayBuffer())
check('Range → 206 partial', r.status === 206, { status: r.status })
check('Range content-range', (r.headers.get('content-range') || '').startsWith('bytes 0-1023/'), r.headers.get('content-range'))
check('Range body = 1024 bytes', rbuf.length === 1024, { len: rbuf.length })
// 4c. suffix range
r = await fetch(base + '/theme-wallpaper/file?path=' + encodeURIComponent(WE_VIDEO), { headers: { Range: 'bytes=-100' } })
const sbuf = Buffer.from(await r.arrayBuffer())
const cr = r.headers.get('content-range') || ''
const m2 = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(cr)
const crOK = !!m2 && m2[2] === String(Number(m2[3]) - 1) && m2[1] === String(Number(m2[3]) - 100)
check('suffix Range → 206 tail 100', r.status === 206 && sbuf.length === 100 && crOK, { status: r.status, cr, len: sbuf.length })

// 5. GET file: non-absolute path → 400
r = await fetch(base + '/theme-wallpaper/file?path=relative.mp4')
check('non-absolute → 400', r.status === 400, { status: r.status })

// 6. GET file: unsupported extension → 400
r = await fetch(base + '/theme-wallpaper/file?path=' + encodeURIComponent('C:/Windows/notepad.exe'))
check('bad ext → 400', r.status === 400, { status: r.status })

// 6b. GET file: path outside every allowed root → 403 (never 404, which would
// leak whether an out-of-root file exists)
r = await fetch(base + '/theme-wallpaper/file?path=' + encodeURIComponent('C:/no/such/file.mp4'))
check('out-of-root path → 403', r.status === 403, { status: r.status })

// 8. WE library scan: DEFAULT returns ONLY converted .mpkg entries (no low-res thumbnails)
r = await fetch(base + '/theme-wallpaper/we-library')
j = await r.json()
check('we-library 200+ok', r.status === 200 && j.ok === true, { count: j.count, mpkgCount: j.mpkgCount })
check('we-library default has no non-mpkg entries', j.entries.every((e) => e.fromMpkg === true), { count: j.count })
// 8b. ?lib=1 still exposes the full WE library (community/advanced)
r = await fetch(base + '/theme-wallpaper/we-library?lib=1')
j = await r.json()
check('lib=1 returns full library', r.status === 200 && j.ok === true && j.count > 100, { count: j.count })
check('lib=1 has >100 previews', j.entries.filter((e) => e.preview).length > 100, { previews: j.entries.filter((e) => e.preview).length })
const perFolder = {}
for (const e of j.entries) { const f = e.id.split('::')[0]; perFolder[f] = (perFolder[f] || 0) + 1 }
const multiFolders = Object.entries(perFolder).filter(([, n]) => n > 1)
check('lib=1 some WE bundles expose multiple images', multiFolders.length > 0, { multiFolders: multiFolders.length })
const packed = j.entries.filter((e) => e.id.startsWith('3653655328'))
check('lib=1 packed bundle 3653655328 listed', packed.length >= 1, { packed: packed.length })

// 9. WE dir auto-detection (no hardcoding)
r = await fetch(base + '/theme-wallpaper/we-dirs')
j = await r.json()
check('we-dirs ok + primary detected', j.ok === true && typeof j.primary === 'string' && j.primary.length > 0, j)
check('we-dirs workshop dir exists', Array.isArray(j.workshopDirs) && j.workshopDirs.length > 0, j)

// 10. mpkg auto-import: dedicated export folder (NOT Desktop), synthetic PKGM0014 container
function buildPkg(filePath, files) {
  let dirLen = 0
  for (const f of files) dirLen += 4 + Buffer.byteLength(f.name) + 8
  const header = Buffer.alloc(16)
  header.writeUInt32LE(8, 0)               // version
  header.write('PKGM0014', 4, 'ascii')     // magic
  header.writeUInt32LE(files.length, 12)   // count
  const dir = Buffer.alloc(dirLen)
  let p = 0
  let off = 0
  for (const f of files) {
    const nb = Buffer.byteLength(f.name)
    dir.writeUInt32LE(nb, p); p += 4
    dir.write(f.name, p, 'utf8'); p += nb
    dir.writeUInt32LE(off, p); dir.writeUInt32LE(f.data.length, p + 4); p += 8
    off += f.data.length
  }
  writeFileSync(filePath, Buffer.concat([header, dir, ...files.map((f) => f.data)]))
}
buildPkg(join(MPKG_TMP, 'testexport.mpkg'), [
  { name: 'preview.jpg', data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]) },
  { name: 'project.json', data: Buffer.from('{"title":"t"}') },
  { name: 'scene.json', data: Buffer.from('{}') },
  { name: 'wallpaper.mp4', data: Buffer.concat([Buffer.from('fake-mp4-bytes-'), Buffer.alloc(1000, 7)]) },
])
// an .mpkg WITHOUT a rendered video (like dino_run.mpkg) must be reported as skipped
buildPkg(join(MPKG_TMP, 'no_video.mpkg'), [
  { name: 'preview.gif', data: Buffer.from('GIF89a') },
  { name: 'project.json', data: Buffer.from('{}') },
  { name: 'scene.json', data: Buffer.from('{}') },
])
// 10a. before setting a folder: default returns nothing + needsFolder flag
r = await fetch(base + '/theme-wallpaper/we-library')
j = await r.json()
check('no folder set → needsFolder + empty', j.ok === true && j.needsFolder === true && j.count === 0 && j.mpkgCount === 0, { count: j.count, needsFolder: j.needsFolder })
// 10a2. mpkg-collect with no folder set → 400 (before any folder is configured)
r = await fetch(base + '/theme-wallpaper/mpkg-collect', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ source: join(tmpdir(), 'dsh-twp-collect-src') }),
})
j = await r.json()
check('mpkg-collect without folder → 400', r.status === 400 && j.ok === false, j)
// 10b. mpkg-folder route sets (and creates if missing) the dedicated export folder
const MPKG_NEW = join(tmpdir(), 'dsh-twp-mpkg-new')
r = await fetch(base + '/theme-wallpaper/mpkg-folder', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ path: MPKG_NEW }),
})
j = await r.json()
check('mpkg-folder ok + persists', j.ok === true && j.path === MPKG_NEW && existsSync(MPKG_NEW), j)
// 10c. after setting the folder, we-library scans ONLY it
r = await fetch(base + '/theme-wallpaper/mpkg-folder', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ path: MPKG_TMP }),
})
j = await r.json()
check('mpkg-folder switch to existing dir', j.ok === true && j.path === MPKG_TMP, j)
r = await fetch(base + '/theme-wallpaper/we-library')
j = await r.json()
const mpkgEntry = (j.entries || []).find((e) => e.id === 'mpkg::testexport')
check('we-library includes mpkg entry', j.ok === true && j.needsFolder === false && !!mpkgEntry, { mpkgCount: j.mpkgCount })
check('mpkg-only default (count==mpkgCount, all fromMpkg)', j.count === j.mpkgCount && j.entries.every((e) => e.fromMpkg === true), { count: j.count, mpkgCount: j.mpkgCount })
check('mpkg entry kind=video fromMpkg', mpkgEntry && mpkgEntry.kind === 'video' && mpkgEntry.fromMpkg === true, mpkgEntry)
check('mpkg media served 200', mpkgEntry ? (await fetch(base + '/theme-wallpaper/file?path=' + encodeURIComponent(mpkgEntry.media))).status === 200 : false)
check('no-video mpkg reported as skipped', Array.isArray(j.skipped) && j.skipped.some((s) => s.file === 'no_video.mpkg'), j.skipped)

// 10f-1. GET file: missing file INSIDE an allowed root → 404.
// MPKG_TMP is now a configured root (set as the export folder above), so the
// 403 allow-list is passed and the route reports the genuine "not found".
r = await fetch(base + '/theme-wallpaper/file?path=' + encodeURIComponent(join(MPKG_TMP, 'definitely-missing.mp4')))
check('missing file inside root → 404', r.status === 404, { status: r.status })
// 10d. mpkg-folder rejects an empty path
r = await fetch(base + '/theme-wallpaper/mpkg-folder', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ path: '   ' }),
})
j = await r.json()
check('mpkg-folder rejects empty path', r.status === 400 && j.ok === false, j)

// 10e. mpkg-collect moves .mpkg from a source dir (Desktop in real use) into the export folder
buildPkg(join(COLLECT_SRC, '桌面来的.mpkg'), [
  { name: 'preview.jpg', data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]) },
  { name: 'project.json', data: Buffer.from('{}') },
  { name: 'scene.json', data: Buffer.from('{}') },
  { name: 'wallpaper.mp4', data: Buffer.from('fake2') },
])
r = await fetch(base + '/theme-wallpaper/mpkg-collect', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ source: COLLECT_SRC }),
})
j = await r.json()
check('mpkg-collect moves 1 file', j.ok === true && j.count === 1, j)
check('mpkg-collect moved into export folder', existsSync(join(MPKG_TMP, '桌面来的.mpkg')) && !existsSync(join(COLLECT_SRC, '桌面来的.mpkg')), j)
// 10g. save must NOT wipe an already-set export folder (regression for the wipe bug)
r = await fetch(base + '/theme-wallpaper/save', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ state: { theme: 'macos', wallpaper: { enabled: true, path: 'D:/x.png', autopause: true, dim: 0, panelOpacity: 0.3, fit: 'cover', kind: 'image' } } }),
})
j = await r.json()
check('save without we keeps mpkgDir', j.ok === true && j.state.we && j.state.we.mpkgDir === MPKG_TMP, j.state && j.state.we)
r = await fetch(base + '/theme-wallpaper/save', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ state: { theme: 'macos', wallpaper: { enabled: false, path: '', autopause: true, dim: 0, panelOpacity: 0.8, fit: 'cover', kind: 'image' }, we: { mpkgDir: '' } } }),
})
j = await r.json()
check('save with empty we.mpkgDir still keeps folder', j.ok === true && j.state.we && j.state.we.mpkgDir === MPKG_TMP, j.state && j.state.we)

// 10h. dir browser route (replaces the broken webkitdirectory picker)
r = await fetch(base + '/theme-wallpaper/dirs?path=' + encodeURIComponent(MPKG_TMP))
j = await r.json()
check('dirs lists folder + its mpkg', j.ok === true && j.path === MPKG_TMP && j.mpkgFiles.includes('testexport.mpkg'), j)
r = await fetch(base + '/theme-wallpaper/dirs')
j = await r.json()
check('dirs default starts at home', j.ok === true && typeof j.path === 'string' && j.path.length > 0, j)
r = await fetch(base + '/theme-wallpaper/dirs?path=' + encodeURIComponent(join(MPKG_TMP, '不存在的子目录')))
j = await r.json()
check('dirs falls back on missing path', j.ok === true && typeof j.path === 'string' && j.path.length > 0, j)

// 11. real mpkg from a real WE export, if present (optional fixture)
const REAL_MPKG = join(process.env.USERPROFILE || '', 'Desktop', '3668222441.mpkg')
if (existsSync(REAL_MPKG)) {
  // point the dedicated export folder at the Desktop fixture, then scan
  await fetch(base + '/theme-wallpaper/mpkg-folder', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: join(process.env.USERPROFILE || '', 'Desktop') }),
  })
  r = await fetch(base + '/theme-wallpaper/we-library')
  j = await r.json()
  const real = (j.entries || []).find((e) => e.id === 'mpkg::3668222441')
  check('real mpkg 3668222441 detected', !!real, { mpkgCount: j.mpkgCount })
  check('real mpkg media served 200', real ? (await fetch(base + '/theme-wallpaper/file?path=' + encodeURIComponent(real.media))).status === 200 : false)
  check('real mpkg lists its files', real && Array.isArray(real.files) && real.files.includes('wallpaper.mp4'), real && real.files)
} else {
  console.log('  SKIP real-mpkg fixture (3668222441.mpkg not on Desktop)')
}

// cleanup temp state + synthetic dirs (never touches the real state.json)
try { await unlink(TEST_STATE) } catch {}
try { await rm(MPKG_TMP, { recursive: true, force: true }) } catch {}
try { await rm(COLLECT_SRC, { recursive: true, force: true }) } catch {}

server.close()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
