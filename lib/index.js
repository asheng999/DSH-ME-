/**
 * 主题与壁纸 — Host half.
 *
 * Persists the theme/wallpaper state beside the plugin and serves the
 * selected local media file to the browser. Routes:
 *   GET  /theme-wallpaper/state        → current state JSON
 *   POST /theme-wallpaper/save         → { state } persist state JSON
 *   GET  /theme-wallpaper/file?path=   → stream one local media file
 *
 * The state file lives at state.json next to this module, so it survives
 * engine/desktop updates (it is profile/plugin data, not app internals).
 *
 * 社区化：Wallpaper Engine 安装位置不再是硬编码——启动时通过
 * Steam 常见目录 + libraryfolders.vdf 动态探测（注册表读取依赖外部进程，
 * 宿主里不可靠，所以纯用文件系统探测），也支持环境变量 WE_DIR 与
 * 客户端 ?dir= 覆盖。另外会自动扫描 WE 的"发送至移动设备"导出包
 * （*.mpkg，PKGM 容器），解出里面 WE 渲染好的 wallpaper.mp4 当作高清
 * 视频壁纸条目。
 */

import { readFile, writeFile, stat, readdir, mkdir, open, rename } from 'node:fs/promises'
import { createReadStream, existsSync } from 'node:fs'
import { extname, isAbsolute, join, resolve, basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'theme-wallpaper'
export const inject = ['webServer']

const STATE_PATH = process.env.THEME_WALLPAPER_STATE
  ? resolve(process.env.THEME_WALLPAPER_STATE)
  : fileURLToPath(new URL('../state.json', import.meta.url))

const MEDIA_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
}

const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.mkv'])
const THEMES = new Set(['system', 'light', 'dark', 'macos'])
const FITS = new Set(['cover', 'fill', 'stretch', 'free'])

function defaultState() {
  return {
    theme: 'system',
    wallpaper: { enabled: false, path: '', kind: 'image', fit: 'cover', dim: 0.35, panelOpacity: 0.85, autopause: true },
    we: { dir: '', mpkgDir: '' },
  }
}

function clamp01(value) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0
}

function guessKind(path) {
  return VIDEO_EXT.has(extname(path).toLowerCase()) ? 'video' : 'image'
}

/** Fold any raw shape into a valid state object (never throws). */
function sanitize(raw) {
  const s = defaultState()
  if (raw === null || typeof raw !== 'object') return s
  if (THEMES.has(raw.theme)) s.theme = raw.theme
  const w = raw.wallpaper
  if (w !== null && typeof w === 'object') {
    if (typeof w.enabled === 'boolean') s.wallpaper.enabled = w.enabled
    if (typeof w.path === 'string' && w.path.length > 0) {
      s.wallpaper.path = w.path
      s.wallpaper.kind = guessKind(w.path)
    }
    s.wallpaper.dim = clamp01(w.dim)
    s.wallpaper.panelOpacity = clamp01(w.panelOpacity)
    if (typeof w.fit === 'string' && FITS.has(w.fit)) s.wallpaper.fit = w.fit
    if (typeof w.autopause === 'boolean') s.wallpaper.autopause = w.autopause
  }
  const we = raw.we
  if (we !== null && typeof we === 'object') {
    if (typeof we.dir === 'string' && we.dir.length > 0) s.we.dir = we.dir
    if (typeof we.mpkgDir === 'string' && we.mpkgDir.length > 0) s.we.mpkgDir = we.mpkgDir
  }
  return s
}

async function readState() {
  try {
    return sanitize(JSON.parse(await readFile(STATE_PATH, 'utf8')))
  } catch {
    return defaultState()
  }
}

function json(res, status, body) {
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.statusCode = status
  res.end(JSON.stringify(body))
}

async function readBody(req) {
  return await new Promise((resolveBody) => {
    let data = ''
    req.on('data', (chunk) => { data += chunk })
    req.on('end', () => resolveBody(data))
  })
}

function mediaTypeFor(filePath) {
  return MEDIA_TYPES[extname(filePath).toLowerCase()]
}

// Wallpaper Engine 壁纸库：Steam 工作坊内容目录。
// 不再硬编码——优先动态探测（detectWeDirs），其次环境变量 WE_DIR，最后退回此默认。
const WE_DEFAULT_DIR = 'D:\\GAME\\steam\\steamapps\\workshop\\content\\431960'
const WE_WORKSHOP_APPID = '431960'
const MPKG_CACHE_DIR = fileURLToPath(new URL('../.mpkg-cache/', import.meta.url))
const WE_PREVIEW_NAMES = ['preview.jpg', 'preview.gif', 'preview.png', 'preview.webp', 'preview.jpeg', 'preview.bmp']
const WE_PREVIEW_SET = new Set(WE_PREVIEW_NAMES)
const MEDIA_PER_FOLDER_CAP = 40

/** 从 libraryfolders.vdf 文本里抽出所有 "path" "..." 值（Steam 库目录）。 */
function vdfLibraryPaths(text) {
  const out = []
  const re = /"path"\s*"((?:[^"\\]|\\.)*)"/g
  let m
  while ((m = re.exec(text))) {
    const raw = m[1].replace(/\\\\/g, '\\').replace(/\\"/g, '"')
    if (raw) out.push(raw)
  }
  return out
}

/** 常见 Steam 安装根目录候选（不依赖注册表，纯文件系统探测）。 */
function candidateSteamRoots() {
  const roots = new Set()
  const add = (p) => { if (typeof p === 'string' && p.length > 0) roots.add(p) }
  add(process.env.STEAM_PATH)
  add(process.env.WE_STEAM_PATH)
  const pf86 = process.env['ProgramFiles(x86)']
  if (pf86) add(join(pf86, 'Steam'))
  const pf = process.env.ProgramFiles
  if (pf) add(join(pf, 'Steam'))
  const lap = process.env.LOCALAPPDATA
  if (lap) add(join(lap, 'Steam'))
  for (const ch of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    add(ch + ':\\Steam')
    add(ch + ':\\SteamLibrary')
    add(ch + ':\\steam')
  }
  add('D:\\GAME\\steam') // 早期版本硬编码过的目录，留作兜底
  return [...roots]
}

/**
 * 动态探测 Wallpaper Engine 位置：
 *   - 遍历候选 Steam 根，找 steamapps 目录
 *   - 解析每个库的 libraryfolders.vdf，收集所有 Steam 库
 *   - 在每个库里找 workshop/content/431960（壁纸库）与 common/wallpaper_engine（安装目录）
 * 返回 { workshopDirs, installDirs, primary, source }
 */
async function detectWeDirs() {
  const libs = new Set()
  for (const root of candidateSteamRoots()) {
    if (!existsSync(join(root, 'steamapps'))) continue
    libs.add(root)
    try {
      const vdf = await readFile(join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8')
      for (const p of vdfLibraryPaths(vdf)) if (existsSync(p)) libs.add(p)
    } catch { /* 没有 vdf 就只认根库 */ }
  }
  const workshopDirs = []
  const installDirs = []
  for (const lib of libs) {
    const ws = join(lib, 'steamapps', 'workshop', 'content', WE_WORKSHOP_APPID)
    if (existsSync(ws)) workshopDirs.push(ws)
    const ins = join(lib, 'steamapps', 'common', 'wallpaper_engine')
    if (existsSync(ins)) installDirs.push(ins)
  }
  return {
    workshopDirs,
    installDirs,
    primary: workshopDirs[0] || '',
    source: workshopDirs.length || installDirs.length ? 'detected' : 'none',
  }
}

const MPKG_MAGIC = /^PKG[VM]\d{4}$/

/** 读 PKG 容器（PKGV0023 / PKGM0014 同构）的目录区，返回 { dataStart, files }。 */
async function readPkgDirectory(mpkgPath) {
  const fh = await open(mpkgPath, 'r')
  try {
    const head = Buffer.alloc(16)
    await fh.read(head, 0, 16, 0)
    if (!MPKG_MAGIC.test(head.toString('ascii', 4, 12))) return null
    const count = head.readUInt32LE(12)
    const dirBuf = Buffer.alloc(8192)
    const { bytesRead } = await fh.read(dirBuf, 0, 8192, 16)
    let pos = 0
    const files = []
    for (let i = 0; i < count; i++) {
      if (pos + 4 > bytesRead) return null
      const nlen = dirBuf.readUInt32LE(pos); pos += 4
      if (pos + nlen > bytesRead) return null
      const name = dirBuf.toString('utf8', pos, pos + nlen); pos += nlen
      if (pos + 8 > bytesRead) return null
      const off = dirBuf.readUInt32LE(pos)
      const size = dirBuf.readUInt32LE(pos + 4); pos += 8
      files.push({ name, off, size })
    }
    return { dataStart: 16 + pos, files }
  } finally {
    await fh.close()
  }
}

/**
 * 解包一个 WE 移动端导出包（.mpkg）：抽出里面 WE 渲染好的 wallpaper.mp4
 * 与 preview 图，缓存到 <plugin>/.mpkg-cache/<名字>/，返回 { entry } 或 { skip: 原因 }。
 * 缓存按 mpkg 的 mtime 判新，重复扫描不重读大文件。
 */
async function extractMpkg(mpkgPath) {
  const dir = await readPkgDirectory(mpkgPath).catch(() => null)
  if (!dir || !dir.files || !dir.files.length) return { skip: '不是有效的 WE 导出包' }
  const { dataStart, files } = dir
  const video = files.find((f) => /\.mp4$/i.test(f.name)) || files.find((f) => /\.(mp4|webm|mov)$/i.test(f.name))
  if (!video) return { skip: '里面没有渲染好的视频（可能不是"发送到移动设备"导出的）' }
  const stem = basename(mpkgPath, extname(mpkgPath))
  const cacheDir = join(MPKG_CACHE_DIR, stem)
  await mkdir(cacheDir, { recursive: true })
  const media = join(cacheDir, video.name)
  const prev = files.find((f) => /^preview\.(jpe?g|png|webp|gif)$/i.test(f.name))
  const pout = prev ? join(cacheDir, prev.name) : ''
  const pkgStat = await stat(mpkgPath).catch(() => undefined)
  const mediaStat = await stat(media).catch(() => undefined)
  const stale = !mediaStat || (pkgStat !== undefined && pkgStat.mtimeMs > mediaStat.mtimeMs)
  if (stale || (prev && pout && !existsSync(pout))) {
    const fh = await open(mpkgPath, 'r')
    try {
      if (stale) {
        const videoBuf = Buffer.alloc(video.size)
        await fh.read(videoBuf, 0, video.size, dataStart + video.off)
        await writeFile(media, videoBuf)
      }
      if (prev && pout && (!stale || !existsSync(pout))) {
        const prevBuf = Buffer.alloc(prev.size)
        await fh.read(prevBuf, 0, prev.size, dataStart + prev.off)
        await writeFile(pout, prevBuf)
      }
    } finally {
      await fh.close()
    }
  }
  return {
    entry: {
      id: 'mpkg::' + stem,
      title: stem + '（WE导出·动态）',
      media,
      preview: prev && pout ? pout : '',
      kind: 'video',
      fromMpkg: true,
      files: files.map((f) => f.name),
    },
  }
}

/** 扫描若干目录里的 *.mpkg，返回 { entries, skipped }。 */
async function scanMpkgDirs(dirs) {
  const entries = []
  const skipped = []
  const seen = new Set()
  for (const dir of dirs) {
    if (!dir || typeof dir !== 'string') continue
    let files
    try { files = await readdir(dir, { withFileTypes: true }) } catch { continue }
    for (const f of files) {
      if (!f.isFile() || !/\.mpkg$/i.test(f.name)) continue
      const abs = join(dir, f.name)
      if (seen.has(abs)) continue
      seen.add(abs)
      const result = await extractMpkg(abs).catch(() => ({ skip: '读取失败' }))
      if (result && result.entry) entries.push(result.entry)
      else if (result && result.skip) skipped.push({ file: f.name, reason: result.skip })
    }
  }
  return { entries, skipped }
}

function mediaKind(filePath) {
  return VIDEO_EXT.has(extname(filePath).toLowerCase()) ? 'video' : 'image'
}

function usableWallpaperMedia(absPath) {
  const base = basename(absPath).toLowerCase()
  if (base === 'scene.pkg' || base.endsWith('.html') || base.endsWith('.htm')) return false
  return MEDIA_TYPES[extname(absPath).toLowerCase()] !== undefined
}

/**
 * Scan one WE workshop directory into wallpaper entries.
 *
 * 一套 WE 壁纸往往不止一张图：有的是 project.json 声明了多个文件（数组），
 * 有的文件夹里直接放了好几张图（轮播/多场景）。因此这里"每张可用媒体文件
 * 一个条目"——优先用 project.json 声明的文件（字符串或数组），其次列出文件夹
 * 里所有零散的可用媒体，只有两者都没有时才退回用文件夹自带的 preview 图
 * （覆盖 scene.pkg 全打包、只剩 preview.jpg 这种"只有一张 JPG"的情况）。
 */
async function scanWeLibrary(dir) {
  let subs
  try {
    subs = await readdir(dir, { withFileTypes: true })
  } catch {
    return { ok: false, message: '无法读取目录：' + dir }
  }
  const entries = []
  for (const sub of subs) {
    if (!sub.isDirectory()) continue
    const folder = join(dir, sub.name)
    let title = sub.name
    const declared = []
    try {
      const pj = JSON.parse(await readFile(join(folder, 'project.json'), 'utf8'))
      if (pj !== null && typeof pj === 'object') {
        if (typeof pj.title === 'string' && pj.title.length > 0) title = pj.title
        const declaredRaw = Array.isArray(pj.file) ? pj.file : (typeof pj.file === 'string' ? [pj.file] : [])
        for (const f of declaredRaw) {
          if (typeof f !== 'string' || f.length === 0) continue
          const abs = resolve(folder, f)
          if (usableWallpaperMedia(abs)) declared.push(abs)
        }
      }
    } catch { /* no/invalid project.json — fall through to folder scan */ }
    let files = []
    try { files = await readdir(folder, { withFileTypes: true }) } catch { /* ignore unreadable folder */ }
    const mediaFiles = []
    const previewFiles = []
    for (const f of files) {
      if (!f.isFile()) continue
      const abs = join(folder, f.name)
      if (!usableWallpaperMedia(abs)) continue
      if (WE_PREVIEW_SET.has(f.name.toLowerCase())) { previewFiles.push(abs); continue }
      mediaFiles.push(abs)
    }
    const candidates = []
    const seen = new Set()
    for (const d of declared) if (existsSync(d) && !seen.has(d)) { candidates.push(d); seen.add(d) }
    for (const m of mediaFiles) if (!seen.has(m)) { candidates.push(m); seen.add(m) }
    if (candidates.length === 0) candidates.push(...previewFiles)
    if (candidates.length === 0) continue
    const preview = previewFiles[0] || ''
    const multi = candidates.length > 1
    candidates.slice(0, MEDIA_PER_FOLDER_CAP).forEach((media, i) => {
      const kind = mediaKind(media)
      entries.push({
        id: sub.name + '::' + basename(media),
        title: multi ? title + '（' + (i + 1) + '）' : title,
        preview: preview || (kind === 'image' ? media : ''),
        media,
        kind,
      })
    })
  }
  entries.sort((a, b) => a.title.localeCompare(b.title, 'zh'))
  return { ok: true, dir, count: entries.length, entries }
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/theme-wallpaper/state',
    handler: async (_req, res) => {
      try {
        json(res, 200, { ok: true, state: await readState() })
      } catch (error) {
        json(res, 500, { ok: false, message: String(error && error.message ? error.message : error) })
      }
    },
  }), 'theme-wallpaper: state')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/theme-wallpaper/save',
    handler: async (req, res) => {
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const incoming = body.state || {}
        // 防御：客户端如果没带 we 或带了空 mpkgDir（旧客户端/状态未同步），
        // 不要覆盖已设置的导出目录，否则用户设一次目录就会被下一次保存清空。
        const existing = await readState()
        const existingDir = existing.we && typeof existing.we.mpkgDir === 'string' ? existing.we.mpkgDir : ''
        const incomingDir = incoming.we && typeof incoming.we.mpkgDir === 'string' ? incoming.we.mpkgDir : ''
        if (existingDir && !incomingDir) {
          incoming.we = Object.assign({}, incoming.we || {}, { mpkgDir: existingDir })
        }
        const state = sanitize(incoming)
        await writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf8')
        json(res, 200, { ok: true, state })
      } catch (error) {
        json(res, 500, { ok: false, message: String(error && error.message ? error.message : error) })
      }
    },
  }), 'theme-wallpaper: save')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/theme-wallpaper/file',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://x')
        let filePath = url.searchParams.get('path') ?? ''
        if (/^file:\/\//i.test(filePath)) filePath = decodeURIComponent(filePath.replace(/^file:\/\/[^/]*/i, ''))
        if (!isAbsolute(filePath)) { json(res, 400, { ok: false, message: 'path must be absolute' }); return }
        const mediaType = mediaTypeFor(filePath)
        if (mediaType === undefined) { json(res, 400, { ok: false, message: 'unsupported media type' }); return }
        const info = await stat(filePath).catch(() => undefined)
        if (info === undefined || !info.isFile()) { json(res, 404, { ok: false, message: 'file not found' }); return }
        const total = info.size
        res.setHeader('accept-ranges', 'bytes')
        res.setHeader('content-type', mediaType)
        res.setHeader('cache-control', 'no-cache')
        const range = req.headers.range
        if (range) {
          // HTML5 <video> relies on Range/206 — without it seekable/HEVC-tail
          // moov videos never get metadata and fail to play.
          const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim())
          let start = 0
          let end = total - 1
          if (m) {
            if (m[1] === '' && m[2] !== '') {
              const suffix = parseInt(m[2], 10)
              start = Math.max(total - suffix, 0)
              end = total - 1
            } else if (m[1] !== '') {
              start = parseInt(m[1], 10)
              end = m[2] !== '' ? parseInt(m[2], 10) : total - 1
            }
          }
          if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || start >= total || end < start) {
            res.statusCode = 416
            res.setHeader('content-range', 'bytes */' + total)
            res.end()
            return
          }
          if (end >= total) end = total - 1
          res.statusCode = 206
          res.setHeader('content-range', 'bytes ' + start + '-' + end + '/' + total)
          res.setHeader('content-length', String(end - start + 1))
          const stream = createReadStream(filePath, { start, end })
          stream.on('error', () => {
            if (!res.headersSent) { res.statusCode = 500; res.end() } else { res.destroy() }
          })
          stream.pipe(res)
          return
        }
        res.statusCode = 200
        res.setHeader('content-length', String(total))
        const stream = createReadStream(filePath)
        stream.on('error', () => {
          if (!res.headersSent) { res.statusCode = 500; res.end() } else { res.destroy() }
        })
        stream.pipe(res)
      } catch (error) {
        json(res, 500, { ok: false, message: String(error && error.message ? error.message : error) })
      }
    },
  }), 'theme-wallpaper: file')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/theme-wallpaper/we-dirs',
    handler: async (_req, res) => {
      try {
        const detected = await detectWeDirs()
        const state = await readState()
        json(res, 200, {
          ok: true,
          ...detected,
          mpkgDir: (state.we && state.we.mpkgDir) || '',
        })
      } catch (error) {
        json(res, 500, { ok: false, message: String(error && error.message ? error.message : error) })
      }
    },
  }), 'theme-wallpaper: we-dirs')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/theme-wallpaper/mpkg-folder',
    handler: async (req, res) => {
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const raw = typeof body.path === 'string' ? body.path.trim() : ''
        if (!raw) { json(res, 400, { ok: false, message: '请填写文件夹路径' }); return }
        const abs = isAbsolute(raw) ? raw : resolve(raw)
        await mkdir(abs, { recursive: true }) // 不存在则创建，已存在则复用
        const state = await readState()
        state.we = state.we || { dir: '', mpkgDir: '' }
        state.we.mpkgDir = abs
        await writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf8')
        json(res, 200, { ok: true, path: abs })
      } catch (error) {
        json(res, 500, { ok: false, message: String(error && error.message ? error.message : error) })
      }
    },
  }), 'theme-wallpaper: mpkg-folder')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/theme-wallpaper/mpkg-collect',
    handler: async (req, res) => {
      try {
        const state = await readState()
        const dest = state.we && typeof state.we.mpkgDir === 'string' && state.we.mpkgDir ? state.we.mpkgDir : ''
        if (!dest) { json(res, 400, { ok: false, message: '请先设置导出目录' }); return }
        if (!existsSync(dest)) { json(res, 400, { ok: false, message: '导出目录不存在：' + dest }); return }
        // WE 导出默认落在桌面；source 可被测试覆盖（默认桌面）
        const body = JSON.parse((await readBody(req)) || '{}')
        const source = typeof body.source === 'string' && body.source
          ? body.source
          : (process.env.USERPROFILE ? join(process.env.USERPROFILE, 'Desktop') : '')
        const moved = []
        if (source && existsSync(source)) {
          for (const f of await readdir(source, { withFileTypes: true })) {
            if (!f.isFile() || !/\.mpkg$/i.test(f.name)) continue
            const src = join(source, f.name)
            let dst = join(dest, f.name)
            let n = 1
            while (existsSync(dst)) { dst = join(dest, f.name.replace(/\.mpkg$/i, '') + '-' + n + '.mpkg'); n++ }
            await rename(src, dst)
            moved.push(basename(dst))
          }
        }
        json(res, 200, { ok: true, moved, count: moved.length })
      } catch (error) {
        json(res, 500, { ok: false, message: String(error && error.message ? error.message : error) })
      }
    },
  }), 'theme-wallpaper: mpkg-collect')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/theme-wallpaper/dirs',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://x')
        const raw = url.searchParams.get('path') || ''
        const home = process.env.USERPROFILE || process.env.HOME || 'C:\\'
        let base = raw ? (isAbsolute(raw) ? raw : resolve(raw)) : home
        const info = await stat(base).catch(() => undefined)
        if (info === undefined || !info.isDirectory()) base = dirname(base)
        const entries = await readdir(base, { withFileTypes: true }).catch(() => [])
        const dirs = []
        const mpkgFiles = []
        for (const e of entries) {
          if (e.isDirectory()) dirs.push(e.name)
          else if (/\.mpkg$/i.test(e.name)) mpkgFiles.push(e.name)
        }
        dirs.sort((a, b) => a.localeCompare(b, 'zh'))
        mpkgFiles.sort((a, b) => a.localeCompare(b, 'zh'))
        json(res, 200, {
          ok: true,
          path: base,
          parent: dirname(base) !== base ? dirname(base) : '',
          home,
          dirs,
          mpkgFiles,
        })
      } catch (error) {
        json(res, 500, { ok: false, message: String(error && error.message ? error.message : error) })
      }
    },
  }), 'theme-wallpaper: dirs')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/theme-wallpaper/we-library',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://x')
        const detected = await detectWeDirs()
        const state = await readState()
        // mpkg 目录：只扫用户指定的导出文件夹（留空=未设置，不扫桌面不乱翻文件）
        const mpkgDirs = state.we && typeof state.we.mpkgDir === 'string' && state.we.mpkgDir
          ? [state.we.mpkgDir]
          : []
        const { entries: mpkgEntries, skipped } = await scanMpkgDirs(mpkgDirs)
        mpkgEntries.sort((a, b) => a.title.localeCompare(b.title, 'zh'))
        let entries = mpkgEntries
        // 默认只返回已转换的高清 .mpkg 条目（避免 WE 库低清缩略图刷屏）。
        // 想要完整 WE 库缩略图列表时用 ?lib=1（社区/高级用户保留能力）。
        if (url.searchParams.get('lib') === '1') {
          const override = url.searchParams.get('dir') || ''
          const dir = override || process.env.WE_DIR || detected.primary || WE_DEFAULT_DIR
          const lib = await scanWeLibrary(dir)
          if (lib.ok) entries = lib.entries.concat(mpkgEntries)
        }
        json(res, 200, {
          ok: true,
          count: entries.length,
          entries,
          mpkgCount: mpkgEntries.length,
          skipped,
          needsFolder: mpkgDirs.length === 0,
          detected: { workshopDirs: detected.workshopDirs, installDirs: detected.installDirs, primary: detected.primary },
          autoDetected: !url.searchParams.get('dir'),
        })
      } catch (error) {
        json(res, 500, { ok: false, message: String(error && error.message ? error.message : error) })
      }
    },
  }), 'theme-wallpaper: we-library')
}
