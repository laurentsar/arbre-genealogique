/* backend.js — synchronisation de l'arbre avec Home Assistant, AUTONOME.
 *
 * Ne modifie pas l'app : on intercepte les écritures localStorage de store.js
 * (clé "genealogie:data:v1") pour pousser vers HA, et on recharge la page quand
 * l'état distant est plus récent. Compatible avec toute version de l'app tant
 * que la clé de stockage ne change pas.
 *
 * Configuration (URL webhook + fichier de données) : window.GENEALOGIE_BACKEND,
 * défini dans backend-config.js — présent uniquement sur l'instance HA. Absent
 * (github.io) → ce module ne fait rien (mode démo localStorage).
 *
 * Modèle : dernière écriture gagnante (last-write-wins) sur meta.updatedAt.
 */
(function () {
  'use strict';

  var cfg = window.GENEALOGIE_BACKEND;
  if (!cfg || !cfg.webhookUrl || !cfg.dataUrl) return;
  if (typeof localStorage === 'undefined') return;

  var KEY = 'genealogie:data:v1'; // doit correspondre à store.js
  var deviceId = getDeviceId();
  var pushTimer = null;
  var lastSyncedJSON = null; // évite les push/echos redondants
  var applying = false;      // vrai pendant nos propres écritures internes

  function getDeviceId() {
    var k = 'genealogie:deviceId';
    var v = localStorage.getItem(k);
    if (!v) {
      v = 'dev' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem(k, v);
    }
    return v;
  }

  function readLocal() {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null'); }
    catch (e) { return null; }
  }
  function localUpdatedAt() {
    var s = readLocal();
    return (s && s.meta && s.meta.updatedAt) || 0;
  }
  function toB64(str) {
    return btoa(unescape(encodeURIComponent(str))); // sûr en UTF-8 (accents)
  }

  // Intercepte les écritures de l'app (store.js -> localStorage.setItem).
  var rawSet = localStorage.setItem.bind(localStorage);
  localStorage.setItem = function (k, v) {
    rawSet(k, v);
    if (k === KEY && !applying) schedulePush();
  };
  function writeLocalSilently(json) {
    applying = true;
    rawSet(KEY, json);
    applying = false;
  }

  function schedulePush() {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(stampAndPush, 900);
  }

  function stampAndPush() {
    var s = readLocal();
    if (!s) return;
    s.meta = s.meta || {};
    s.meta.updatedAt = Date.now();
    s.meta.device = deviceId;
    var json = JSON.stringify(s);
    writeLocalSilently(json); // persiste le tampon sans reboucler
    if (json === lastSyncedJSON) return;
    fetch(cfg.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ b64: toB64(json), device: deviceId })
    }).then(function (r) {
      if (r.ok) lastSyncedJSON = json;
    }).catch(function () { /* hors-ligne : réessai à la prochaine écriture */ });
  }

  function pull() {
    var url = cfg.dataUrl + (cfg.dataUrl.indexOf('?') === -1 ? '?' : '&') + '_=' + Date.now();
    fetch(url, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (remote) {
        if (!remote || !remote.persons) return;
        var ru = (remote.meta && remote.meta.updatedAt) || 0;
        if (ru > localUpdatedAt()) {
          lastSyncedJSON = JSON.stringify(remote);
          writeLocalSilently(lastSyncedJSON);
          location.reload(); // l'app relit l'état au chargement
        }
      })
      .catch(function () { /* hors-ligne : on garde la copie locale */ });
  }

  pull(); // au démarrage
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') pull();
  });
  window.addEventListener('focus', pull);
})();
