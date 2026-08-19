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

  function get(params) {
    params.appId = APP_ID;
    params.format = 'json';
    var qs = Object.keys(params).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
    }).join('&');
    // Pas de credentials : l'API renvoie les profils publics et réplique
    // l'origine CORS. `credentials: omit` évite un blocage navigateur.
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var fetchPromise = fetch(API + '?' + qs, { credentials: 'omit', signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) {
        if (!r.ok) throw new Error('WikiTree HTTP ' + r.status);
        return r.json();
      });
    // Timeout garanti par Promise.race (pas seulement par AbortController) :
    // dans l'app Android, les requêtes passent par le pont natif CapacitorHttp
    // (contourne l'absence de CORS de l'API WikiTree — vérifié : elle ne
    // renvoie jamais d'en-tête Access-Control-Allow-Origin), qui ne respecte
    // pas toujours le signal d'abandon. Sans ce filet, une réponse lente ou
    // bloquée laissait la recherche tourner indéfiniment sans jamais aboutir.
    var timeoutPromise = new Promise(function (resolve, reject) {
      setTimeout(function () {
        if (ctrl) ctrl.abort();
        reject(new Error('délai dépassé (30 s) — réessayez'));
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
  function search(firstName, lastName, limit) {
    return get({
      action: 'searchPerson',
      FirstName: firstName || '',
      LastName: lastName || '',
      fields: FIELDS,
      limit: limit || 20
    }).then(function (data) {
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
