/* Util — fonctions PURES partagées (dates, texte, URLs de recherche,
   analyse d'une fiche Geneanet collée). Aucun accès à l'état ni au rendu :
   testables telles quelles sous Node (voir tests/). */
(function (global) {
  'use strict';

  function $(sel) { return document.querySelector(sel); }
  function $all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  // Date interne : vide, ou AAAA / AAAA-MM / AAAA-MM-JJ (mois 01-12, jour 01-31).
  // Format de stockage inchangé (tri, comparaisons, export GEDCOM, WikiTree/
  // INSEE en dépendent) — seuls la SAISIE et l'AFFICHAGE passent en JJ/MM/AAAA.
  function isValidDate(s) {
    if (!s) return true;
    var m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(s);
    if (!m) return false;
    if (m[2] && (+m[2] < 1 || +m[2] > 12)) return false;
    if (m[3] && (+m[3] < 1 || +m[3] > 31)) return false;
    return true;
  }

  // AAAA-MM-JJ -> JJ/MM/AAAA (partiel : AAAA-MM -> MM/AAAA, AAAA -> AAAA).
  function formatDateFr(iso) {
    if (!iso) return '';
    var m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(iso);
    if (!m) return iso; // format déjà inattendu : affiché tel quel plutôt que masqué
    var y = m[1], mo = m[2], d = m[3];
    if (d) return d + '/' + mo + '/' + y;
    if (mo) return mo + '/' + y;
    return y;
  }

  // Saisie utilisateur (JJ/MM/AAAA, MM/AAAA ou AAAA) -> format interne
  // AAAA-MM-JJ. Accepte aussi directement le format interne en entrée, pour
  // ne pas casser un collage depuis un ancien export ou un GEDCOM.
  function parseDateFr(input) {
    var s = (input || '').trim();
    if (!s) return '';
    if (/^\d{4}(-\d{2}(-\d{2})?)?$/.test(s)) return s;
    var m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
    if (m) return m[3] + '-' + m[2] + '-' + m[1];
    m = /^(\d{2})\/(\d{4})$/.exec(s);
    if (m) return m[2] + '-' + m[1];
    return s; // invalide : laissé tel quel, isValidDate() le rejettera avec un message clair
  }

  function escapeHtml(s) {
    return (s == null ? '' : String(s)).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function initials(p) {
    var a = (p.prenom || '').charAt(0);
    var b = (p.nom || '').charAt(0);
    return (a + b).toUpperCase() || '?';
  }

  function timeAgo(iso, now) {
    var s = Math.max(0, Math.floor(((now || Date.now()) - new Date(iso).getTime()) / 1000));
    if (s < 60) return 'à l’instant';
    var m = Math.floor(s / 60); if (m < 60) return 'il y a ' + m + ' min';
    var h = Math.floor(m / 60); if (h < 24) return 'il y a ' + h + ' h';
    return 'il y a ' + Math.floor(h / 24) + ' j';
  }

  // Champ de recherche GLOBAL (un seul champ) : dernier mot = nom, le reste
  // = prénom (un seul mot → traité comme nom, l'index principal de WikiTree).
  function splitNameQuery(q) {
    var parts = q.trim().split(/\s+/);
    if (parts.length === 1) return { fn: '', ln: parts[0] };
    return { fn: parts.slice(0, -1).join(' '), ln: parts[parts.length - 1] };
  }

  // Première lettre de regroupement (par NOM de famille, plus naturel pour
  // chercher « les Sarniguet ») — accents neutralisés pour ne pas éclater
  // « É » et « E » en deux groupes séparés. Ignore la ponctuation en tête
  // (ex. surnom entre guillemets dans un nom GEDCOM : `"Corfic" Morvan`).
  function groupLetter(s) {
    var stripped = (s || '').trim().replace(/^[^\p{L}\p{N}]+/u, '');
    var c = stripped.charAt(0).toUpperCase();
    if (!c) return '#';
    var norm = c.normalize('NFD').replace(/[̀-ͯ]/g, '');
    return /[A-Z]/.test(norm) ? norm : '#';
  }

  // Retarde l'appel jusqu'à `ms` sans nouvel appel (saisie clavier).
  function debounce(fn, ms) {
    var t = null;
    return function () {
      var self = this, args = arguments;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  // Lien de recherche Geneanet pour une personne (pas d'API publique chez
  // Geneanet — contrairement à WikiTree/INSEE, ceci ouvre juste LEUR site
  // dans le navigateur, prérempli, plutôt que d'interroger une donnée dans
  // l'app). Réduit le nombre de résultats à filtrer soi-même côté Geneanet :
  // jour/mois de naissance quand connus (pas seulement l'année), et
  // nom/prénom du conjoint quand il y en a un d'enregistré. Paramètres du
  // conjoint (nom_conjoint/prenom_conjoint) confirmés via une URL Geneanet
  // réelle indexée (prenom_conjoint_operateur, sur le même formulaire) —
  // à noter : Geneanet réserve ce filtre conjoint aux comptes Premium, un
  // compte gratuit/non connecté verra probablement ce paramètre ignoré.
  // Jour/mois de naissance non vérifiés de la même façon (aucune URL
  // indexée trouvée) : ajoutés par convention avec naissance_annee (déjà
  // en place) — si Geneanet les ignore, la recherche reste fonctionnelle,
  // juste moins précise.
  function geneanetSearchUrl(prenom, nom, naissanceDate, conjoint) {
    var params = 'go=1';
    if (nom) params += '&nom=' + encodeURIComponent(nom);
    if (prenom) params += '&prenom=' + encodeURIComponent(prenom);
    var d = naissanceDate ? naissanceDate.split('-') : [];
    if (d[0]) params += '&naissance_annee=' + encodeURIComponent(d[0]);
    if (d[1]) params += '&naissance_mois=' + encodeURIComponent(parseInt(d[1], 10));
    if (d[2]) params += '&naissance_jour=' + encodeURIComponent(parseInt(d[2], 10));
    if (conjoint && conjoint.nom) params += '&nom_conjoint=' + encodeURIComponent(conjoint.nom);
    if (conjoint && conjoint.prenom) params += '&prenom_conjoint=' + encodeURIComponent(conjoint.prenom);
    return 'https://www.geneanet.org/fonds/individus/?' + params;
  }

  // Lien de recherche nominative sur le Portale Antenati (Archives d'État
  // italiennes, registres d'état civil numérisés — gratuit, pas d'API
  // publique). Chemin et paramètre « cognome » confirmés via des URLs
  // indexées réelles (antenati.cultura.gov.it/search-nominative/?cognome=…) ;
  // « nome » suit la même convention italienne (nome = prénom).
  function antenatiSearchUrl(prenom, nom) {
    var params = [];
    if (nom) params.push('cognome=' + encodeURIComponent(nom));
    if (prenom) params.push('nome=' + encodeURIComponent(prenom));
    return 'https://antenati.cultura.gov.it/search-nominative/' + (params.length ? '?' + params.join('&') : '');
  }

  // Reconnaissance d'une fiche individu Geneanet copiée-collée (texte brut,
  // pas d'API) — évite de retaper chaque champ à la main. Basé sur un
  // exemple réel :
  //   Josèphe VIDAILHET
  //   Née le 21 mars 1759 - Sarrancolin, 65408, Hautes-Pyrénées, ..., France
  //   Décédée le 19 janvier 1832 - ..., France, à l'âge de 72 ans
  // Le sexe se déduit du « e » de « Né(e) »/« Décédé(e) » — signal gratuit,
  // pas besoin de le deviner autrement. Chaque champ manque sans faire
  // échouer les autres (ex. lieu absent, date approximative « en 1759 »).
  var GENEANET_MOIS = {
    'janvier': 1, 'février': 2, 'fevrier': 2, 'mars': 3, 'avril': 4, 'mai': 5, 'juin': 6,
    'juillet': 7, 'août': 8, 'aout': 8, 'septembre': 9, 'octobre': 10, 'novembre': 11,
    'décembre': 12, 'decembre': 12
  };
  function geneanetDateToISO(jour, moisNom, annee) {
    var mois = GENEANET_MOIS[(moisNom || '').toLowerCase()];
    var y = ('0000' + annee).slice(-4);
    if (!mois) return y;
    var m = ('0' + mois).slice(-2);
    var d = ('0' + jour).slice(-2);
    return y + '-' + m + '-' + d;
  }
  function parseGeneanetEventLine(rest) {
    var dm = /(\d{1,2})\s+([^\s\d]+)\s+(\d{3,4})/.exec(rest);
    var date = '';
    if (dm) date = geneanetDateToISO(dm[1], dm[2], dm[3]);
    else { var ym = /\b(\d{3,4})\b/.exec(rest); if (ym) date = ym[1]; }
    var afterDash = rest.split(' - ')[1] || '';
    var lieu = afterDash.replace(/,?\s*à l['’]âge de.*$/i, '').trim();
    return { date: date, lieu: lieu };
  }
  function parseGeneanetProfile(text) {
    var lines = (text || '').split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
    var result = { prenom: '', nom: '', sexe: null, naissance: null, deces: null };
    if (!lines.length) return result;
    // Ligne 1 : « Prénom(s) NOM » — nom de famille en MAJUSCULES (convention
    // Geneanet, comme le slash du GEDCOM). Recherche lazy du plus petit
    // préfixe laissant un suffixe entièrement capitalisé.
    var nameMatch = /^(.+?)\s+([A-ZÀÂÄÇÉÈÊËÏÎÔÖÙÛÜŸÑ][A-ZÀÂÄÇÉÈÊËÏÎÔÖÙÛÜŸÑ'\-\s]*)$/.exec(lines[0]);
    if (nameMatch) { result.prenom = nameMatch[1].trim(); result.nom = nameMatch[2].trim(); }
    else { result.prenom = lines[0]; }
    lines.forEach(function (line) {
      var mBirth = /^N[ée]e?\s+(?:le|en|vers)\s+(.+)$/i.exec(line);
      if (mBirth && !result.naissance) {
        if (result.sexe === null) result.sexe = /^Née\b/i.test(line) ? 'F' : 'H';
        result.naissance = parseGeneanetEventLine(mBirth[1]);
      }
      var mDeath = /^D[ée]c[ée]d[ée]e?\s+(?:le|en|vers)\s+(.+)$/i.exec(line);
      if (mDeath && !result.deces) {
        if (result.sexe === null) result.sexe = /^Décédée\b/i.test(line) ? 'F' : 'H';
        result.deces = parseGeneanetEventLine(mDeath[1]);
      }
    });
    return result;
  }

  global.GenUtil = {
    $: $, $all: $all,
    isValidDate: isValidDate,
    formatDateFr: formatDateFr,
    parseDateFr: parseDateFr,
    escapeHtml: escapeHtml,
    initials: initials,
    timeAgo: timeAgo,
    splitNameQuery: splitNameQuery,
    groupLetter: groupLetter,
    debounce: debounce,
    geneanetSearchUrl: geneanetSearchUrl,
    antenatiSearchUrl: antenatiSearchUrl,
    parseGeneanetProfile: parseGeneanetProfile
  };
})(window);
