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
 * CONFIG — deux sources, dans l'ordre (modèle gesthote : rien de secret dans le
 * build public) :
 *   1. window.GENEALOGIE_BACKEND (backend-config.js) — présent sur l'instance HA
 *      servie (URLs RELATIVES, même origine). Prioritaire.
 *   2. localStorage "genealogie:backend" = { baseUrl, webhookId } — saisi par
 *      l'utilisateur dans le panneau réglages (bouton ☁ auto-injecté). C'est ce
 *      qui rend l'APK Release PUBLIC fonctionnel sans embarquer le moindre secret.
 * Non configuré → aucune sync, l'app reste 100 % locale (localStorage).
 *
 * ⚠️ crypto.subtle exige un contexte sécurisé : OK en https (Nabu Casa) et sur
 * l'APK (https://localhost), PAS en http LAN. Sinon on n'écrit rien (fail-safe).
 * ⚠️ Depuis un navigateur, une URL HA ABSOLUE tombe sous le coup du CORS. Ça
 * marche sur l'APK (CapacitorHttp = requêtes natives) et sur la page servie par
 * HA (même origine, URLs relatives). github.io reste donc une démo.
 */
(function () {
  'use strict';

  if (typeof localStorage === 'undefined') return;

  var KEY = 'genealogie:data:v1';   // doit correspondre à store.js
  var PW_KEY = 'genealogie:pw';      // mot de passe famille (mémorisé)
  var SALT_KEY = 'genealogie:salt';  // sel PBKDF2 partagé (base64)
  var CFG_KEY = 'genealogie:backend'; // config saisie à l'exécution (JSON)
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

  // --- résolution de la config (bakée > saisie utilisateur) ----------------
  function loadStored() {
    try { return JSON.parse(localStorage.getItem(CFG_KEY) || '{}'); } catch (e) { return {}; }
  }
  function deriveFromStored(st) {
    if (!st || !st.baseUrl || !st.webhookId) return { webhookUrl: '', dataUrl: '' };
    var base = String(st.baseUrl).trim().replace(/\/+$/, '');
    var id = String(st.webhookId).trim();
    return {
      webhookUrl: base + '/api/webhook/' + id,
      dataUrl: base + '/local/genealogie/data/tree.json'
    };
  }
  function resolved() {
    var b = window.GENEALOGIE_BACKEND;
    if (b && b.webhookUrl && b.dataUrl) return { webhookUrl: b.webhookUrl, dataUrl: b.dataUrl };
    return deriveFromStored(loadStored());
  }
  function hasBaked() {
    var b = window.GENEALOGIE_BACKEND;
    return !!(b && b.webhookUrl && b.dataUrl);
  }
  function configured() {
    var r = resolved();
    return !!(r.webhookUrl && r.dataUrl);
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
  function localHasData() {
    var s = readLocal(); return !!(s && s.persons && Object.keys(s.persons).length);
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

  // Compression gzip AVANT chiffrement : le JSON généalogie se compresse ~6-10×.
  // Indispensable car HA limite le rendu d'un template (le webhook passe la
  // charge via `{{ trigger.json.b64 }}`) à 262144 caractères — un gros arbre
  // sans compression dépasse et l'écriture échoue. Repli sans zip si l'API
  // CompressionStream est absente (vieux WebView).
  function gzipBytes(str) {
    var enc = new TextEncoder().encode(str);
    if (typeof CompressionStream === 'undefined') return Promise.resolve({ bytes: enc, zip: null });
    try {
      var cs = new CompressionStream('gzip');
      var w = cs.writable.getWriter(); w.write(enc); w.close();
      return new Response(cs.readable).arrayBuffer()
        .then(function (b) { return { bytes: new Uint8Array(b), zip: 'gzip' }; })
        .catch(function () { return { bytes: enc, zip: null }; });
    } catch (e) { return Promise.resolve({ bytes: enc, zip: null }); }
  }
  function gunzipToStr(bytes) {
    var ds = new DecompressionStream('gzip');
    var w = ds.writable.getWriter(); w.write(bytes); w.close();
    return new Response(ds.readable).arrayBuffer()
      .then(function (b) { return new TextDecoder().decode(b); });
  }

  function encryptState(plaintextStr) {
    return ensureKey().then(function (k) {
      return gzipBytes(plaintextStr).then(function (p) {
        var iv = crypto.getRandomValues(new Uint8Array(12));
        return subtle.encrypt({ name: 'AES-GCM', iv: iv }, k, p.bytes)
          .then(function (buf) {
            return { iv: bytesToB64(iv), ct: bytesToB64(new Uint8Array(buf)), zip: p.zip };
          });
      });
    });
  }
  function decryptEnvelope(env) {
    return ensureKey().then(function (k) {
      return subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(env.iv) }, k, b64ToBytes(env.ct))
        .then(function (buf) {
          if (env.zip === 'gzip') return gunzipToStr(new Uint8Array(buf));
          return new TextDecoder().decode(buf);
        });
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

  // --- configuration DANS l'onglet Réglages (carte #genSyncMount) ---------
  // Rendu inline dans la vue Paramètres (index.html), pas de bouton flottant.
  // Page servie par HA (config bakée) : simple statut. Sinon (APK / public) :
  // formulaire URL + identifiant webhook.
  function syncInputStyle() {
    return 'width:100%;box-sizing:border-box;margin-top:4px;padding:10px;border-radius:8px;' +
      'border:1px solid rgba(128,128,128,.4);background:rgba(0,0,0,.15);color:inherit;font-size:14px';
  }
  function renderSyncSettings() {
    var el = document.getElementById('genSyncMount');
    if (!el) return;
    if (hasBaked()) {
      el.innerHTML = '<p class="muted">Synchronisation activée via Home Assistant (cette page). ' +
        'Les modifications de l\'arbre sont partagées automatiquement entre appareils.</p>';
      return;
    }
    var st = loadStored();
    var conf = configured();
    el.innerHTML =
      '<p class="muted">Relie l\'app à ton Home Assistant pour partager l\'arbre entre appareils. ' +
      'Données chiffrées (mot de passe famille). Facultatif : sans ça, l\'app reste locale.</p>' +
      '<label style="display:block;font-size:13px;margin:10px 0 0">URL Home Assistant (Nabu Casa)' +
      '<input id="genSyncUrl" type="url" autocapitalize="off" autocomplete="off" ' +
      'style="' + syncInputStyle() + '" placeholder="https://xxxxx.ui.nabu.casa"></label>' +
      '<label style="display:block;font-size:13px;margin:10px 0 0">Identifiant du webhook' +
      '<input id="genSyncHook" type="text" autocapitalize="off" autocomplete="off" ' +
      'style="' + syncInputStyle() + '" placeholder="genealogie_xxxxxxxx"></label>' +
      '<div class="btn-row" style="margin-top:12px">' +
      '<button id="genSyncSave" class="btn btn-sm" type="button">Enregistrer et tester</button>' +
      (conf ? '<button id="genSyncForget" class="btn btn-sm btn-ghost" type="button">Oublier</button>' : '') +
      '</div>' +
      '<p id="genSyncMsg" class="muted" style="margin-top:8px;min-height:1.2em">' +
      (conf ? 'État : configuré ✓' : '') + '</p>';
    document.getElementById('genSyncUrl').value = st.baseUrl || '';
    document.getElementById('genSyncHook').value = st.webhookId || '';
    document.getElementById('genSyncSave').onclick = function () {
      saveSyncConfig(document.getElementById('genSyncUrl').value,
                     document.getElementById('genSyncHook').value);
    };
    var forget = document.getElementById('genSyncForget');
    if (forget) forget.onclick = function () { localStorage.removeItem(CFG_KEY); renderSyncSettings(); };
  }
  function saveSyncConfig(urlVal, hookVal) {
    var msg = document.getElementById('genSyncMsg');
    var st2 = { baseUrl: (urlVal || '').trim().replace(/\/+$/, ''), webhookId: (hookVal || '').trim() };
    if (!st2.baseUrl || !st2.webhookId) { if (msg) msg.textContent = 'Renseigne les deux champs.'; return; }
    var d = deriveFromStored(st2);
    if (msg) msg.textContent = 'Test de connexion…';
    netGetJson(d.dataUrl + (d.dataUrl.indexOf('?') === -1 ? '?' : '&') + '_=' + Date.now())
      .then(function () { finishSyncSave(st2, 'Connecté ✓ — synchronisation activée.'); })
      .catch(function (e) {
        // 404 sur tree.json = instance joignable mais pas encore de données : OK.
        if (/HTTP 404/.test(String(e && e.message))) {
          finishSyncSave(st2, 'Connecté ✓ (aucune donnée distante encore).');
        } else if (msg) {
          msg.textContent = 'Échec : ' + (e && e.message || e) + '. Vérifie l\'URL / le webhook.';
        }
      });
  }
  function finishSyncSave(st2, okText) {
    localStorage.setItem(CFG_KEY, JSON.stringify(st2));
    var msg = document.getElementById('genSyncMsg');
    if (msg) msg.textContent = okText;
    pull(); schedulePush();
  }

  // --- accès réseau -------------------------------------------------------
  // Sur l'APK on appelle le plugin CapacitorHttp EN DIRECT (comme wikitree.js /
  // insee.js) : le fetch() « patché » passe par un contournement WebView d'un
  // bug Chromium qui peut se bloquer / échouer ("Failed to fetch") et ne mord
  // pas de façon fiable ici. Le natif applique aussi un timeout OkHttp.
  function isNative() {
    var Cap = window.Capacitor;
    return !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform() &&
      Cap.Plugins && Cap.Plugins.CapacitorHttp);
  }
  function netGetJson(url) {
    if (isNative()) {
      return window.Capacitor.Plugins.CapacitorHttp.get({
        url: url, connectTimeout: 8000, readTimeout: 12000
      }).then(function (res) {
        if (res.status && (res.status < 200 || res.status >= 300)) throw new Error('HTTP ' + res.status);
        return (typeof res.data === 'string') ? JSON.parse(res.data) : res.data;
      });
    }
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }
  function netPostJson(url, bodyObj) {
    if (isNative()) {
      return window.Capacitor.Plugins.CapacitorHttp.post({
        url: url, headers: { 'Content-Type': 'application/json' },
        data: bodyObj, connectTimeout: 8000, readTimeout: 15000
      }).then(function (res) {
        return { ok: !!(res.status >= 200 && res.status < 300), status: res.status };
      });
    }
    return fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyObj)
    }).then(function (r) { return { ok: r.ok, status: r.status }; });
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
    if (!configured()) return;
    if (!subtle) { console.warn('genealogie: crypto indisponible (http ?) → pas de sync'); return; }
    var s = readLocal();
    if (!s) return;
    s.meta = s.meta || {};
    s.meta.updatedAt = Date.now();
    s.meta.device = deviceId;
    var plain = JSON.stringify(s);
    writeLocalSilently(plain);
    if (plain === lastSyncedJSON) return;
    var webhookUrl = resolved().webhookUrl;
    encryptState(plain).then(function (enc) {
      var envelope = {
        enc: 'v1', salt: currentSaltB64(), iv: enc.iv, ct: enc.ct, zip: enc.zip,
        meta: { updatedAt: s.meta.updatedAt, device: deviceId }
      };
      return netPostJson(webhookUrl, { b64: strToB64(JSON.stringify(envelope)), device: deviceId });
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
    if (!configured() || !subtle) return;
    var dataUrl = resolved().dataUrl;
    var url = dataUrl + (dataUrl.indexOf('?') === -1 ? '?' : '&') + '_=' + Date.now();
    netGetJson(url)
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

  // --- démarrage ----------------------------------------------------------
  function initSyncUI() {
    renderSyncSettings();
    // Re-rend la carte à chaque ouverture de l'onglet Réglages (statut à jour).
    var nav = document.querySelector('.bottombar [data-view="settings"]');
    if (nav) nav.addEventListener('click', function () { setTimeout(renderSyncSettings, 40); });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSyncUI);
  } else {
    initSyncUI();
  }

  pull();
  // Remonte l'état local au démarrage s'il contient des données (utile après
  // une 1re configuration : sinon rien ne pousse tant qu'on n'édite pas). Gardé
  // par localHasData() pour ne jamais écraser le distant avec un arbre vide ;
  // si le distant est plus récent, pull() a déjà rechargé avant ce push.
  if (configured() && localHasData()) schedulePush();
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') pull();
  });
  window.addEventListener('focus', pull);
})();
