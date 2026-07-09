/**
 * Watermark-from-params: DOM overlay on #editor_sdk (AnyShare-safe).
 * Optional: usePageOverlay (per-page scroll), useEngineWatermark (sdkjs draw).
 */
(function (window) {
  'use strict';

  var LAYER_ID = 'oo-plugin-watermark-params-layer';
  /** Above #id_viewer(1) / #id_viewer_overlay(2); below menus & modals (~1000+). */
  var LAYER_Z = 3;
  var POLL_MS = 40;
  var POLL_MAX = 80;
  var KEEPALIVE_MS = 800;

  var cachedWm = null;
  var overlayState = null;
  var keepAliveTimer = null;
  var nativeActive = false;

  // --- config / editor DOM ---

  function getCfg() {
    var info = window.Asc && window.Asc.plugin && window.Asc.plugin.info;
    if (info) {
      var wm = (info.options || info).watermark;
      if (wm && wm.watermarkItems && wm.watermarkItems.length) {
        cachedWm = wm;
        return wm;
      }
    }
    return cachedWm;
  }

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

  /** Prefer #editor_sdk — #id_main_view can be ~100px tall in WOPI embeds. */
  function resolveEditorShell(doc) {
    if (!doc) return null;
    var sdk = doc.getElementById('editor_sdk');
    if (sdk && sdk.clientWidth >= 64 && sdk.clientHeight >= 64) return sdk;
    var main = doc.getElementById('id_main');
    if (main && main.clientWidth >= 64 && main.clientHeight >= 64) return main;
    var wrap = doc.getElementById('editor-container');
    if (wrap && wrap.clientWidth >= 64 && wrap.clientHeight >= 64) return wrap;
    return sdk || main || wrap || doc.getElementById('id_main_view') || doc.getElementById('id_viewer');
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
    return { r: parseInt(h.substr(0, 2), 16), g: parseInt(h.substr(2, 2), 16), b: parseInt(h.substr(4, 2), 16) };
  }

  // --- tile drawing (block lines centered within cell width) ---

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
      padX: padX,
      padY: padY,
      rot: -rotDeg * Math.PI / 180, /* canvas: negative = counter-clockwise */
      cellW: maxW + padX,
      cellH: totalH + padY,
    };
  }

  /** Lines centered within blockW (widest line in cell). */
  function paintBlock(ctx, rows, x0, y0, blockW) {
    blockW = blockW > 0 ? blockW : 0;
    var y = y0;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.kind === 'img') {
        ctx.drawImage(r.img, x0 + (blockW > r.w ? (blockW - r.w) / 2 : 0), y, r.w, r.h);
        y += r.h + 6;
      } else {
        var rgb = parseRgb(r.color);
        ctx.fillStyle = 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + r.opacity + ')';
        ctx.font = 'normal ' + r.fs + 'px ' + r.ff;
        ctx.textBaseline = 'top';
        ctx.textAlign = 'center';
        var cx = x0 + (blockW || r.w) / 2;
        for (var li = 0; li < r.lines.length; li++) {
          ctx.fillText(r.lines[li], cx, y + li * r.lh);
        }
        ctx.textAlign = 'left';
        y += r.h + 4;
      }
    }
  }

  function drawTiledPixels(ctx, W, H, rows, m, singleCenter) {
    var bw = m.maxW;
    var bh = m.totalH;
    var off = document.createElement('canvas');
    off.width = Math.ceil(bw);
    off.height = Math.ceil(bh);
    paintBlock(off.getContext('2d'), rows, 0, 0, bw);
    ctx.clearRect(0, 0, W, H);
    if (singleCenter) {
      ctx.save();
      ctx.translate(W / 2, H / 2);
      ctx.rotate(m.rot);
      ctx.drawImage(off, -bw / 2, -bh / 2);
      ctx.restore();
    } else {
      var diag = Math.sqrt(m.cellW * m.cellW + m.cellH * m.cellH);
      for (var cy = -diag; cy < H + diag; cy += m.cellH) {
        for (var cx = -diag; cx < W + diag; cx += m.cellW) {
          ctx.save();
          ctx.translate(cx + m.cellW / 2, cy + m.cellH / 2);
          ctx.rotate(m.rot);
          ctx.drawImage(off, -bw / 2, -bh / 2);
          ctx.restore();
        }
      }
    }
  }

  function renderTiled(wm, layerEl, doc) {
    doc = doc || editorDoc() || document;
    var win = doc.defaultView || window;
    buildRows(wm, function (rows) {
      if (!rows.length) return;
      var m = measureBlock(rows, num(wm.horizontal, 50), num(wm.vertical, 100), num(wm.rotation, 45));
      var singleCenter = String(wm.layout || '').toLowerCase() === 'center';

      function paint() {
        var W = layerEl.clientWidth;
        var H = layerEl.clientHeight;
        if (W < 2 || H < 2) {
          var shell = resolveEditorShell(doc);
          if (shell) {
            W = shell.clientWidth;
            H = shell.clientHeight;
          }
        }
        if (W < 2 || H < 2) {
          win.requestAnimationFrame(paint);
          return;
        }
        var dpr = win.devicePixelRatio || 1;
        var c = doc.createElement('canvas');
        c.width = Math.floor(W * dpr);
        c.height = Math.floor(H * dpr);
        c.style.width = W + 'px';
        c.style.height = H + 'px';
        var ctx = c.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawTiledPixels(ctx, W, H, rows, m, singleCenter);
        layerEl.innerHTML = '';
        layerEl.appendChild(c);
      }
      paint();
    }, doc);
  }

  // --- viewport layer on #editor_sdk ---

  function layoutLayer(el, doc) {
    var host = resolveEditorShell(doc);
    if (!el || !host) return null;
    if (el.parentNode !== host) host.appendChild(el);
    try {
      if ((doc.defaultView || window).getComputedStyle(host).position === 'static') {
        host.style.position = 'relative';
      }
    } catch (e) {}
    var w = Math.max(0, Math.floor(host.clientWidth));
    var h = Math.max(0, Math.floor(host.clientHeight));
    el.setAttribute('data-oo-host', host.id || 'shell');
    el.style.cssText =
      'position:absolute;left:0;top:0;width:' + w + 'px;height:' + h + 'px;' +
      'box-sizing:border-box;overflow:hidden;pointer-events:none;z-index:' + LAYER_Z + ';';
    return host;
  }

  function mountViewport(wm) {
    var doc = editorDoc();
    if (!doc) return false;
    var el = doc.getElementById(LAYER_ID);
    if (!el) {
      el = doc.createElement('div');
      el.id = LAYER_ID;
      el.setAttribute('data-oo-watermark', 'params');
    }
    var host = layoutLayer(el, doc);
    if (!host) return false;
    renderTiled(wm, el, doc);

    if (!el._ooBound) {
      el._ooBound = true;
      var relayout = function () {
        layoutLayer(el, doc);
        renderTiled(wm, el, doc);
      };
      var win = doc.defaultView || window;
      win.addEventListener('resize', relayout, false);
      if (win.ResizeObserver) {
        el._ooRo = new win.ResizeObserver(relayout);
        el._ooRo.observe(host);
        var main = doc.getElementById('id_main');
        if (main && main !== host) el._ooRo.observe(main);
      }
    }
    return true;
  }

  function removeViewport() {
    var doc = editorDoc();
    if (!doc) return;
    var el = doc.getElementById(LAYER_ID);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  // --- optional engine watermark (useEngineWatermark: true) ---

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

  function applyEngine(wm, cb) {
    if (!window.Asc || !window.Asc.plugin || !window.Asc.plugin.callCommand) {
      cb(false);
      return;
    }
    buildRows(wm, function (rows) {
      if (!rows.length) {
        cb(false);
        return;
      }
      var m = measureBlock(rows, num(wm.horizontal, 50), num(wm.vertical, 100), 0);
      var c = document.createElement('canvas');
      c.width = 400;
      c.height = Math.max(280, Math.round(400 * m.totalH / Math.max(m.maxW, 1)));
      drawTiledPixels(c.getContext('2d'), c.width, c.height, rows, m, false);
      var dataUrl;
      try {
        dataUrl = c.toDataURL('image/png');
      } catch (e) {
        cb(false);
        return;
      }
      if (!dataUrl || dataUrl.length > 600000) {
        cb(false);
        return;
      }
      window.Asc.scope = window.Asc.scope || {};
      window.Asc.scope.ooWmEngine = { fill: dataUrl, w: 210, h: 297, transparent: wmOpacity(wm) };
      window.Asc.plugin.callCommand(
        function () {
          if (typeof AscCommon === 'undefined' || !AscCommon.CWatermarkOnDraw) return false;
          var oApi = Api;
          if (!oApi || !oApi.WordControl) return false;
          var c = scope.ooWmEngine;
          oApi.watermarkDraw = new AscCommon.CWatermarkOnDraw(
            JSON.stringify({
              type: 'rect',
              width: c.w,
              height: c.h,
              rotate: 0,
              transparent: c.transparent,
              fill: c.fill,
              align: 1,
              paragraphs: [{ align: 1, runs: [{ text: ' ', 'font-size': 8 }] }],
            }),
            oApi
          );
          oApi.watermarkDraw.checkOnReady();
          if (oApi.WordControl.OnRePaintAttack) oApi.WordControl.OnRePaintAttack();
          return true;
        },
        false,
        true,
        function (ok) {
          cb(!!ok);
        }
      );
    }, document);
  }

  // --- optional per-page overlay (usePageOverlay: true) ---

  function stopPageSync() {
    if (overlayState && window.OOWatermarkPageOverlay) {
      window.OOWatermarkPageOverlay.stopSync(overlayState);
    }
    overlayState = null;
  }

  function startPageSync(wm) {
    if (!window.OOWatermarkPageOverlay) return;
    stopPageSync();
    var doc = editorDoc();
    overlayState = window.OOWatermarkPageOverlay.startSync(
      wm,
      function (cfg, pageEl) {
        renderTiled(cfg, pageEl, doc);
      },
      { pages: new Map() }
    );
  }

  // --- lifecycle ---

  function run(wm) {
    mountViewport(wm);
    if (wm.usePageOverlay === true) startPageSync(wm);
    if (!keepAliveTimer) {
      keepAliveTimer = setInterval(function () {
        var cfg = getCfg();
        if (!cfg) return;
        if (nativeActive) return;
        mountViewport(cfg);
      }, KEEPALIVE_MS);
    }
    if (wm.useEngineWatermark === true) {
      applyEngine(wm, function (ok) {
        nativeActive = !!ok;
        if (ok) stopPageSync();
      });
    }
  }

  function stop() {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
    stopPageSync();
    removeViewport();
    cachedWm = null;
    nativeActive = false;
    if (window.Asc && window.Asc.plugin && window.Asc.plugin.callCommand) {
      window.Asc.plugin.callCommand(
        function () {
          if (Api) Api.watermarkDraw = null;
          if (Api && Api.WordControl && Api.WordControl.OnRePaintAttack) Api.WordControl.OnRePaintAttack();
          return true;
        },
        false,
        true
      );
    }
  }

  /** Poll every 40ms until plugins.options + #editor_sdk are ready (no 2s delay). */
  function bootstrap() {
    var wm = getCfg();
    if (!wm || !wm.watermarkItems || !wm.watermarkItems.length) return;

    function ready() {
      var doc = editorDoc();
      return doc && resolveEditorShell(doc);
    }

    if (ready()) {
      run(wm);
      return;
    }
    var n = 0;
    (function poll() {
      if (ready()) {
        run(getCfg() || wm);
        return;
      }
      if (++n < POLL_MAX) setTimeout(poll, POLL_MS);
    })();
  }

  window.Asc.plugin.init = function () {
    bootstrap();
    if (window.Asc.plugin.attachEditorEvent) {
      window.Asc.plugin.attachEditorEvent('onDocumentContentReady', bootstrap);
    }
  };

  window.Asc.plugin.onUpdateOptions = function () {
    cachedWm = null;
    bootstrap();
  };

  window.Asc.plugin.button = function () {};
  window.Asc.plugin.onEditorClose = function () {
    stop();
  };
})(window);
