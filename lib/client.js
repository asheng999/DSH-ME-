/* Theme & wallpaper — browser half.
 *
 * Registers a settings section "主题与壁纸" (nav order 30, below Agent预设)
 * with four independent controls:
 *   - 主题: 跟随系统 / 浅色 / 深色 / macOS 观感
 *   - 壁纸: 本地任意路径的静态图 / 动图(GIF/WebP) / 视频(MP4/WebM/MOV/MKV)
 *   - 壁纸暗化 + 面板半透明 两个滑杆
 *   - 失焦自动暂停（视频壁纸）
 *
 * Host routes:
 *   GET  /theme-wallpaper/state
 *   POST /theme-wallpaper/save  { state }
 *   GET  /theme-wallpaper/file?path=...
 *
 * Rendering model: the wallpaper is a fixed layer on document.body
 * (z-index 0) covering the WHOLE window — including the 38px titlebar strip,
 * so the traffic-light bar and the app surface read as one continuous
 * wallpaper. The app content (#root) is lifted to z-index 1 so every UI
 * element floats above it and stays readable; the main frame's frosted-glass
 * backdrop is neutralised so it never blurs the wallpaper into haze. The
 * darkening shade sits right after the layer (same z, later DOM order).
 */
window.__ModuleLoader__.load({
  id: '@deepseek-ai/dsh-theme-wallpaper',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require('react');

    const PLUGIN_ID = '@deepseek-ai/dsh-theme-wallpaper';
    const STATE_URL = '/theme-wallpaper/state';
    const SAVE_URL = '/theme-wallpaper/save';
    const FILE_URL = '/theme-wallpaper/file?path=';
    const WE_LIBRARY_URL = '/theme-wallpaper/we-library';
    const MPKG_FOLDER_URL = '/theme-wallpaper/mpkg-folder';
    const MPKG_COLLECT_URL = '/theme-wallpaper/mpkg-collect';
    const DIRS_URL = '/theme-wallpaper/dirs?path=';
    const STYLE_ID = 'dsh-theme-wallpaper-style';
    const LAYER_ID = 'dsh-theme-wallpaper-layer';
    const DIM_ID = 'dsh-theme-wallpaper-dim';

    // ---- module-level runtime state ----
    let currentVideo = null;
    let autopauseEnabled = true;
    let latestState = null;

    function fileUrl(path) {
      return FILE_URL + encodeURIComponent(path);
    }
    // 拼接一个目录和一个子项名（处理 Windows 分隔符与首尾斜杠）
    function joinPath(dir, name) {
      var d = String(dir || '');
      var n = String(name || '');
      if (!d) return n;
      if (d.slice(-1) === '\\' || d.slice(-1) === '/') return d + n;
      return d + '\\' + n;
    }
    function alpha(value) {
      const n = Number(value);
      return (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0).toFixed(3);
    }

    // ---- contrast maths (方案 5) ----
    // Same numbers the settings panel reports must match what the eye sees, so
    // this mirrors the WCAG relative-luminance formula rather than an ad-hoc
    // brightness average. Everything works on 0-255 sRGB triples.
    const WCAG_AA = 4.5;
    const WCAG_AA_LARGE = 3;

    function srgbToLinear(c) {
      const v = c / 255;
      return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    }

    function relativeLuminance(rgb) {
      return 0.2126 * srgbToLinear(rgb[0]) + 0.7152 * srgbToLinear(rgb[1]) + 0.0722 * srgbToLinear(rgb[2]);
    }

    function contrastRatio(a, b) {
      const la = relativeLuminance(a);
      const lb = relativeLuminance(b);
      const hi = Math.max(la, lb);
      const lo = Math.min(la, lb);
      return (hi + 0.05) / (lo + 0.05);
    }

    /** Panel colour laid over one wallpaper pixel. */
    function panelOver(wall, panelAlpha, panelRgb) {
      return [
        Math.round(wall[0] * (1 - panelAlpha) + panelRgb[0] * panelAlpha),
        Math.round(wall[1] * (1 - panelAlpha) + panelRgb[1] * panelAlpha),
        Math.round(wall[2] * (1 - panelAlpha) + panelRgb[2] * panelAlpha),
      ];
    }

    /** Wallpaper pixel darkened by the shade layer that sits under the panels. */
    function shaded(wall, dim) {
      const k = 1 - dim;
      return [Math.round(wall[0] * k), Math.round(wall[1] * k), Math.round(wall[2] * k)];
    }

    const PANEL_RGB = { light: [246, 246, 248], dark: [17, 17, 20] };
    const TEXT_RGB = { light: [17, 17, 20], dark: [229, 231, 235] };

    /**
     * Smallest panel opacity that clears `target` for the whole wallpaper, found
     * by scanning the 0-100 slider range. Returns null when no setting reaches
     * it (a wallpaper so close to the text colour that only dimming helps).
     */
    function safePanelPercent(samples, dim, target) {
      if (!samples) return null;
      for (let pct = 0; pct <= 100; pct++) {
        if (worstContrast(samples, dim, pct / 100) >= target) return pct;
      }
      return null;
    }

    /**
     * Paint the safe portion of the panel slider's track. The track is the
     * element's own background, so the marker costs no extra DOM and survives
     * the host's styling: unsafe range stays neutral, the safe range is tinted.
     */
    function safeZoneStyle(samples, dim, target) {
      const safe = safePanelPercent(samples, dim, target);
      if (safe === null) return {};
      return {
        background: 'linear-gradient(to right,' +
          ' rgba(239,68,68,.28) 0%,' +
          ' rgba(239,68,68,.28) ' + safe + '%,' +
          ' rgba(52,211,153,.30) ' + safe + '%,' +
          ' rgba(52,211,153,.30) 100%)',
        borderRadius: '6px',
      };
    }

    function panelSafeTitle(samples, dim) {
      if (samples === null) return '正在测量壁纸对比度…';
      if (samples === false) return '无法测量这张壁纸的对比度（像素读取受限），请手动确认文字是否清晰';
      const safe = safePanelPercent(samples, dim, WCAG_AA);
      // At 100% the panel fully covers the wallpaper, so a threshold exists for
      // every measurable wallpaper; this guard only covers degenerate input.
      if (safe === null) return '当前壁纸在任何面板不透明度下都达不到 AA 对比度，请加大壁纸暗化';
      return '绿色区：正文清晰可读（>= ' + WCAG_AA + ':1）。当前暗化下，面板不透明度需 >= ' + safe + '%';
    }

    /**
     * Worst-case contrast for one wallpaper sample, given the current dim and
     * panel opacity. Returns the ratio of the *least* readable sample point,
     * because a single unreadable word is the failure users notice.
     */
    function worstContrast(samples, dim, panelOpacity) {
      let worst = Infinity;
      for (const scheme of ['light', 'dark']) {
        const text = TEXT_RGB[scheme];
        const panel = PANEL_RGB[scheme];
        for (const px of samples) {
          const bg = panelOver(shaded(px, dim), panelOpacity, panel);
          const ratio = contrastRatio(text, bg);
          if (ratio < worst) worst = ratio;
        }
      }
      return worst;
    }

    /**
     * Draw a wallpaper's pixels into a small offscreen canvas and return the
     * colour samples. Images and videos both route through an <img>/<video>
     * element that the file route already serves same-origin, so the canvas is
     * never tainted and getImageData() stays legal.
     */
    function sampleWallpaper(path, kind, onDone) {
      const SIZE = 32;
      const canvas = document.createElement('canvas');
      canvas.width = SIZE;
      canvas.height = SIZE;
      const g = canvas.getContext('2d', { willReadFrequently: true });
      if (!g) { onDone(null); return; }

      const url = fileUrl(path);
      function harvest(source) {
        try {
          g.drawImage(source, 0, 0, SIZE, SIZE);
          const data = g.getImageData(0, 0, SIZE, SIZE).data;
          const out = [];
          for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] < 8) continue; // transparent input pixels say nothing
            out.push([data[i], data[i + 1], data[i + 2]]);
          }
          onDone(out.length > 0 ? out : null);
        } catch (error) {
          // A tainted canvas or a codec the browser cannot decode leaves the
          // panel without a measurement rather than breaking the page.
          onDone(null);
        }
      }

      if (kind === 'video') {
        const v = document.createElement('video');
        v.muted = true;
        v.crossOrigin = 'anonymous';
        // 'metadata' is deliberate: 'auto' would pull the whole file just to
        // sample 32x32 colours, and these exports run to hundreds of megabytes
        // (one measured 2.4 GB). The first decoded frame is all we need.
        v.preload = 'metadata';
        let settled = false;
        const finish = function () {
          if (settled) return;
          settled = true;
          harvest(v);
          v.removeAttribute('src');
          v.load();
        };
        // 'loadeddata' carries a decoded frame; 'seeked' after a seek to 0
        // catches files whose preload policy delivered metadata only.
        v.addEventListener('loadeddata', finish, { once: true });
        v.addEventListener('error', function () {
          if (settled) return;
          settled = true;
          onDone(null);
        }, { once: true });
        v.addEventListener('loadedmetadata', function () {
          if (settled) return;
          try { v.currentTime = 0.001 } catch (error) { /* seek unsupported */ }
        }, { once: true });
        v.addEventListener('seeked', finish, { once: true });
        v.src = url;
      } else {
        const im = new Image();
        im.crossOrigin = 'anonymous';
        im.onload = function () { harvest(im); };
        im.onerror = function () { onDone(null); };
        im.src = url;
      }
    }

    // ---- palette overrides via the host Theme service ----
    // The host's `ctx.theme.overrideTokens()` is the supported way to change
    // --dsw-alias-* tokens: it feeds ThemeRuntime.composeActive(), and the
    // layout's ThemePresenter then writes the resulting values onto <body> as
    // inline custom properties. Writing those same tokens from our own
    // stylesheet would LOSE to that inline style as soon as any other plugin
    // registers a themed override, so the translucent palette must go through
    // the service, not through `${'<style>'}`.
    //
    // validateOverrides() requires { light, dark } pairs and throws on a bare
    // string, so each token is computed for both palettes here.
    const THEME_SOURCE = PLUGIN_ID + ':palette';
    let disposePalette = null;

    function paletteFor(panel, dark) {
      const base = dark ? '17,17,20' : '246,246,248';
      const a = (value) => alpha(value);
      return {
        '--dsw-alias-bg-layer-2': 'rgba(' + base + ',' + a(panel * 0.97) + ')',
        '--dsw-alias-bg-layer-3': 'rgba(' + base + ',' + a(panel * 0.98) + ')',
        '--dsw-alias-bg-overlay': 'rgba(' + base + ',' + a(panel * 0.99) + ')',
      }
    }

    /**
     * Push (or clear) the translucent palette through the Theme service.
     * Falls back to a stylesheet when the service is absent, so the plugin
     * still works on hosts that ship without ui-theme.
     */
    function applyPalette(theme, state) {
      const w = state.wallpaper;
      const active = w.enabled && w.path.length > 0;
      if (disposePalette !== null) {
        disposePalette();
        disposePalette = null;
      }
      if (!active || theme === null) return;
      const light = paletteFor(w.panelOpacity, false);
      const dark = paletteFor(w.panelOpacity, true);
      const tokens = {};
      for (const name of Object.keys(light)) {
        tokens[name] = { light: light[name], dark: dark[name] };
      }
      try {
        disposePalette = theme.overrideTokens(THEME_SOURCE, tokens);
      } catch (error) {
        // A rejected source/registration must never break the settings page.
        disposePalette = null;
      }
    }

    // ---- stylesheet: wallpaper layer + macos theme ----
    // Geometry only: the colour tokens above are owned by the Theme service.
    function ensureStyle(state) {
      let style = document.getElementById(STYLE_ID);
      if (!style) {
        style = document.createElement('style');
        style.id = STYLE_ID;
        style.dataset.plugin = PLUGIN_ID;
        document.head.appendChild(style);
      }
      const w = state.wallpaper;
      const active = w.enabled && w.path.length > 0;
      const rules = [];
      if (active) {
        rules.push(
          // Wallpaper lives on body as a fixed layer (z-index 0) covering the
          // WHOLE window including the 38px titlebar strip; the app content
          // (#root) is lifted to z-index 1 so it floats above the wallpaper,
          // and the frame's own frosted-glass backdrop is neutralised so it
          // never blurs the wallpaper into haze.
          '#root{position:relative;z-index:1}',
          '#root [class$="_frame"]{backdrop-filter:none !important;-webkit-backdrop-filter:none !important}',
          '#' + LAYER_ID + '{position:fixed;inset:0;z-index:0;pointer-events:none;background-repeat:no-repeat}',
          '#' + LAYER_ID + '[data-fit="cover"]{background-size:cover;background-position:center}',
          '#' + LAYER_ID + '[data-fit="fill"]{background-size:contain;background-position:center}',
          '#' + LAYER_ID + '[data-fit="stretch"]{background-size:100% 100%;background-position:center}',
          '#' + LAYER_ID + '[data-fit="free"]{background-size:auto;background-position:center}',
          '#' + LAYER_ID + '.dsh-twp-video{object-position:center}',
          '#' + LAYER_ID + '.dsh-twp-video[data-fit="cover"]{object-fit:cover}',
          '#' + LAYER_ID + '.dsh-twp-video[data-fit="fill"]{object-fit:contain}',
          '#' + LAYER_ID + '.dsh-twp-video[data-fit="stretch"]{object-fit:fill}',
          '#' + LAYER_ID + '.dsh-twp-video[data-fit="free"]{object-fit:none}',
          '#' + DIM_ID + '{position:fixed;inset:0;z-index:0;pointer-events:none;background:linear-gradient(rgba(0,0,0,' + Number(w.dim).toFixed(3) + '),rgba(0,0,0,' + Number(w.dim).toFixed(3) + '))}',
          'body[data-dsh-theme-wallpaper]{background:transparent !important;' +
            '--dsw-specific-sidebar-fill:transparent;' +
            '--dsw-alias-border-l1:transparent;' +
            '--dsw-alias-border-l2:transparent;' +
            '--dsw-alias-border-l3:transparent;' +
            '--dsw-alias-bg-base:transparent;' +
            '--dsw-alias-bg-layer-1:transparent}',
        );
      }
      if (state.theme === 'macos') {
        rules.push(
          'body[data-dsh-theme-wallpaper="macos"]{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Microsoft YaHei",system-ui,sans-serif}',
        );
      }
      // ---- Text legibility guard (方案 1) ----
      // The wallpaper sits behind translucent panels, so text competes with
      // whatever colour happens to be underneath it. A hairline halo makes glyph
      // edges hold up against both a pale sky and a dark mountain without
      // raising the panel opacity (which would hide the wallpaper).
      //
      // The halo is chosen against the *text* colour, not the wallpaper: light
      // text gets a dark halo, dark text gets a light one. `currentColor` is not
      // usable here — a shadow can carry its own alpha, so the two cases get
      // declared explicitly and the app's own light/dark switch picks one.
      // `!== false` keeps protection on for state written before the field
      // existed; sanitize() now always materialises a boolean, so this is
      // belt-and-braces rather than the primary source of truth.
      const protect = active && w.textProtect !== false;
      if (protect) {
        // Scoped to text-bearing regions rather than `*`: a global text-shadow
        // would also smear icons, borders and focus rings drawn with currentColor.
        rules.push(
          'body[data-dsh-theme-wallpaper][data-dsh-twp-protect]{' +
            '--dsh-twp-halo:rgba(0,0,0,.55)}',
          'body[data-dsh-theme-wallpaper][data-dsh-dark-theme][data-dsh-twp-protect]{' +
            '--dsh-twp-halo:rgba(255,255,255,.42)}',
          // Text-bearing surfaces only. The halo is the shadow of the glyph
          // itself, so it never widens layout or changes line height.
          'body[data-dsh-twp-protect] [data-conversation-region],' +
          'body[data-dsh-twp-protect] [data-chat-flow],' +
          'body[data-dsh-twp-protect] [data-chat-flow] *,' +
          'body[data-dsh-twp-protect] [data-composer-seat],' +
          'body[data-dsh-twp-protect] [data-composer-seat] *{' +
            'text-shadow:0 0 1.5px var(--dsh-twp-halo),0 1px 1px var(--dsh-twp-halo)}',
        );
      }
      const next = rules.join('\n');
      if (style.textContent !== next) style.textContent = next;
    }

    // ---- wallpaper layer element ----
    function ensureLayer(state) {
      const w = state.wallpaper;
      const active = w.enabled && w.path.length > 0;
      // Mount on document.body as a fixed layer: it covers the whole window
      // INCLUDING the 38px titlebar strip (top edge feels continuous). The app
      // content (#root) is lifted above it (z-index 1) and the frame's frosted
      // backdrop is neutralised by the stylesheet, so the wallpaper shows
      // clearly through the transparent columns without ever covering the UI.
      const host = document.body;

      let dim = document.getElementById(DIM_ID);
      if (active) {
        if (!dim) {
          dim = document.createElement('div');
          dim.id = DIM_ID;
        }
        if (dim.parentElement !== host) host.appendChild(dim);
      } else if (dim) {
        dim.remove();
      }

      let layer = document.getElementById(LAYER_ID);
      if (!active) {
        if (layer) layer.remove();
        currentVideo = null;
        return;
      }
      const wantVideo = w.kind === 'video';
      const isVideo = layer !== null && layer.tagName === 'VIDEO';
      if (isVideo !== wantVideo) {
        if (layer) layer.remove();
        layer = null;
      }
      if (!layer) {
        if (wantVideo) {
          layer = document.createElement('video');
          layer.id = LAYER_ID;
          layer.muted = true;
          layer.loop = true;
          layer.autoplay = true;
          layer.preload = 'auto';
          layer.setAttribute('playsinline', '');
          layer.classList.add('dsh-twp-video');
          layer.style.cssText = 'position:fixed;inset:0;z-index:0;pointer-events:none;width:100vw;height:100vh';
        } else {
          layer = document.createElement('div');
          layer.id = LAYER_ID;
          layer.style.cssText = 'position:fixed;inset:0;z-index:0;pointer-events:none';
        }
        host.appendChild(layer);
        // Keep the shade after the layer so it overlays the wallpaper (same
        // z-index, later DOM order wins) while #root (z-index 1) stays above.
        if (dim && dim.parentElement === host) host.appendChild(dim);
      } else if (layer.parentElement !== host) {
        host.appendChild(layer);
        if (dim && dim.parentElement === host) host.appendChild(dim);
      }
      layer.dataset.fit = w.fit || 'cover';
      if (wantVideo) {
        currentVideo = layer;
        const src = fileUrl(w.path);
        if (layer.getAttribute('src') !== src) {
          layer.setAttribute('src', src);
          layer.load();
        }
        if (layer.paused || layer.readyState === 0) {
          const p = layer.play();
          if (p && typeof p.catch === 'function') p.catch(function () {});
        }
      } else {
        currentVideo = null;
        layer.style.backgroundImage = "url('" + fileUrl(w.path) + "')";
      }
    }

    // ---- auto pause (video wallpaper) ----
    function resumeIfAllowed() {
      if (!currentVideo) return;
      if (!autopauseEnabled) return;
      if (typeof currentVideo.paused !== 'boolean' || currentVideo.paused === false) return;
      const p = currentVideo.play();
      if (p && typeof p.catch === 'function') p.catch(function () {});
    }
    function onVisibility() {
      if (!currentVideo) return;
      if (document.hidden) { try { currentVideo.pause(); } catch (e) {} }
      else { resumeIfAllowed(); }
    }
    function onBlur() {
      if (currentVideo && autopauseEnabled) { try { currentVideo.pause(); } catch (e) {} }
    }
    function onFocus() {
      resumeIfAllowed();
    }
    /**
     * Install the focus/visibility listeners. Called from apply() inside a
     * ctx.effect so they are removed when the plugin unloads — a module-level
     * addEventListener would outlive the plugin and keep pausing a video that
     * no longer belongs to it.
     */
    function installAutoPauseListeners() {
      document.addEventListener('visibilitychange', onVisibility);
      window.addEventListener('blur', onBlur);
      window.addEventListener('focus', onFocus);
      return function () {
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('blur', onBlur);
        window.removeEventListener('focus', onFocus);
      };
    }

    // ---- apply the full state to the page ----
    function applyThemeWallpaper(state) {
      latestState = state;
      const w = state.wallpaper;
      document.body.dataset.dshThemeWallpaper = state.theme;
      // Drives the text-halo rules in ensureStyle(); kept off the body entirely
      // when the wallpaper is inactive so no stray attributes linger.
      const protect = w.enabled && w.path.length > 0 && w.textProtect !== false;
      if (protect) document.body.dataset.dshTwpProtect = '';
      else delete document.body.dataset.dshTwpProtect;
      autopauseEnabled = w.autopause !== false;
      ensureStyle(state);
      applyPalette(themeService, state);
      ensureLayer(state);
      armRotation(state);
    }

    // ---- wallpaper rotation ----
    // One timer for the current schedule. Re-armed on every state change, so a
    // mode/interval/playlist edit takes effect immediately instead of waiting
    // out the previous interval.
    let rotateTimer = null;

    function clearRotation() {
      if (rotateTimer !== null) {
        clearTimeout(rotateTimer);
        rotateTimer = null;
      }
    }

    /** Next playlist index for the given mode, or null when there is nowhere to go. */
    function nextRotationIndex(rotate, mode) {
      const list = rotate.playlist;
      if (list.length === 0) return null;
      if (mode === 'sequential') {
        return (rotate.cursor + 1) % list.length;
      }
      // Random: pick any index other than the current one, so the wallpaper
      // actually changes every tick instead of sometimes landing on itself.
      if (list.length === 1) return 0;
      let pick = rotate.cursor;
      // Bounded retry: a long playlist makes a collision unlikely, and looping
      // forever on a degenerate cursor would be worse than one repeat.
      for (let attempt = 0; attempt < 12 && pick === rotate.cursor; attempt++) {
        pick = Math.floor(Math.random() * list.length);
      }
      if (pick === rotate.cursor) pick = (rotate.cursor + 1) % list.length;
      return pick;
    }

    /**
     * (Re)start the rotation schedule from the current state.
     * Runs on the page-side timer; `latestState` is the source of truth so the
     * handler never closes over a stale state object.
     */
    function armRotation(state) {
      clearRotation();
      const rotate = state.rotate;
      if (rotate === null || typeof rotate !== 'object') return;
      if (rotate.mode !== 'sequential' && rotate.mode !== 'random') return;
      if (!state.wallpaper.enabled) return;
      if (!Array.isArray(rotate.playlist) || rotate.playlist.length < 2) return;
      const minutes = Number(rotate.minutes);
      const ms = Math.min(Math.max(minutes, 1), 24 * 60) * 60 * 1000;
      rotateTimer = setTimeout(runRotation, ms);
    }

    function runRotation() {
      rotateTimer = null;
      // A hidden window has no wallpaper to show; counting down a rotation there
      // would burn through the playlist while the user is away, so the timer
      // simply re-arms and the schedule resumes when the page is visible again.
      if (typeof document !== 'undefined' && document.hidden) {
        if (latestState) armRotation(latestState);
        return;
      }
      const state = latestState;
      if (state === null || !state.rotate) return;
      const rotate = state.rotate;
      const index = nextRotationIndex(rotate, rotate.mode);
      if (index === null) return;
      const path = rotate.playlist[index];
      if (!path) { armRotation(state); return; }
      // Advance locally and persist, so a reload resumes from the same place
      // rather than restarting the sequence.
      const next = Object.assign({}, state, {
        wallpaper: Object.assign({}, state.wallpaper, {
          path,
          kind: guessKind(path),
          enabled: true,
        }),
        rotate: Object.assign({}, rotate, { cursor: index }),
      });
      applyThemeWallpaper(next);
      persistState(next);
    }

    /** Fire-and-forget save used by the rotation timer (no UI wiring involved). */
    function persistState(state) {
      if (typeof fetch !== 'function') return;
      fetch(SAVE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state }),
      }).then(function (res) { return res.json(); }).then(function (data) {
        if (data && data.ok && data.state) latestState = data.state;
      }).catch(function () {
        // A failed save must not stop the visible rotation; the in-memory state
        // already moved on and the next save will carry the newer cursor.
      });
    }

    /** Mirrors the Host's extension→kind rule so rotation picks the right renderer. */
    function guessKind(path) {
      return /\.(mp4|webm|mov|mkv)$/i.test(String(path)) ? 'video' : 'image';
    }

    // The host Theme service, when the running host provides one. `null` keeps
    // the stylesheet-only fallback path.
    let themeService = null;

    // Rebuild the stylesheet when the app's dark/light theme flips later. The
    // palette itself needs no rebuild: the { light, dark } pairs handed to the
    // Theme service already cover both schemes. Returns a disposer for apply().
    function installThemeObserver() {
      if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') {
        return function () {};
      }
      const themeObserver = new MutationObserver(function () {
        if (latestState) ensureStyle(latestState);
      });
      themeObserver.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] });
      return function () { themeObserver.disconnect(); };
    }

    // ---- state transport ----
    function loadState() {
      return fetch(STATE_URL).then(function (res) { return res.json(); }).then(function (data) {
        if (!data.ok) throw new Error(data.message || 'state load failed');
        return data.state;
      });
    }
    function saveState(state) {
      return fetch(SAVE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: state }),
      }).then(function (res) { return res.json(); }).then(function (data) {
        if (!data.ok) throw new Error(data.message || 'state save failed');
        applyThemeWallpaper(data.state);
        return data.state;
      });
    }

    // ---- settings section UI ----
    const THEME_OPTIONS = [
      { id: 'system', label: '跟随系统' },
      { id: 'light', label: '浅色' },
      { id: 'dark', label: '深色' },
      { id: 'macos', label: 'macOS 观感' },
    ];
    const FIT_OPTIONS = [
      { id: 'cover', label: '覆盖' },
      { id: 'fill', label: '填充' },
      { id: 'stretch', label: '拉伸' },
      { id: 'free', label: '自由' },
    ];

    const MAX_ROTATE_MINUTES = 24 * 60;
    const ROTATE_OPTIONS = [
      { id: 'off', label: '不轮换' },
      { id: 'sequential', label: '顺序轮换' },
      { id: 'random', label: '随机轮换' },
    ];
    /** Same shape the Host's defaultState() uses, for merging partial edits. */
    function ROTATE_DEFAULT() {
      return { mode: 'off', minutes: 30, playlist: [], cursor: 0 };
    }
    /** Last path segment, for showing a playlist entry without the whole path. */
    function baseName(p) {
      var s = String(p || '');
      var i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
      return i >= 0 ? s.slice(i + 1) : s;
    }

    const S = {
      section: { display: 'flex', flexDirection: 'column', gap: '18px', maxWidth: '640px', padding: '4px 0 24px' },
      card: { border: '1px solid var(--dsw-alias-border-l2, #2a3441)', borderRadius: '12px', padding: '14px 16px', background: 'var(--dsw-alias-bg-layer-1, rgba(30,34,42,.8))' },
      blockTitle: { fontSize: '15px', fontWeight: 600, margin: '0 0 10px', color: 'var(--dsw-alias-label-primary, #e5e7eb)' },
      hint: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, #9ca3af)', margin: '6px 0 0' },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      seg: { display: 'inline-flex', border: '1px solid var(--dsw-alias-border-l2, #2a3441)', borderRadius: '9px', overflow: 'hidden' },
      segBtn: function (active) {
        return {
          padding: '6px 13px', cursor: 'pointer', fontSize: '13px', border: 'none',
          background: active ? 'var(--dsw-alias-interactive-bg-active, #3b82f6)' : 'transparent',
          color: active ? '#fff' : 'var(--dsw-alias-label-secondary, #cbd5e1)',
        };
      },
      sliderRow: { display: 'flex', alignItems: 'center', gap: '12px' },
      sliderLabel: { fontSize: '13px', minWidth: '110px', color: 'var(--dsw-alias-label-secondary, #cbd5e1)' },
      sliderValue: { fontSize: '12px', minWidth: '44px', textAlign: 'right', color: 'var(--dsw-alias-label-tertiary, #9ca3af)' },
      input: { background: 'var(--dsw-alias-bg-layer-2, #1f2937)', color: 'var(--dsw-alias-label-primary, #e5e7eb)', border: '1px solid var(--dsw-alias-border-l2, #374151)', borderRadius: '8px', padding: '6px 10px', fontSize: '13px', flex: '1', minWidth: '0' },
      btn: { padding: '6px 14px', cursor: 'pointer', fontSize: '13px', borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l2, #374151)', background: 'var(--dsw-alias-bg-layer-2, #2a3441)', color: 'var(--dsw-alias-label-primary, #e5e7eb)' },
      pathText: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #9ca3af)', wordBreak: 'break-all', lineHeight: '18px', margin: '8px 0 0' },
      toggle: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '14px', color: 'var(--dsw-alias-label-primary, #e5e7eb)' },
      error: { fontSize: '13px', color: 'var(--dsw-alias-state-error-primary, #ef4444)', margin: '0 0 10px' },
      range: { flex: '1', minWidth: '0' },
      preview: { marginTop: '10px', maxHeight: '120px', maxWidth: '100%', borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l2, #374151)', display: 'block' },
      // Contrast readout: a strip that states the current worst-case ratio and
      // colours itself by verdict, so the number and its meaning arrive together.
      readout: { marginTop: '10px', padding: '8px 10px', borderRadius: '8px', fontSize: '12px', lineHeight: '18px', border: '1px solid' },
      swatch: { display: 'inline-block', width: '9px', height: '9px', borderRadius: '2px', marginLeft: '6px', verticalAlign: 'middle' },
      playlist: { marginTop: '8px', maxHeight: '150px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '2px' },
      playlistRow: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', padding: '2px 0' },
      playlistName: { flex: '1', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-secondary, #cbd5e1)' },
      num: { width: '46px', border: '1px solid var(--dsw-alias-border-l2, #374151)', borderRadius: '6px', padding: '4px 6px', fontSize: '13px', background: 'var(--dsw-alias-bg-layer-2, #1f2937)', color: 'var(--dsw-alias-label-primary, #e5e7eb)' },
    };

    function ThemeWallpaperSection(props) {
      var stateHook = React.useState(null);
      var state = stateHook[0];
      var setState = stateHook[1];
      var errHook = React.useState(null);
      var error = errHook[0];
      var setError = errHook[1];
      var pathHook = React.useState('');
      var manualPath = pathHook[0];
      var setManualPath = pathHook[1];
      var fileRef = React.useRef(null);
      var galleryHook = React.useState(false);
      var weOpen = galleryHook[0];
      var setWeOpen = galleryHook[1];
      var weItemsHook = React.useState(null);
      var weItems = weItemsHook[0];
      var setWeItems = weItemsHook[1];
      var weBusyHook = React.useState(false);
      var weBusy = weBusyHook[0];
      var setWeBusy = weBusyHook[1];
      var weErrHook = React.useState(null);
      var weErr = weErrHook[0];
      var setWeErr = weErrHook[1];
      var weNeedsFolderHook = React.useState(false);
      var weNeedsFolder = weNeedsFolderHook[0];
      var setWeNeedsFolder = weNeedsFolderHook[1];
      var weInfoHook = React.useState(null);
      var weInfo = weInfoHook[0];
      var setWeInfo = weInfoHook[1];
      var weSkippedHook = React.useState([]);
      var weSkipped = weSkippedHook[0];
      var setWeSkipped = weSkippedHook[1];
      var mpkgDirHook = React.useState('');
      var mpkgDir = mpkgDirHook[0];
      var setMpkgDir = mpkgDirHook[1];
      var createModeHook = React.useState(false);
      var createMode = createModeHook[0];
      var setCreateMode = createModeHook[1];
      var newFolderHook = React.useState('');
      var newFolder = newFolderHook[0];
      var setNewFolder = newFolderHook[1];
      // 文件夹浏览器（宿主目录列表，替代 Electron 里失效的 webkitdirectory 选择器）
      var browseOpenHook = React.useState(false);
      var browseOpen = browseOpenHook[0];
      var setBrowseOpen = browseOpenHook[1];
      var browsePathHook = React.useState('');
      var browsePath = browsePathHook[0];
      var setBrowsePath = browsePathHook[1];
      var browseParentHook = React.useState('');
      var browseParent = browseParentHook[0];
      var setBrowseParent = browseParentHook[1];
      var browseDirsHook = React.useState([]);
      var browseDirs = browseDirsHook[0];
      var setBrowseDirs = browseDirsHook[1];
      var browseMpkgHook = React.useState([]);
      var browseMpkg = browseMpkgHook[0];
      var setBrowseMpkg = browseMpkgHook[1];
      var browseBusyHook = React.useState(false);
      var browseBusy = browseBusyHook[0];
      var setBrowseBusy = browseBusyHook[1];
      var dimsHook = React.useState(null);
      var dims = dimsHook[0];
      var setDims = dimsHook[1];
      // Colour samples of the current wallpaper, used for the contrast readout.
      // `null` means "not measured yet"; `false` means "could not measure"
      // (tainted canvas, unsupported codec) and suppresses the readout.
      var swatchesHook = React.useState(null);
      var swatches = swatchesHook[0];
      var setSwatches = swatchesHook[1];
      // Playlist editor: the raw text lets a user paste many paths at once,
      // which beats adding them one dialog at a time.
      var pasteHook = React.useState('');
      var pasteText = pasteHook[0];
      var setPasteText = pasteHook[1];
      var showPasteHook = React.useState(false);
      var showPaste = showPasteHook[0];
      var setShowPaste = showPasteHook[1];
      // Reading window.innerWidth during render freezes the "is it big enough?"
      // hint at whatever the size was when the panel first painted; track it so
      // resizing the window updates the verdict.
      var viewportHook = React.useState(function () {
        return { w: window.innerWidth, h: window.innerHeight };
      });
      var viewport = viewportHook[0];
      var setViewport = viewportHook[1];
      React.useEffect(function () {
        function onResize() { setViewport({ w: window.innerWidth, h: window.innerHeight }); }
        window.addEventListener('resize', onResize);
        return function () { window.removeEventListener('resize', onResize); };
      }, []);

      // Resolution is measured by the preview element itself (below), so no
      // separate probe element is created here: a preload="metadata" <video>
      // would download and decode the same file a second time.
      React.useEffect(function () {
        var wp = state && state.wallpaper && state.wallpaper.enabled && state.wallpaper.path ? state.wallpaper : null;
        if (!wp) setDims(null);
      }, [state && state.wallpaper ? state.wallpaper.path + '|' + state.wallpaper.kind + '|' + state.wallpaper.enabled : '']);

      // Sample the wallpaper's colours once per file, so the contrast readout
      // below can state a real number instead of guessing. Re-sampled only when
      // the file changes: the pixel data of a given path cannot change.
      React.useEffect(function () {
        var alive = true;
        var wp = state && state.wallpaper && state.wallpaper.enabled && state.wallpaper.path ? state.wallpaper : null;
        if (!wp) { setSwatches(null); return; }
        setSwatches(null);
        sampleWallpaper(wp.path, wp.kind, function (samples) {
          if (!alive) return;
          setSwatches(samples === null ? false : samples);
        });
        return function () { alive = false; };
      }, [state && state.wallpaper && state.wallpaper.enabled ? state.wallpaper.path + '|' + state.wallpaper.kind : '']);

      React.useEffect(function () {
        var alive = true;
        loadState().then(function (s) {
          if (!alive) return;
          setState(s);
          setManualPath(s.wallpaper.path);
          setMpkgDir((s.we && s.we.mpkgDir) || '');
          applyThemeWallpaper(s);
        }).catch(function (e) {
          if (alive) setError(String(e && e.message ? e.message : e));
        });
        return function () { alive = false; };
      }, []);

      // Sliders fire onChange on every pixel of a drag (~100 events), and each
      // one used to POST the whole state and rewrite state.json. Apply locally
      // right away (so the wallpaper reacts at drag speed) and persist once the
      // user stops moving. Discrete actions still commit immediately.
      var commitTimer = null;
      var pendingCommit = null;

      function flushCommit() {
        if (commitTimer !== null) { clearTimeout(commitTimer); commitTimer = null; }
        var next = pendingCommit;
        pendingCommit = null;
        if (next === null) return;
        saveState(next).then(function (saved) {
          setState(saved);
          setManualPath(saved.wallpaper.path);
        }).catch(function (e) {
          setError(String(e && e.message ? e.message : e));
        });
      }

      function commit(next, deferred) {
        setError(null);
        var merged = Object.assign({}, state, next, { we: state.we || { dir: '', mpkgDir: '' } });
        // Repaint immediately from the merged state; the POST only persists it.
        setState(merged);
        applyThemeWallpaper(merged);
        if (deferred === true) {
          pendingCommit = merged;
          if (commitTimer !== null) clearTimeout(commitTimer);
          commitTimer = setTimeout(flushCommit, 260);
          return;
        }
        pendingCommit = null;
        if (commitTimer !== null) clearTimeout(commitTimer);
        commitTimer = setTimeout(function () {
          commitTimer = null;
          saveState(merged).then(function (saved) {
            setState(saved);
            setManualPath(saved.wallpaper.path);
          }).catch(function (e) {
            setError(String(e && e.message ? e.message : e));
          });
        }, 0);
      }

      // Never lose the last slider position when the panel closes or the plugin
      // unmounts mid-drag.
      React.useEffect(function () {
        return function () { flushCommit(); };
      }, []);
      // 设置/创建导出目录：POST 给宿主（不存在则自动创建），成功后同步回本地 state，
      // 否则下一次 commit（如换壁纸）会用旧的空 we 把目录覆盖掉
      function setMpkgFolder(path) {
        var p = (path || '').trim();
        if (!p) { setWeErr('请填写文件夹路径。'); return; }
        setWeBusy(true);
        setWeErr(null);
        fetch(MPKG_FOLDER_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: p }),
        }).then(function (r) { return r.json(); }).then(function (d) {
          setWeBusy(false);
          if (!d.ok) { setWeErr(d.message || '设置失败'); return; }
          setMpkgDir(d.path);
          setState(function (cur) {
            return Object.assign({}, cur, { we: Object.assign({}, (cur && cur.we) || {}, { mpkgDir: d.path }) });
          });
          setCreateMode(false);
          setNewFolder('');
          setWeItems(null);
          scanWe();
        }).catch(function (e) { setWeBusy(false); setWeErr(String(e && e.message ? e.message : e)); });
      }
      // 文件夹浏览器：向宿主拉取目录列表（Electron 里 webkitdirectory 选择器会退化成上传对话框，不可用）
      function navTo(dir) {
        setBrowseBusy(true);
        fetch(DIRS_URL + encodeURIComponent(dir))
          .then(function (r) { return r.json(); })
          .then(function (d) {
            setBrowseBusy(false);
            if (!d.ok) { setWeErr(d.message || '无法读取该文件夹'); return; }
            setBrowsePath(d.path);
            setBrowseParent(d.parent || '');
            setBrowseDirs(d.dirs || []);
            setBrowseMpkg(d.mpkgFiles || []);
          })
          .catch(function (e) { setBrowseBusy(false); setWeErr(String(e && e.message ? e.message : e)); });
      }
      function openBrowser() {
        setBrowseOpen(true);
        navTo(mpkgDir || '');
      }
      // 把当前浏览到的文件夹设为导出目录
      function useThisFolder() {
        if (!browsePath) return;
        setBrowseOpen(false);
        setMpkgFolder(browsePath);
      }
      // 一键把桌面上的 .mpkg 移进导出目录（WE 导出默认落桌面，收一次桌面就清爽）
      function collectDesktopMpkg() {
        if (!mpkgDir) { setWeErr('请先设置导出目录。'); return; }
        setWeBusy(true);
        setWeErr(null);
        setWeInfo(null);
        fetch(MPKG_COLLECT_URL, { method: 'POST' })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            setWeBusy(false);
            if (!d.ok) { setWeErr(d.message || '收集失败'); return; }
            if (d.count > 0) { setWeItems(null); scanWe(); }
            setWeInfo(d.count > 0 ? '已从桌面移入 ' + d.count + ' 个 .mpkg 到导出目录。' : '桌面上没有 .mpkg 文件。');
          })
          .catch(function (e) { setWeBusy(false); setWeErr(String(e && e.message ? e.message : e)); });
      }
      function setTheme(id) {
        if (state) commit({ theme: id, wallpaper: state.wallpaper });
      }
      function setWall(patch, deferred) {
        if (state) commit({ theme: state.theme, wallpaper: Object.assign({}, state.wallpaper, patch) }, deferred === true);
      }
      function onPickFile(e) {
        var input = e.target;
        var file = input && input.files && input.files[0];
        input.value = '';
        if (!file) return;
        var p = file.path || '';
        if (p) {
          var isVideo = (/\.(mp4|webm|mov|mkv)$/i.test(p)) || (typeof file.type === 'string' && file.type.indexOf('video/') === 0);
          setWall({ path: p, enabled: true, kind: isVideo ? 'video' : 'image' });
        } else {
          setError('桌面端可直接选文件；浏览器里请用下面的路径输入框手动粘贴完整路径。');
        }
      }
      function onManualApply() {
        var p = (manualPath || '').trim();
        if (!p) { setError('请输入壁纸文件的完整路径。'); return; }
        var isVideo = /\.(mp4|webm|mov|mkv)$/i.test(p);
        setWall({ path: p, enabled: true, kind: isVideo ? 'video' : 'image' });
      }
      function onToggleWall(e) {
        setWall({ enabled: e.target.checked });
      }
      function onToggleAutoPause(e) {
        setWall({ autopause: e.target.checked });
      }
      function onToggleTextProtect(e) {
        setWall({ textProtect: e.target.checked });
      }

      // ---- rotation handlers ----
      /** Merge a rotate patch, keeping every other rotate field intact. */
      function setRotate(patch, deferred) {
        if (!state) return;
        var rotate = Object.assign({}, ROTATE_DEFAULT(), state.rotate || {}, patch);
        commit({ theme: state.theme, wallpaper: state.wallpaper, rotate: rotate }, deferred === true);
      }
      function onRotateMode(e) {
        setRotate({ mode: e.target.value });
      }
      function onRotateMinutes(e) {
        var n = Number(e.target.value);
        if (!Number.isFinite(n)) return;
        setRotate({ minutes: Math.min(MAX_ROTATE_MINUTES, Math.max(1, Math.round(n))) }, true);
      }
      function addToPlaylist(paths) {
        var cur = (state && state.rotate && Array.isArray(state.rotate.playlist)) ? state.rotate.playlist : [];
        var seen = {};
        var out = [];
        for (var i = 0; i < cur.length; i++) { if (!seen[cur[i]]) { seen[cur[i]] = 1; out.push(cur[i]); } }
        for (var k = 0; k < paths.length; k++) {
          var p = paths[k];
          if (typeof p !== 'string' || !p) continue;
          if (!seen[p]) { seen[p] = 1; out.push(p); }
        }
        setRotate({ playlist: out, cursor: Math.min((state && state.rotate && state.rotate.cursor) || 0, Math.max(0, out.length - 1)) });
      }
      function removeFromPlaylist(index) {
        var cur = (state.rotate && state.rotate.playlist) ? state.rotate.playlist.slice() : [];
        if (index < 0 || index >= cur.length) return;
        cur.splice(index, 1);
        var cursor = (state.rotate && state.rotate.cursor) || 0;
        if (cursor >= cur.length) cursor = 0;
        setRotate({ playlist: cur, cursor: cursor });
      }
      function movePlaylistItem(index, delta) {
        var cur = (state.rotate && state.rotate.playlist) ? state.rotate.playlist.slice() : [];
        var to = index + delta;
        if (to < 0 || to >= cur.length) return;
        var tmp = cur[index];
        cur[index] = cur[to];
        cur[to] = tmp;
        setRotate({ playlist: cur });
      }
      function addCurrentWallpaper() {
        if (!state || !state.wallpaper.path) { setError('还没有设置壁纸，无法加入轮换列表。'); return; }
        addToPlaylist([state.wallpaper.path]);
      }
      function applyPasteList() {
        var parts = String(pasteText || '')
          .split(/[\r\n]+/)
          .map(function (s) { return s.trim(); })
          .filter(function (s) { return s.length > 0; });
        if (parts.length === 0) { setError('请粘贴至少一个文件路径（每行一个）。'); return; }
        addToPlaylist(parts);
        setPasteText('');
        setShowPaste(false);
      }
      /** Add every entry currently loaded in the .mpkg gallery. */
      function addGalleryToPlaylist() {
        if (!weItems || weItems.length === 0) { setError('画廊里还没有条目，先扫描一次。'); return; }
        var paths = [];
        for (var i = 0; i < weItems.length; i++) {
          var media = weItems[i].media || weItems[i].preview;
          if (media) paths.push(media);
        }
        addToPlaylist(paths);
      }
      function onDim(e) {
        setWall({ dim: Number(e.target.value) / 100 }, true);
      }
      function onPanel(e) {
        setWall({ panelOpacity: Number(e.target.value) / 100 }, true);
      }
      function scanWe() {
        setWeErr(null);
        setWeInfo(null);
        setWeBusy(true);
        setWeItems(null);
        fetch(WE_LIBRARY_URL)
          .then(function (r) { return r.json(); })
          .then(function (data) {
            setWeBusy(false);
            if (!data.ok) { setWeErr(data.message || '扫描失败'); return; }
            setWeItems(data.entries || []);
            setWeNeedsFolder(data.needsFolder === true);
            setWeSkipped(data.skipped || []);
          })
          .catch(function (e) { setWeBusy(false); setWeErr(String(e && e.message ? e.message : e)); });
      }
      function openGallery() {
        setWeOpen(true);
        if (weItems === null) scanWe();
      }
      function pickWe(item) {
        var path = item.media || item.preview;
        if (!path) return;
        setWall({ path: path, enabled: true, kind: item.kind === 'video' ? 'video' : 'image' });
        setWeOpen(false);
      }

      if (!state) {
        return React.createElement('div', { style: S.section },
          error !== null
            ? React.createElement('div', { style: S.error }, error)
            : React.createElement('div', { style: S.hint }, '加载中…'),
        );
      }

      var w = state.wallpaper;
      var themeButtons = THEME_OPTIONS.map(function (o) {
        return React.createElement('button', {
          key: o.id,
          style: S.segBtn(state.theme === o.id),
          onClick: function () { setTheme(o.id); },
        }, o.label);
      });

      // The preview element doubles as the resolution probe: for a video it is
      // already downloading and decoding the same file, so a second
      // preload="metadata" element only duplicated the transfer and decode.
      var onPreviewMeta = function (w0, h0) {
        if (w0 > 0 && h0 > 0) setDims({ w: w0, h: h0 });
      };
      var preview = null;
      if (w.enabled && w.path) {
        if (w.kind === 'video') {
          preview = React.createElement('video', {
            key: fileUrl(w.path),
            src: fileUrl(w.path),
            style: S.preview,
            muted: true,
            loop: true,
            autoPlay: true,
            playsInline: true,
            onLoadedMetadata: function (e) {
              var el = e.currentTarget;
              onPreviewMeta(el.videoWidth, el.videoHeight);
            },
            onError: function () {
              setDims(null);
              setError('视频无法播放：可能是 HEVC/H.265 编码（Chrome 不支持）或文件损坏，试试 H.264 的 MP4 / WebM。');
            },
          });
        } else {
          preview = React.createElement('img', {
            key: fileUrl(w.path),
            src: fileUrl(w.path),
            style: S.preview,
            alt: '',
            onLoad: function (e) { onPreviewMeta(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight); },
            onError: function () { setDims(null); },
          });
        }
      }

      return React.createElement('div', { style: S.section },
        error !== null && React.createElement('div', { style: S.error }, error),

        // 主题
        React.createElement('div', { style: S.card },
          React.createElement('div', { style: S.blockTitle }, '主题'),
          React.createElement('div', { style: S.row }, themeButtons),
          React.createElement('div', { style: S.hint }, 'macOS 观感：系统字体 + 半透明面板配色（配合下方"面板半透明"使用效果最佳）。'),
        ),

        // 壁纸
        React.createElement('div', { style: S.card },
          React.createElement('div', { style: S.blockTitle }, '背景壁纸'),

          React.createElement('label', { style: S.toggle },
            React.createElement('input', { type: 'checkbox', checked: w.enabled, onChange: onToggleWall }),
            '启用壁纸',
          ),

          React.createElement('div', { style: Object.assign({}, S.row, { marginTop: '10px' }) },
            React.createElement('input', { type: 'file', ref: fileRef, style: { display: 'none' }, accept: 'image/*,video/*,.gif,.webp,.mp4,.webm,.mov,.mkv', onChange: onPickFile }),
            React.createElement('button', { style: S.btn, onClick: function () { if (fileRef.current) fileRef.current.click(); } }, '选择本地文件…'),
            React.createElement('input', { style: Object.assign({}, S.input, { flex: '2' }), value: manualPath, placeholder: '或直接粘贴文件完整路径（如 D:\\…\\wallpaper.mp4）', onChange: function (e) { setManualPath(e.target.value); } }),
            React.createElement('button', { style: S.btn, onClick: onManualApply }, '应用'),
          ),
          React.createElement('div', { style: Object.assign({}, S.row, { marginTop: '10px' }) },
            React.createElement('button', { style: S.btn, onClick: openGallery }, '从素材文件夹选择…'),
          ),
          weOpen && React.createElement('div', { style: { marginTop: '10px', border: '1px solid var(--dsw-alias-border-l2, #2a3441)', borderRadius: '10px', padding: '12px' } },
            React.createElement('div', { style: Object.assign({}, S.row, { marginTop: '2px' }) },
              React.createElement('span', { style: S.sliderLabel }, '素材文件夹'),
              React.createElement('span', { style: Object.assign({}, S.hint, { flex: '1', wordBreak: 'break-all' }) }, mpkgDir || '未设置（请选择或创建存放 .mpkg 的文件夹）'),
            ),
            React.createElement('div', { style: Object.assign({}, S.row, { marginTop: '8px' }) },
              React.createElement('button', { style: S.btn, onClick: openBrowser }, '浏览文件夹…'),
              React.createElement('button', { style: S.btn, onClick: function () { setCreateMode(!createMode); } }, createMode ? '取消' : '创建新文件夹…'),
              React.createElement('button', { style: S.btn, onClick: scanWe }, weBusy ? '扫描中…' : '重新扫描'),
              mpkgDir && React.createElement('button', { style: S.btn, onClick: collectDesktopMpkg }, weBusy ? '处理中…' : '收桌面 .mpkg'),
            ),
            createMode && React.createElement('div', { style: Object.assign({}, S.row, { marginTop: '6px' }) },
              React.createElement('input', { style: Object.assign({}, S.input, { flex: '1' }), value: newFolder, placeholder: '新文件夹完整路径，如 D:\\壁纸导出\\mpkg', onChange: function (e) { setNewFolder(e.target.value); } }),
              React.createElement('button', { style: S.btn, onClick: function () { setMpkgFolder(newFolder); } }, '创建并设为目录'),
            ),
            browseOpen && React.createElement('div', { style: { marginTop: '8px', border: '1px solid var(--dsw-alias-border-l2, #2a3441)', borderRadius: '8px', padding: '8px' } },
              React.createElement('div', { style: Object.assign({}, S.row) },
                React.createElement('span', { style: Object.assign({}, S.hint, { flex: '1', wordBreak: 'break-all' }) }, '📂 ' + (browsePath || '…')),
                browseParent && React.createElement('button', { style: S.btn, onClick: function () { navTo(browseParent); } }, '⬆ 上一级'),
              ),
              browseBusy && React.createElement('div', { style: Object.assign({}, S.hint, { marginTop: '6px' }) }, '读取中…'),
              !browseBusy && React.createElement('div', { style: { marginTop: '6px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(120px,1fr))', gap: '6px', maxHeight: '180px', overflowY: 'auto' } },
                browseDirs.map(function (d) {
                  return React.createElement('button', {
                    key: d,
                    title: '进入 ' + d,
                    style: Object.assign({}, S.btn, { textAlign: 'left', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }),
                    onClick: function () { navTo(joinPath(browsePath, d)); },
                  }, '📁 ' + d);
                }),
              ),
              !browseBusy && React.createElement('div', { style: Object.assign({}, S.hint, { marginTop: '6px' }) },
                browseMpkg.length > 0
                  ? '这个文件夹里有 ' + browseMpkg.length + ' 个 .mpkg：' + browseMpkg.join('、')
                  : '这个文件夹里没有 .mpkg 文件。',
              ),
              React.createElement('div', { style: Object.assign({}, S.row, { marginTop: '8px' }) },
                React.createElement('button', { style: Object.assign({}, S.btn, { background: 'var(--dsw-alias-state-info-bg, rgba(59,130,246,.18))' }), onClick: useThisFolder }, '选这个文件夹为素材目录'),
              ),
            ),
            React.createElement('div', { style: Object.assign({}, S.hint, { marginTop: '8px' }) },
              '把图片、动图、视频直接放进这个文件夹就能在这里看到；Wallpaper Engine 导出的 .mpkg 也放这里（在 WE 里右键壁纸→发送到移动设备，导出默认落在桌面，点「收桌面 .mpkg」可一键移进来）。插件只扫这一个文件夹。',
            ),
            weInfo !== null && React.createElement('div', { style: Object.assign({}, S.hint, { marginTop: '8px', color: 'var(--dsw-alias-state-success-primary, #34d399)' }) }, weInfo),
            weErr !== null && React.createElement('div', { style: Object.assign({}, S.error, { margin: '8px 0 0' }) }, weErr),
            weItems !== null && React.createElement('div', { style: { marginTop: '10px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(96px,1fr))', gap: '8px', maxHeight: '260px', overflowY: 'auto' } },
              weItems.map(function (item) {
                return React.createElement('button', {
                  key: item.id,
                  title: item.title + (item.files && item.files.length ? '\n包含：' + item.files.join(', ') : ''),
                  style: { position: 'relative', border: '1px solid var(--dsw-alias-border-l2, #2a3441)', borderRadius: '8px', overflow: 'hidden', padding: '0', cursor: 'pointer', background: 'var(--dsw-alias-bg-layer-2, #1f2937)' },
                  onClick: function () { pickWe(item); },
                },
                  // 两类来源各给一个角标，避免用户以为普通文件没被识别。
                  React.createElement('div', {
                    style: {
                      position: 'absolute', top: '2px', right: '2px', zIndex: 2, fontSize: '9px',
                      lineHeight: '1', padding: '2px 4px', borderRadius: '4px',
                      background: item.fromMpkg ? '#3b82f6' : '#6b7280',
                      color: '#fff',
                    },
                  }, item.fromMpkg ? '高清' : (item.kind === 'video' ? '视频' : '图片')),
                  item.preview
                    ? React.createElement('img', { src: fileUrl(item.preview), alt: '', loading: 'lazy', style: { width: '100%', height: '64px', objectFit: 'cover', display: 'block' } })
                    : React.createElement('div', { style: { height: '64px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, #9ca3af)', padding: '4px' } }, item.title),
                  React.createElement('div', { style: { fontSize: '10px', padding: '3px 4px', color: 'var(--dsw-alias-label-tertiary, #9ca3af)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, item.title),
                );
              }),
            ),
            weItems !== null && weItems.length === 0 && !weBusy && React.createElement('div', { style: Object.assign({}, S.hint, { marginTop: '8px' }) },
              weNeedsFolder
                ? '还没设置素材目录。选一个已有文件夹或创建新文件夹，把壁纸放进去即可——图片(jpg/png/webp)、动图(gif)、视频(mp4/webm/mov/mkv)和 Wallpaper Engine 的 .mpkg 导出包都能识别。'
                : '这个文件夹里还没有可用的壁纸。支持图片(jpg/png/webp)、动图(gif)、视频(mp4/webm/mov/mkv)，以及 Wallpaper Engine 导出的 .mpkg。',
            ),
            weSkipped.length > 0 && React.createElement('div', { style: Object.assign({}, S.hint, { marginTop: '8px', color: 'var(--dsw-alias-state-warning-primary, #f59e0b)' }) },
              '已跳过 ' + weSkipped.length + ' 个（没有可用渲染视频）：' + weSkipped.map(function (s) { return s.file + '（' + s.reason + '）'; }).join('；'),
            ),
          ),
          w.enabled && w.path
            ? React.createElement('div', { style: S.pathText }, '当前：' + w.path)
            : React.createElement('div', { style: S.hint }, '支持静态图(jpg/png/webp)、动图(GIF/WebP)、视频(mp4/webm/mov/mkv)；可指向任意本地路径，包括 Wallpaper Engine 的壁纸库目录。'),

          preview,

          w.enabled && w.path && dims
            ? React.createElement('div', { style: Object.assign({}, S.pathText, { marginTop: '6px', color: dims.w < viewport.w * 0.6 || dims.h < viewport.h * 0.6 ? 'var(--dsw-alias-state-warning-primary, #f59e0b)' : 'var(--dsw-alias-label-tertiary, #9ca3af)' }) },
                '分辨率：' + dims.w + '×' + dims.h + (dims.w < viewport.w * 0.6 || dims.h < viewport.h * 0.6
                  ? '（低于你的窗口 ' + viewport.w + '×' + viewport.h + '，放大后清晰度不足，建议选更高清的素材，或用 4K 视频）'
                  : '（足够清晰）'))
            : null,

          React.createElement('div', { style: Object.assign({}, S.sliderRow, { marginTop: '12px' }) },
            React.createElement('span', { style: S.sliderLabel }, '壁纸暗化'),
            React.createElement('input', { type: 'range', min: '0', max: '100', step: '1', value: Math.round(w.dim * 100), onChange: onDim, style: S.range }),
            React.createElement('span', { style: S.sliderValue }, Math.round(w.dim * 100) + '%'),
          ),
          React.createElement('div', { style: Object.assign({}, S.sliderRow, { marginTop: '10px' }) },
            React.createElement('span', { style: S.sliderLabel }, '面板半透明'),
            React.createElement('input', {
              type: 'range', min: '0', max: '100', step: '1',
              value: Math.round(w.panelOpacity * 100),
              onChange: onPanel,
              style: Object.assign({}, S.range, safeZoneStyle(swatches, w.dim, WCAG_AA)),
              title: panelSafeTitle(swatches, w.dim),
            }),
            React.createElement('span', { style: S.sliderValue }, Math.round(w.panelOpacity * 100) + '%'),
          ),

          // Contrast readout (方案 5). Recomputes on every slider move because
          // `w` comes from the already-merged local state, so the number tracks
          // the drag without waiting for the debounced save.
          (function () {
            if (swatches === null) {
              return React.createElement('div', { style: Object.assign({}, S.hint, { marginTop: '8px' }) }, '正在测量壁纸对比度…');
            }
            if (swatches === false) {
              return React.createElement('div', { style: Object.assign({}, S.hint, { marginTop: '8px' }) },
                '无法读取这张壁纸的像素（可能是编码不受支持或画布受限），所以无法给出对比度参考。');
            }
            var ratio = worstContrast(swatches, w.dim, w.panelOpacity);
            var level = ratio >= WCAG_AA ? 'good' : (ratio >= WCAG_AA_LARGE ? 'warn' : 'bad');
            var tone = {
              good: { border: 'var(--dsw-alias-state-success-primary, #34d399)', color: 'var(--dsw-alias-state-success-primary, #34d399)' },
              warn: { border: 'var(--dsw-alias-state-warn-primary, #f59e0b)', color: 'var(--dsw-alias-state-warn-primary, #f59e0b)' },
              bad: { border: 'var(--dsw-alias-state-error-primary, #ef4444)', color: 'var(--dsw-alias-state-error-primary, #ef4444)' },
            }[level];
            var advice = level === 'good'
              ? '文字清晰可读。'
              : (level === 'warn'
                ? '仅大号文字够清晰，正文偏吃力：把「面板半透明」调高一些，或加大「壁纸暗化」。'
                : '文字会看不清：调高「面板半透明」，或加大「壁纸暗化」；也可以保持「文字描边保护」开启。');
            return React.createElement('div',
              { style: Object.assign({}, S.readout, { marginTop: '10px', borderColor: tone.border, color: tone.color }) },
              React.createElement('div', { style: { fontWeight: 600 } },
                '最低对比度 ' + ratio.toFixed(2) + ' : 1',
                React.createElement('span', { style: S.swatch, backgroundColor: tone.color }),
                React.createElement('span', { style: { fontWeight: 400, opacity: 0.75 } },
                  '（AA 正文需 ' + WCAG_AA + ' : 1）'),
              ),
              React.createElement('div', { style: { marginTop: '2px', opacity: 0.9 } }, advice),
            );
          })(),
          React.createElement('div', { style: Object.assign({}, S.row, { marginTop: '10px' }) },
            React.createElement('span', { style: S.sliderLabel }, '对齐方式'),
            React.createElement('div', { style: S.seg },
              FIT_OPTIONS.map(function (opt) {
                return React.createElement('button', {
                  key: opt.id,
                  onClick: function () { setWall({ fit: opt.id }); },
                  style: S.segBtn((w.fit || 'cover') === opt.id),
                }, opt.label);
              }),
            ),
          ),
          React.createElement('div', { style: Object.assign({}, S.hint, { marginTop: '8px' }) },
            '对齐方式：覆盖=铺满并裁掉超出部分；填充=整图完整显示（可能留边）；拉伸=变形铺满；自由=原始尺寸。',
          ),
          React.createElement('div', { style: Object.assign({}, S.hint, { marginTop: '8px' }) },
            '面板半透明影响页面表面透出壁纸的程度（过低可能导致文字不好读，用"壁纸暗化"找平衡）。',
          ),

          React.createElement('label', { style: Object.assign({}, S.toggle, { marginTop: '12px' }) },
            React.createElement('input', { type: 'checkbox', checked: w.textProtect !== false, onChange: onToggleTextProtect }),
            '文字描边保护（推荐开启）',
          ),
          React.createElement('div', { style: Object.assign({}, S.hint, { marginTop: '6px' }) },
            '给对话和输入框的文字加一圈极淡的光晕：无论壁纸是浅色的天空还是深色的山，字都立得住。它不占用布局、不改变字号，也不影响壁纸的透明度；觉得文字发毛可以关掉。',
          ),
        ),

        // 壁纸轮换
        (function () {
          var rotate = Object.assign({}, ROTATE_DEFAULT(), state.rotate || {});
          var list = Array.isArray(rotate.playlist) ? rotate.playlist : [];
          var modeOn = rotate.mode === 'sequential' || rotate.mode === 'random';
          var canRotate = list.length >= 2;
          var intervalLabel = rotate.minutes >= 60
            ? (Math.floor(rotate.minutes / 60) + ' 小时' + (rotate.minutes % 60 ? ' ' + (rotate.minutes % 60) + ' 分' : ''))
            : (rotate.minutes + ' 分钟');
          return React.createElement('div', { style: S.card },
            React.createElement('div', { style: S.blockTitle }, '壁纸轮换'),
            React.createElement('div', { style: S.row },
              ROTATE_OPTIONS.map(function (opt) {
                return React.createElement('button', {
                  key: opt.id,
                  onClick: function () { setRotate({ mode: opt.id }); },
                  style: S.segBtn(rotate.mode === opt.id),
                }, opt.label);
              }),
            ),

            modeOn && React.createElement('div', { style: Object.assign({}, S.sliderRow, { marginTop: '12px' }) },
              React.createElement('span', { style: S.sliderLabel }, '轮换间隔'),
              React.createElement('input', {
                type: 'number', min: '1', max: String(MAX_ROTATE_MINUTES), step: '1',
                value: String(rotate.minutes),
                onChange: onRotateMinutes,
                style: S.num,
              }),
              React.createElement('span', { style: Object.assign({}, S.hint, { margin: '0' }) }, '分钟（1 分钟 ~ 24 小时）'),
            ),
            modeOn && React.createElement('div', { style: Object.assign({}, S.hint, { marginTop: '6px' }) },
              '当前每 ' + intervalLabel + ' 换一张。' +
              (rotate.mode === 'sequential' ? '顺序轮换：按下面的列表自上而下依次切换。' : '随机轮换：每次随机挑一张，且不会连续重复同一张。')
            ),

            // 列表
            React.createElement('div', { style: Object.assign({}, S.row, { marginTop: '12px' }) },
              React.createElement('span', { style: S.sliderLabel }, '轮换列表'),
              React.createElement('span', { style: Object.assign({}, S.hint, { margin: '0', flex: '1' }) }, list.length + ' 张'),
            ),
            list.length === 0
              ? React.createElement('div', { style: Object.assign({}, S.hint, { marginTop: '6px' }) },
                  '列表为空。把想轮换的壁纸加进来：先设成当前壁纸再点「加入当前壁纸」，或用「粘贴多个路径」批量添加，也可以从上面的 .mpkg 画廊一键全加。')
              : React.createElement('div', { style: S.playlist },
                  list.map(function (p, i) {
                    var isCurrent = state.wallpaper && state.wallpaper.path === p;
                    return React.createElement('div', { key: p + i, style: S.playlistRow },
                      React.createElement('span', { style: Object.assign({}, S.hint, { margin: '0', width: '22px', textAlign: 'right' }) }, String(i + 1)),
                      React.createElement('span', { style: Object.assign({}, S.playlistName, isCurrent ? { color: 'var(--dsw-alias-state-success-primary, #34d399)' } : null), title: p },
                        baseName(p) + (isCurrent ? '（当前）' : '')),
                      React.createElement('button', { style: Object.assign({}, S.btn, { padding: '2px 7px', fontSize: '11px' }), title: '上移', onClick: function () { movePlaylistItem(i, -1); } }, '↑'),
                      React.createElement('button', { style: Object.assign({}, S.btn, { padding: '2px 7px', fontSize: '11px' }), title: '下移', onClick: function () { movePlaylistItem(i, 1); } }, '↓'),
                      React.createElement('button', { style: Object.assign({}, S.btn, { padding: '2px 7px', fontSize: '11px' }), title: '设为当前壁纸', onClick: function () { setWall({ path: p, enabled: true, kind: /\.(mp4|webm|mov|mkv)$/i.test(p) ? 'video' : 'image' }); } }, '用'),
                      React.createElement('button', { style: Object.assign({}, S.btn, { padding: '2px 7px', fontSize: '11px' }), title: '从列表移除', onClick: function () { removeFromPlaylist(i); } }, '✕'),
                    );
                  }),
                ),

            React.createElement('div', { style: Object.assign({}, S.row, { marginTop: '10px' }) },
              React.createElement('button', { style: S.btn, onClick: addCurrentWallpaper }, '加入当前壁纸'),
              React.createElement('button', { style: S.btn, onClick: function () { setShowPaste(!showPaste); } }, showPaste ? '取消粘贴' : '粘贴多个路径…'),
              weItems && weItems.length > 0 && React.createElement('button', { style: S.btn, onClick: addGalleryToPlaylist }, '把画廊全部加入'),
              list.length > 0 && React.createElement('button', { style: S.btn, onClick: function () { setRotate({ playlist: [], cursor: 0 }); } }, '清空列表'),
            ),
            showPaste && React.createElement('div', { style: { marginTop: '8px' } },
              React.createElement('textarea', {
                value: pasteText,
                onChange: function (e) { setPasteText(e.target.value); },
                placeholder: '每行一个壁纸的完整路径，例如：\nD:\\壁纸\\a.mp4\nD:\\壁纸\\b.jpg',
                rows: 4,
                style: Object.assign({}, S.input, { width: '100%', fontFamily: 'inherit', resize: 'vertical' }),
              }),
              React.createElement('div', { style: Object.assign({}, S.row, { marginTop: '6px' }) },
                React.createElement('button', { style: S.btn, onClick: applyPasteList }, '加入列表'),
              ),
            ),

            modeOn && !canRotate && React.createElement('div', { style: Object.assign({}, S.hint, { marginTop: '8px', color: 'var(--dsw-alias-state-warn-primary, #f59e0b)' }) },
              '轮换至少需要列表里有 2 张壁纸；当前只有 ' + list.length + ' 张，所以暂时不会切换。'
            ),
          );
        })(),

        // 动态壁纸省电
        React.createElement('div', { style: S.card },
          React.createElement('label', { style: S.toggle },
            React.createElement('input', { type: 'checkbox', checked: w.autopause !== false, onChange: onToggleAutoPause }),
            '视频壁纸失焦自动暂停（省电）',
          ),
          React.createElement('div', { style: S.hint }, '窗口最小化或切到其他软件时，视频壁纸自动暂停；回到窗口时恢复播放。'),
        ),
      );
    }

    // ---- plugin entry ----
    // Cordis `inject` is a plain array of service names; a listed service is
    // required for activation, so `theme` is resolved softly through
    // ctx.inject([...], cb) instead: a host without dsh-client-ui-theme keeps
    // the stylesheet fallback rather than failing to activate. `slots` stays
    // required because the settings section cannot render without it.
    function apply(ctx) {
      var slots = ctx.get('slots');
      if (slots !== undefined) {
        slots.inject('settings.section', function () {
          return slots.register(
            { name: 'settings.section', id: 'theme-wallpaper', order: 30, label: function () { return '主题与壁纸'; } },
            function (props) { return React.createElement(ThemeWallpaperSection, { close: props.close }); },
          );
        });
      }
      // Bind the host Theme service as an optional dependency: the callback runs
      // whenever `theme` becomes available and is disposed when it goes away.
      if (typeof ctx.inject === 'function') {
        ctx.inject(['theme'], function (scope) {
          themeService = (scope && scope.get ? scope.get('theme') : null) || null;
          if (latestState) applyPalette(themeService, latestState);
          return function () {
            themeService = null;
            if (disposePalette !== null) { disposePalette(); disposePalette = null; }
          };
        });
      }
      // Apply persisted state as soon as the page is up (before settings opens).
      // Retry a few times in case the host routes register a beat after the client.
      var bootAttempts = 0;
      (function bootLoad() {
        loadState().then(applyThemeWallpaper).catch(function () {
          bootAttempts++;
          if (bootAttempts < 5) setTimeout(bootLoad, 1500);
        });
      })();
      // Every page-level resource is owned by an effect so unloading the plugin
      // removes it: the focus listeners, the theme observer, the palette override
      // and the wallpaper layer/shade elements.
      var effect = typeof ctx.effect === 'function' ? ctx.effect.bind(ctx) : function (fn) { return fn(); };
      effect(function () { return installAutoPauseListeners(); }, 'theme-wallpaper: auto-pause listeners');
      effect(function () { return installThemeObserver(); }, 'theme-wallpaper: theme observer');
      effect(function () {
        // The rotation timer would otherwise keep rotating wallpapers behind a
        // plugin the user has already turned off.
        return function () { clearRotation(); };
      }, 'theme-wallpaper: rotation timer');
      effect(function () {
        return function () {
          if (disposePalette !== null) { disposePalette(); disposePalette = null; }
        };
      }, 'theme-wallpaper: palette override disposal');
      effect(function () {
        return function () {
          var layer = document.getElementById(LAYER_ID);
          if (layer) layer.remove();
          var dim = document.getElementById(DIM_ID);
          if (dim) dim.remove();
          var style = document.getElementById(STYLE_ID);
          if (style) style.remove();
          currentVideo = null;
        };
      }, 'theme-wallpaper: layer teardown');
    }

    exports.name = 'theme-wallpaper';
    exports.inject = ['slots'];
    exports.apply = apply;
    return module.exports;
  },
});
