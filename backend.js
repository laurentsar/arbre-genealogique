/* backend.js — synchronisation CHIFFRÉE de l'arbre avec Home Assistant, AUTONOME.
 *
 * Ne modifie pas l'app : on intercepte les écritures localStorage de store.js
 * (clé "genealogie:data:v1") pour pousser vers HA, et on recharge la page quand
 * l'état distant est plus récent. Compatible avec toute version de l'app.
 *
 * Sécurité : les données sont chiffrées côté client (AES-GCM 256, clé dérivée
 * d'un mot de passe famille via PBKDF2). HA ne stocke qu'un blob chiffré ; le
 * fichier /local public est donc illisible sans le mot de passe, et une écriture
 * forgée ne peut pas être déchiffrée. Seuls meta.updatedAt/device restent en
 * clair (comparaison de fraîcheur, last-write-wins).
 *
 * Config (URL webhook + fichier) : window.GENEALOGIE_BACKEND (backend-config.js),
 * présent uniquement sur l'instance HA / le build privé. Absent → module inerte.
 *
 * ⚠️ crypto.subtle exige un contexte sécurisé : OK en https (Nabu Casa) et sur
 * l'APK (https://localhost), PAS en http LAN. Sinon on n'écrit rien (fail-safe).
 */
(function () {
  'use strict';

  var cfg = window.GENEALOGIE_BACKEND;
  if (!cfg || !cfg.webhookUrl || !cfg.dataUrl) return;
  if (typeof localStorage === 'undefined') return;

  var KEY = 'genealogie:data:v1';   // doit correspondre à store.js
  var PW_KEY = 'genealogie:pw';      // mot de passe famille (mémorisé)
  var SALT_KEY = 'genealogie:salt';  // sel PBKDF2 partagé (base64)
  var ITER = 200000;

  var crypto = window.crypto;
  var subtle = crypto && crypto.subtle;

  var deviceId = getDeviceId();
  var pushTimer = null;
  var lastSyncedJSON = null;
  var applying = false;
  var cryptoKey = null;    // CryptoKey AES-GCM dérivée
  var keyForSalt = null;   // sel avec lequel cryptoKey a été dérivée

  function getDeviceId() {
    var k = 'genealogie:deviceId';
    var v = localStorage.getItem(k);
    if (!v) { v = 'dev' + Math.random().toString(36).slice(2, 10); localStorage.setItem(k, v); }
    return v;
  }

  // --- utilitaires base64 <-> octets --------------------------------------
  function bytesToB64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function b64ToBytes(str) {
    var s = atob(str), a = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
    return a;
  }
  function strToB64(str) { return btoa(unescape(encodeURIComponent(str))); } // UTF-8

  function readLocal() {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; }
  }
  function localUpdatedAt() {
    var s = readLocal(); return (s && s.meta && s.meta.updatedAt) || 0;
  }

  // --- crypto -------------------------------------------------------------
  function getSaltBytes() {
    var b64 = localStorage.getItem(SALT_KEY);
    if (!b64) {
      var salt = crypto.getRandomValues(new Uint8Array(16));
      b64 = bytesToB64(salt);
      localStorage.setItem(SALT_KEY, b64);
    }
    return b64ToBytes(b64);
  }
  function currentSaltB64() { return localStorage.getItem(SALT_KEY); }

  function deriveKey(password, saltBytes) {
    var enc = new TextEncoder();
    return subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey'])
      .then(function (base) {
        return subtle.deriveKey(
          { name: 'PBKDF2', salt: saltBytes, iterations: ITER, hash: 'SHA-256' },
          base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      });
  }

  // Garantit une clé dérivée du mot de passe + sel courant (prompt si besoin).
  function ensureKey() {
    var salt = currentSaltB64();
    if (cryptoKey && keyForSalt === salt) return Promise.resolve(cryptoKey);
    return ensurePassword().then(function (pw) {
      var saltBytes = getSaltBytes();
      return deriveKey(pw, saltBytes).then(function (k) {
        cryptoKey = k; keyForSalt = currentSaltB64(); return k;
      });
    });
  }

  function encryptState(plaintextStr) {
    return ensureKey().then(function (k) {
      var iv = crypto.getRandomValues(new Uint8Array(12));
      return subtle.encrypt({ name: 'AES-GCM', iv: iv }, k, new TextEncoder().encode(plaintextStr))
        .then(function (buf) {
          return { iv: bytesToB64(iv), ct: bytesToB64(new Uint8Array(buf)) };
        });
    });
  }
  function decryptEnvelope(env) {
    return ensureKey().then(function (k) {
      return subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(env.iv) }, k, b64ToBytes(env.ct))
        .then(function (buf) { return new TextDecoder().decode(buf); });
    });
  }

  // --- saisie du mot de passe (overlay minimal, aucune dépendance) --------
  var pwResolve = null;
  function ensurePassword() {
    var pw = localStorage.getItem(PW_KEY);
    if (pw) return Promise.resolve(pw);
    return askPassword(false);
  }
  function askPassword(isError) {
    return new Promise(function (resolve) {
      pwResolve = resolve;
      showOverlay(isError);
    });
  }
  function showOverlay(isError) {
    if (document.getElementById('genPwOverlay')) {
      var e = document.getElementById('genPwErr');
      if (e) e.style.display = isError ? 'block' : 'none';
      return;
    }
    var wrap = document.createElement('div');
    wrap.id = 'genPwOverlay';
    wrap.setAttribute('style', 'position:fixed;inset:0;z-index:99999;background:rgba(20,15,10,.92);' +
      'display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif');
    wrap.innerHTML =
      '<form id="genPwForm" style="background:#241a12;color:#f0e7db;padding:22px;border-radius:14px;' +
      'width:min(340px,86vw);box-shadow:0 10px 40px rgba(0,0,0,.5)">' +
      '<h2 style="margin:0 0 6px;font-size:18px">🔒 Arbre généalogique</h2>' +
      '<p style="margin:0 0 12px;font-size:13px;opacity:.8">Mot de passe famille (protège la synchronisation).</p>' +
      '<input id="genPwInput" type="password" autocomplete="current-password" ' +
      'style="width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #5a483a;' +
      'background:#1b130d;color:#fff;font-size:15px" placeholder="Mot de passe">' +
      '<p id="genPwErr" style="display:' + (isError ? 'block' : 'none') + ';color:#ff9a8a;font-size:12px;margin:8px 0 0">' +
      'Mot de passe incorrect.</p>' +
      '<button type="submit" style="margin-top:12px;width:100%;padding:11px;border:0;border-radius:8px;' +
      'background:#c8722e;color:#fff;font-size:15px;font-weight:600">Déverrouiller</button></form>';
    document.body.appendChild(wrap);
    var form = document.getElementById('genPwForm');
    var input = document.getElementById('genPwInput');
    setTimeout(function () { input.focus(); }, 50);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var val = input.value;
      if (!val) return;
      localStorage.setItem(PW_KEY, val);
      cryptoKey = null; // force re-dérivation
      wrap.remove();
      var r = pwResolve; pwResolve = null;
      if (r) r(val);
    });
  }
  function badPassword() {
    localStorage.removeItem(PW_KEY);
    cryptoKey = null;
    return askPassword(true);
  }

  // --- interception des écritures de l'app --------------------------------
  var rawSet = localStorage.setItem.bind(localStorage);
  localStorage.setItem = function (k, v) {
    rawSet(k, v);
    if (k === KEY && !applying) schedulePush();
  };
  function writeLocalSilently(json) { applying = true; rawSet(KEY, json); applying = false; }

  function schedulePush() {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(stampAndPush, 900);
  }

  function stampAndPush() {
    if (!subtle) { console.warn('genealogie: crypto indisponible (http ?) → pas de sync'); return; }
    var s = readLocal();
    if (!s) return;
    s.meta = s.meta || {};
    s.meta.updatedAt = Date.now();
    s.meta.device = deviceId;
    var plain = JSON.stringify(s);
    writeLocalSilently(plain);
    if (plain === lastSyncedJSON) return;
    encryptState(plain).then(function (enc) {
      var envelope = {
        enc: 'v1', salt: currentSaltB64(), iv: enc.iv, ct: enc.ct,
        meta: { updatedAt: s.meta.updatedAt, device: deviceId }
      };
      return fetch(cfg.webhookUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ b64: strToB64(JSON.stringify(envelope)), device: deviceId })
      });
    }).then(function (r) { if (r && r.ok) lastSyncedJSON = plain; })
      .catch(function (e) { console.warn('genealogie: push échoué', e); });
  }

  function adoptRemote(remoteStr, updatedAt) {
    if (updatedAt > localUpdatedAt()) {
      lastSyncedJSON = remoteStr;
      writeLocalSilently(remoteStr);
      location.reload();
    }
  }

  function pull() {
    if (!subtle) return;
    var url = cfg.dataUrl + (cfg.dataUrl.indexOf('?') === -1 ? '?' : '&') + '_=' + Date.now();
    fetch(url, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (env) {
        if (!env) return;
        if (env.enc === 'v1' && env.ct) {
          // adopte le sel du serveur (clé partagée famille)
          if (env.salt && env.salt !== currentSaltB64()) {
            localStorage.setItem(SALT_KEY, env.salt); cryptoKey = null;
          }
          var ru = (env.meta && env.meta.updatedAt) || 0;
          if (ru <= localUpdatedAt()) return; // rien de plus récent → pas de déchiffrement
          decryptEnvelope(env)
            .then(function (plain) { adoptRemote(plain, ru); })
            .catch(function () { badPassword().then(pull); });
        } else if (env.persons) { // legacy clair (seed / avant chiffrement)
          adoptRemote(JSON.stringify(env), (env.meta && env.meta.updatedAt) || 0);
        }
      })
      .catch(function () { /* hors-ligne : on garde la copie locale */ });
  }

  pull();
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') pull();
  });
  window.addEventListener('focus', pull);
})();
