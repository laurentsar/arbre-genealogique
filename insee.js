/* insee.js — accès au Fichier des personnes décédées (INSEE), via l'API
   ouverte matchID (deces.matchid.io). Données d'état civil françaises
   (naissance/décès), gratuites, sans clé. Complément à WikiTree : moins de
   généalogie (pas de parents/enfants), mais dates et lieux exacts issus des
   actes — utile pour CONFIRMER une correspondance plutôt que l'importer. */
(function (global) {
  'use strict';

  var API = 'https://deces.matchid.io/deces/api/v1/search';

  function get(params, onController) {
    var cleanParams = {};
    Object.keys(params).forEach(function (k) {
      if (params[k] !== undefined && params[k] !== '') cleanParams[k] = params[k];
    });
    var Cap = typeof window !== 'undefined' ? window.Capacitor : undefined;
    var isNative = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform() && Cap.Plugins && Cap.Plugins.CapacitorHttp);
    if (isNative) {
      // Appel natif direct : timeout appliqué côté natif (OkHttp), pas côté
      // JS/WebView — voir wikitree.js pour le détail du problème contourné
      // (fetch() patché pouvant se bloquer indéfiniment sur certains ROM).
      var aborted = false;
      if (onController) onController({ abort: function () { aborted = true; } });
      var nativePromise = Cap.Plugins.CapacitorHttp.get({
        url: API,
        params: cleanParams,
        connectTimeout: 8000,
        readTimeout: 12000
      }).then(function (res) {
        if (aborted) { var e = new Error('Annulé'); e.name = 'AbortError'; throw e; }
        if (res.status && (res.status < 200 || res.status >= 300)) throw new Error('INSEE HTTP ' + res.status);
        return res.data;
      });
      // Filet supplémentaire : voir wikitree.js pour le détail (certaines
      // connexions mobiles empêchent même un timeout natif de se déclencher).
      var nativeTimeoutPromise = new Promise(function (resolve, reject) {
        setTimeout(function () { reject(new Error('délai dépassé (natif) — réessayez')); }, 20000);
      });
      return Promise.race([nativePromise, nativeTimeoutPromise]);
    }
    var qs = Object.keys(cleanParams)
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(cleanParams[k]); })
      .join('&');
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    if (onController) onController(ctrl);
    var fetchPromise = fetch(API + '?' + qs, { credentials: 'omit', signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) {
        if (!r.ok) throw new Error('INSEE HTTP ' + r.status);
        return r.json();
      });
    var timeoutPromise = new Promise(function (resolve, reject) {
      setTimeout(function () {
        if (ctrl) ctrl.abort();
        reject(new Error('délai dépassé (web) — réessayez'));
      }, 30000);
    });
    return Promise.race([fetchPromise, timeoutPromise]);
  }

  // "19010131" -> "1901-01-31" ; "19010000" -> "1901" ; "" -> ""
  function fromInseeDate(d) {
    if (!d || d.length < 4) return '';
    var y = d.slice(0, 4), m = d.slice(4, 6), day = d.slice(6, 8);
    if (m && m !== '00') { return (day && day !== '00') ? (y + '-' + m + '-' + day) : (y + '-' + m); }
    return y;
  }

  function toFields(p) {
    var sex = p.sex === 'M' ? 'H' : (p.sex === 'F' ? 'F' : '?');
    var bLoc = (p.birth && p.birth.location) || {};
    var dLoc = (p.death && p.death.location) || {};
    var bCity = Array.isArray(bLoc.city) ? bLoc.city[0] : bLoc.city;
    var dCity = Array.isArray(dLoc.city) ? dLoc.city[0] : dLoc.city;
    return {
      id: p.id || '', // identifiant stable du profil source (sert à mémoriser un rejet par personne)
      prenom: (p.name && p.name.first && p.name.first[0]) || '',
      nom: (p.name && p.name.last) || '',
      sexe: sex,
      naissance: { date: fromInseeDate(p.birth && p.birth.date), lieu: bCity || '' },
      deces: { date: fromInseeDate(p.death && p.death.date), lieu: dCity || '' },
      decede: true,
      notes: 'Source : Fichier des personnes décédées (INSEE)' +
        (p.death && p.death.certificateId ? ', acte n° ' + p.death.certificateId : '') +
        (p.source ? ' — millésime ' + p.source : '')
    };
  }

  // Recherche par nom (obligatoire), prénom et année de naissance (optionnels,
  // affinent le score de pertinence côté serveur). Ne couvre que les décès
  // enregistrés en France (essentiellement depuis 1970) : renvoie un tableau
  // vide en silence en cas d'échec réseau, pour ne jamais bloquer la
  // recherche WikiTree menée en parallèle.
  function search(firstName, lastName, birthYear, onController) {
    if (!lastName) return Promise.resolve([]);
    var params = { firstName: firstName || '', lastName: lastName, size: 15 };
    if (birthYear) params.birthDate = String(birthYear);
    return get(params, onController).then(function (data) {
      var persons = (data && data.response && data.response.persons) || [];
      return persons.map(toFields);
    });
  }

  global.InseeDeces = { search: search, toFields: toFields };
})(window);
