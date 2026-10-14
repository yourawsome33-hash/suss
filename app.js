(function () {
  'use strict';

  var KINDS = {
    note:    { label: 'Note',    icon: '📝' },
    lesson:  { label: 'Lesson',  icon: '💡' },
    tip:     { label: 'Tip',     icon: '🔧' },
    problem: { label: 'Problem', icon: '⚠️' },
    fix:     { label: 'Fix',     icon: '✅' },
    idea:    { label: 'Idea',    icon: '✨' }
  };

  var CHECKLIST = [
    'Check power first: is the supply giving the voltage and current you expect under load?',
    'Change one thing at a time, and write down what you changed.',
    'Test the smallest piece on its own before testing the whole build.',
    'Re-measure. Dimensions, tolerances and wiring are wrong more often than the design.',
    'Look at the last thing that changed before it stopped working.',
    'Explain the problem out loud (or write it here). Half the time the answer shows up.',
    'Take a break and come back. Fresh eyes catch what tired ones miss.'
  ];

  var EXAMPLES = [
    { title: 'Servo horn slips on 3D printed gear', kind: 'problem', project: 'Robot arm',
      body: 'The plastic gear spins on the servo spline under load. Press fit was too loose at 0.2 mm clearance.',
      solution: 'Printed the hole 0.1 mm smaller and added an M2 set screw. No slipping since.',
      tags: ['servo', 'gears', '3d print', 'tolerance'] },
    { title: 'Always add a capacitor across the motor supply', kind: 'lesson', project: 'Robot arm',
      body: 'Arduino kept resetting when the motors started. A 470uF cap across the power rail fixed the brownouts. Use a separate supply for motors when possible.',
      tags: ['power', 'arduino', 'motor', 'reset'], pinned: true },
    { title: 'Epoxy vs super glue on PLA', kind: 'tip', project: 'Bird feeder',
      body: 'Super glue sets fast but snaps on impact. 5 minute epoxy holds much better on PLA, especially if you sand both surfaces first.',
      tags: ['glue', 'pla', 'adhesive'] },
    { title: 'Solar charger idea', kind: 'idea', project: 'Bird feeder',
      body: 'Small 6V panel + TP4056 module to keep the camera battery topped up.',
      tags: ['solar', 'battery'] }
  ];

  // ---------- state ----------
  var data = null;  // decrypted vault contents, only while unlocked: { notes, cameras, settings }
  var ui = { view: 'notebook', filterKind: 'all', filterProject: 'all', query: '' };
  var editingId = null;
  var editPhotos = [];
  var saveChain = Promise.resolve();

  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function notes() { return data ? data.notes : []; }

  function persist() {
    if (!data) return Promise.resolve();
    var snapshot = data;
    saveChain = saveChain.then(function () { return Vault.save(snapshot); })
      .catch(function () { toast('Could not save — browser storage may be full or blocked.'); });
    return saveChain;
  }

  function examples() {
    var now = Date.now();
    return EXAMPLES.map(function (n, i) {
      return Object.assign({ id: uid(), created: now - i * 86400000, updated: now - i * 86400000, helpful: 0, example: true }, n);
    });
  }

  // ---------- helpers ----------
  var $ = function (sel) { return document.querySelector(sel); };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Escape text and wrap words that match the query in <mark>.
  function highlight(text, stems) {
    if (!stems || !stems.length) return esc(text);
    return String(text || '').split(/([A-Za-z0-9'’]+)/).map(function (part, i) {
      if (i % 2 === 1 && NoteSearch.matchesWord(part, stems)) return '<mark>' + esc(part) + '</mark>';
      return esc(part);
    }).join('');
  }

  function snippet(text, max) {
    text = String(text || '');
    return text.length > max ? text.slice(0, max).replace(/\s+\S*$/, '') + '…' : text;
  }

  function timeAgo(ts) {
    var s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    var units = [[31536000, 'year'], [2592000, 'month'], [604800, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute']];
    for (var i = 0; i < units.length; i++) {
      var n = Math.floor(s / units[i][0]);
      if (n >= 1) return n + ' ' + units[i][1] + (n > 1 ? 's' : '') + ' ago';
    }
    return '';
  }

  function projects() {
    var set = new Set();
    notes().forEach(function (n) { if (n.project) set.add(n.project); });
    return Array.from(set).sort(function (a, b) { return a.localeCompare(b); });
  }

  function isOpenProblem(n) { return n.kind === 'problem' && !n.solution; }
  function isLesson(n) { return n.kind === 'lesson' || n.kind === 'tip' || n.kind === 'fix' || (n.kind === 'problem' && !!n.solution); }

  var toastTimer;
  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2800);
  }

  function debounce(fn, ms) {
    var t;
    return function () { var args = arguments; clearTimeout(t); t = setTimeout(function () { fn.apply(null, args); }, ms); };
  }

  // Give freshly rendered children a stagger index for their entrance animation.
  function stagger(container, selector) {
    container.querySelectorAll(selector).forEach(function (el, i) { el.style.setProperty('--i', Math.min(i, 14)); });
  }

  // Shrink an image (file, data URL or canvas source) to a JPEG data URL so notes stay small.
  function shrinkImage(src, maxW) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, maxW / img.naturalWidth);
        var c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * scale);
        c.height = Math.round(img.naturalHeight * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.72));
      };
      img.onerror = reject;
      img.src = src;
    });
  }

  // ---------- dialogs with exit animation ----------
  function openModal(d) {
    d.classList.remove('closing');
    if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
  }
  function closeModal(d) {
    if (!d.open || d.classList.contains('closing')) return;
    d.classList.add('closing');
    var t;
    var onEnd = function (e) { if (e.target === d && e.animationName === 'modalOut') done(); };
    var done = function () {
      clearTimeout(t);
      d.removeEventListener('animationend', onEnd);
      if (!d.classList.contains('closing')) return;
      d.classList.remove('closing');
      if (d.close) d.close(); else d.removeAttribute('open');
    };
    t = setTimeout(done, 320);
    d.addEventListener('animationend', onEnd);
  }
  document.querySelectorAll('dialog.modal').forEach(function (d) {
    d.addEventListener('cancel', function (e) { e.preventDefault(); closeModal(d); });
    d.addEventListener('click', function (e) {
      if (e.target === d || e.target.closest('[data-close]')) closeModal(d);
    });
  });

  // Themed replacement for confirm()/prompt(). Resolves the typed text (or true), or null on cancel.
  var askResolve = null;
  function ask(opts) {
    var d = $('#askDialog');
    if (askResolve) askResolve(null);
    $('#askTitle').textContent = opts.title || 'Are you sure?';
    $('#askMessage').textContent = opts.message || '';
    var input = $('#askInput');
    input.classList.toggle('hidden', !opts.input);
    input.type = opts.input === 'password' ? 'password' : 'text';
    input.placeholder = opts.placeholder || '';
    input.value = '';
    var ok = $('#askOk');
    ok.textContent = opts.confirmLabel || 'OK';
    ok.className = 'btn ' + (opts.danger ? 'danger' : 'primary');
    openModal(d);
    setTimeout(function () { (opts.input ? input : ok).focus(); }, 40);
    return new Promise(function (resolve) { askResolve = resolve; });
  }
  function settleAsk(value) {
    if (askResolve) { var r = askResolve; askResolve = null; r(value); }
  }
  $('#askForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var input = $('#askInput');
    settleAsk(input.classList.contains('hidden') ? true : input.value);
    closeModal($('#askDialog'));
  });
  $('#askDialog').addEventListener('close', function () { settleAsk(null); });

  // ==========================================================================
  // LOCK SCREEN
  // ==========================================================================
  var lockPanel = $('#lockPanel');
  var lockForm = $('#lockForm');
  var passInput = $('#passInput');
  var passConfirm = $('#passConfirm');
  var lockMsg = $('#lockMsg');
  var setupMode = false;
  var countdownTimer = null;

  function bootSequence(lines) {
    var boot = $('#boot');
    boot.innerHTML = '';
    return lines.reduce(function (p, line, i) {
      return p.then(function () {
        return new Promise(function (r) {
          setTimeout(function () {
            var div = document.createElement('div');
            div.textContent = line.text;
            if (line.ok) div.className = 'ok';
            boot.appendChild(div);
            r();
          }, i === 0 ? 250 : 260);
        });
      });
    }, Promise.resolve());
  }

  function showLockForm() {
    lockForm.classList.remove('hidden');
    $('#confirmWrap').classList.toggle('hidden', !setupMode);
    $('#strength').classList.toggle('hidden', !setupMode);
    $('#setupNote').classList.toggle('hidden', !setupMode);
    $('#passLabel').textContent = setupMode ? 'Create a passphrase' : 'Passphrase';
    passInput.autocomplete = setupMode ? 'new-password' : 'current-password';
    $('#unlockBtn').textContent = setupMode ? 'Create vault' : 'Unlock';
    passInput.value = ''; passConfirm.value = '';
    lockMsg.textContent = ''; lockMsg.className = 'lock-msg';
    updateCountdown();
    setTimeout(function () { passInput.focus(); }, 50);
  }

  function updateCountdown() {
    clearInterval(countdownTimer);
    var tick = function () {
      var wait = Vault.lockedOutFor();
      $('#unlockBtn').disabled = wait > 0;
      if (wait > 0) {
        lockMsg.className = 'lock-msg';
        lockMsg.textContent = 'Too many wrong tries. Try again in ' + Math.ceil(wait / 1000) + 's.';
      } else {
        clearInterval(countdownTimer);
        if (/Too many/.test(lockMsg.textContent)) lockMsg.textContent = '';
      }
    };
    tick();
    if (Vault.lockedOutFor() > 0) countdownTimer = setInterval(tick, 500);
  }

  function strengthOf(p) {
    var score = 0;
    if (p.length >= 8) score++;
    if (p.length >= 12) score++;
    if (p.length >= 16) score++;
    if (/[a-z]/.test(p) && /[A-Z]/.test(p)) score++;
    if (/\d/.test(p)) score++;
    if (/[^A-Za-z0-9]/.test(p)) score++;
    if (/\s/.test(p.trim()) && p.length >= 14) score++; // multi-word passphrases are strong
    return Math.min(score, 5);
  }
  passInput.addEventListener('input', function () {
    if (!setupMode) return;
    var s = strengthOf(passInput.value);
    var bar = $('#strength i');
    var labels = ['Too short', 'Weak', 'Okay', 'Good', 'Strong', 'Excellent'];
    var colors = ['#ff5468', '#ff5468', '#f59e42', '#f5c542', '#4ade80', '#4ade80'];
    bar.style.width = (passInput.value ? (s + 1) / 6 * 100 : 0) + '%';
    bar.style.background = colors[s];
    $('#strength span').textContent = passInput.value ? labels[s] : '';
  });

  function rejectPanel(msg) {
    lockMsg.className = 'lock-msg';
    lockMsg.textContent = msg;
    lockPanel.classList.remove('shake'); void lockPanel.offsetWidth; lockPanel.classList.add('shake');
    passInput.select();
  }
  lockPanel.addEventListener('animationend', function (e) { if (e.animationName === 'shake') lockPanel.classList.remove('shake'); });

  lockForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var pass = passInput.value;
    if (setupMode) {
      if (pass.length < 8) return rejectPanel('Use at least 8 characters. A short sentence works great.');
      if (pass !== passConfirm.value) return rejectPanel('The two passphrases don’t match.');
    }
    lockPanel.classList.add('working');
    $('#unlockBtn').disabled = true;
    lockMsg.className = 'lock-msg info';
    lockMsg.textContent = setupMode ? 'Forging encryption key…' : 'Decrypting vault…';

    var job = setupMode
      ? (function () { var fresh = { notes: examples(), cameras: [], settings: { autoLock: 5 } }; return Vault.create(pass, fresh).then(function () { return fresh; }); })()
      : Vault.unlock(pass);

    job.then(function (contents) {
      passInput.value = ''; passConfirm.value = '';
      grantAccess(contents);
    }, function (err) {
      lockPanel.classList.remove('working');
      $('#unlockBtn').disabled = false;
      if (err && err.message === 'WRONG_PASSPHRASE') {
        rejectPanel('Access denied.' + (err.fails >= 3 && !err.wait ? ' ' + (5 - err.fails) + ' tries before a cooldown.' : ''));
        updateCountdown();
      } else if (err && err.message === 'LOCKED_OUT') {
        updateCountdown();
      } else {
        rejectPanel('Something went wrong opening the vault.');
      }
    });
  });

  function grantAccess(contents) {
    clearTimeout(scrubTimer);
    data = contents;
    data.notes = data.notes || [];
    data.cameras = data.cameras || [];
    data.settings = Object.assign({ autoLock: 5 }, data.settings || {});
    lockPanel.classList.remove('working');
    lockPanel.classList.add('granted');
    $('#lockSub').textContent = 'Access granted';
    lockMsg.textContent = '';

    Cameras.setNetworkCams(data.cameras);
    ui.view = 'notebook'; ui.query = ''; ui.filterKind = 'all'; ui.filterProject = 'all';
    $('#searchBox').value = '';
    render(true);

    setTimeout(function () {
      document.body.classList.remove('is-locked');
      document.body.classList.add('is-unlocked');
      $('#app').inert = false;
      $('#lock').inert = true;
      positionInk();
      bumpActivity();
    }, 650);
  }

  var scrubTimer = null;
  function lockNow(reason) {
    if (!data) return;
    persist();
    Cameras.stopAll();
    document.querySelectorAll('dialog.modal[open]').forEach(function (d) { if (d.close) d.close(); });
    data = null;
    editingId = null; editPhotos = [];
    $('#app').inert = true;
    $('#lock').inert = false;
    document.body.classList.remove('is-unlocked');
    document.body.classList.add('is-locked');

    lockPanel.classList.remove('granted', 'working');
    $('#lockSub').textContent = 'Secure vault';
    setupMode = false;
    $('#boot').innerHTML = '';
    bootSequence([{ text: reason || 'Session locked' }, { text: 'Vault sealed · AES-256', ok: true }]).then(showLockForm);

    // Wipe decrypted content from the page once it's hidden behind the lock.
    clearTimeout(scrubTimer);
    scrubTimer = setTimeout(function () {
      ['#noteList', '#stuckResults', '#projectGrid', '#relatedList', '#rememberCard', '#photoStrip'].forEach(function (s) { $(s).innerHTML = ''; });
      $('#stuckInput').value = '';
      $('#editorForm').reset();
    }, 1100);
  }

  // ---------- idle auto-lock ----------
  var lastActivity = Date.now();
  function bumpActivity() { lastActivity = Date.now(); }
  ['pointerdown', 'keydown', 'wheel', 'touchstart', 'mousemove'].forEach(function (ev) {
    document.addEventListener(ev, bumpActivity, { passive: true });
  });
  function checkIdle() {
    if (!data) return;
    var limit = (data.settings.autoLock || 5) * 60000;
    if (Date.now() - lastActivity > limit) lockNow('Locked after being idle');
  }
  setInterval(checkIdle, 10000);
  document.addEventListener('visibilitychange', checkIdle);

  // ==========================================================================
  // RENDERING
  // ==========================================================================
  function badge(n) {
    var k = KINDS[n.kind] || KINDS.note;
    var cls = 'badge kind-' + n.kind;
    var label = k.label;
    var icon = k.icon;
    if (n.kind === 'problem') { cls += n.solution ? ' solved' : ' open'; label = n.solution ? 'Solved' : 'Open problem'; icon = n.solution ? '✅' : icon; }
    return '<span class="' + cls + '">' + icon + ' ' + label + '</span>';
  }

  function noteCard(n, opts) {
    opts = opts || {};
    var stems = opts.stems;
    var tags = (n.tags || []).map(function (t) { return '<span class="tag">' + highlight(t, stems) + '</span>'; }).join('');
    var solution = n.solution
      ? '<div class="solution"><strong>What fixed it:</strong> ' + highlight(snippet(n.solution, opts.full ? 2000 : 220), stems) + '</div>'
      : '';
    var thumbs = (n.photos || []).length
      ? '<div class="thumbs">' + n.photos.slice(0, 4).map(function (p) { return '<img src="' + esc(p) + '" alt="">'; }).join('') + '</div>'
      : '';
    var why = opts.matched && opts.matched.length ? '<div class="why">Matched: ' + opts.matched.map(esc).join(', ') + '</div>' : '';
    var actions = opts.helpButton
      ? '<div class="card-actions"><button class="btn small" data-helpful="' + n.id + '">👍 This helped' + (n.helpful ? ' (' + n.helpful + ')' : '') + '</button>' +
        '<button class="btn small" data-open="' + n.id + '">Open</button></div>'
      : '';
    var cls = 'card kind-' + n.kind + (n.pinned ? ' pinned' : '') + (n.solution ? ' is-solved' : '');
    return '<article class="' + cls + '"' + (opts.helpButton ? '' : ' data-open="' + n.id + '" tabindex="0"') + '>' +
      '<div class="card-top">' + badge(n) +
        (n.project ? '<span class="project-name">' + esc(n.project) + '</span>' : '') +
        (n.pinned ? '<span class="pin" title="Pinned">📌</span>' : '') +
      '</div>' +
      '<h3>' + highlight(n.title, stems) + '</h3>' +
      (n.body ? '<p>' + highlight(snippet(n.body, opts.full ? 2000 : 220), stems) + '</p>' : '') +
      solution + thumbs +
      (tags ? '<div class="tags">' + tags + '</div>' : '') +
      why +
      '<div class="meta">' + timeAgo(n.updated || n.created) + '</div>' +
      actions +
    '</article>';
  }

  function renderFilters() {
    var sel = $('#projectFilter');
    var ps = projects();
    if (ui.filterProject !== 'all' && ps.indexOf(ui.filterProject) < 0) ui.filterProject = 'all';
    sel.innerHTML = '<option value="all">All projects</option>' +
      ps.map(function (p) { return '<option' + (p === ui.filterProject ? ' selected' : '') + '>' + esc(p) + '</option>'; }).join('');

    var all = notes();
    var counts = { all: all.length, open: all.filter(isOpenProblem).length };
    Object.keys(KINDS).forEach(function (k) { counts[k] = all.filter(function (n) { return n.kind === k; }).length; });
    var chips = [['all', 'All'], ['open', '⚠️ Unsolved']].concat(Object.keys(KINDS).map(function (k) { return [k, KINDS[k].icon + ' ' + KINDS[k].label]; }));
    $('#kindFilter').innerHTML = chips.map(function (c) {
      if (c[0] !== 'all' && !counts[c[0]] && ui.filterKind !== c[0]) return '';
      return '<button class="chip' + (ui.filterKind === c[0] ? ' active' : '') + '" data-kind="' + c[0] + '">' + c[1] +
        ' <span class="count">' + counts[c[0]] + '</span></button>';
    }).join('');

    $('#projectOptions').innerHTML = ps.map(function (p) { return '<option value="' + esc(p) + '">'; }).join('');
  }

  function filteredNotes() {
    var list = notes().filter(function (n) {
      if (ui.filterProject !== 'all' && n.project !== ui.filterProject) return false;
      if (ui.filterKind === 'open') return isOpenProblem(n);
      if (ui.filterKind !== 'all' && n.kind !== ui.filterKind) return false;
      return true;
    });
    if (ui.query.trim()) return NoteSearch.rank(list, ui.query, { limit: 200 }).map(function (r) { return r.note; });
    return list.slice().sort(function (a, b) {
      if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
      return (b.updated || b.created) - (a.updated || a.created);
    });
  }

  function renderNotebook() {
    renderFilters();
    $('#exampleBanner').classList.toggle('hidden', !notes().some(function (n) { return n.example; }));
    var stems = NoteSearch.tokenize(ui.query);
    var list = filteredNotes();
    var el = $('#noteList');
    if (!notes().length) {
      el.innerHTML = '<div class="empty"><h2>Your notebook is empty</h2><p>Write down what you try, what breaks and what works. ' +
        'Next time you’re stuck, the <strong>I’m stuck</strong> tab will find it for you.</p>' +
        '<button class="btn primary" data-new>+ Write your first note</button></div>';
    } else if (!list.length) {
      el.innerHTML = '<div class="empty"><p>No notes match. Try a different word, or clear the filters.</p></div>';
    } else {
      el.innerHTML = list.map(function (n) { return noteCard(n, { stems: stems }); }).join('');
      stagger(el, '.card');
    }
    renderRemember();
  }

  // Resurfaces one lesson/tip/fix so good ideas don't get buried.
  var rememberPick = null;
  function renderRemember() {
    var el = $('#rememberCard');
    var pool = notes().filter(isLesson);
    if (!pool.length || ui.query) { el.classList.add('hidden'); return; }
    if (!rememberPick || pool.indexOf(rememberPick) < 0) rememberPick = pool[Math.floor(Math.random() * pool.length)];
    var n = rememberPick;
    el.classList.remove('hidden');
    el.innerHTML = '<div class="remember-label">💭 Remember this?</div>' +
      '<div class="remember-body"><strong>' + esc(n.title) + '</strong> — ' + esc(snippet(n.solution || n.body, 160)) + '</div>' +
      '<div class="remember-actions"><button class="btn small" data-open="' + n.id + '">Open</button>' +
      '<button class="btn small" id="anotherTip">Show another</button></div>';
  }

  function renderProjects() {
    var ps = projects();
    var unassigned = notes().filter(function (n) { return !n.project; }).length;
    var el = $('#projectGrid');
    if (!ps.length) {
      el.innerHTML = '<div class="empty"><p>No projects yet. Give a note a project name and it will show up here.</p></div>';
      return;
    }
    el.innerHTML = ps.map(function (p) {
      var ns = notes().filter(function (n) { return n.project === p; });
      var open = ns.filter(isOpenProblem).length;
      var lessons = ns.filter(isLesson).length;
      var last = Math.max.apply(null, ns.map(function (n) { return n.updated || n.created; }));
      return '<button class="project-card" data-project="' + esc(p) + '">' +
        '<h3>' + esc(p) + '</h3>' +
        '<div class="stats"><span>' + ns.length + ' notes</span><span>' + lessons + ' lessons &amp; fixes</span>' +
        (open ? '<span class="warn">' + open + ' unsolved</span>' : '') + '</div>' +
        '<div class="meta">Last touched ' + timeAgo(last) + '</div></button>';
    }).join('') + (unassigned ? '<div class="muted small unassigned">' + unassigned + ' note(s) without a project</div>' : '');
    stagger(el, '.project-card');
  }

  function renderView(view) {
    if (view === 'notebook') renderNotebook();
    if (view === 'projects') renderProjects();
    if (view === 'stuck') renderFilters();
  }

  // Animated view switch: old view fades/blur out, new one rises in.
  var switching = null;
  function render(instant) {
    var next = $('#view-' + ui.view);
    var current = document.querySelector('.view.active');
    document.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('active', t.dataset.view === ui.view); });
    positionInk();
    renderView(ui.view);
    if (current === next) return;
    clearTimeout(switching);
    document.querySelectorAll('.view.leaving').forEach(function (v) { v.classList.remove('leaving'); });
    if (instant || !current) {
      if (current) current.classList.remove('active');
      next.classList.add('active');
      return;
    }
    current.classList.remove('active');
    current.classList.add('leaving');
    switching = setTimeout(function () {
      current.classList.remove('leaving');
      next.classList.add('active');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }, 200);
  }

  function positionInk() {
    var tab = document.querySelector('.tab.active');
    var ink = $('#tabInk');
    if (!tab || !ink) return;
    ink.style.left = (tab.offsetLeft + 12) + 'px';
    ink.style.width = Math.max(0, tab.offsetWidth - 24) + 'px';
  }
  window.addEventListener('resize', debounce(positionInk, 100));
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(positionInk);

  function go(view) { ui.view = view; render(); }

  // ==========================================================================
  // I'M STUCK
  // ==========================================================================
  function runStuck() {
    var q = $('#stuckInput').value.trim();
    var el = $('#stuckResults');
    if (!q) { el.innerHTML = ''; $('#stuckInput').focus(); return; }
    var stems = NoteSearch.tokenize(q);
    var results = NoteSearch.rank(notes(), q, { limit: 8 });
    var openSimilar = results.filter(function (r) { return isOpenProblem(r.note); });
    var helpful = results.filter(function (r) { return !isOpenProblem(r.note); });

    var html = '';
    if (helpful.length) {
      html += '<h2>From your notebook</h2><div class="note-list">' +
        helpful.map(function (r) { return noteCard(r.note, { stems: stems, matched: r.matched, helpButton: true, full: true }); }).join('') +
        '</div>';
    } else {
      html += '<div class="empty"><p>Nothing in your notes matches that yet. Once you solve it, write down what fixed it — next time it will show up here.</p></div>';
    }
    if (openSimilar.length) {
      html += '<h2>Similar problems you haven’t solved yet</h2><p class="muted">Maybe they share a cause.</p><div class="note-list">' +
        openSimilar.map(function (r) { return noteCard(r.note, { stems: stems, matched: r.matched, helpButton: true }); }).join('') +
        '</div>';
    }
    html += '<div class="checklist"><h2>General unsticking checklist</h2><ul>' +
      CHECKLIST.map(function (c) { return '<li><label><input type="checkbox"> ' + esc(c) + '</label></li>'; }).join('') +
      '</ul></div>';
    el.innerHTML = html;
    stagger(el, '.card');
  }

  // ==========================================================================
  // NOTE EDITOR
  // ==========================================================================
  var editor = $('#editor');
  var form = $('#editorForm');

  function openEditor(note, preset) {
    editingId = note ? note.id : null;
    var n = note || Object.assign({ kind: 'note' }, preset || {});
    $('#editorTitle').textContent = note ? 'Edit note' : 'New note';
    form.title.value = n.title || '';
    form.kind.value = n.kind || 'note';
    form.project.value = n.project || (!note && ui.filterProject !== 'all' ? ui.filterProject : '');
    form.body.value = n.body || '';
    form.solution.value = n.solution || '';
    form.tags.value = (n.tags || []).join(', ');
    form.pinned.checked = !!n.pinned;
    editPhotos = (n.photos || []).slice();
    renderPhotos();
    $('#deleteNoteBtn').classList.toggle('hidden', !note);
    toggleSolution();
    renderRelated();
    openModal(editor);
    setTimeout(function () { (n.title ? form.body : form.title).focus(); }, 40);
  }

  function toggleSolution() { $('#solutionField').classList.toggle('hidden', form.kind.value !== 'problem'); }

  function renderPhotos() {
    $('#photoStrip').innerHTML = editPhotos.map(function (p, i) {
      return '<div class="photo"><img src="' + esc(p) + '" alt="Photo ' + (i + 1) + '" data-view-photo="' + i + '">' +
        '<button type="button" data-remove-photo="' + i + '" aria-label="Remove photo">✕</button></div>';
    }).join('');
  }

  function renderRelated() {
    var q = [form.title.value, form.title.value, form.tags.value, form.body.value].join(' ');
    var el = $('#relatedList');
    var stems = NoteSearch.tokenize(q);
    if (!stems.length) {
      el.innerHTML = '<p class="muted small">Start writing and related notes, fixes and lessons will appear here.</p>';
      return;
    }
    var results = NoteSearch.rank(notes(), q, { limit: 5, excludeId: editingId });
    el.innerHTML = results.length
      ? results.map(function (r) {
          var n = r.note;
          return '<div class="related">' + '<div>' + badge(n) + '</div>' +
            '<div class="related-title">' + highlight(n.title, stems) + '</div>' +
            '<div class="small">' + highlight(snippet(n.solution || n.body, 140), stems) + '</div>' +
            (n.project ? '<div class="muted small">' + esc(n.project) + '</div>' : '') + '</div>';
        }).join('')
      : '<p class="muted small">Nothing related yet.</p>';
    stagger(el, '.related');
  }
  var renderRelatedSoon = debounce(renderRelated, 220);

  function saveFromForm() {
    var fields = {
      title: form.title.value.trim(),
      kind: form.kind.value,
      project: form.project.value.trim(),
      body: form.body.value.trim(),
      solution: form.kind.value === 'problem' ? form.solution.value.trim() : '',
      tags: form.tags.value.split(',').map(function (t) { return t.trim(); }).filter(Boolean),
      pinned: form.pinned.checked,
      photos: editPhotos.slice(),
      updated: Date.now()
    };
    if (!fields.title) { form.title.focus(); return false; }
    var n = editingId && data.notes.find(function (x) { return x.id === editingId; });
    if (n) {
      var wasOpen = isOpenProblem(n);
      Object.assign(n, fields);
      delete n.example;
      toast(wasOpen && fields.solution ? 'Problem solved — saved for next time 🎉' : 'Note saved');
    } else {
      data.notes.push(Object.assign({ id: uid(), created: Date.now(), helpful: 0 }, fields));
      toast('Note saved');
    }
    persist();
    return true;
  }

  form.addEventListener('input', renderRelatedSoon);
  form.kind.addEventListener('change', toggleSolution);
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!saveFromForm()) return;
    closeModal(editor);
    render();
    if (ui.view === 'stuck' && $('#stuckInput').value.trim()) runStuck();
  });
  $('#deleteNoteBtn').addEventListener('click', function () {
    if (!editingId) return;
    var id = editingId;
    ask({ title: 'Delete this note?', message: 'This can’t be undone.', confirmLabel: 'Delete note', danger: true }).then(function (yes) {
      if (!yes || !data) return;
      data.notes = data.notes.filter(function (n) { return n.id !== id; });
      persist(); closeModal(editor); render(); toast('Note deleted');
    });
  });
  $('#photoFile').addEventListener('change', function (e) {
    var files = Array.from(e.target.files || []);
    Promise.all(files.map(function (f) {
      return new Promise(function (r) { var fr = new FileReader(); fr.onload = function () { r(fr.result); }; fr.readAsDataURL(f); })
        .then(function (url) { return shrinkImage(url, 1280); });
    })).then(function (urls) { editPhotos = editPhotos.concat(urls); renderPhotos(); })
      .catch(function () { toast('Couldn’t read that image'); })
      .finally(function () { e.target.value = ''; });
  });
  $('#photoStrip').addEventListener('click', function (e) {
    var rm = e.target.closest('[data-remove-photo]');
    if (rm) { editPhotos.splice(+rm.dataset.removePhoto, 1); renderPhotos(); return; }
    var v = e.target.closest('[data-view-photo]');
    if (v) { $('#photoBig').src = v.src; openModal($('#photoDialog')); }
  });

  // ==========================================================================
  // CAMERAS
  // ==========================================================================
  Cameras.init({
    hooks: {
      toast: toast,
      onChange: function (n) {
        var pill = $('#livePill');
        pill.textContent = n;
        pill.classList.toggle('hidden', !n);
        positionInk();
      },
      saveNetwork: function (list) { if (data) { data.cameras = list; persist(); } },
      onSnapshot: function (url, camName) {
        var stamp = new Date().toLocaleString();
        openEditor(null, { title: 'Snapshot — ' + camName, body: 'Taken ' + stamp, photos: [url], tags: ['snapshot'] });
      }
    }
  });
  $('#startCamsBtn').addEventListener('click', function () { Cameras.startDeviceCameras(); });
  $('#addCamBtn').addEventListener('click', function () { $('#camForm').reset(); openModal($('#camDialog')); });
  $('#camForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var f = e.target;
    Cameras.addNetworkCam({ name: f.name.value.trim(), url: f.url.value.trim(), refresh: Math.max(0, +f.refresh.value || 0) });
    closeModal($('#camDialog'));
  });

  // ==========================================================================
  // SETTINGS, BACKUP
  // ==========================================================================
  $('#settingsBtn').addEventListener('click', function () {
    $('#autoLockSelect').value = String(data.settings.autoLock || 5);
    $('#changePassForm').reset();
    openModal($('#settingsDialog'));
  });
  $('#autoLockSelect').addEventListener('change', function (e) {
    data.settings.autoLock = +e.target.value; persist(); toast('Auto-lock set to ' + e.target.selectedOptions[0].textContent);
  });
  $('#changePassForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var oldP = $('#oldPass').value, newP = $('#newPass').value;
    if (newP.length < 8) { toast('New passphrase needs at least 8 characters'); return; }
    saveChain.then(function () { return Vault.changePassphrase(oldP, newP, data); })
      .then(function () { e.target.reset(); toast('Passphrase changed'); },
            function () { toast('Current passphrase is wrong'); });
  });
  $('#exportBtn').addEventListener('click', function () {
    var filename = 'invention-notebook-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    Vault.exportBackup(data).then(function (backup) {
      var text = JSON.stringify(backup);
      // Inside a claude.ai page, downloads go through the viewer's save prompt.
      var viaHost = window.claude && window.claude.use ? window.claude.use('downloads') : Promise.resolve(null);
      return viaHost.then(function (downloads) {
        if (downloads) {
          return downloads.save({ filename: filename, data: text }).then(function () { toast('Encrypted backup saved'); },
            function (err) { if (!err || err.code !== 'declined') toast('Couldn’t save the backup here'); });
        }
        var a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
        a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
        toast('Encrypted backup downloaded');
      });
    });
  });
  $('#importFile').addEventListener('change', function (e) {
    var file = e.target.files[0];
    if (!file) return;
    file.text().then(function (txt) {
      var obj = JSON.parse(txt);
      if (obj.format !== 'encrypted-backup') throw new Error('format');
      return ask({ title: 'Unlock backup', message: 'Enter the passphrase this backup was made with.', input: 'password', confirmLabel: 'Restore' })
        .then(function (pass) { return pass == null || !data ? null : Vault.readBackup(obj, pass); });
    }).then(function (incoming) {
      if (!incoming) return;
      var ids = new Set(data.notes.map(function (n) { return n.id; }));
      var added = 0;
      (incoming.notes || []).forEach(function (n) {
        if (!n || typeof n.title !== 'string' || ids.has(n.id)) return;
        n.id = n.id || uid();
        n.tags = Array.isArray(n.tags) ? n.tags.map(String) : [];
        n.kind = KINDS[n.kind] ? n.kind : 'note';
        data.notes.push(n); ids.add(n.id); added++;
      });
      persist(); render(); toast('Restored ' + added + ' note(s)');
    }).catch(function (err) {
      toast(err && err.message === 'WRONG_PASSPHRASE' ? 'Wrong passphrase for that backup' : 'That file isn’t a notebook backup');
    }).finally(function () { e.target.value = ''; });
  });
  $('#wipeBtn').addEventListener('click', function () {
    ask({ title: 'Erase everything?', message: 'This permanently deletes every note on this device.\nType ERASE to confirm.',
      input: 'text', placeholder: 'ERASE', confirmLabel: 'Erase everything', danger: true }).then(function (answer) {
      if (answer !== 'ERASE') { if (answer != null) toast('Nothing erased — type ERASE exactly'); return; }
      Cameras.stopAll();
      Vault.wipe().then(function () { data = null; location.reload(); });
    });
  });

  // ==========================================================================
  // GLOBAL EVENTS
  // ==========================================================================
  document.querySelectorAll('.tab').forEach(function (t) {
    t.addEventListener('click', function () { go(t.dataset.view); });
  });
  $('#newNoteBtn').addEventListener('click', function () { openEditor(null); });
  $('#lockBtn').addEventListener('click', function () { lockNow('Locked by you'); });
  $('#searchBox').addEventListener('input', debounce(function (e) { ui.query = e.target.value; renderNotebook(); }, 120));
  $('#projectFilter').addEventListener('change', function (e) { ui.filterProject = e.target.value; renderNotebook(); });
  $('#clearExamplesBtn').addEventListener('click', function () {
    data.notes = data.notes.filter(function (n) { return !n.example; });
    persist(); render(); toast('Examples removed');
  });
  $('#stuckBtn').addEventListener('click', runStuck);
  $('#stuckInput').addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) runStuck(); });
  $('#logProblemBtn').addEventListener('click', function () {
    var q = $('#stuckInput').value.trim();
    openEditor(null, { kind: 'problem', title: snippet(q.split(/[.\n]/)[0], 80), body: q });
  });

  $('#app').addEventListener('click', function (e) {
    var t = e.target;
    var kind = t.closest('[data-kind]');
    if (kind) { ui.filterKind = kind.dataset.kind; renderNotebook(); return; }

    var helpful = t.closest('[data-helpful]');
    if (helpful) {
      var hn = data.notes.find(function (n) { return n.id === helpful.dataset.helpful; });
      if (hn) {
        hn.helpful = (hn.helpful || 0) + 1; persist();
        helpful.textContent = '👍 This helped (' + hn.helpful + ')';
        toast('Got it — this note will rank higher next time');
      }
      return;
    }

    var proj = t.closest('[data-project]');
    if (proj) { ui.filterProject = proj.dataset.project; ui.filterKind = 'all'; go('notebook'); return; }
    if (t.closest('[data-new]')) { openEditor(null); return; }
    if (t.id === 'anotherTip') { rememberPick = null; renderRemember(); return; }

    var open = t.closest('[data-open]');
    if (open) {
      var on = data.notes.find(function (n) { return n.id === open.dataset.open; });
      if (on) openEditor(on);
    }
  });
  $('#app').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target.matches('.card[data-open]')) e.target.click();
  });

  document.addEventListener('keydown', function (e) {
    if (!data) return;
    if (e.altKey && (e.key === 'l' || e.key === 'L')) { e.preventDefault(); lockNow('Locked by you'); return; }
    var typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    var modalOpen = !!document.querySelector('dialog.modal[open]');
    if (typing || modalOpen || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'n') { e.preventDefault(); openEditor(null); }
    if (e.key === '/') { e.preventDefault(); go('notebook'); setTimeout(function () { $('#searchBox').focus(); }, 260); }
  });

  // Save before the tab goes away.
  window.addEventListener('pagehide', function () { persist(); });

  // ==========================================================================
  // START
  // ==========================================================================
  function startLockScreen() {
    if (!Vault.supported()) {
      bootSequence([{ text: 'Secure storage unavailable' }]).then(function () {
        lockMsg.textContent = 'This browser can’t run the encrypted vault here. Open the site over https (e.g. GitHub Pages) in an up-to-date browser.';
        lockForm.classList.remove('hidden');
        lockForm.querySelectorAll('input, button').forEach(function (el) { el.disabled = true; });
      });
      return;
    }
    Vault.exists().then(function (exists) {
      setupMode = !exists;
      lockPanel.classList.remove('granted');
      $('#lockSub').textContent = 'Secure vault';
      var lines = exists
        ? [{ text: 'Initializing secure vault' }, { text: 'Encrypted notebook found' }, { text: 'Awaiting passphrase', ok: true }]
        : [{ text: 'Initializing secure vault' }, { text: 'No vault on this device' }, { text: 'Create a passphrase to seal it', ok: true }];
      return bootSequence(lines).then(showLockForm);
    }).catch(function () {
      lockMsg.textContent = 'Storage is blocked in this browser window (private mode?).';
    });
  }

  if (!document.body.classList.contains('is-unlocked')) document.body.classList.add('is-locked');
  $('#app').inert = true;
  startLockScreen();
})();
