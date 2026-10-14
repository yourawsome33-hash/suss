// Cameras: live feeds from this device's cameras plus network cameras (MJPEG / snapshot / video URLs),
// with snapshots and optional motion alerts. Feeds only run while the notebook is unlocked.
(function (root) {
  'use strict';

  var tiles = new Map();      // id -> { id, name, kind: 'device'|'network', el, video|img, stream, motion, prev, timer }
  var events = [];            // in-memory motion log for this session
  var hooks = { onChange: function () {}, onSnapshot: function () {}, saveNetwork: function () {}, toast: function () {} };
  var grid, eventsEl, networkCams = [];
  var motionLoop = null;

  function $(s) { return document.querySelector(s); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function uid() { return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  function liveCount() {
    var n = 0;
    tiles.forEach(function (t) { if (t.live) n++; });
    return n;
  }

  function renderEmpty() {
    var empty = $('#camEmpty');
    if (empty) empty.classList.toggle('hidden', tiles.size > 0);
  }

  function clock() {
    var d = new Date();
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString();
  }

  function makeTile(t) {
    var el = document.createElement('div');
    el.className = 'cam-tile entering';
    el.innerHTML =
      '<div class="cam-feed"></div>' +
      '<div class="cam-hud">' +
        '<span class="cam-name"><span class="rec-dot"></span>' + esc(t.name) + '</span>' +
        '<span class="cam-clock"></span>' +
      '</div>' +
      '<div class="cam-motion-flag">MOTION</div>' +
      '<div class="cam-scan" aria-hidden="true"></div>' +
      '<div class="cam-controls">' +
        '<button class="btn small" data-cam-snap title="Save a snapshot to a new note">📸 Snapshot</button>' +
        '<button class="btn small" data-cam-motion title="Alert me when something moves">🛰 Motion: off</button>' +
        '<button class="btn small" data-cam-full title="Fullscreen">⛶</button>' +
        '<button class="btn small" data-cam-close title="' + (t.kind === 'network' ? 'Remove camera' : 'Turn off') + '">✕</button>' +
      '</div>';
    t.el = el;
    el.addEventListener('animationend', function () { el.classList.remove('entering'); }, { once: true });
    el.querySelector('[data-cam-snap]').addEventListener('click', function () { snapshot(t); });
    el.querySelector('[data-cam-full]').addEventListener('click', function () {
      if (el.requestFullscreen) el.requestFullscreen(); else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    });
    el.querySelector('[data-cam-motion]').addEventListener('click', function (e) { toggleMotion(t, e.currentTarget); });
    el.querySelector('[data-cam-close]').addEventListener('click', function () {
      if (t.kind === 'network') {
        networkCams = networkCams.filter(function (c) { return c.id !== t.id; });
        hooks.saveNetwork(networkCams);
      }
      removeTile(t);
    });
    grid.appendChild(el);
    tiles.set(t.id, t);
    renderEmpty();
    return el;
  }

  function removeTile(t) {
    if (t.stream) t.stream.getTracks().forEach(function (tr) { tr.stop(); });
    if (t.timer) clearInterval(t.timer);
    t.live = false;
    tiles.delete(t.id);
    var el = t.el;
    el.classList.add('leaving');
    setTimeout(function () { el.remove(); renderEmpty(); }, 320);
    hooks.onChange(liveCount());
  }

  // ---------- this device's cameras ----------
  function startDeviceCameras() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      hooks.toast('This browser can’t access cameras here. Open the site over https (e.g. GitHub Pages) or localhost.');
      return Promise.resolve();
    }
    // Ask permission once so device labels become visible, then open every camera.
    return navigator.mediaDevices.getUserMedia({ video: true, audio: false }).then(function (probe) {
      probe.getTracks().forEach(function (tr) { tr.stop(); });
      return navigator.mediaDevices.enumerateDevices();
    }).then(function (devices) {
      var cams = devices.filter(function (d) { return d.kind === 'videoinput'; });
      if (!cams.length) { hooks.toast('No cameras found on this device'); return; }
      var opened = 0;
      return cams.slice(0, 6).reduce(function (p, d, i) {
        return p.then(function () {
          var id = 'dev-' + (d.deviceId || i);
          if (tiles.has(id)) return;
          return navigator.mediaDevices.getUserMedia({ video: { deviceId: d.deviceId ? { exact: d.deviceId } : undefined, width: { ideal: 1280 } }, audio: false })
            .then(function (stream) {
              var t = { id: id, name: d.label || ('Camera ' + (i + 1)), kind: 'device', stream: stream, live: true };
              makeTile(t);
              var v = document.createElement('video');
              v.autoplay = true; v.muted = true; v.playsInline = true;
              v.srcObject = stream;
              t.media = v;
              t.el.querySelector('.cam-feed').appendChild(v);
              opened++;
            }).catch(function () { /* camera busy or blocked: skip it */ });
        });
      }, Promise.resolve()).then(function () {
        hooks.onChange(liveCount());
        if (opened) hooks.toast(opened + ' camera' + (opened > 1 ? 's' : '') + ' online');
      });
    }).catch(function (err) {
      hooks.toast(err && err.name === 'NotAllowedError'
        ? 'Camera access was blocked. Allow it in your browser, or use the GitHub Pages version of the site.'
        : 'Could not start cameras');
    });
  }

  // ---------- network cameras ----------
  function addNetworkTile(cam) {
    if (tiles.has(cam.id)) return;
    var t = { id: cam.id, name: cam.name, kind: 'network', live: true, cam: cam };
    makeTile(t);
    var feed = t.el.querySelector('.cam-feed');
    var isVideo = /\.(mp4|webm|ogg|m3u8)(\?|$)/i.test(cam.url);
    var media;
    if (isVideo) {
      media = document.createElement('video');
      media.autoplay = true; media.muted = true; media.playsInline = true; media.loop = true;
      media.crossOrigin = 'anonymous';
      media.src = cam.url;
    } else {
      // MJPEG streams play natively in <img>; plain snapshot URLs get refreshed.
      media = document.createElement('img');
      media.alt = cam.name;
      media.crossOrigin = 'anonymous';
      var load = function () { media.src = cam.url + (cam.refresh ? (cam.url.indexOf('?') < 0 ? '?' : '&') + '_t=' + Date.now() : ''); };
      media.addEventListener('error', function () {
        if (media.crossOrigin) { media.removeAttribute('crossorigin'); load(); return; } // retry without CORS (no motion/snapshot then)
        t.el.classList.add('offline');
        t.live = false;
        hooks.onChange(liveCount());
      });
      load();
      if (cam.refresh) t.timer = setInterval(load, cam.refresh * 1000);
    }
    t.media = media;
    feed.appendChild(media);
    hooks.onChange(liveCount());
  }

  // ---------- snapshots & motion ----------
  function frameCanvas(t, maxW) {
    var m = t.media;
    var w = m.videoWidth || m.naturalWidth, h = m.videoHeight || m.naturalHeight;
    if (!w || !h) return null;
    var scale = Math.min(1, maxW / w);
    var c = document.createElement('canvas');
    c.width = Math.round(w * scale); c.height = Math.round(h * scale);
    c.getContext('2d').drawImage(m, 0, 0, c.width, c.height);
    return c;
  }

  function snapshot(t) {
    var c = frameCanvas(t, 960);
    if (!c) { hooks.toast('No picture from this camera yet'); return; }
    var url;
    try { url = c.toDataURL('image/jpeg', 0.72); }
    catch (e) { hooks.toast('This camera doesn’t allow snapshots from the browser (CORS)'); return; }
    t.el.classList.remove('flash'); void t.el.offsetWidth; t.el.classList.add('flash');
    hooks.onSnapshot(url, t.name);
  }

  function toggleMotion(t, btn) {
    t.motion = !t.motion;
    t.prev = null;
    btn.textContent = '🛰 Motion: ' + (t.motion ? 'on' : 'off');
    btn.classList.toggle('active', t.motion);
    if (t.motion && !motionLoop) motionLoop = setInterval(checkMotion, 500);
  }

  function checkMotion() {
    var any = false;
    tiles.forEach(function (t) {
      if (!t.motion) return;
      any = true;
      var c = frameCanvas(t, 64);
      if (!c) return;
      var px;
      try { px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; }
      catch (e) { t.motion = false; hooks.toast(t.name + ': motion alerts need a camera that allows CORS'); return; }
      var gray = new Uint8Array(px.length / 4);
      for (var i = 0, j = 0; i < px.length; i += 4, j++) gray[j] = (px[i] * 3 + px[i + 1] * 6 + px[i + 2]) / 10;
      if (t.prev && t.prev.length === gray.length) {
        var changed = 0;
        for (var k = 0; k < gray.length; k++) if (Math.abs(gray[k] - t.prev[k]) > 28) changed++;
        var ratio = changed / gray.length;
        if (ratio > 0.04 && (!t.lastAlert || Date.now() - t.lastAlert > 4000)) {
          t.lastAlert = Date.now();
          alertMotion(t);
        }
      }
      t.prev = gray;
    });
    if (!any) { clearInterval(motionLoop); motionLoop = null; }
  }

  function alertMotion(t) {
    t.el.classList.remove('motion'); void t.el.offsetWidth; t.el.classList.add('motion');
    var thumb = null;
    var c = frameCanvas(t, 240);
    try { thumb = c && c.toDataURL('image/jpeg', 0.6); } catch (e) { /* tainted */ }
    events.unshift({ cam: t.name, at: new Date(), thumb: thumb });
    events = events.slice(0, 24);
    renderEvents();
    hooks.toast('Motion detected on ' + t.name);
  }

  function renderEvents() {
    if (!eventsEl) return;
    eventsEl.innerHTML = events.length
      ? events.map(function (e) {
          return '<div class="event">' + (e.thumb ? '<img src="' + e.thumb + '" alt="">' : '') +
            '<div><strong>' + esc(e.cam) + '</strong><div class="muted small">' + e.at.toLocaleTimeString() + '</div></div></div>';
        }).join('')
      : '<p class="muted small">No motion yet. Turn on 🛰 Motion on a camera to watch for movement.</p>';
  }

  setInterval(function () {
    var now = clock();
    tiles.forEach(function (t) { var c = t.el && t.el.querySelector('.cam-clock'); if (c) c.textContent = now; });
  }, 1000);

  var Cameras = {
    init: function (opts) {
      hooks = Object.assign(hooks, opts.hooks || {});
      grid = $('#camGrid');
      eventsEl = $('#camEvents');
      renderEvents();
    },
    setNetworkCams: function (list) { networkCams = (list || []).slice(); },
    showNetworkCams: function () { networkCams.forEach(addNetworkTile); },
    addNetworkCam: function (cam) {
      cam.id = uid();
      networkCams.push(cam);
      hooks.saveNetwork(networkCams);
      addNetworkTile(cam);
    },
    startDeviceCameras: startDeviceCameras,
    liveCount: liveCount,
    // Called on lock: stop every stream and forget motion history.
    stopAll: function () {
      tiles.forEach(function (t) {
        if (t.stream) t.stream.getTracks().forEach(function (tr) { tr.stop(); });
        if (t.timer) clearInterval(t.timer);
        if (t.el) t.el.remove();
      });
      tiles.clear();
      events = [];
      networkCams = [];
      renderEvents();
      renderEmpty();
      hooks.onChange(0);
    }
  };

  root.Cameras = Cameras;
})(window);
