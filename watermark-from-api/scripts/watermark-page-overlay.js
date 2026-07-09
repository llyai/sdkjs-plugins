/**
 * Page-aligned watermark overlay (canvas coords). Uses Api in callCommand (not Asc.editor).
 */
(function (window) {
  'use strict';

  var HOST_ID = 'oo-plugin-watermark-pages-host';
  var HOST_VIEWPORT_ID = 'oo-plugin-watermark-viewport-layer';
  var PAGE_CLS = 'oo-plugin-watermark-page';

  function editorDoc() {
    var w = window;
    while (w) {
      try {
        var d = w.document;
        if (d && d.getElementById('id_viewer')) return d;
      } catch (e) {}
      if (!w.parent || w.parent === w) break;
      w = w.parent;
    }
    return null;
  }

  function getViewerCanvas(doc) {
    return doc ? doc.getElementById('id_viewer') : null;
  }

  function removeHost(doc) {
    if (!doc) return;
    var a = doc.getElementById(HOST_ID);
    var b = doc.getElementById(HOST_VIEWPORT_ID);
    if (a && a.parentNode) a.parentNode.removeChild(a);
    if (b && b.parentNode) b.parentNode.removeChild(b);
  }

  /** Host covers id_viewer; page rects are in canvas pixel space (0,0 = top-left of canvas). */
  function ensurePageHost(doc, canvas) {
    var vp = doc.getElementById(HOST_VIEWPORT_ID);
    if (vp && vp.parentNode) vp.parentNode.removeChild(vp);

    var existing = doc.getElementById(HOST_ID);
    if (existing) return existing;

    var parent = canvas.parentElement || doc.getElementById('id_main_view') || doc.getElementById('id_main');
    if (!parent) return null;

    var host = doc.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('data-oo-watermark', 'pages');
    host.style.cssText =
      'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:3;overflow:visible;';

    if (parent.style.position !== 'relative' && parent.style.position !== 'absolute') {
      parent.style.position = 'relative';
    }
    parent.appendChild(host);

    if (window.ResizeObserver && !host._ooResizeObs) {
      host._ooResizeObs = new window.ResizeObserver(function () {
        stateInvalidatePaint(host);
      });
      host._ooResizeObs.observe(canvas);
    }
    return host;
  }

  function stateInvalidatePaint(host) {
    if (!host || !host._ooState || !host._ooState.pages) return;
    host._ooState.pages.forEach(function (el) {
      el.removeAttribute('data-oo-size');
      el.innerHTML = '';
    });
  }

  /** Fallback: full canvas area (scroll does not follow document — better than nothing). */
  function ensureViewportHost(doc, canvas, paintPage, wm) {
    removeHost(doc);
    var parent = canvas.parentElement || doc.getElementById('id_main_view') || doc.getElementById('id_main');
    if (!parent) return null;

    var el = doc.createElement('div');
    el.id = HOST_VIEWPORT_ID;
    el.setAttribute('data-oo-watermark', 'viewport-fallback');
    el.style.cssText =
      'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:3;overflow:hidden;';
    if (parent.style.position !== 'relative' && parent.style.position !== 'absolute') {
      parent.style.position = 'relative';
    }
    parent.appendChild(el);

    function repaint() {
      el.innerHTML = '';
      paintPage(wm, el, { width: el.clientWidth, height: el.clientHeight });
    }
    repaint();
    if (window.ResizeObserver) {
      var ro = new window.ResizeObserver(repaint);
      ro.observe(canvas);
      el._ooResizeObs = ro;
    }
    return el;
  }

  function fetchPageRects(callback) {
    if (!window.Asc || !window.Asc.plugin || !window.Asc.plugin.callCommand) {
      callback([]);
      return;
    }
    window.Asc.plugin.callCommand(
      function () {
        var oApi = Api;
        if (!oApi || !oApi.WordControl) return '';
        var DD = oApi.WordControl.m_oDrawingDocument;
        if (!DD || DD.m_lDrawingFirst < 0 || DD.m_lDrawingEnd < 0) return '';
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
          } catch (e) {
            rects = [];
          }
        } else if (Array.isArray(raw)) {
          rects = raw;
        }
        callback(rects);
      }
    );
  }

  window.OOWatermarkPageOverlay = {
    editorDoc: editorDoc,
    getViewerCanvas: getViewerCanvas,
    removeHost: removeHost,

    startSync: function (wm, paintPage, state) {
      var self = this;
      if (!state) {
        state = { pages: new Map(), running: false, emptyTicks: 0, mode: 'pages' };
      }
      state.running = true;
      state.wm = wm;
      state.paintPage = paintPage;
      state.mode = 'pages';
      state.emptyTicks = 0;

      function tick() {
        if (!state.running) return;

        var doc = self.editorDoc();
        var canvas = self.getViewerCanvas(doc);
        if (!doc || !canvas) {
          state.raf = window.setTimeout(tick, 200);
          return;
        }

        if (state.mode === 'viewport') {
          if (!doc.getElementById(HOST_VIEWPORT_ID)) {
            ensureViewportHost(doc, canvas, paintPage, wm);
          }
          state.raf = window.setTimeout(tick, 500);
          return;
        }

        var host = doc.getElementById(HOST_ID) || ensurePageHost(doc, canvas);
        if (!host) {
          state.raf = window.setTimeout(tick, 200);
          return;
        }
        host._ooState = state;

        self.fetchPageRects(function (rects) {
          if (!state.running) return;

          if (!rects || !rects.length) {
            state.emptyTicks += 1;
            if (state.emptyTicks > 50) {
              state.mode = 'viewport';
              self.removeHost(doc);
              ensureViewportHost(doc, canvas, paintPage, wm);
              state.raf = window.setTimeout(tick, 500);
              return;
            }
            state.raf = window.setTimeout(tick, 150);
            return;
          }

          state.emptyTicks = 0;
          if (!host.parentNode) {
            state.raf = window.setTimeout(tick, 150);
            return;
          }

          var seen = new Set();
          for (var i = 0; i < rects.length; i++) {
            var r = rects[i];
            if (r.width < 2 || r.height < 2) continue;
            var key = String(r.index != null ? r.index : i);
            seen.add(key);

            var pageEl = state.pages.get(key);
            var sizeKey = Math.round(r.width) + 'x' + Math.round(r.height);
            if (!pageEl) {
              pageEl = document.createElement('div');
              pageEl.className = PAGE_CLS;
              pageEl.style.cssText =
                'position:absolute;overflow:hidden;pointer-events:none;';
              host.appendChild(pageEl);
              state.pages.set(key, pageEl);
            }
            pageEl.style.left = r.left + 'px';
            pageEl.style.top = r.top + 'px';
            pageEl.style.width = r.width + 'px';
            pageEl.style.height = r.height + 'px';

            var needPaint =
              pageEl.getAttribute('data-oo-size') !== sizeKey ||
              (!pageEl.firstChild && pageEl.clientWidth >= 2 && pageEl.clientHeight >= 2);
            if (needPaint) {
              pageEl.setAttribute('data-oo-size', sizeKey);
              pageEl.innerHTML = '';
              paintPage(wm, pageEl, r);
            }
          }

          state.pages.forEach(function (el, k) {
            if (!seen.has(k) && el.parentNode) el.parentNode.removeChild(el);
          });
          state.pages.forEach(function (el, k) {
            if (!seen.has(k)) state.pages.delete(k);
          });

          state.raf = window.setTimeout(tick, 150);
        });
      }

      tick();
      return state;
    },

    stopSync: function (state) {
      if (!state) return;
      state.running = false;
      if (state.raf) {
        clearTimeout(state.raf);
        state.raf = null;
      }
      var doc = this.editorDoc();
      var vp = doc && doc.getElementById(HOST_VIEWPORT_ID);
      if (vp && vp._ooResizeObs) {
        vp._ooResizeObs.disconnect();
      }
      var host = doc && doc.getElementById(HOST_ID);
      if (host && host._ooResizeObs) {
        host._ooResizeObs.disconnect();
      }
      this.removeHost(doc);
      if (state.pages) state.pages.clear();
    },
  };
})(window);
