/**
 * watermark-from-params — preview watermark via engine SetProperties (watermark_on_draw).
 * Reads plugins.options.watermark; see WATERMARK_SCHEMES.zh-CN.md.
 * Optional DOM modes: useDomOverlay (viewport), usePageOverlay (per-page sync).
 */
(function (window) {
  'use strict';

  var LAYER_ID = 'oo-plugin-watermark-params-layer';
  var LAYER_Z = 3;
  var POLL_MS = 40;
  var POLL_MAX = 80;
  var KEEPALIVE_MS = 800;

  var cachedWm = null;
  var overlayState = null;
  var keepAliveTimer = null;
  var docReady = false;
  var editMode = false;
  var applied = false;

  // --- config ---

  function pluginInfo() {
    return (window.Asc && window.Asc.plugin && window.Asc.plugin.info) || null;
  }

  function getCfg() {
    var info = pluginInfo();
    if (info) {
      var wm = (info.options || info).watermark;
      if (wm && wm.watermarkItems && wm.watermarkItems.length) {
        cachedWm = wm;
        return wm;
      }
    }
    return cachedWm;
  }

  function isViewMode() {
    var info = pluginInfo();
    return !!(info && info.isViewMode);
  }

  function editorType() {
    var info = pluginInfo();
    return (info && info.editorType) || 'word';
  }

  function num(v, d) {
    if (v === undefined || v === null || v === '') return d;
    var n = parseFloat(v, 10);
    return isNaN(n) ? d : n;
  }

  function parseRgb(hex) {
    if (!hex || typeof hex !== 'string') return { r: 128, g: 128, b: 128 };
    var m = hex.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!m) return { r: 128, g: 128, b: 128 };
    var h = m[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return {
      r: parseInt(h.substr(0, 2), 16),
      g: parseInt(h.substr(2, 2), 16),
      b: parseInt(h.substr(4, 2), 16),
    };
  }

  function wmOpacity(wm) {
    var items = wm.watermarkItems || [];
    var o = num(wm.opacity, 0.12);
    for (var i = 0; i < items.length; i++) {
      if (String((items[i] || {}).type || 'text').toLowerCase() === 'text') {
        return num(items[i].opacity, o);
      }
    }
    return o;
  }

  /** Physical page size and raster size for watermark_on_draw (aligned with settings plugin). */
  function getPageSettings(type) {
    if (type === 'slide') {
      return { widthMm: 338.7, heightMm: 190.5, imageWidth: 1280, imageHeight: 720 };
    }
    return { widthMm: 210, heightMm: 297, imageWidth: 1000, imageHeight: 1414 };
  }

  // --- watermark block (multi-line text + images) ---

  function buildRows(wm, cb, doc) {
    doc = doc || document;
    var items = wm.watermarkItems || [];
    var rows = [];
    var i = 0;

    function next() {
      if (i >= items.length) {
        cb(rows);
        return;
      }
      var it = items[i++] || {};
      if (String(it.type || 'text').toLowerCase() === 'image') {
        var src = it.data || it.image;
        var im = new ((doc.defaultView || window).Image || Image)();
        im.crossOrigin = 'anonymous';
        im.onload = function () {
          rows.push({ kind: 'img', w: im.naturalWidth, h: im.naturalHeight, img: im });
          next();
        };
        im.onerror = next;
        im.src = src || '';
        if (!src) next();
      } else {
        var fs = num(it.fontSize, 18);
        var ff = it.fontFamily || it['font-family'] || 'Arial';
        var lines = String(it.value != null ? it.value : '').split(/\r?\n/);
        var lh = fs * 1.25;
        var c = doc.createElement('canvas').getContext('2d');
        c.font = 'normal ' + fs + 'px ' + ff;
        var maxW = 0;
        for (var li = 0; li < lines.length; li++) {
          var tw = c.measureText(lines[li]).width;
          if (tw > maxW) maxW = tw;
        }
        rows.push({
          kind: 'txt',
          lines: lines,
          fs: fs,
          lh: lh,
          w: maxW,
          h: lines.length * lh,
          ff: ff,
          color: it.color || '#808080',
          opacity: num(it.opacity, num(wm.opacity, 0.12)),
        });
        next();
      }
    }
    next();
  }

  function measureBlock(rows, padX, padY, rotDeg) {
    var maxW = 0;
    var totalH = 0;
    for (var j = 0; j < rows.length; j++) {
      var r = rows[j];
      if (r.w > maxW) maxW = r.w;
      totalH += r.h + (j < rows.length - 1 ? (r.kind === 'img' ? 6 : 4) : 0);
    }
    return {
      maxW: maxW,
      totalH: totalH,
      rot: -rotDeg * Math.PI / 180,
      tileW: maxW + padX,
      tileH: totalH + padY,
    };
  }

  function paintBlock(ctx, rows, blockW) {
    blockW = blockW > 0 ? blockW : 0;
    var y = 0;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.kind === 'img') {
        ctx.drawImage(r.img, (blockW > r.w ? (blockW - r.w) / 2 : 0), y, r.w, r.h);
        y += r.h + 6;
      } else {
        var rgb = parseRgb(r.color);
        ctx.fillStyle = 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + r.opacity + ')';
        ctx.font = 'normal ' + r.fs + 'px ' + r.ff;
        ctx.textBaseline = 'top';
        ctx.textAlign = 'center';
        var cx = blockW / 2;
        for (var li = 0; li < r.lines.length; li++) {
          ctx.fillText(r.lines[li], cx, y + li * r.lh);
        }
        ctx.textAlign = 'left';
        y += r.h + 4;
      }
    }
  }

  /**
   * Draw one watermark block centered on (cx, cy), then rotate about that center.
   * Grid cell (0,0) uses center (tileW/2, tileH/2) → unrotated block top-left at
   * (horizontal/2, vertical/2) since tileW = maxW + horizontal (same for vertical).
   */
  function drawTile(ctx, cx, cy, rows, m) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(m.rot);
    ctx.translate(-m.maxW / 2, -m.totalH / 2);
    paintBlock(ctx, rows, m.maxW);
    ctx.restore();
  }

  /** Build full-page PNG: tile grid or single center (layout === 'center'). */
  function createPageFillImage(wm, page, rows, m, cb) {
    var lay = String(wm.layout || '').toLowerCase();
    var canvas = document.createElement('canvas');
    canvas.width = page.imageWidth;
    canvas.height = page.imageHeight;
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (lay === 'center') {
      ctx.save();
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate(m.rot);
      ctx.translate(-m.maxW / 2, -m.totalH / 2);
      paintBlock(ctx, rows, m.maxW);
      ctx.restore();
    } else {
      // Pitch = content + spacing; cell(0,0) center → block starts at spacing/2 from page origin.
      var tw = m.tileW;
      var th = m.tileH;
      for (var y = -th; y < canvas.height + th; y += th) {
        for (var x = -tw; x < canvas.width + tw; x += tw) {
          drawTile(ctx, x + tw / 2, y + th / 2, rows, m);
        }
      }
    }

    try {
      cb(canvas.toDataURL('image/png'));
    } catch (e) {
      cb(null);
    }
  }

  function emptyWatermarkJson(page) {
    // Omit stroke / stroke-width: CWatermarkOnDraw treats stroke-width:0 as a pen,
    // and AddSmartRect expands 0-width pens to 1px black borders around the watermark rect.
    return JSON.stringify({
      transparent: 0,
      type: 'none',
      width: page.widthMm,
      height: page.heightMm,
      rotate: 0,
      margins: [0, 0, 0, 0],
      fill: [],
      align: 1,
      paragraphs: [{
        align: 2,
        fill: [],
        linespacing: 1,
        runs: [{ text: ' ', fill: [], 'font-family': 'Arial', 'font-size': 1, bold: false, italic: false, strikeout: false, underline: false }],
      }],
    });
  }

  function buildWatermarkJson(wm, fillUrl, page) {
    return JSON.stringify({
      transparent: num(wm.transparent, Math.max(wmOpacity(wm), 0.68)),
      type: 'rect',
      width: page.widthMm,
      height: page.heightMm,
      rotate: 0,
      margins: [0, 0, 0, 0],
      fill: fillUrl,
      align: 1,
      paragraphs: [{
        align: 2,
        fill: [],
        linespacing: 1,
        runs: [{ text: ' ', fill: [], 'font-family': 'Arial', 'font-size': 1, bold: false, italic: false, strikeout: false, underline: false }],
      }],
    });
  }

  function setProperties(watermarkJson, done) {
    if (!window.Asc || !window.Asc.plugin || !window.Asc.plugin.executeMethod) {
      if (done) done(false);
      return;
    }
    window.Asc.plugin.executeMethod(
      'SetProperties',
      [{ copyoutenabled: false, watermark_on_draw: watermarkJson }],
      function () {
        if (done) done(true);
      }
    );
  }

  function closePlugin() {
    if (window.Asc && window.Asc.plugin && window.Asc.plugin.executeCommand) {
      window.Asc.plugin.executeCommand('close', '');
    }
  }

  function applyEngineWatermark(wm, done) {
    var page = getPageSettings(editorType());
    buildRows(wm, function (rows) {
      if (!rows.length) {
        if (done) done(false);
        return;
      }
      var m = measureBlock(rows, num(wm.horizontal, 50), num(wm.vertical, 100), num(wm.rotation, 45));
      createPageFillImage(wm, page, rows, m, function (fillUrl) {
        if (!fillUrl) {
          if (done) done(false);
          return;
        }
        setProperties(buildWatermarkJson(wm, fillUrl, page), done);
      });
    }, document);
  }

  function clearEngineWatermark(done) {
    setProperties(emptyWatermarkJson(getPageSettings(editorType())), done);
  }

  // --- DOM overlay fallback (useDomOverlay / usePageOverlay) ---

  function editorDoc() {
    try {
      var p = window.parent;
      if (p && p !== window && p.document) {
        var d = p.document;
        if (d.getElementById('editor_sdk') || d.getElementById('id_viewer')) return d;
      }
    } catch (e) {}
    var w = window;
    while (w) {
      try {
        var doc = w.document;
        if (doc && (doc.getElementById('editor_sdk') || doc.getElementById('id_viewer'))) return doc;
      } catch (err) {}
      if (!w.parent || w.parent === w) break;
      w = w.parent;
    }
    return null;
  }

  function resolveEditorShell(doc) {
    if (!doc) return null;
    var sdk = doc.getElementById('editor_sdk');
    if (sdk && sdk.clientWidth >= 64 && sdk.clientHeight >= 64) return sdk;
    var main = doc.getElementById('id_main');
    if (main && main.clientWidth >= 64 && main.clientHeight >= 64) return main;
    return sdk || main || doc.getElementById('editor-container') || doc.getElementById('id_viewer');
  }

  function drawTiledDom(ctx, W, H, rows, m, singleCenter) {
    var off = document.createElement('canvas');
    off.width = Math.ceil(m.maxW);
    off.height = Math.ceil(m.totalH);
    paintBlock(off.getContext('2d'), rows, m.maxW);
    ctx.clearRect(0, 0, W, H);
    if (singleCenter) {
      ctx.save();
      ctx.translate(W / 2, H / 2);
      ctx.rotate(m.rot);
      ctx.drawImage(off, -m.maxW / 2, -m.totalH / 2);
      ctx.restore();
    } else {
      var tw = m.tileW;
      var th = m.tileH;
      for (var y = -th; y < H + th; y += th) {
        for (var x = -tw; x < W + tw; x += tw) {
          ctx.save();
          ctx.translate(x + tw / 2, y + th / 2);
          ctx.rotate(m.rot);
          ctx.drawImage(off, -m.maxW / 2, -m.totalH / 2);
          ctx.restore();
        }
      }
    }
  }

  function renderDomLayer(wm, el, doc) {
    doc = doc || editorDoc() || document;
    buildRows(wm, function (rows) {
      if (!rows.length) return;
      var m = measureBlock(rows, num(wm.horizontal, 50), num(wm.vertical, 100), num(wm.rotation, 45));
      var single = String(wm.layout || '').toLowerCase() === 'center';
      var W = el.clientWidth;
      var H = el.clientHeight;
      if (W < 2 || H < 2) return;
      var dpr = (doc.defaultView || window).devicePixelRatio || 1;
      var c = doc.createElement('canvas');
      c.width = Math.floor(W * dpr);
      c.height = Math.floor(H * dpr);
      c.style.width = W + 'px';
      c.style.height = H + 'px';
      var ctx = c.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawTiledDom(ctx, W, H, rows, m, single);
      el.innerHTML = '';
      el.appendChild(c);
    }, doc);
  }

  function removeDomLayer() {
    var doc = editorDoc();
    if (!doc) return;
    var el = doc.getElementById(LAYER_ID);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function mountDomLayer(wm) {
    var doc = editorDoc();
    if (!doc) return false;
    var host = resolveEditorShell(doc);
    if (!host) return false;
    var el = doc.getElementById(LAYER_ID);
    if (!el) {
      el = doc.createElement('div');
      el.id = LAYER_ID;
    }
    if (el.parentNode !== host) host.appendChild(el);
    if (host.style.position === 'static') host.style.position = 'relative';
    el.style.cssText =
      'position:absolute;left:0;top:0;width:' + host.clientWidth + 'px;height:' + host.clientHeight +
      'px;overflow:hidden;pointer-events:none;z-index:' + LAYER_Z + ';';
    renderDomLayer(wm, el, doc);
    return true;
  }

  function stopPageSync() {
    if (overlayState && window.OOWatermarkPageOverlay) {
      window.OOWatermarkPageOverlay.stopSync(overlayState);
    }
    overlayState = null;
  }

  function startPageSync(wm) {
    if (!window.OOWatermarkPageOverlay) return;
    stopPageSync();
    overlayState = window.OOWatermarkPageOverlay.startSync(wm, function (cfg, pageEl) {
      renderDomLayer(cfg, pageEl, editorDoc());
    }, { pages: new Map() });
  }

  function stopDomOverlay() {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
    stopPageSync();
    removeDomLayer();
  }

  function runDomOverlay(wm) {
    mountDomLayer(wm);
    if (wm.usePageOverlay === true) startPageSync(wm);
    if (!keepAliveTimer) {
      keepAliveTimer = setInterval(function () {
        var cfg = getCfg();
        if (cfg) mountDomLayer(cfg);
      }, KEEPALIVE_MS);
    }
  }

  function bootstrapDomOverlay() {
    var wm = getCfg();
    if (!wm || !wm.watermarkItems || !wm.watermarkItems.length) return;
    function ready() {
      return editorDoc() && resolveEditorShell(editorDoc());
    }
    if (ready()) {
      runDomOverlay(wm);
      return;
    }
    var n = 0;
    (function poll() {
      if (ready()) runDomOverlay(getCfg() || wm);
      else if (++n < POLL_MAX) setTimeout(poll, POLL_MS);
    })();
  }

  // --- lifecycle ---

  /** True when preview mode or document is ready (covers stale isViewMode at autostart). */
  function readyToApply() {
    if (editMode) return false;
    var wm = getCfg();
    if (!wm || !wm.watermarkItems || !wm.watermarkItems.length) return false;
    return isViewMode() || docReady;
  }

  function isCenterLayout(wm) {
    return String((wm && wm.layout) || '').toLowerCase() === 'center';
  }

  /**
   * Excel tiles watermark_on_draw bitmaps across the sheet (DrawingArea loop).
   * A center-layout page PNG therefore appears as multiple off-center copies.
   * Use DOM overlay for Excel + center only (Word/PPT/PDF still use engine).
   */
  function needsDomCenter(wm) {
    return editorType() === 'cell' && isCenterLayout(wm);
  }

  function applyWatermark(wm) {
    if (wm.useDomOverlay === true || needsDomCenter(wm)) {
      // Clear any engine watermark first so tiled PNG does not remain under DOM.
      stopDomOverlay();
      clearEngineWatermark(function () {
        bootstrapDomOverlay();
        applied = true;
      });
      return;
    }
    stopDomOverlay();
    applyEngineWatermark(wm, function (ok) {
      applied = true;
      if (ok === false) {
        bootstrapDomOverlay();
        return;
      }
      closePlugin();
    });
  }

  function removeWatermark() {
    stopDomOverlay();
    clearEngineWatermark(closePlugin);
  }

  /** Async check: clear watermark only when Api confirms edit mode. */
  function confirmEditMode() {
    if (!window.Asc || !window.Asc.plugin || !window.Asc.plugin.callCommand) return;
    window.Asc.plugin.callCommand(
      function () {
        var oApi = Api;
        if (!oApi) return '';
        return oApi.isViewMode ? '1' : '0';
      },
      false,
      false,
      function (raw) {
        if (raw !== '0' && raw !== 0 && raw !== false) return;
        editMode = true;
        removeWatermark();
      }
    );
  }

  function syncWatermark(source) {
    if (source === 'updateOptions') {
      cachedWm = null;
      applied = false;
      editMode = false;
    } else if (applied) {
      return;
    }

    if (readyToApply()) {
      applyWatermark(getCfg());
    }

    confirmEditMode();
  }

  window.Asc.plugin.init = function () {
    syncWatermark('init');

    if (window.Asc.plugin.attachEditorEvent) {
      window.Asc.plugin.attachEditorEvent('onDocumentContentReady', function () {
        docReady = true;
        syncWatermark('docReady');
      });
    }

    if (window.Asc.plugin.callCommand) {
      window.Asc.plugin.callCommand(
        function () {
          var oApi = Api;
          return oApi && oApi.isDocumentLoadComplete ? '1' : '0';
        },
        false,
        false,
        function (raw) {
          if (raw === '1' || raw === 1 || raw === true) {
            docReady = true;
            syncWatermark('docReadyLate');
          }
        }
      );
    }
  };

  window.Asc.plugin.onUpdateOptions = function () {
    syncWatermark('updateOptions');
  };

  window.Asc.plugin.button = function () {};

  window.Asc.plugin.onEditorClose = function () {
    stopDomOverlay();
    cachedWm = null;
    applied = false;
    editMode = false;
    docReady = false;
  };
})(window);
