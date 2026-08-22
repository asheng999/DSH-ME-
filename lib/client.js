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

    // ---- stylesheet: wallpaper layer + translucent surfaces + macos theme ----
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
      const dark = document.body.hasAttribute('data-ds-dark-theme');
      const base = dark ? '17,17,20' : '246,246,248';
      const panel = w.panelOpacity;
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
            '--dsw-alias-bg-layer-1:transparent;' +
            '--dsw-alias-bg-layer-2:rgba(' + base + ',' + alpha(panel * 0.97) + ');' +
            '--dsw-alias-bg-layer-3:rgba(' + base + ',' + alpha(panel * 0.98) + ');' +
            '--dsw-alias-bg-overlay:rgba(' + base + ',' + alpha(panel * 0.99) + ')}',
        );
      }
      if (state.theme === 'macos') {
        rules.push(
          'body[data-dsh-theme-wallpaper="macos"]{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Microsoft YaHei",system-ui,sans-serif}',
        );
      }
      style.textContent = rules.join('\n');
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
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
      window.addEventListener('blur', onBlur);
      window.addEventListener('focus', onFocus);
    }

    // ---- apply the full state to the page ----
    function applyThemeWallpaper(state) {
      latestState = state;
      document.body.dataset.dshThemeWallpaper = state.theme;
      autopauseEnabled = state.wallpaper.autopause !== false;
      ensureStyle(state);
      ensureLayer(state);
    }

    // Rebuild the translucent palette when the app's dark/light theme changes later.
    if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
      const themeObserver = new MutationObserver(function () {
        if (latestState) ensureStyle(latestState);
      });
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-ds-dark-theme'] });
      themeObserver.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] });
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

      // 测量当前壁纸素材的真实分辨率，用于提示是否会被放大导致模糊
      React.useEffect(function () {
        var alive = true;
        var wp = state && state.wallpaper && state.wallpaper.enabled && state.wallpaper.path ? state.wallpaper : null;
        if (!wp) { setDims(null); return; }
        setDims(null);
        if (wp.kind === 'video') {
          var v = document.createElement('video');
          v.preload = 'metadata';
          v.muted = true;
          v.onloadedmetadata = function () { if (alive) setDims({ w: v.videoWidth, h: v.videoHeight }); };
          v.onerror = function () { if (alive) setDims(null); };
          v.src = fileUrl(wp.path);
        } else {
          var im = new Image();
          im.onload = function () { if (alive) setDims({ w: im.naturalWidth, h: im.naturalHeight }); };
          im.onerror = function () { if (alive) setDims(null); };
          im.src = fileUrl(wp.path);
        }
        return function () { alive = false; };
      }, [state && state.wallpaper ? state.wallpaper.path + '|' + state.wallpaper.kind + '|' + state.wallpaper.enabled : '']);

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

      function commit(next) {
        setError(null);
        var merged = Object.assign({}, state, next, { we: state.we || { dir: '', mpkgDir: '' } });
        saveState(merged).then(function (saved) {
          setState(saved);
          setManualPath(saved.wallpaper.path);
        }).catch(function (e) {
          setError(String(e && e.message ? e.message : e));
        });
      }
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
      function setWall(patch) {
        if (state) commit({ theme: state.theme, wallpaper: Object.assign({}, state.wallpaper, patch) });
      }
      function onPickFile(e) {
        var input = e.target;
        var file = input && input.files && input.files[0];
        input.value = '';
        if (!file) return;
        var p = file.path || '';
        if (p) {
          var isVideo = (/.(mp4|webm|mov|mkv)$/i.test(p)) || (typeof file.type === 'string' && file.type.indexOf('video/') === 0);
          setWall({ path: p, enabled: true, kind: isVideo ? 'video' : 'image' });
        } else {
          setError('桌面端可直接选文件；浏览器里请用下面的路径输入框手动粘贴完整路径。');
        }
      }
      function onManualApply() {
        var p = (manualPath || '').trim();
        if (!p) { setError('请输入壁纸文件的完整路径。'); return; }
        var isVideo = /.(mp4|webm|mov|mkv)$/i.test(p);
        setWall({ path: p, enabled: true, kind: isVideo ? 'video' : 'image' });
      }
      function onToggleWall(e) {
        setWall({ enabled: e.target.checked });
      }
      function onToggleAutoPause(e) {
        setWall({ autopause: e.target.checked });
      }
      function onDim(e) {
        setWall({ dim: Number(e.target.value) / 100 });
      }
      function onPanel(e) {
        setWall({ panelOpacity: Number(e.target.value) / 100 });
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

      var preview = null;
      if (w.enabled && w.path) {
        if (w.kind === 'video') {
          preview = React.createElement('video', {
            src: fileUrl(w.path),
            style: S.preview,
            muted: true,
            loop: true,
            autoPlay: true,
            playsInline: true,
            onError: function () {
              setError('视频无法播放：可能是 HEVC/H.265 编码（Chrome 不支持）或文件损坏，试试 H.264 的 MP4 / WebM。');
            },
          });
        } else {
          preview = React.createElement('img', { src: fileUrl(w.path), style: S.preview, alt: '' });
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
            React.createElement('button', { style: S.btn, onClick: openGallery }, '从 WE 导出包(.mpkg)选择…'),
          ),
          weOpen && React.createElement('div', { style: { marginTop: '10px', border: '1px solid var(--dsw-alias-border-l2, #2a3441)', borderRadius: '10px', padding: '12px' } },
            React.createElement('div', { style: Object.assign({}, S.row, { marginTop: '2px' }) },
              React.createElement('span', { style: S.sliderLabel }, '导出目录'),
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
                React.createElement('button', { style: Object.assign({}, S.btn, { background: 'var(--dsw-alias-state-info-bg, rgba(59,130,246,.18))' }), onClick: useThisFolder }, '选这个文件夹为导出目录'),
              ),
            ),
            React.createElement('div', { style: Object.assign({}, S.hint, { marginTop: '8px' }) },
              '在 Wallpaper Engine 里右键壁纸→发送到移动设备，导出的 .mpkg 会落在桌面。点「收桌面 .mpkg」把它们移进上面这个文件夹，插件只扫这里，桌面不会堆满文件。',
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
                  item.fromMpkg && React.createElement('div', { style: { position: 'absolute', top: '2px', right: '2px', zIndex: 2, fontSize: '9px', lineHeight: '1', padding: '2px 4px', borderRadius: '4px', background: '#3b82f6', color: '#fff' } }, '高清'),
                  item.preview
                    ? React.createElement('img', { src: fileUrl(item.preview), alt: '', loading: 'lazy', style: { width: '100%', height: '64px', objectFit: 'cover', display: 'block' } })
                    : React.createElement('div', { style: { height: '64px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, #9ca3af)', padding: '4px' } }, item.title),
                  React.createElement('div', { style: { fontSize: '10px', padding: '3px 4px', color: 'var(--dsw-alias-label-tertiary, #9ca3af)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, item.title),
                );
              }),
            ),
            weItems !== null && weItems.length === 0 && !weBusy && React.createElement('div', { style: Object.assign({}, S.hint, { marginTop: '8px' }) },
              weNeedsFolder
                ? '还没设置导出目录。选一个已有文件夹或创建新文件夹，再把 WE 导出的 .mpkg 放进去。你桌面上已有的 .mpkg：可把导出目录设为桌面，或把文件移进新文件夹。'
                : '这个文件夹里还没有 .mpkg。去 Wallpaper Engine 里右键壁纸→发送到移动设备，把导出的 .mpkg 放进这个文件夹，高清动态壁纸就会出现在这里。',
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
            ? React.createElement('div', { style: Object.assign({}, S.pathText, { marginTop: '6px', color: dims.w < window.innerWidth * 0.6 || dims.h < window.innerHeight * 0.6 ? 'var(--dsw-alias-state-warning-primary, #f59e0b)' : 'var(--dsw-alias-label-tertiary, #9ca3af)' }) },
                '分辨率：' + dims.w + '×' + dims.h + (dims.w < window.innerWidth * 0.6 || dims.h < window.innerHeight * 0.6
                  ? '（低于你的窗口 ' + window.innerWidth + '×' + window.innerHeight + '，放大后清晰度不足，建议选更高清的素材，或用 4K 视频）'
                  : '（足够清晰）'))
            : null,

          React.createElement('div', { style: Object.assign({}, S.sliderRow, { marginTop: '12px' }) },
            React.createElement('span', { style: S.sliderLabel }, '壁纸暗化'),
            React.createElement('input', { type: 'range', min: '0', max: '100', step: '1', value: Math.round(w.dim * 100), onChange: onDim, style: S.range }),
            React.createElement('span', { style: S.sliderValue }, Math.round(w.dim * 100) + '%'),
          ),
          React.createElement('div', { style: Object.assign({}, S.sliderRow, { marginTop: '10px' }) },
            React.createElement('span', { style: S.sliderLabel }, '面板半透明'),
            React.createElement('input', { type: 'range', min: '0', max: '100', step: '1', value: Math.round(w.panelOpacity * 100), onChange: onPanel, style: S.range }),
            React.createElement('span', { style: S.sliderValue }, Math.round(w.panelOpacity * 100) + '%'),
          ),
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
        ),

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
      // Apply persisted state as soon as the page is up (before settings opens).
      // Retry a few times in case the host routes register a beat after the client.
      var bootAttempts = 0;
      (function bootLoad() {
        loadState().then(applyThemeWallpaper).catch(function () {
          bootAttempts++;
          if (bootAttempts < 5) setTimeout(bootLoad, 1500);
        });
      })();
    }

    exports.name = 'theme-wallpaper';
    exports.apply = apply;
    return module.exports;
  },
});
