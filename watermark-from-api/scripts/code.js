/**
 * Watermark-from-api: tiles image from imageProxyUrl on #editor_sdk.
 * Optional usePageOverlay for per-page scroll.
 */
(function (window) {
  'use strict';

  var LAYER_ID = 'oo-plugin-watermark-api-viewport';
  var POLL_MS = 40;
  var POLL_MAX = 80;

  var overlayState = null;
  var imageDataUrl = null;

  function getCfg() {
    var i = window.Asc && window.Asc.plugin && window.Asc.plugin.info;
    return i && i.options ? i.options.watermark : null;
  }

  function num(v, d) {
    if (v === undefined || v === null || v === '') return d;
    var n = parseFloat(v, 10);
    return isNaN(n) ? d : n;
  }

  function fetchImageData(url, cb) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.responseType = 'blob';
    xhr.onload = function () {
      if (xhr.status < 200 || xhr.status >= 300) return cb(null);
      var ct = xhr.getResponseHeader('Content-Type') || '';
      if (ct.indexOf('json') >= 0) {
        var r = new FileReader();
        r.onload = function () {
          try {
            var j = JSON.parse(r.result);
            cb(j.imageBase64 || j.data || j.image || null);
          } catch (e) {
            cb(null);
          }
        };
        r.readAsText(xhr.response);
        return;
      }
      var fr = new FileReader();
      fr.onload = function () {
        cb(fr.result);
      };
      fr.onerror = function () {
        cb(null);
      };
      fr.readAsDataURL(xhr.response);
    };
    xhr.onerror = function () {
      cb(null);
    };
    xhr.send();
  }

  function paintTiled(wm, layerEl, dataUrl) {
    var rot = -num(wm.rotation, 45) * Math.PI / 180;
    var padX = num(wm.horizontal, 50);
    var padY = num(wm.vertical, 100);
    var single = String(wm.layout || '').toLowerCase() === 'center';
    var im = new ((layerEl.ownerDocument.defaultView || window).Image || Image)();
    im.onload = function () {
      var bw = im.naturalWidth;
      var bh = im.naturalHeight;
      var W = layerEl.clientWidth;
      var H = layerEl.clientHeight;
      if (W < 2 || H < 2) {
        requestAnimationFrame(function () {
          paintTiled(wm, layerEl, dataUrl);
        });
        return;
      }
      var dpr = window.devicePixelRatio || 1;
      var c = layerEl.ownerDocument.createElement('canvas');
      c.width = Math.floor(W * dpr);
      c.height = Math.floor(H * dpr);
      c.style.width = W + 'px';
      c.style.height = H + 'px';
      var ctx = c.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      var cellW = bw + padX;
      var cellH = bh + padY;
      if (single) {
        ctx.save();
        ctx.translate(W / 2, H / 2);
        ctx.rotate(rot);
        ctx.drawImage(im, -bw / 2, -bh / 2);
        ctx.restore();
      } else {
        var diag = Math.sqrt(cellW * cellW + cellH * cellH);
        for (var cy = -diag; cy < H + diag; cy += cellH) {
          for (var cx = -diag; cx < W + diag; cx += cellW) {
            ctx.save();
            ctx.translate(cx + cellW / 2, cy + cellH / 2);
            ctx.rotate(rot);
            ctx.drawImage(im, -bw / 2, -bh / 2);
            ctx.restore();
          }
        }
      }
      layerEl.innerHTML = '';
      layerEl.appendChild(c);
    };
    im.src = dataUrl;
  }

  function run(wm) {
    if (!window.OOWatermarkPageOverlay || !imageDataUrl) return;
    window.OOWatermarkPageOverlay.mountViewportLayer(LAYER_ID, function (el) {
      paintTiled(wm, el, imageDataUrl);
    });
    if (wm.usePageOverlay === true) {
      if (overlayState) window.OOWatermarkPageOverlay.stopSync(overlayState);
      overlayState = window.OOWatermarkPageOverlay.startSync(wm, function (cfg, pageEl) {
        paintTiled(cfg, pageEl, imageDataUrl);
      });
    }
  }

  function stop() {
    if (overlayState && window.OOWatermarkPageOverlay) {
      window.OOWatermarkPageOverlay.stopSync(overlayState);
    }
    overlayState = null;
    if (window.OOWatermarkPageOverlay) {
      var doc = window.OOWatermarkPageOverlay.editorDoc();
      window.OOWatermarkPageOverlay.removeViewportLayer(doc, LAYER_ID);
    }
    imageDataUrl = null;
  }

  function bootstrap() {
    var wm = getCfg();
    if (!wm || !wm.imageProxyUrl) return;
    fetchImageData(wm.imageProxyUrl, function (url) {
      if (!url) return;
      imageDataUrl = url;
      function ready() {
        return window.OOWatermarkPageOverlay && window.OOWatermarkPageOverlay.editorDoc();
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
    });
  }

  window.Asc.plugin.init = function () {
    bootstrap();
    if (window.Asc.plugin.attachEditorEvent) {
      window.Asc.plugin.attachEditorEvent('onDocumentContentReady', bootstrap);
    }
  };

  window.Asc.plugin.onUpdateOptions = function () {
    imageDataUrl = null;
    bootstrap();
  };

  window.Asc.plugin.button = function () {};
  window.Asc.plugin.onEditorClose = function () {
    stop();
  };
})(window);
