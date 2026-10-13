// Relevance engine: finds past notes that relate to what you're working on.
// Works in the browser (window.NoteSearch) and in Node (module.exports) for tests.
(function (root) {
  'use strict';

  var STOPWORDS = new Set((
    'a an and are as at be been but by can could did do does doing done for from had has have how i if in into is it its ' +
    'just me my no not of on or our so some than that the their them then there these they this to too up was we were ' +
    'what when where which while who why will with would you your im ive dont doesnt didnt isnt wont cant get got getting ' +
    'thing things stuff really very still keep keeps kept again also any all only out over about after before because ' +
    'trying tried try want need make making made work working works worked'
  ).split(/\s+/));

  // Maker-flavoured synonym groups so "glue" finds "adhesive", "servo" finds "motor", etc.
  var SYNONYM_GROUPS = [
    ['glue', 'adhesive', 'epoxy', 'superglue', 'cyanoacrylate', 'bond', 'stick'],
    ['motor', 'servo', 'stepper', 'actuator'],
    ['battery', 'power', 'voltage', 'volt', 'lipo', 'charge', 'supply'],
    ['wire', 'wiring', 'cable', 'lead', 'connector'],
    ['solder', 'soldering', 'joint', 'flux'],
    ['print', '3d', 'printer', 'filament', 'pla', 'petg', 'nozzle', 'layer'],
    ['screw', 'bolt', 'nut', 'fastener', 'thread'],
    ['break', 'broke', 'broken', 'crack', 'snap', 'fail', 'failure', 'fracture'],
    ['hot', 'heat', 'overheat', 'temperature', 'thermal', 'burn', 'melt'],
    ['loose', 'wobble', 'wobbly', 'slip', 'slipping', 'play', 'rattle'],
    ['code', 'program', 'sketch', 'firmware', 'script', 'software'],
    ['arduino', 'microcontroller', 'esp32', 'esp8266', 'pico', 'raspberry', 'board'],
    ['sensor', 'detect', 'reading', 'measure', 'measurement'],
    ['light', 'led', 'lamp', 'bright'],
    ['wood', 'plywood', 'timber', 'mdf'],
    ['cut', 'saw', 'drill', 'hole'],
    ['weak', 'flimsy', 'strong', 'strength', 'sturdy', 'rigid'],
    ['leak', 'seal', 'waterproof', 'water', 'gasket'],
    ['noise', 'noisy', 'loud', 'vibration', 'vibrate', 'hum', 'buzz'],
    ['slow', 'speed', 'fast', 'rpm', 'torque'],
    ['measure', 'size', 'dimension', 'tolerance', 'fit', 'gap', 'clearance'],
    ['short', 'spark', 'fuse', 'smoke'],
    ['spring', 'tension', 'elastic'],
    ['magnet', 'magnetic'],
    ['paint', 'finish', 'coat', 'sand', 'sanding']
  ];

  function stem(word) {
    // Tiny suffix stripper: good enough to match "gears"/"gear", "glued"/"glue", "wobbling"/"wobbl".
    if (word.length <= 3) return word;
    var rules = [
      ['ies', 'y'], ['ing', ''], ['edly', ''], ['ed', ''], ['ly', ''], ['es', ''], ['s', '']
    ];
    for (var i = 0; i < rules.length; i++) {
      var suf = rules[i][0];
      if (word.length - suf.length >= 3 && word.slice(-suf.length) === suf) {
        word = word.slice(0, -suf.length) + rules[i][1];
        break;
      }
    }
    // collapse doubled final consonant: "stopp" -> "stop"
    if (word.length > 3 && word[word.length - 1] === word[word.length - 2] && !/[aeiou]/.test(word[word.length - 1])) {
      word = word.slice(0, -1);
    }
    return word;
  }

  var SYNONYMS = new Map();
  SYNONYM_GROUPS.forEach(function (group) {
    var stems = group.map(stem);
    stems.forEach(function (s) {
      var set = SYNONYMS.get(s) || new Set();
      stems.forEach(function (o) { if (o !== s) set.add(o); });
      SYNONYMS.set(s, set);
    });
  });

  function tokenize(text) {
    if (!text) return [];
    return String(text)
      .toLowerCase()
      .replace(/['’]/g, '')
      .split(/[^a-z0-9]+/)
      .filter(function (w) { return w && w.length > 1 && !STOPWORDS.has(w); })
      .map(stem);
  }

  function noteFields(note) {
    return {
      title: tokenize(note.title),
      tags: tokenize((note.tags || []).join(' ')),
      body: tokenize((note.body || '') + ' ' + (note.solution || '')),
      project: tokenize(note.project)
    };
  }

  var FIELD_WEIGHT = { title: 3, tags: 3, body: 1, project: 0.5 };
  // Notes that record what worked are the most useful when you're stuck.
  var KIND_BOOST = { lesson: 1.5, fix: 1.5, tip: 1.3, problem: 1.0, idea: 0.9, note: 1.0 };

  // Builds an index over notes, then ranks them against free text.
  function rank(notes, query, options) {
    options = options || {};
    var excludeId = options.excludeId;
    var limit = options.limit || 10;

    var qTokens = Array.from(new Set(tokenize(query)));
    if (!qTokens.length) return [];

    var docs = notes
      .filter(function (n) { return n.id !== excludeId; })
      .map(function (n) { return { note: n, fields: noteFields(n) }; });
    if (!docs.length) return [];

    // document frequency for idf
    var df = new Map();
    docs.forEach(function (d) {
      var seen = new Set([].concat(d.fields.title, d.fields.tags, d.fields.body, d.fields.project));
      seen.forEach(function (t) { df.set(t, (df.get(t) || 0) + 1); });
    });
    var N = docs.length;
    function idf(t) { return Math.log(1 + N / (1 + (df.get(t) || 0))) + 0.1; }

    var results = [];
    docs.forEach(function (d) {
      var score = 0;
      var matched = new Set();
      qTokens.forEach(function (q) {
        var best = 0;
        var bestWord = null;
        Object.keys(FIELD_WEIGHT).forEach(function (field) {
          var toks = d.fields[field];
          if (!toks.length) return;
          var exact = 0, syn = 0, prefix = 0;
          var syns = SYNONYMS.get(q);
          toks.forEach(function (t) {
            if (t === q) exact++;
            else if (syns && syns.has(t)) syn++;
            else if (q.length >= 4 && t.length >= 4 && (t.indexOf(q) === 0 || q.indexOf(t) === 0)) prefix++;
          });
          var raw = exact + 0.6 * syn + 0.4 * prefix;
          if (!raw) return;
          // dampen repeated terms, scale by field importance
          var s = (1 + Math.log(raw)) * FIELD_WEIGHT[field];
          if (s > best) { best = s; bestWord = q; }
        });
        if (best) {
          score += best * idf(q);
          matched.add(bestWord);
        }
      });
      if (!score) return;
      // reward notes that cover more of the query
      var coverage = matched.size / qTokens.length;
      score *= 0.5 + coverage;
      score *= (d.note.kind === 'problem' && d.note.solution) ? 1.5 : (KIND_BOOST[d.note.kind] || 1);
      if (d.note.pinned) score *= 1.15;
      score *= 1 + Math.min(d.note.helpful || 0, 10) * 0.05;
      results.push({ note: d.note, score: score, matched: Array.from(matched) });
    });

    results.sort(function (a, b) { return b.score - a.score; });
    return results.slice(0, limit);
  }

  // Returns words in `text` whose stem (or a synonym of it) is in `stems`, for highlighting.
  function matchesWord(word, stems) {
    var s = stem(word.toLowerCase().replace(/['’]/g, ''));
    if (!s) return false;
    for (var i = 0; i < stems.length; i++) {
      var q = stems[i];
      if (s === q) return true;
      var syns = SYNONYMS.get(q);
      if (syns && syns.has(s)) return true;
      if (q.length >= 4 && s.length >= 4 && (s.indexOf(q) === 0 || q.indexOf(s) === 0)) return true;
    }
    return false;
  }

  var api = { tokenize: tokenize, stem: stem, rank: rank, matchesWord: matchesWord };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NoteSearch = api;
})(typeof window !== 'undefined' ? window : this);
