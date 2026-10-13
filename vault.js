// Encrypted vault: everything you write is stored encrypted with AES-256-GCM.
// The key is derived from your passphrase (PBKDF2-SHA256) and only ever lives in memory
// while the notebook is unlocked. Without the passphrase the stored data is unreadable.
(function (root) {
  'use strict';

  var DB_NAME = 'invention-notebook';
  var STORE = 'kv';
  var RECORD = 'vault';
  var ITERATIONS = 600000;
  var THROTTLE_KEY = 'inventionNotebook.throttle';

  var key = null;   // CryptoKey while unlocked
  var salt = null;  // salt of the current vault

  // ---------- tiny IndexedDB wrapper ----------
  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore(STORE); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function tx(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, mode);
        var req = fn(t.objectStore(STORE));
        t.oncomplete = function () { db.close(); resolve(req && req.result); };
        t.onerror = t.onabort = function () { db.close(); reject(t.error); };
      });
    });
  }
  function idbGet(k) { return tx('readonly', function (s) { return s.get(k); }); }
  function idbPut(k, v) { return tx('readwrite', function (s) { return s.put(v, k); }); }
  function idbDel(k) { return tx('readwrite', function (s) { return s.delete(k); }); }

  // ---------- crypto ----------
  var enc = new TextEncoder();
  var dec = new TextDecoder();

  function rand(n) { return crypto.getRandomValues(new Uint8Array(n)); }

  function deriveKey(pass, saltBytes, iterations) {
    return crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']).then(function (base) {
      return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: saltBytes, iterations: iterations, hash: 'SHA-256' },
        base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    });
  }

  function encryptWith(k, saltBytes, data) {
    var iv = rand(12);
    return crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, k, enc.encode(JSON.stringify(data))).then(function (ct) {
      return { v: 1, kdf: 'PBKDF2-SHA256', iterations: ITERATIONS, salt: saltBytes, iv: iv, ct: new Uint8Array(ct) };
    });
  }

  function decryptRecord(rec, pass) {
    return deriveKey(pass, rec.salt, rec.iterations).then(function (k) {
      return crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv }, k, rec.ct).then(function (pt) {
        return { key: k, data: JSON.parse(dec.decode(pt)) };
      }, function () { throw new Error('WRONG_PASSPHRASE'); });
    });
  }

  // ---------- brute-force throttle ----------
  // Slows down guessing at the lock screen. (The real protection is the encryption itself.)
  function throttle() {
    try { return JSON.parse(localStorage.getItem(THROTTLE_KEY)) || { fails: 0, until: 0 }; }
    catch (e) { return { fails: 0, until: 0 }; }
  }
  function setThrottle(t) { try { localStorage.setItem(THROTTLE_KEY, JSON.stringify(t)); } catch (e) { /* ignore */ } }
  function lockedOutFor() { return Math.max(0, throttle().until - Date.now()); }
  function recordFail() {
    var t = throttle();
    t.fails += 1;
    if (t.fails >= 5) t.until = Date.now() + Math.min(30000 * Math.pow(2, t.fails - 5), 15 * 60000);
    setThrottle(t);
    return t;
  }

  // ---------- base64 for backups ----------
  function toB64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function fromB64(str) {
    var s = atob(str), out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  var Vault = {
    supported: function () {
      return !!(root.crypto && crypto.subtle && root.indexedDB);
    },
    exists: function () { return idbGet(RECORD).then(function (r) { return !!r; }); },
    isUnlocked: function () { return !!key; },
    lockedOutFor: lockedOutFor,
    failCount: function () { return throttle().fails; },

    create: function (pass, data) {
      var s = rand(16);
      return deriveKey(pass, s, ITERATIONS).then(function (k) {
        return encryptWith(k, s, data).then(function (rec) {
          return idbPut(RECORD, rec).then(function () { key = k; salt = s; setThrottle({ fails: 0, until: 0 }); });
        });
      });
    },

    unlock: function (pass) {
      var wait = lockedOutFor();
      if (wait) return Promise.reject(Object.assign(new Error('LOCKED_OUT'), { wait: wait }));
      return idbGet(RECORD).then(function (rec) {
        if (!rec) throw new Error('NO_VAULT');
        return decryptRecord(rec, pass).then(function (res) {
          key = res.key; salt = rec.salt;
          setThrottle({ fails: 0, until: 0 });
          return res.data;
        }, function (err) {
          var t = recordFail();
          err.fails = t.fails;
          err.wait = lockedOutFor();
          throw err;
        });
      });
    },

    save: function (data) {
      if (!key) return Promise.reject(new Error('LOCKED'));
      return encryptWith(key, salt, data).then(function (rec) { return idbPut(RECORD, rec); });
    },

    lock: function () { key = null; salt = null; },

    changePassphrase: function (oldPass, newPass, data) {
      return idbGet(RECORD).then(function (rec) { return decryptRecord(rec, oldPass); }).then(function () {
        return Vault.create(newPass, data);
      });
    },

    wipe: function () {
      key = null; salt = null;
      setThrottle({ fails: 0, until: 0 });
      return idbDel(RECORD);
    },

    // Backups are encrypted with the same passphrase, so the file is safe to keep anywhere.
    exportBackup: function (data) {
      if (!key) return Promise.reject(new Error('LOCKED'));
      return encryptWith(key, salt, data).then(function (rec) {
        return { app: 'invention-notebook', format: 'encrypted-backup', v: 1, kdf: rec.kdf, iterations: rec.iterations,
          salt: toB64(rec.salt), iv: toB64(rec.iv), ct: toB64(rec.ct), exported: new Date().toISOString() };
      });
    },
    readBackup: function (obj, pass) {
      var rec = { salt: fromB64(obj.salt), iv: fromB64(obj.iv), ct: fromB64(obj.ct), iterations: obj.iterations || ITERATIONS };
      return decryptRecord(rec, pass).then(function (res) { return res.data; });
    }
  };

  root.Vault = Vault;
})(window);
