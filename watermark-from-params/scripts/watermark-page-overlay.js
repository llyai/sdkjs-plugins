/**
 * Per-page watermark host aligned to #id_viewer (optional; usePageOverlay: true).
 */
(function (window) {
  'use strict';

  var HOST_ID = 'oo-plugin-watermark-pages-host';
  var PAGE_CLS = 'oo-plugin-watermark-page';
  /** Same band as params viewport layer — under web-apps UI overlays. */
  var Z = 3;

  function editorDoc() {
    try {
      var p = window.parent;
      if (p && p !== window && p.document && p.document.getElementById('id_viewer')) return p.document;
    } catch (e) {}
    var w = window;
    while (w) {
      try {
        if (w.document && w.document.getElementById('id_viewer')) return w.document;
      } catch (e2) {}
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

  function offsetIn(el, ancestor) {
    var l = 0;
    var t = 0;
    var cur = el;
    while (cur && cur !== ancestor) {
      l += cur.offsetLeft || 0;
      t += cur.offsetTop || 0;
      cur = cur.offsetParent;
    }
    return cur === ancestor ? { left: l, top: t } : null;
  }

  function syncPageHost(host, doc, canvas) {
    var shell = doc.getElementById('id_main') || resolveEditorShell(doc);
    if (!shell || !canvas) return false;
    if (host.parentNode !== shell) shell.appendChild(host);
    var off = offsetIn(canvas, shell);
    var ol = off ? off.left : canvas.offsetLeft;
    var ot = off ? off.top : canvas.offsetTop;
    if (shell.style.position !== 'relative' && shell.style.position !== 'absolute') {
      shell.style.position = 'relative';
    }
    host.style.cssText =
      'position:absolute;left:' + ol + 'px;top:' + ot + 'px;width:' + canvas.offsetWidth + 'px;height:' +
      canvas.offsetHeight + 'px;pointer-events:none;z-index:' + Z + ';overflow:hidden;';
    return true;
  }

  function fetchPageRects(cb) {
    if (!window.Asc || !window.Asc.plugin || !window.Asc.plugin.callCommand) {
      cb([]);
      return;
    }
    window.Asc.plugin.callCommand(
      function () {
        var oApi = Api;
        if (!oApi || !oApi.WordControl) return '';
        var DD = oApi.WordControl.m_oDrawingDocument;
        if (!DD || DD.m_lDrawingFirst < 0) return '';
        var out = [];
        for (var i = DD.m_lDrawingFirst; i <= DD.m_lDrawingEnd; i++) {
          var page = DD.m_arrPages[i];
          if (!page || !page.drawingPage) continue;
          var p = page.drawingPage;
          out.push({
            index: i,
            left: p.left,
            top: p.top,
            width: Math.max(0, p.right - p.left),
            height: Math.max(0, p.bottom - p.top),
          });
        }
        return JSON.stringify(out);
      },
      false,
      false,
      function (raw) {
        var rects = [];
        if (typeof raw === 'string' && raw) {
          try {
            rects = JSON.parse(raw);
          } catch (e) {}
        }
        cb(rects);
      }
    );
  }

  /** Full #editor_sdk layer (used by watermark-from-api). */
  function mountViewportLayer(layerId, renderInto) {
    var doc = editorDoc();
    if (!doc || typeof renderInto !== 'function') return null;
    var host = resolveEditorShell(doc);
    if (!host) return null;
    var el = doc.getElementById(layerId) || doc.createElement('div');
    el.id = layerId;
    if (el.parentNode !== host) host.appendChild(el);
    if (host.style.position === 'static') host.style.position = 'relative';
    var relayout = function () {
      var shell = resolveEditorShell(doc) || host;
      if (el.parentNode !== shell) shell.appendChild(el);
      el.style.cssText =
        'position:absolute;left:0;top:0;width:' + shell.clientWidth + 'px;height:' + shell.clientHeight +
        'px;box-sizing:border-box;pointer-events:none;z-index:' + Z + ';overflow:hidden;';
      renderInto(el);
    };
    relayout();
    var win = doc.defaultView || window;
    if (!el._ooVp) {
      el._ooVp = true;
      win.addEventListener('resize', relayout, false);
      if (win.ResizeObserver) new win.ResizeObserver(relayout).observe(host);
    }
    return el;
  }

  function removeViewportLayer(doc, layerId) {
    var el = doc && doc.getElementById(layerId);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  window.OOWatermarkPageOverlay = {
    editorDoc: editorDoc,
    mountViewportLayer: mountViewportLayer,
    removeViewportLayer: removeViewportLayer,
    fetchPageRects: fetchPageRects,

    startSync: function (wm, paintPage, state) {
      var self = this;
      state = state || { pages: new Map(), running: true, wm: wm, paintPage: paintPage };
      state.running = true;

      function tick() {
        if (!state.running) return;
        var doc = self.editorDoc();
        var canvas = doc && doc.getElementById('id_viewer');
        if (!doc || !canvas) {
          state.raf = setTimeout(tick, 120);
          return;
        }
        var host = doc.getElementById(HOST_ID);
        if (!host) {
          host = doc.createElement('div');
          host.id = HOST_ID;
          (doc.getElementById('id_main') || resolveEditorShell(doc)).appendChild(host);
        }
        syncPageHost(host, doc, canvas);

        self.fetchPageRects(function (rects) {
          if (!state.running) return;
          if (!rects || !rects.length) {
            state.raf = setTimeout(tick, 120);
            return;
          }
          var seen = new Set();
          for (var i = 0; i < rects.length; i++) {
            var r = rects[i];
            if (r.width < 2 || r.height < 2) continue;
            var key = String(r.index != null ? r.index : i);
            seen.add(key);
            var pageEl = state.pages.get(key);
            var sk = Math.round(r.width) + 'x' + Math.round(r.height);
            if (!pageEl) {
              pageEl = doc.createElement('div');
              pageEl.className = PAGE_CLS;
              pageEl.style.cssText = 'position:absolute;overflow:hidden;pointer-events:none;';
              host.appendChild(pageEl);
              state.pages.set(key, pageEl);
            }
            pageEl.style.left = r.left + 'px';
            pageEl.style.top = r.top + 'px';
            pageEl.style.width = r.width + 'px';
            pageEl.style.height = r.height + 'px';
            if (pageEl.getAttribute('data-oo-size') !== sk) {
              pageEl.setAttribute('data-oo-size', sk);
              pageEl.innerHTML = '';
              paintPage(wm, pageEl, r);
            }
          }
          state.pages.forEach(function (el, k) {
            if (!seen.has(k) && el.parentNode) el.parentNode.removeChild(el);
            if (!seen.has(k)) state.pages.delete(k);
          });
          state.raf = setTimeout(tick, 120);
        });
      }
      tick();
      return state;
    },

    stopSync: function (state) {
      if (!state) return;
      state.running = false;
      if (state.raf) clearTimeout(state.raf);
      var doc = this.editorDoc();
      var host = doc && doc.getElementById(HOST_ID);
      if (host && host.parentNode) host.parentNode.removeChild(host);
      if (state.pages) state.pages.clear();
    },
  };
})(window);
