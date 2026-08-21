/* wikitree.js — accès à la base généalogique libre WikiTree (api.wikitree.com).
   Aucune clé requise, données publiques. Sert à rechercher une personne et à
   récupérer ses proches pour les importer dans l'arbre local. */
(function (global) {
  'use strict';

  var API = 'https://api.wikitree.com/api.php';
  var APP_ID = 'arbre-genealogique';
  var FIELDS = [
    'Id', 'Name', 'FirstName', 'RealName', 'LastNameAtBirth', 'LastNameCurrent',
    'Gender', 'BirthDate', 'DeathDate', 'BirthLocation', 'DeathLocation',
    'IsLiving', 'Father', 'Mother'
  ].join(',');

  // onController(ctrl), s'il est fourni, reçoit un objet { abort() } dès sa
  // création — permet à l'appelant d'annuler la requête en cours (bouton
  // « Annuler » pendant une recherche lente) sans changer la forme de la
  // promesse renvoyée.
  function get(params, onController) {
    params.appId = APP_ID;
    params.format = 'json';
    var Cap = typeof window !== 'undefined' ? window.Capacitor : undefined;
    var isNative = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform() && Cap.Plugins && Cap.Plugins.CapacitorHttp);
    if (isNative) {
      // Appel natif DIRECT (plugin CapacitorHttp), plutôt que le fetch()
      // patché : ce dernier fait passer les requêtes GET par un contournement
      // WebView d'un bug Chromium (réécriture d'URL + interception) qui peut
      // se bloquer indéfiniment sans jamais déclencher de minuteur JS de
      // secours (observé en usage réel : recherche restée bloquée plusieurs
      // minutes). L'appel natif applique un timeout CÔTÉ NATIF (OkHttp),
      // indépendant du thread JS/WebView — il aboutit donc même si la
      // WebView est gelée en arrière-plan (constaté sur certains ROM comme
      // MIUI/Xiaomi qui gèlent agressivement la WebView).
      var aborted = false;
      if (onController) onController({ abort: function () { aborted = true; } });
      // Toujours des chaînes : le pont natif attend des params de type
      // Record<string,string> — une valeur numérique (ex. limit:20,
      // getParents:1) peut échouer silencieusement à sa sérialisation et
      // vider TOUS les params de la requête (constaté sur insee.js : la
      // requête part alors sans aucun paramètre, l'API renvoie une erreur
      // qu'on lit à tort comme "0 résultat").
      var nativeParams = {};
      Object.keys(params).forEach(function (k) { nativeParams[k] = String(params[k]); });
      var nativePromise = Cap.Plugins.CapacitorHttp.get({
        url: API,
        params: nativeParams,
        connectTimeout: 8000,
        readTimeout: 12000
      }).then(function (res) {
        if (aborted) { var e = new Error('Annulé'); e.name = 'AbortError'; throw e; }
        if (res.status && (res.status < 200 || res.status >= 300)) throw new Error('WikiTree HTTP ' + res.status);
        return res.data;
      });
      // Filet de secours SUPPLÉMENTAIRE en plus du timeout natif ci-dessus :
      // certaines connexions mobiles (proxy transparent, trafic « en filet
      // d'eau » qui réarme le readTimeout sans jamais livrer de vraie
      // réponse) peuvent empêcher même un timeout natif OkHttp de se
      // déclencher. Ce filet JS reste un filet DE PLUS, pas LE filet — voir
      // app.js pour le filet final indépendant de tout minuteur.
      var nativeTimeoutPromise = new Promise(function (resolve, reject) {
        // Tag « (natif) » : sert de diagnostic si ça bloque encore malgré
        // tout — confirme quelle voie de transport a réellement été prise.
        setTimeout(function () { reject(new Error('délai dépassé (natif) — réessayez')); }, 20000);
      });
      return Promise.race([nativePromise, nativeTimeoutPromise]);
    }
    // Web / dev : fetch() classique + filet Promise.race indépendant.
    var qs = Object.keys(params).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
    }).join('&');
    // Pas de credentials : l'API renvoie les profils publics et réplique
    // l'origine CORS. `credentials: omit` évite un blocage navigateur.
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    if (onController) onController(ctrl);
    var fetchPromise = fetch(API + '?' + qs, { credentials: 'omit', signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) {
        if (!r.ok) throw new Error('WikiTree HTTP ' + r.status);
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

  // "1926-04-00" -> "1926-04" ; "0000-00-00" -> "" ; "1982-00-00" -> "1982"
  function cleanDate(d) {
    if (!d || d === '0000-00-00') return '';
    return d.replace(/(-00)+$/g, '');
  }

  // Convertit un profil WikiTree en champs de personne locale.
  function toFields(p) {
    var gender = p.Gender === 'Male' ? 'H' : (p.Gender === 'Female' ? 'F' : '?');
    var death = cleanDate(p.DeathDate);
    return {
      prenom: p.FirstName || p.RealName || '',
      nom: p.LastNameAtBirth || p.LastNameCurrent || '',
      sexe: gender,
      naissance: { date: cleanDate(p.BirthDate), lieu: p.BirthLocation || '' },
      deces: { date: death, lieu: p.DeathLocation || '' },
      decede: p.IsLiving === 0 || !!death,
      wikitree: p.Name || '',
      notes: p.Name ? ('Importé de WikiTree — https://www.wikitree.com/wiki/' + p.Name) : ''
    };
  }

  // Recherche par prénom/nom. Renvoie un tableau de profils (résumés).
  function search(firstName, lastName, limit, onController) {
    return get({
      action: 'searchPerson',
      FirstName: firstName || '',
      LastName: lastName || '',
      fields: FIELDS,
      limit: limit || 20
    }, onController).then(function (data) {
      var block = Array.isArray(data) ? data[0] : data;
      var matches = (block && block.matches) || [];
      // searchPerson renvoie parfois l'entrée 0 (compteur) : on filtre.
      return matches.filter(function (m) { return m && m.Name; });
    });
  }

  // Récupère une personne + ses parents/conjoints/enfants.
  // Renvoie { person, parents:{id:profil}, spouses:{}, children:{}, fatherId, motherId }.
  function getRelatives(key) {
    return get({
      action: 'getRelatives',
      keys: key,
      getParents: 1,
      getSpouses: 1,
      getChildren: 1,
      fields: FIELDS
    }).then(function (data) {
      var block = Array.isArray(data) ? data[0] : data;
      var items = (block && block.items) || [];
      if (!items.length) throw new Error('Profil introuvable');
      var per = items[0].person || {};
      return {
        person: per,
        parents: per.Parents || {},
        spouses: per.Spouses || {},
        children: per.Children || {},
        fatherId: per.Father,
        motherId: per.Mother
      };
    });
  }

  global.WikiTree = {
    search: search,
    getRelatives: getRelatives,
    toFields: toFields
  };
})(window);
