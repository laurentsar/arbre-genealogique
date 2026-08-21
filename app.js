/* App — contrôleur principal de l'application indépendante « Arbre généalogique ». */
(function () {
  'use strict';

  var state = Store.load();
  var treeMode = 'ancestors';
  var maxGen = 4;
  var panZoomCtl = null;

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

  var treeSvg = $('#treeSvg');
  var treeEmpty = $('#treeEmpty');
  var personList = $('#personList');
  var personListEmpty = $('#personListEmpty');
  var searchInput = $('#searchInput');
  var rootSelect = $('#rootSelect');
  var statPersons = $('#statPersons');
  var statUnions = $('#statUnions');
  var detailDialog = $('#detailDialog');
  var detailContent = $('#detailContent');

  // --- Utilitaires d'affichage ---------------------------------------------

  function escapeHtml(s) {
    return (s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function initials(p) {
    var a = (p.prenom || '').charAt(0);
    var b = (p.nom || '').charAt(0);
    return (a + b).toUpperCase() || '?';
  }

  function avatarHTML(p) {
    return '<span class="avatar">' + escapeHtml(initials(p)) + '</span>';
  }

  function subLine(p) {
    if (p.naissance && p.naissance.date) return 'né(e) ' + formatDateFr(p.naissance.date);
    if (p.naissance && p.naissance.lieu) return p.naissance.lieu;
    if (p.decede) return 'Décédé(e)';
    return '';
  }

  function detailMeta(p) {
    var parts = [];
    parts.push(p.sexe === 'H' ? 'Homme' : p.sexe === 'F' ? 'Femme' : 'Sexe non précisé');
    if (p.naissance && (p.naissance.date || p.naissance.lieu)) {
      parts.push('né(e) ' + [p.naissance.date ? 'le ' + formatDateFr(p.naissance.date) : '', p.naissance.lieu ? 'à ' + p.naissance.lieu : ''].filter(Boolean).join(' '));
    }
    if (p.decede || (p.deces && (p.deces.date || p.deces.lieu))) {
      parts.push('décédé(e) ' + [p.deces.date ? 'le ' + formatDateFr(p.deces.date) : '', p.deces.lieu ? 'à ' + p.deces.lieu : ''].filter(Boolean).join(' '));
    }
    return parts.join(' · ');
  }

  // --- Mise en évidence des apports d'un rapprochement (doublon local ou ---
  // --- correspondance en ligne) : ce que l'AUTRE fiche apporterait de neuf. --

  function fieldGains(existing, incoming) {
    var gains = [];
    if (!existing.prenom && incoming.prenom) gains.push('prénom');
    if (!existing.nom && incoming.nom) gains.push('nom');
    if ((!existing.sexe || existing.sexe === '?') && incoming.sexe && incoming.sexe !== '?') gains.push('sexe');
    if (!(existing.naissance && existing.naissance.date) && incoming.naissance && incoming.naissance.date) {
      gains.push('naissance ' + formatDateFr(incoming.naissance.date));
    }
    if (!(existing.naissance && existing.naissance.lieu) && incoming.naissance && incoming.naissance.lieu) {
      gains.push('lieu de naissance');
    }
    if (!(existing.deces && existing.deces.date) && incoming.deces && incoming.deces.date) {
      gains.push('décès ' + formatDateFr(incoming.deces.date));
    }
    if (!(existing.deces && existing.deces.lieu) && incoming.deces && incoming.deces.lieu) {
      gains.push('lieu de décès');
    }
    if (!existing.decede && incoming.decede) gains.push('statut décédé');
    if (incoming.notes && (!existing.notes || existing.notes.indexOf(incoming.notes) === -1)) gains.push('notes');
    return gains;
  }

  // Compare les relations déjà connues (branches raccrochées) entre deux
  // personnes LOCALES — n'a de sens que pour un doublon interne à l'arbre.
  function relationGains(existingId, incomingId) {
    var gains = [];
    function diff(getFn, label) {
      var e = getFn(state, existingId).length, i = getFn(state, incomingId).length;
      if (i > e) gains.push((i - e) + ' ' + label + (i - e > 1 ? 's' : '') + ' en plus');
    }
    diff(Store.getParents, 'parent');
    diff(Store.getSpouses, 'conjoint');
    diff(Store.getChildren, 'enfant');
    return gains;
  }

  function gainsHTML(gains) {
    return gains.length ? '<div class="gains-line">✚ ' + escapeHtml(gains.join(', ')) + '</div>' : '';
  }

  // Notification légère persistante (indépendante des dialogs) : sert à prévenir
  // du résultat d'une recherche en ligne même si l'utilisateur a fermé la fiche.
  var toastWrap = null;
  function toast(msg, kind) {
    if (!toastWrap) {
      toastWrap = document.createElement('div');
      toastWrap.className = 'toast-wrap';
      document.body.appendChild(toastWrap);
    }
    var t = document.createElement('div');
    t.className = 'toast' + (kind ? ' toast-' + kind : '');
    t.textContent = msg;
    t.addEventListener('click', function () { t.remove(); });
    toastWrap.appendChild(t);
    setTimeout(function () { t.classList.add('show'); }, 10);
    setTimeout(function () { t.classList.remove('show'); setTimeout(function () { t.remove(); }, 300); }, 6000);
  }

  // Dans la WebView Android (app native), un lien <a download> sur une URL
  // blob: ne déclenche pas toujours de téléchargement visible (pas de
  // gestionnaire de téléchargement enregistré) : le clic ne fait rien, en
  // silence. On tente d'abord le partage natif (Web Share, fichier réel —
  // fonctionne dans la plupart des WebView Android récentes et laisse choisir
  // Fichiers/Drive/e-mail…), puis on retombe sur le lien classique (fonctionne
  // bien sur la version web/PWA). Voir aussi openCopyExport() : filet de
  // secours toujours disponible si aucun des deux ne fonctionne sur un
  // appareil donné.
  // Écrit le fichier via le plugin natif Capacitor Filesystem (cache de
  // l'app) puis ouvre le partage natif Android (Share) sur ce fichier —
  // totalement indépendant de la WebView : ni téléchargement blob:, ni API
  // presse-papiers, ni Web Share du navigateur, qui se sont tous montrés
  // peu fiables selon les appareils (certaines ROM Android restreignent ces
  // API pour les apps installées hors Play Store). Renvoie null si l'app ne
  // tourne pas dans le shell natif ou si les plugins ne sont pas dispo,
  // pour que l'appelant retombe sur le chemin web.
  function nativeShareFile(filename, content) {
    var Cap = window.Capacitor;
    if (!Cap || !Cap.isNativePlatform || !Cap.isNativePlatform()) return null;
    var Plugins = Cap.Plugins || {};
    var FS = Plugins.Filesystem, ShareApi = Plugins.Share;
    if (!FS || !ShareApi) return null;
    return FS.writeFile({ path: filename, data: content, directory: 'CACHE', encoding: 'utf8' })
      .then(function () { return FS.getUri({ path: filename, directory: 'CACHE' }); })
      .then(function (res) {
        return ShareApi.share({ title: filename, dialogTitle: 'Enregistrer ou partager ' + filename, files: [res.uri] });
      });
  }

  function webDownloadFallback(filename, content, mime) {
    var blob = new Blob([content], { type: mime });
    if (navigator.share && navigator.canShare && typeof File !== 'undefined') {
      try {
        var file = new File([blob], filename, { type: mime });
        if (navigator.canShare({ files: [file] })) {
          navigator.share({ files: [file] }).catch(function () { /* annulé par l'utilisateur : rien à faire */ });
          return;
        }
      } catch (e) { /* Web Share indisponible sur cet appareil : on retombe sur le lien classique */ }
    }
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function downloadFile(filename, content, mime) {
    var native = nativeShareFile(filename, content);
    if (native) {
      native.catch(function () { webDownloadFallback(filename, content, mime); });
      return;
    }
    webDownloadFallback(filename, content, mime);
  }

  // Filet de secours TOUJOURS disponible : affiche les données en texte
  // sélectionnable, avec un bouton copier. Ne dépend d'aucune API de
  // téléchargement/partage — marche même si downloadFile() échoue en silence.
  function openCopyExport(filename, content) {
    var dlg = $('#copyExportDialog');
    $('#copyExportTitle').textContent = 'Copier : ' + filename;
    var ta = $('#copyExportArea');
    ta.value = content;
    dlg.showModal();
    ta.focus();
    ta.select();
  }

  // --- Vues ------------------------------------------------------------

  function switchView(name) {
    $all('.view').forEach(function (v) { v.classList.toggle('active', v.id === 'view-' + name); });
    $all('.bottombar button').forEach(function (b) { b.classList.toggle('active', b.dataset.view === name); });
    if (name === 'tree') renderTree();
    if (name === 'list') renderList();
    if (name === 'settings') renderSettings();
  }

  function renderTree() {
    var hasPersons = Object.keys(state.persons).length > 0;
    treeEmpty.classList.toggle('hidden', hasPersons);
    if (!hasPersons) {
      while (treeSvg.firstChild) treeSvg.removeChild(treeSvg.firstChild);
      renderBreadcrumb();
      return;
    }
    if (!state.rootId || !state.persons[state.rootId]) state.rootId = Object.keys(state.persons)[0];
    var cr = currentRoot();
    panZoomCtl = Tree.render(treeSvg, state, { rootId: cr, mode: treeMode, maxGen: maxGen, onSelect: focusPerson, onOpen: openDetail });
    renderBreadcrumb();
    updateNav();
  }

  // Fil d'Ariane du chemin parcouru (rootHistory + position courante) :
  // chaque étape est cliquable et ramène directement dessus, plus rapide que
  // de cliquer plusieurs fois sur « Retour ».
  function renderBreadcrumb() {
    var nav = $('#treeBreadcrumb');
    if (!nav) return;
    if (!state.rootId || !state.persons[state.rootId]) { nav.innerHTML = ''; return; }
    var trail = rootHistory.concat([currentRoot()]);
    nav.innerHTML = trail.map(function (id, i) {
      var p = state.persons[id];
      var label = escapeHtml(p ? Store.fullName(p) : '?');
      var isLast = i === trail.length - 1;
      var sep = i > 0 ? '<span class="crumb-sep">›</span>' : '';
      return sep + '<button type="button" class="crumb' + (isLast ? ' current' : '') + '" data-idx="' + i + '"' +
        (isLast ? ' disabled' : '') + '>' + label + '</button>';
    }).join('');
    $all('#treeBreadcrumb .crumb:not(.current)').forEach(function (b) {
      b.addEventListener('click', function () { goToBreadcrumb(+b.dataset.idx); });
    });
  }

  // NAVIGATION vs RACINE.
  //
  // `state.rootId` = la PERSONNE RACINE (point d'ancrage, PERSISTÉE, définie dans
  // Réglages ou via « Définir comme racine »). Elle ne change PAS quand on
  // explore l'arbre. `viewRoot` = le centre d'affichage COURANT (navigation,
  // transitoire, non sauvegardé) : cliquer une pastille déplace la vue sans
  // perdre la racine. On revient à la racine d'un bouton 🏠, et à la personne
  // précédente d'un bouton Retour.
  var viewRoot = null;
  var rootHistory = [];

  function currentRoot() {
    return (viewRoot && state.persons[viewRoot]) ? viewRoot : state.rootId;
  }

  function updateNav() {
    var back = $('#btnTreeBack');
    if (back) back.disabled = rootHistory.length === 0;
    var home = $('#btnTreeHome');
    if (home) home.disabled = !state.rootId || currentRoot() === state.rootId;
  }

  // Déplacer la VUE (navigation) sans toucher à la racine persistée.
  function navigateTo(id) {
    if (!state.persons[id]) return;
    var cur = currentRoot();
    if (cur && cur !== id) rootHistory.push(cur);
    viewRoot = id;
    updateNav();
    renderTree();
  }

  function goBackRoot() {
    var prev;
    while (rootHistory.length) {
      prev = rootHistory.pop();
      if (state.persons[prev]) break;
      prev = null;
    }
    if (prev) { viewRoot = prev; updateNav(); renderTree(); }
  }

  // Saute directement à une étape du fil d'Ariane (index dans
  // rootHistory + position courante) : tronque l'historique après ce point.
  function goToBreadcrumb(idx) {
    var trail = rootHistory.concat([currentRoot()]);
    if (idx < 0 || idx >= trail.length - 1 || !state.persons[trail[idx]]) return;
    rootHistory = trail.slice(0, idx);
    viewRoot = trail[idx];
    updateNav();
    renderTree();
  }

  // Revenir à la PERSONNE RACINE (le point de départ).
  function goHome() {
    if (!state.rootId || !state.persons[state.rootId]) return;
    var cur = currentRoot();
    if (cur !== state.rootId) rootHistory.push(cur);
    viewRoot = state.rootId;
    updateNav();
    renderTree();
  }

  // Définir la PERSONNE RACINE (persistée) et s'y placer.
  function setHome(id) {
    if (!state.persons[id]) return;
    state.rootId = id;
    viewRoot = id;
    rootHistory = [];
    Store.save(state);
    updateNav();
    refreshAll();
  }

  // Clic sur une pastille = explorer cette branche (navigation).
  function focusPerson(id) {
    navigateTo(id);
  }

  // Première lettre de regroupement (par NOM de famille, plus naturel pour
  // chercher « les Sarniguet ») — accents neutralisés pour ne pas éclater
  // « É » et « E » en deux groupes séparés.
  function groupLetter(s) {
    // Ignore la ponctuation en tête (ex. surnom entre guillemets dans un nom
    // GEDCOM : `"Corfic" Morvan`) pour regrouper sur la vraie première lettre
    // plutôt que de tout jeter dans « # ».
    var stripped = (s || '').trim().replace(/^[^\p{L}\p{N}]+/u, '');
    var c = stripped.charAt(0).toUpperCase();
    if (!c) return '#';
    var norm = c.normalize('NFD').replace(/[̀-ͯ]/g, '');
    return /[A-Z]/.test(norm) ? norm : '#';
  }

  function renderAlphaStrip(letters) {
    var box = $('#alphaStrip');
    if (!box) return;
    // Peu d'intérêt à naviguer par lettre sur une petite liste.
    if (letters.length < 4) { box.innerHTML = ''; return; }
    box.innerHTML = letters.map(function (g) {
      return '<button type="button" data-letter="' + g + '">' + g + '</button>';
    }).join('');
    $all('#alphaStrip button').forEach(function (b) {
      b.addEventListener('click', function () {
        var el = document.getElementById('plh-' + b.dataset.letter);
        if (el) el.scrollIntoView({ block: 'start' });
      });
    });
  }

  // Bascule vers l'onglet Arbre, centré sur cette personne (navigation
  // depuis la liste, sans passer par la fiche détail).
  function viewInTree(id) {
    navigateTo(id);
    switchView('tree');
  }

  function renderList() {
    var results = Store.searchPersons(state, searchInput.value).slice().sort(function (a, b) {
      var ka = (a.nom || a.prenom || ''), kb = (b.nom || b.prenom || '');
      var c = ka.localeCompare(kb, 'fr', { sensitivity: 'base' });
      return c !== 0 ? c : Store.fullName(a).localeCompare(Store.fullName(b), 'fr', { sensitivity: 'base' });
    });
    personList.innerHTML = '';
    personListEmpty.classList.toggle('hidden', results.length > 0);
    var letters = [];
    var lastGroup = null;
    results.forEach(function (p) {
      var g = groupLetter(p.nom || p.prenom);
      if (g !== lastGroup) {
        lastGroup = g;
        letters.push(g);
        var h = document.createElement('li');
        h.className = 'person-list-header';
        h.id = 'plh-' + g;
        h.textContent = g;
        personList.appendChild(h);
      }
      var li = document.createElement('li');
      li.innerHTML = avatarHTML(p) +
        '<div style="flex:1 1 auto;min-width:0"><div class="person-line-name">' + escapeHtml(Store.fullName(p)) + '</div>' +
        '<div class="person-line-sub">' + escapeHtml(subLine(p)) + '</div></div>' +
        '<button class="person-nav-btn" type="button" title="Rechercher cette personne en ligne (WikiTree)">🔍</button>' +
        '<button class="person-nav-btn" type="button" title="Voir dans l’arbre">🌳</button>';
      var buttons = li.querySelectorAll('.person-nav-btn');
      buttons[0].addEventListener('click', function (e) {
        e.stopPropagation();
        completeFromWikiTree(p.id);
      });
      buttons[1].addEventListener('click', function (e) {
        e.stopPropagation();
        viewInTree(p.id);
      });
      li.addEventListener('click', function () { openDetail(p.id); });
      personList.appendChild(li);
    });
    renderAlphaStrip(letters);
  }

  function renderSettings() {
    rootSelect.innerHTML = '';
    Store.allPersons(state).sort(function (a, b) { return Store.fullName(a).localeCompare(Store.fullName(b)); })
      .forEach(function (p) {
        var opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = Store.fullName(p);
        if (p.id === state.rootId) opt.selected = true;
        rootSelect.appendChild(opt);
      });
    statPersons.textContent = Object.keys(state.persons).length;
    statUnions.textContent = Object.keys(state.unions).length;
    renderSuggestions();
  }

  // --- Suggestions : scan de l'arbre (doublons, fiches incomplètes, dates) ---

  var SUGGEST_CAP = 8;

  function personChips(ids, extraClass) {
    var shown = ids.slice(0, SUGGEST_CAP);
    var html = shown.map(function (id) {
      var p = state.persons[id];
      if (!p) return '';
      return '<span class="chip chip-name' + (extraClass ? ' ' + extraClass : '') + '" data-open="' + id + '">' + escapeHtml(Store.fullName(p)) + '</span>';
    }).join('');
    if (ids.length > SUGGEST_CAP) html += '<span class="muted" style="align-self:center;font-size:0.8rem">+' + (ids.length - SUGGEST_CAP) + ' de plus</span>';
    return html;
  }

  // Complétude d'une fiche (dates, lieux, sexe, notes, relations) : sert à
  // décider automatiquement laquelle garder lors d'une fusion approximative
  // (la plus complète l'emporte, l'autre est absorbée).
  function completenessScore(p) {
    var s = 0;
    if (p.naissance && p.naissance.date) s++;
    if (p.naissance && p.naissance.lieu) s++;
    if (p.deces && p.deces.date) s++;
    if (p.deces && p.deces.lieu) s++;
    if (p.sexe && p.sexe !== '?') s++;
    if (p.notes) s++;
    s += (p.parentIds || []).length;
    s += (p.unionIds || []).length * 2;
    return s;
  }

  function renderSuggestions() {
    var box = $('#suggestionsBox');
    if (!box) return;
    var issues = Store.scanIssues(state);
    var fuzzy = (issues.fuzzyDuplicates || []).filter(function (d) { return d.confidence !== 'faible'; });
    var total = issues.duplicates.length + fuzzy.length + issues.noDates.length + issues.noSexe.length +
      issues.isolated.length + issues.badDates.length;
    if (!total) {
      box.innerHTML = '<p class="muted">Aucun souci détecté. 👍</p>';
      return;
    }

    var html = '';
    if (issues.duplicates.length) {
      html += '<div class="detail-section"><h3>Doublons probables (' + issues.duplicates.length + ')</h3><div class="chip-row">';
      issues.duplicates.slice(0, SUGGEST_CAP).forEach(function (d) {
        var a = state.persons[d.a], b = state.persons[d.b];
        if (!a || !b) return;
        html += '<span class="chip chip-add" data-dup="' + d.a + '">' +
          escapeHtml(Store.fullName(a)) + ' ≈ ' + escapeHtml(Store.fullName(b)) + '</span>';
      });
      if (issues.duplicates.length > SUGGEST_CAP) html += '<span class="muted" style="align-self:center;font-size:0.8rem">+' + (issues.duplicates.length - SUGGEST_CAP) + ' de plus</span>';
      html += '</div></div>';
    }
    if (fuzzy.length) {
      html += '<div class="detail-section"><h3>Orthographe proche, probablement la même personne (' + fuzzy.length + ')</h3>' +
        '<p class="muted" style="margin:0 0 8px">Noms différents mais proches (fautes de frappe, troncatures). Vérifie avant de fusionner.</p>' +
        '<ul class="person-list picker-list" id="fuzzyDupList"></ul></div>';
    }
    if (issues.badDates.length) {
      html += '<div class="detail-section"><h3>Dates suspectes (' + issues.badDates.length + ')</h3><div class="chip-row">';
      issues.badDates.slice(0, SUGGEST_CAP).forEach(function (b) {
        var p = state.persons[b.id];
        if (!p) return;
        html += '<span class="chip chip-name" data-open="' + b.id + '" title="' + escapeHtml(b.reason) + '">' + escapeHtml(Store.fullName(p)) + '</span>';
      });
      if (issues.badDates.length > SUGGEST_CAP) html += '<span class="muted" style="align-self:center;font-size:0.8rem">+' + (issues.badDates.length - SUGGEST_CAP) + ' de plus</span>';
      html += '</div></div>';
    }
    if (issues.noDates.length) {
      html += '<div class="detail-section"><h3>Sans aucune date (' + issues.noDates.length + ')</h3><div class="chip-row">' + personChips(issues.noDates) + '</div></div>';
    }
    if (issues.noSexe.length) {
      html += '<div class="detail-section"><h3>Sexe non précisé (' + issues.noSexe.length + ')</h3><div class="chip-row">' + personChips(issues.noSexe) + '</div></div>';
    }
    if (issues.isolated.length) {
      html += '<div class="detail-section"><h3>Isolées — aucun parent ni union (' + issues.isolated.length + ')</h3><div class="chip-row">' + personChips(issues.isolated) + '</div></div>';
    }
    box.innerHTML = html;

    $all('#suggestionsBox [data-open]').forEach(function (el) {
      el.addEventListener('click', function () { openDetail(el.dataset.open); });
    });
    $all('#suggestionsBox [data-dup]').forEach(function (el) {
      el.addEventListener('click', function () { proposeMatch(el.dataset.dup, true); });
    });
    if (fuzzy.length) renderFuzzyDuplicates(fuzzy);
  }

  var CONFIDENCE_LABEL = { forte: 'confiance forte', 'moyenne-forte': 'confiance moyenne-forte', moyenne: 'confiance moyenne' };

  function renderFuzzyDuplicates(fuzzy) {
    var ul = $('#fuzzyDupList');
    if (!ul) return;
    ul.innerHTML = '';
    fuzzy.forEach(function (d) {
      var a = state.persons[d.a], b = state.persons[d.b];
      if (!a || !b) return;
      var keepId = completenessScore(a) >= completenessScore(b) ? d.a : d.b;
      var dropId = keepId === d.a ? d.b : d.a;
      var keep = state.persons[keepId], drop = state.persons[dropId];
      var gains = fieldGains(keep, drop).concat(relationGains(keepId, dropId));
      var li = document.createElement('li');
      li.innerHTML = avatarHTML(keep) +
        '<div style="flex:1 1 auto;min-width:0">' +
        '<div class="person-line-name">' + escapeHtml(Store.fullName(keep)) + ' ≈ ' + escapeHtml(Store.fullName(drop)) + '</div>' +
        '<div class="person-line-sub">' + escapeHtml(CONFIDENCE_LABEL[d.confidence] || d.confidence) + '</div>' +
        gainsHTML(gains) + '</div>' +
        '<button class="btn btn-sm btn-accent" type="button" data-role="merge">Fusionner</button>' +
        '<button class="btn btn-sm btn-ghost" type="button" data-role="ignore">Ignorer</button>';
      li.querySelector('[data-role="merge"]').addEventListener('click', function () {
        Store.mergePersons(state, keepId, dropId);
        refreshAll();
        toast('✓ Fusionné : ' + Store.fullName(keep));
      });
      li.querySelector('[data-role="ignore"]').addEventListener('click', function () { li.remove(); });
      ul.appendChild(li);
    });
  }

  function refreshAll() {
    renderTree();
    renderList();
    renderSettings();
  }

  // --- Formulaire personne (créer / modifier) --------------------------

  function openPersonForm(existing) {
    return new Promise(function (resolve) {
      var dlg = $('#personDialog');
      var form = $('#personForm');
      var btnCancel = $('#btnPersonCancel');
      $('#personFormTitle').textContent = existing ? 'Modifier la personne' : 'Nouvelle personne';
      $('#fPrenom').value = existing ? existing.prenom : '';
      $('#fNom').value = existing ? existing.nom : '';
      $('#fSexe').value = existing ? existing.sexe : '?';
      $('#fDecede').checked = existing ? !!existing.decede : false;
      $('#fNaissanceDate').value = existing && existing.naissance ? formatDateFr(existing.naissance.date) : '';
      $('#fNaissanceLieu').value = existing && existing.naissance ? existing.naissance.lieu : '';
      $('#fDecesDate').value = existing && existing.deces ? formatDateFr(existing.deces.date) : '';
      $('#fDecesLieu').value = existing && existing.deces ? existing.deces.lieu : '';
      $('#fNotes').value = existing ? existing.notes : '';

      var resolved = false;
      function finish(val) { if (resolved) return; resolved = true; resolve(val); }

      function onSubmit(e) {
        e.preventDefault();
        // Saisie en JJ/MM/AAAA (ou MM/AAAA, AAAA) ; converti vers le format
        // interne AAAA-MM-JJ avant validation et stockage.
        var nDate = parseDateFr($('#fNaissanceDate').value.trim());
        var dDate = parseDateFr($('#fDecesDate').value.trim());
        // Validation douce : vide, ou AAAA / AAAA-MM / AAAA-MM-JJ une fois
        // converti. On bloque la saisie invalide (elle casserait tri et
        // fusion) sans fermer la fenêtre.
        if (!isValidDate(nDate) || !isValidDate(dDate)) {
          alert('Date invalide. Formats acceptés : JJ/MM/AAAA, MM/AAAA ou AAAA (ex. 20/04/1889).');
          return;
        }
        var vPrenom = $('#fPrenom').value.trim();
        var vNom = $('#fNom').value.trim();
        // Prénom OU nom suffit (une personne peut n'avoir qu'un nom de famille —
        // sinon les fiches importées sans prénom devenaient impossibles à modifier).
        if (!vPrenom && !vNom) {
          alert('Indique au moins un prénom OU un nom.');
          return;
        }
        var fields = {
          prenom: vPrenom,
          nom: vNom,
          sexe: $('#fSexe').value,
          decede: $('#fDecede').checked,
          naissance: { date: nDate, lieu: $('#fNaissanceLieu').value.trim() },
          deces: { date: dDate, lieu: $('#fDecesLieu').value.trim() },
          notes: $('#fNotes').value.trim()
        };
        var person = null;
        try {
          person = existing ? Store.updatePerson(state, existing.id, fields) : Store.addPerson(state, fields);
        } catch (err) {
          alert('Enregistrement impossible : ' + err.message);
        }
        // Fermeture TOUJOURS effectuée (le dialog restait ouvert sur certains
        // WebView Android avec un form method="dialog").
        dlg.close();
        finish(person);
      }
      function onCancel() { dlg.close(); }
      function onClose() { finish(null); cleanup(); }
      function cleanup() {
        form.removeEventListener('submit', onSubmit);
        btnCancel.removeEventListener('click', onCancel);
        dlg.removeEventListener('close', onClose);
      }
      form.addEventListener('submit', onSubmit);
      btnCancel.addEventListener('click', onCancel);
      dlg.addEventListener('close', onClose);
      dlg.showModal();
    });
  }

  // --- Sélecteur de personne (existante ou nouvelle) --------------------

  function pickPerson(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var dlg = $('#pickerDialog');
      var search = $('#pickerSearch');
      var listEl = $('#pickerList');
      var newBtn = $('#pickerNew');
      var cancelBtn = $('#pickerCancel');
      $('#pickerTitle').textContent = opts.title || 'Choisir une personne';
      search.value = '';
      newBtn.style.display = opts.allowNew === false ? 'none' : '';

      var resolved = false, handled = false;
      function finish(val) { if (resolved) return; resolved = true; resolve(val); }

      function candidates(q) {
        var base = opts.onlyIds
          ? opts.onlyIds.map(function (id) { return state.persons[id]; }).filter(Boolean)
          : Store.allPersons(state);
        var excl = opts.excludeIds || [];
        var list = base.filter(function (p) { return excl.indexOf(p.id) === -1; });
        var qq = (q || '').toLowerCase().trim();
        if (qq) list = list.filter(function (p) { return Store.fullName(p).toLowerCase().indexOf(qq) !== -1; });
        return list.sort(function (a, b) { return Store.fullName(a).localeCompare(Store.fullName(b)); });
      }

      function renderOptions() {
        var results = candidates(search.value);
        listEl.innerHTML = '';
        if (!results.length) {
          var li = document.createElement('li');
          li.textContent = 'Aucun résultat.';
          li.style.cursor = 'default';
          listEl.appendChild(li);
          return;
        }
        results.forEach(function (p) {
          var li = document.createElement('li');
          li.innerHTML = avatarHTML(p) +
            '<div><div class="person-line-name">' + escapeHtml(Store.fullName(p)) + '</div>' +
            '<div class="person-line-sub">' + escapeHtml(subLine(p)) + '</div></div>';
          li.addEventListener('click', function () { closeAndResolve({ id: p.id }); });
          listEl.appendChild(li);
        });
      }

      function closeAndResolve(val) { handled = true; dlg.close(); finish(val); }

      function onSearch() { renderOptions(); }
      function onNew() {
        handled = true;
        dlg.close();
        openPersonForm(null).then(function (person) {
          finish(person ? { id: person.id } : null);
        });
      }
      function onCancel() { closeAndResolve(null); }
      function onClose() { if (!handled) finish(null); cleanup(); }
      function cleanup() {
        search.removeEventListener('input', onSearch);
        newBtn.removeEventListener('click', onNew);
        cancelBtn.removeEventListener('click', onCancel);
        dlg.removeEventListener('close', onClose);
      }

      search.addEventListener('input', onSearch);
      newBtn.addEventListener('click', onNew);
      cancelBtn.addEventListener('click', onCancel);
      dlg.addEventListener('close', onClose);

      renderOptions();
      dlg.showModal();
    });
  }

  // --- Fiche détail (navigation + actions de parenté) --------------------

  function relSection(title, list, addLabel, addAction, unlinkKind) {
    var chips = list.map(function (p) {
      var name = '<span class="chip-name" data-open="' + p.id + '">' + escapeHtml(Store.fullName(p)) + '</span>';
      var rm = unlinkKind ? '<button class="chip-x" type="button" title="Détacher" data-unlink="' + unlinkKind + '" data-id="' + p.id + '">×</button>' : '';
      return '<span class="chip">' + name + rm + '</span>';
    }).join('');
    var addChip = addAction ? '<span class="chip chip-add" data-act="' + addAction + '">+ ' + escapeHtml(addLabel) + '</span>' : '';
    var emptyHint = (!list.length && !addAction) ? '<span class="muted">—</span>' : '';
    return '<div class="detail-section"><h3>' + title + '</h3><div class="chip-row">' + chips + addChip + emptyHint + '</div></div>';
  }

  function renderDetail(personId) {
    var p = state.persons[personId];
    if (!p) return;
    var parents = Store.getParents(state, personId);
    var spouses = Store.getSpouses(state, personId);
    var children = Store.getChildren(state, personId);
    var siblings = Store.getSiblings(state, personId);

    var html = '<div class="detail-header">' + avatarHTML(p) +
      '<div><p class="detail-name">' + escapeHtml(Store.fullName(p)) + '</p>' +
      '<p class="detail-meta">' + escapeHtml(detailMeta(p)) +
      (p.wikitree ? ' <span class="detail-badge" title="Liée à un profil WikiTree">🔗 WikiTree</span>' : '') +
      '</p></div></div>';

    if (p.notes) html += '<div class="detail-section"><h3>Notes</h3><div class="detail-notes">' + escapeHtml(p.notes) + '</div></div>';

    html += relSection('Parents', parents, 'Ajouter un parent', 'add-parent', 'parent');
    html += relSection('Conjoint(s)', spouses, 'Ajouter un conjoint', 'add-spouse', 'spouse');
    html += relSection('Enfants', children, 'Ajouter un enfant', 'add-child', 'child');
    if (siblings.length) html += relSection('Frères et sœurs', siblings, null, null);

    // Trois groupes distincts plutôt qu'un tas de boutons indifférenciés :
    // action principale, outils/navigation secondaires, puis suppression
    // nettement à part (irréversible, ne doit pas se cliquer par réflexe).
    html += '<div class="detail-actions">' +
      '<div class="detail-actions-row">' +
        '<button class="btn btn-accent" data-act="edit">✎ Modifier</button>' +
        '<button class="btn" data-act="complete-online">🔎 Compléter en ligne</button>' +
      '</div>' +
      '<div class="detail-actions-row detail-actions-secondary">' +
        '<button class="btn btn-ghost btn-sm" data-act="center">📍 Centrer la vue</button>' +
        '<button class="btn btn-ghost btn-sm" data-act="set-home">🏠 Définir comme racine</button>' +
        '<button class="btn btn-ghost btn-sm" data-act="find-duplicates">🔗 Doublons locaux</button>' +
      '</div>' +
      '<div class="detail-actions-danger">' +
        '<button class="btn btn-danger btn-sm" data-act="delete">🗑 Supprimer cette personne</button>' +
      '</div>' +
      '</div>';

    detailContent.innerHTML = html;
    detailContent.dataset.personId = personId;
  }

  function openDetail(personId) {
    renderDetail(personId);
    detailDialog.showModal();
  }
  function closeDetail() { detailDialog.close(); }

  // Tous les descendants d'une personne (pour interdire de les choisir comme
  // parent : ça créerait une boucle « X est son propre ancêtre »).
  function descendantIds(id) {
    var seen = {}, stack = [id];
    while (stack.length) {
      Store.getChildren(state, stack.pop()).forEach(function (c) {
        if (!seen[c.id]) { seen[c.id] = true; stack.push(c.id); }
      });
    }
    return Object.keys(seen);
  }

  function addParentFlow(personId) {
    var p = state.persons[personId];
    if ((p.parentIds || []).length >= 2) { alert('Cette personne a déjà deux parents enregistrés.'); return; }
    var exclude = [personId].concat(descendantIds(personId));
    pickPerson({ title: 'Choisir le parent', excludeIds: exclude }).then(function (res) {
      if (!res) return;
      var slot = (p.parentIds || []).length;
      Store.setParent(state, personId, res.id, slot);
      renderDetail(personId);
      refreshAll();
    });
  }

  function addSpouseFlow(personId) {
    pickPerson({ title: 'Choisir le conjoint', excludeIds: [personId] }).then(function (res) {
      if (!res) return;
      Store.findOrCreateUnion(state, [personId, res.id]);
      renderDetail(personId);
      refreshAll();
    });
  }

  function addChildFlow(personId) {
    var unions = Store.getUnions(state, personId);
    function withUnion(union) {
      pickPerson({ title: 'Choisir l’enfant', excludeIds: [personId].concat(union.partnerIds) }).then(function (res) {
        if (!res) return;
        Store.addChildToUnion(state, union.id, res.id);
        renderDetail(personId);
        refreshAll();
      });
    }
    if (unions.length === 0) {
      withUnion(Store.findOrCreateUnion(state, [personId]));
    } else if (unions.length === 1) {
      withUnion(unions[0]);
    } else {
      var spouseIds = unions.map(function (u) {
        return u.partnerIds.filter(function (id) { return id !== personId; })[0];
      }).filter(Boolean);
      pickPerson({ title: 'Enfant avec quel conjoint ?', onlyIds: spouseIds, allowNew: false }).then(function (res) {
        if (!res) return;
        var union = unions.find(function (u) { return u.partnerIds.indexOf(res.id) !== -1; });
        if (union) withUnion(union);
      });
    }
  }

  // Après un ajout/une modif : cherche dans l'arbre une fiche qui ressemble et
  // propose de fusionner (raccrocher les branches, compléter les infos, éviter
  // les doublons). Priorité au LOCAL avant toute recherche en ligne.
  function proposeMatch(id, announceNone) {
    var subject = state.persons[id];
    if (!subject) return;
    var cands = Store.findSimilar(state, subject, id);
    if (!cands.length) {
      if (announceNone) alert('Aucun doublon local détecté pour « ' + Store.fullName(subject) +' ». L’arbre est cohérent sur cette personne.');
      return;
    }
    var dlg = $('#matchDialog');
    $('#matchIntro').textContent = '« ' + Store.fullName(subject) +
      ' » ressemble à une ou plusieurs fiches déjà présentes. Même personne ? La fusion complète les infos et raccroche les branches.';
    var listEl = $('#matchList');
    listEl.innerHTML = '';
    cands.slice(0, 6).forEach(function (c) {
      // Ce que fusionner apporterait au dossier conservé (c.person) : les
      // infos et branches présentes sur la fiche courante et absentes là-bas.
      var gains = fieldGains(c.person, subject).concat(relationGains(c.person.id, id));
      var li = document.createElement('li');
      li.innerHTML = '<div><div class="person-line-name">' + escapeHtml(Store.fullName(c.person)) + '</div>' +
        '<div class="person-line-sub">' + escapeHtml(detailMeta(c.person)) + '</div>' +
        gainsHTML(gains) + '</div>' +
        '<button class="btn btn-sm btn-accent" type="button">C’est la même</button>';
      li.querySelector('button').addEventListener('click', function () {
        Store.mergePersons(state, c.person.id, id);   // garde l'existante, absorbe l'autre
        dlg.close();
        refreshAll();
        openDetail(c.person.id);
      });
      listEl.appendChild(li);
    });
    dlg.showModal();
  }
  $('#matchKeep').addEventListener('click', function () { $('#matchDialog').close(); });

  function handleDetailAction(act, personId) {
    var p = state.persons[personId];
    if (!p) return;
    if (act === 'edit') {
      openPersonForm(p).then(function (updated) { if (updated) { renderDetail(personId); refreshAll(); proposeMatch(personId); } });
    } else if (act === 'center') {
      closeDetail(); navigateTo(personId);
    } else if (act === 'set-home') {
      closeDetail(); setHome(personId);
    } else if (act === 'delete') {
      if (confirm('Supprimer ' + Store.fullName(p) + ' ? Cette action retire aussi ses liens de parenté.')) {
        Store.deletePerson(state, personId);
        closeDetail();
        refreshAll();
      }
    } else if (act === 'add-parent') {
      addParentFlow(personId);
    } else if (act === 'add-spouse') {
      addSpouseFlow(personId);
    } else if (act === 'add-child') {
      addChildFlow(personId);
    } else if (act === 'complete-online') {
      completeFromWikiTree(personId);
    } else if (act === 'find-duplicates') {
      proposeMatch(personId, true);
    }
  }

  function unlinkRelation(kind, personId, otherId) {
    if (kind === 'parent') Store.removeParent(state, personId, otherId);
    else if (kind === 'spouse') Store.unlinkSpouse(state, personId, otherId);
    else if (kind === 'child') Store.unlinkChild(state, personId, otherId);
    renderDetail(personId);
    refreshAll();
  }

  detailContent.addEventListener('click', function (e) {
    var rmBtn = e.target.closest('[data-unlink]');
    if (rmBtn) { unlinkRelation(rmBtn.dataset.unlink, detailContent.dataset.personId, rmBtn.dataset.id); return; }
    var openBtn = e.target.closest('[data-open]');
    if (openBtn) { renderDetail(openBtn.dataset.open); return; }
    var actBtn = e.target.closest('[data-act]');
    if (actBtn) handleDetailAction(actBtn.dataset.act, detailContent.dataset.personId);
  });
  $('#btnDetailClose').addEventListener('click', closeDetail);

  // --- Barre de navigation + arbre ---------------------------------------

  $all('.bottombar button').forEach(function (b) {
    b.addEventListener('click', function () { switchView(b.dataset.view); });
  });

  $all('#modeSwitch button').forEach(function (b) {
    b.addEventListener('click', function () {
      treeMode = b.dataset.mode;
      $all('#modeSwitch button').forEach(function (x) { x.classList.toggle('active', x === b); });
      renderTree();
    });
  });

  $('#genRange').addEventListener('input', function (e) {
    maxGen = parseInt(e.target.value, 10);
    $('#genValue').textContent = maxGen;
    renderTree();
  });

  $('#btnChangeRoot').addEventListener('click', function () {
    pickPerson({ title: 'Aller à…', allowNew: false }).then(function (res) {
      if (!res) return;
      navigateTo(res.id);
    });
  });

  var backBtn = $('#btnTreeBack');
  if (backBtn) backBtn.addEventListener('click', goBackRoot);
  var homeBtn = $('#btnTreeHome');
  if (homeBtn) homeBtn.addEventListener('click', goHome);

  $('#btnZoomIn').addEventListener('click', function () { if (panZoomCtl) panZoomCtl.zoomIn(); });
  $('#btnZoomOut').addEventListener('click', function () { if (panZoomCtl) panZoomCtl.zoomOut(); });
  $('#btnZoomReset').addEventListener('click', function () { if (panZoomCtl) panZoomCtl.reset(); });

  function addPersonFlow() {
    openPersonForm(null).then(function (p) { if (p) { refreshAll(); proposeMatch(p.id); } });
  }
  $('#btnAddPerson').addEventListener('click', addPersonFlow);
  $('#btnEmptyAdd').addEventListener('click', addPersonFlow);

  searchInput.addEventListener('input', renderList);
  rootSelect.addEventListener('change', function () {
    setHome(rootSelect.value);
  });

  // --- Réglages : sauvegarde / GEDCOM / réinitialisation -----------------

  $('#btnExportJson').addEventListener('click', function () {
    downloadFile('arbre-genealogique.json', Store.exportJSON(state), 'application/json');
  });
  $('#btnCopyJson').addEventListener('click', function () {
    openCopyExport('arbre-genealogique.json', Store.exportJSON(state));
  });

  $('#importJsonInput').addEventListener('change', function (e) {
    var file = e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var imported = Store.importJSON(reader.result);
        if (confirm('Remplacer les données actuelles par ce fichier ? Cette action est irréversible.')) {
          state = imported;
          Store.save(state);
          refreshAll();
        }
      } catch (err) {
        alert('Fichier invalide : ' + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  $('#btnExportGedcom').addEventListener('click', function () {
    downloadFile('arbre-genealogique.ged', Gedcom.exportGEDCOM(state), 'text/plain');
  });
  $('#btnCopyGedcom').addEventListener('click', function () {
    openCopyExport('arbre-genealogique.ged', Gedcom.exportGEDCOM(state));
  });

  // Volontairement PAS navigator.clipboard.writeText() : dans certaines
  // WebView Android, cette API asynchrone reste bloquée en attente d'une
  // permission système qui ne se résout jamais — ça a fait planter l'app
  // pour un utilisateur (le bouton ne répondait plus du tout). execCommand
  // est synchrone, sans permission à négocier : ça ne peut pas rester
  // bloqué, même si le résultat est moins garanti sur certains appareils —
  // d'où le rappel de la sélection manuelle (fiable, indépendante de toute
  // API) dans le texte du dialogue au-dessus.
  $('#btnCopyExportDo').addEventListener('click', function () {
    var ta = $('#copyExportArea');
    ta.focus();
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    toast(ok ? '✓ Copié dans le presse-papiers' : 'Copie automatique indisponible : le texte est sélectionné, fais un appui long dessus puis « Copier »', ok ? '' : 'error');
  });
  $('#btnCopyExportClose').addEventListener('click', function () { $('#copyExportDialog').close(); });

  $('#importGedcomInput').addEventListener('change', function (e) {
    var file = e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var imported = Gedcom.parseGEDCOM(reader.result);
        openGedcomImportChoice(imported);
      } catch (err) {
        alert('Fichier invalide : ' + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  function openGedcomImportChoice(imported) {
    var dlg = $('#gedcomImportDialog');
    var nPersons = Object.keys(imported.persons).length;
    var nUnions = Object.keys(imported.unions).length;
    var hasExisting = Object.keys(state.persons).length > 0;
    $('#gedcomImportSummary').textContent =
      'Fichier : ' + nPersons + ' personne(s), ' + nUnions + ' union(s).' +
      (hasExisting ? ' Vos données actuelles contiennent ' + Object.keys(state.persons).length + ' personne(s).' : '');

    var btnMerge = $('#btnGedcomMerge');
    var btnReplace = $('#btnGedcomReplace');
    var btnCancel = $('#btnGedcomCancel');
    btnMerge.style.display = hasExisting ? '' : 'none';

    function onMerge() {
      var stats = Store.mergeGedcom(state, imported);
      dlg.close();
      refreshAll();
      var msg = 'Fusion terminée : ' + stats.matched + ' personne(s) rapprochée(s) et complétée(s), ' +
        stats.added + ' nouvelle(s) personne(s) ajoutée(s), ' + stats.unions + ' union(s) traitée(s).';
      if (stats.conflicts) {
        msg += '\n\n⚠️ ' + stats.conflicts + ' point(s) à vérifier (homonymes ambigus, dates/lieux divergents, ou filiations en conflit) :';
        (stats.details || []).slice(0, 12).forEach(function (d) { msg += '\n• ' + d; });
        if ((stats.details || []).length > 12) msg += '\n… et ' + (stats.details.length - 12) + ' autre(s).';
      }
      alert(msg);
    }
    function onReplace() {
      if (!confirm('Remplacer les données actuelles par ce fichier GEDCOM ? Cette action est irréversible.')) return;
      state = imported;
      Store.save(state);
      dlg.close();
      refreshAll();
    }
    function onCancel() { dlg.close(); }
    function onClose() { cleanup(); }
    function cleanup() {
      btnMerge.removeEventListener('click', onMerge);
      btnReplace.removeEventListener('click', onReplace);
      btnCancel.removeEventListener('click', onCancel);
      dlg.removeEventListener('close', onClose);
    }
    btnMerge.addEventListener('click', onMerge);
    btnReplace.addEventListener('click', onReplace);
    btnCancel.addEventListener('click', onCancel);
    dlg.addEventListener('close', onClose);
    dlg.showModal();
  }

  $('#btnReset').addEventListener('click', function () {
    if (confirm('Supprimer toutes les personnes et unions de cet appareil ? Cette action est irréversible.')) {
      state = Store.emptyState();
      Store.save(state);
      refreshAll();
    }
  });

  // --- Recherche généalogique en ligne (WikiTree) ------------------------

  var onlineDlg = $('#onlineSearchDialog');
  var wtResults = $('#wtResults');
  var wtStatus = $('#wtStatus');
  // Quand non-null : on ne CRÉE pas une nouvelle personne, on COMPLÈTE cette
  // fiche existante avec le profil WikiTree choisi (bouton « Compléter en ligne »
  // de la fiche). Null = recherche/import classique depuis l'onglet Personnes.
  var wtTargetId = null;
  var wtTimer = null;
  var wtCurrentCtrl = null; // AbortController de la recherche en cours, pour le bouton Annuler
  var wtStartTime = null;
  var inseeCurrentCtrl = null;
  var inseeStartTime = null;
  // Compteurs de génération : si une recherche relancée rend l'ancienne
  // obsolète, sa réponse (qui peut malgré tout finir par arriver bien plus
  // tard, ex. après un blocage en arrière-plan) ne doit plus écraser
  // l'affichage de la recherche courante.
  var wtGen = 0;
  var inseeGen = 0;

  // Historique des recherches en ligne (indépendant des données généalogiques :
  // clé localStorage séparée, jamais inclus dans les exports JSON/GEDCOM).
  var WT_HISTORY_KEY = 'genealogie:wtHistory:v1';
  var WT_HISTORY_MAX = 15;
  function loadSearchHistory() {
    try { return JSON.parse(localStorage.getItem(WT_HISTORY_KEY)) || []; } catch (e) { return []; }
  }
  function saveSearchHistory(list) {
    try { localStorage.setItem(WT_HISTORY_KEY, JSON.stringify(list.slice(0, WT_HISTORY_MAX))); } catch (e) {}
  }
  function logSearch(query, count, errorMsg) {
    if (!query) return;
    var list = loadSearchHistory().filter(function (h) { return h.query !== query; });
    list.unshift({ query: query, at: new Date().toISOString(), count: (count == null ? null : count), error: errorMsg || null });
    saveSearchHistory(list);
    renderSearchHistory();
  }
  function timeAgo(iso) {
    var s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 60) return 'à l’instant';
    var m = Math.floor(s / 60); if (m < 60) return 'il y a ' + m + ' min';
    var h = Math.floor(m / 60); if (h < 24) return 'il y a ' + h + ' h';
    return 'il y a ' + Math.floor(h / 24) + ' j';
  }
  function renderSearchHistory() {
    var box = $('#wtHistoryBox');
    if (!box) return;
    var list = loadSearchHistory();
    if (!list.length) { box.innerHTML = ''; return; }
    var html = '<div class="detail-section"><h3>Recherches récentes</h3><div class="chip-row">';
    html += list.map(function (h) {
      var sub = h.error ? 'échec' : (h.count == null ? '' : h.count + ' résultat(s)');
      return '<span class="chip chip-name" data-history="' + escapeHtml(h.query) + '" title="' + escapeHtml(timeAgo(h.at) + (sub ? ' · ' + sub : '')) + '">' +
        escapeHtml(h.query) + '</span>';
    }).join('');
    html += '</div></div>';
    box.innerHTML = html;
    $all('#wtHistoryBox [data-history]').forEach(function (el) {
      el.addEventListener('click', function () {
        $('#wtQuery').value = el.dataset.history;
        runOnlineSearch();
      });
    });
  }

  // Durée du filet de sécurité côté wikitree.js/insee.js (Promise.race) : sert
  // ici à donner une barre de progression DÉTERMINÉE plutôt qu'un spinner
  // indéfini — l'utilisateur voit combien de temps il reste avant l'échec.
  var SEARCH_TIMEOUT_MS = 30000;

  // Indique quelle voie de transport réseau est active (natif CapacitorHttp
  // ou fetch() web) : affiché à l'écran pendant la recherche ET répercuté
  // dans les messages d'erreur de wikitree.js/insee.js — sert de diagnostic
  // si un blocage réapparaît malgré les filets déjà en place, sans avoir à
  // deviner quelle voie a réellement été empruntée sur l'appareil.
  function transportTag() {
    var Cap = window.Capacitor;
    return (Cap && Cap.isNativePlatform && Cap.isNativePlatform()) ? 'natif' : 'web';
  }

  // Indicateur d'avancement de la recherche en ligne (elle peut être lente) :
  // spinner + compteur de secondes + barre de progression, bouton désactivé
  // le temps de l'appel.
  function wtBusy(on, label) {
    var btn = $('#wtSearchBtn');
    if (btn) btn.disabled = on;
    var cancelBtn = $('#wtCancelBtn');
    if (cancelBtn) cancelBtn.classList.toggle('hidden', !on);
    if (!on) { wtCurrentCtrl = null; wtStartTime = null; }
    if (wtTimer) { clearInterval(wtTimer); wtTimer = null; }
    var progressEl = $('#wtProgress');
    if (on) {
      if (progressEl) { progressEl.classList.remove('hidden'); progressEl.value = 0; }
      var t0 = Date.now();
      wtStartTime = t0;
      var draw = function () {
        var elapsed = Date.now() - t0;
        // Constaté sur appareil réel : le setTimeout indépendant posé dans
        // wikitree.js/insee.js (pourtant identique en principe) ne se
        // déclenche pas de façon fiable en production, alors que CE minuteur
        // (celui qui affiche le compteur de secondes) continue, lui,
        // d'avancer normalement jusqu'à 35+ s et au-delà — vérifié sur
        // plusieurs captures d'écran successives. Plutôt que de chercher à
        // comprendre pourquoi deux minuteurs a priori équivalents divergent,
        // on fait reposer l'arrêt forcé sur CELUI dont la fiabilité est
        // démontrée, ici, sur cet appareil précis.
        if (elapsed >= SEARCH_TIMEOUT_MS) { wtForceStop('Délai dépassé — réessaie.'); return; }
        var s = Math.floor(elapsed / 1000);
        wtStatus.innerHTML = '<span class="spinner"></span> ' + escapeHtml(label) + ' (' + s + ' s, ' + transportTag() + ')';
        if (progressEl) progressEl.value = Math.min(100, (elapsed / SEARCH_TIMEOUT_MS) * 100);
      };
      draw();
      wtTimer = setInterval(draw, 300);
    } else if (progressEl) {
      progressEl.classList.add('hidden');
    }
  }

  var inseeBox = $('#inseeBox');
  var inseeResults = $('#inseeResults');
  var inseeStatus = $('#inseeStatus');

  function openOnlineSearch() {
    wtTargetId = null;
    wtResults.innerHTML = '';
    wtStatus.textContent = '';
    if (inseeBox) inseeBox.classList.add('hidden');
    if (inseeResults) inseeResults.innerHTML = '';
    if (inseeStatus) inseeStatus.textContent = '';
    renderSearchHistory();
    onlineDlg.showModal();
  }

  // Lance la recherche WikiTree pré-remplie avec le nom de la personne, en mode
  // « compléter cette fiche » (BDD gratuite, en complément du rapprochement local).
  // En mode fiche individuelle, on interroge AUSSI le Fichier des décès INSEE
  // en parallèle : source différente (actes d'état civil français), utile pour
  // confirmer une date/lieu exact quand WikiTree ne suffit pas ou ne connaît
  // pas la personne.
  function completeFromWikiTree(personId) {
    var p = state.persons[personId];
    if (!p) return;
    wtTargetId = personId;
    $('#wtQuery').value = Store.fullName(p);
    wtResults.innerHTML = '';
    wtStatus.textContent = 'Recherche d’une correspondance pour « ' + Store.fullName(p) + ' »…';
    onlineDlg.showModal();
    // La section INSEE est rendue visible ICI, inconditionnellement, AVANT
    // même d'appeler searchInsee() : si searchInsee() ne s'exécute jamais
    // pour une raison imprévue, "En attente…" reste affiché au lieu que la
    // section entière disparaisse silencieusement — un signal de diagnostic
    // direct plutôt qu'une absence invisible.
    if (inseeBox) { inseeBox.classList.remove('hidden'); }
    if (inseeStatus) inseeStatus.textContent = 'En attente…';
    if (inseeResults) inseeResults.innerHTML = '';
    // Chaque source est isolée dans son propre try/catch : une exception
    // inattendue dans l'une (ex. accès à un élément DOM absent) ne doit
    // jamais empêcher l'autre de se lancer — les deux sont indépendantes
    // et doivent le rester même en cas de bug imprévu dans l'une d'elles.
    try { searchInsee(p); } catch (e) { inseeForceStop('Erreur interne : ' + e.message); }
    try { runOnlineSearch(); } catch (e) { wtForceStop('Erreur interne : ' + e.message); }
  }

  function fmtMatch(m) {
    var name = ((m.FirstName || '') + ' ' + (m.LastNameAtBirth || m.LastNameCurrent || '')).trim() || m.Name;
    var b = m.BirthDate && m.BirthDate !== '0000-00-00' ? m.BirthDate.slice(0, 4) : '';
    var d = m.DeathDate && m.DeathDate !== '0000-00-00' ? m.DeathDate.slice(0, 4) : '';
    var years = (b || d) ? ' (' + b + (d ? '–' + d : '') + ')' : '';
    var loc = m.BirthLocation ? ' · ' + m.BirthLocation : '';
    return { name: name, sub: (m.IsLiving ? 'Vivant · ' : '') + m.Name + years + loc };
  }

  function runOnlineSearch() {
    // Recherche GLOBALE : un seul champ. Dernier mot = nom, le reste = prénom
    // (un seul mot → traité comme nom, l'index principal de WikiTree).
    var q = ($('#wtQuery').value || '').trim();
    if (!q) { wtStatus.textContent = 'Saisis un nom (ou « prénom nom »).'; return; }
    var parts = q.split(/\s+/);
    var fn = '', ln = '';
    if (parts.length === 1) { ln = parts[0]; }
    else { ln = parts[parts.length - 1]; fn = parts.slice(0, -1).join(' '); }
    wtResults.innerHTML = '';
    wtBusy(true, 'Recherche en ligne…');
    var myGen = ++wtGen;
    WikiTree.search(fn, ln, 25, function (ctrl) { wtCurrentCtrl = ctrl; }).then(function (matches) {
      if (myGen !== wtGen) return; // recherche relancée entre-temps : réponse obsolète, ignorée
      wtBusy(false);
      logSearch(q, matches.length);
      // Notifie même si l'utilisateur a fermé la fenêtre entre-temps.
      toast('WikiTree : ' + matches.length + ' résultat(s) pour « ' + q + ' »' +
        (onlineDlg.open ? '' : ' — rouvre « Rechercher en ligne » pour choisir.'));
      if (!matches.length) { wtStatus.textContent = 'Aucun résultat.'; return; }
      var completing = !!wtTargetId;
      wtStatus.textContent = matches.length + ' résultat(s). ' +
        (completing ? 'Choisissez la correspondance pour compléter cette fiche :' : 'Choisissez qui importer :');
      matches.forEach(function (m) {
        var info = fmtMatch(m);
        var gains = (completing && state.persons[wtTargetId]) ? fieldGains(state.persons[wtTargetId], WikiTree.toFields(m)) : [];
        var li = document.createElement('li');
        li.innerHTML = avatarHTML({ prenom: m.FirstName, nom: m.LastNameAtBirth || m.LastNameCurrent }) +
          '<div style="flex:1 1 auto;min-width:0">' +
          '<div class="person-line-name">' + escapeHtml(info.name) + '</div>' +
          '<div class="person-line-sub">' + escapeHtml(info.sub) + '</div>' +
          gainsHTML(gains) + '</div>' +
          '<button class="btn btn-sm btn-accent" type="button">' + (completing ? 'Compléter' : 'Importer') + '</button>';
        li.querySelector('button').addEventListener('click', function () {
          if (wtTargetId) completeInto(m.Name, li, wtTargetId);
          else importFromWikiTree(m.Name, li);
        });
        wtResults.appendChild(li);
      });
    }).catch(function (err) {
      if (myGen !== wtGen) return;
      wtBusy(false);
      if (err && err.name === 'AbortError') { wtStatus.textContent = 'Recherche annulée.'; return; }
      logSearch(q, null, err.message);
      wtStatus.textContent = 'Échec de la recherche : ' + err.message;
      toast('Recherche WikiTree échouée : ' + err.message, 'error');
    });
  }

  // Force la fin de l'état "en cours", QUOI QU'IL ARRIVE côté réseau : on ne
  // dépend plus de ce que fait ctrl.abort() ni de si/quand la promesse en
  // cours finit par se résoudre. Le compteur de génération est incrémenté
  // pour que même une réponse tardive de l'ancienne requête (native, arrivée
  // bien après) soit ignorée au lieu d'écraser cet état forcé.
  function wtForceStop(msg) {
    wtGen++;
    wtBusy(false);
    wtStatus.textContent = msg;
  }
  function inseeForceStop(msg) {
    inseeGen++;
    if (inseeTimer) { clearInterval(inseeTimer); inseeTimer = null; }
    var progressEl = $('#inseeProgress');
    if (progressEl) progressEl.classList.add('hidden');
    inseeCurrentCtrl = null; inseeStartTime = null;
    inseeStatus.textContent = msg;
  }

  $('#wtCancelBtn').addEventListener('click', function () {
    if (wtCurrentCtrl) wtCurrentCtrl.abort();
    if (inseeCurrentCtrl) inseeCurrentCtrl.abort();
    wtForceStop('Recherche annulée.');
    inseeForceStop('Recherche annulée.');
  });

  // Filet de secours contre le blocage Android : quand l'écran s'éteint ou
  // que l'appli passe en arrière-plan, le système suspend/retarde fortement
  // les setTimeout/setInterval — y compris celui des 30 s censé faire
  // échouer une recherche bloquée. Résultat observé : la recherche reste
  // affichée "en cours" bien au-delà de 30 s (parfois plusieurs minutes,
  // voire indéfiniment sur certains ROM comme MIUI/Xiaomi qui gèlent
  // agressivement la WebView en arrière-plan), le minuteur n'ayant tout
  // simplement pas eu l'occasion de s'exécuter à temps. Dès qu'on détecte
  // un retour au premier plan — par n'importe quel signal disponible — on
  // vérifie nous-mêmes le temps réellement écoulé et on force l'arrêt
  // immédiatement (wtForceStop/inseeForceStop : mise à jour d'UI synchrone,
  // pas soumise au même throttling, et qui ne DÉPEND PAS de ce que fait le
  // réseau derrière) plutôt que d'attendre que le minuteur en retard — ou le
  // réseau lui-même — finisse par se déclencher. Plusieurs signaux sont
  // écoutés en parallèle car aucun n'est fiable à 100 % seul selon le
  // ROM/la version d'Android :
  //  - visibilitychange / focus (API web standard, WebView) ;
  //  - resume du plugin natif @capacitor/app (cycle de vie Android natif
  //    onResume, généralement plus fiable que les événements WebView sur
  //    les ROM avec gestion agressive de l'arrière-plan) ;
  //  - toute interaction de l'utilisateur avec le dialogue de recherche
  //    (dernier recours garanti : dès qu'il retouche l'écran, on nettoie).
  function checkStaleSearches() {
    var now = Date.now();
    if (wtCurrentCtrl && wtStartTime && (now - wtStartTime) >= SEARCH_TIMEOUT_MS) {
      wtCurrentCtrl.abort();
      wtForceStop('Délai dépassé — réessaie.');
    }
    if (inseeCurrentCtrl && inseeStartTime && (now - inseeStartTime) >= SEARCH_TIMEOUT_MS) {
      inseeCurrentCtrl.abort();
      inseeForceStop('Délai dépassé — réessaie.');
    }
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') checkStaleSearches();
  });
  window.addEventListener('focus', checkStaleSearches);
  onlineDlg.addEventListener('click', checkStaleSearches);
  if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
    window.Capacitor.Plugins.App.addListener('resume', checkStaleSearches);
  }

  function fmtInsee(f) {
    var name = ((f.prenom || '') + ' ' + (f.nom || '')).trim();
    var b = f.naissance.date ? f.naissance.date.slice(0, 4) : '';
    var d = f.deces.date ? f.deces.date.slice(0, 4) : '';
    var years = (b || d) ? ' (' + b + '–' + d + ')' : '';
    var loc = [f.naissance.lieu, f.deces.lieu].filter(Boolean).join(' → ');
    return { name: name, sub: 'Décès INSEE' + years + (loc ? ' · ' + loc : '') };
  }

  // Interroge le Fichier des décès INSEE (état civil français) pour la fiche
  // ciblée, en complément de WikiTree — ne sert qu'à COMPLÉTER/CONFIRMER
  // (pas de parents/enfants dans cette source). Échec réseau silencieux :
  // ne doit jamais bloquer ni polluer la recherche WikiTree en parallèle.
  var inseeTimer = null;
  function searchInsee(p) {
    if (!inseeBox || !p || !p.nom) { if (inseeBox) inseeBox.classList.add('hidden'); return; }
    var progressEl = $('#inseeProgress');
    inseeBox.classList.remove('hidden');
    inseeResults.innerHTML = '';
    if (inseeTimer) { clearInterval(inseeTimer); inseeTimer = null; }
    if (progressEl) progressEl.value = 0;
    var t0 = Date.now();
    inseeStartTime = t0;
    var draw = function () {
      var elapsed = Date.now() - t0;
      if (elapsed >= SEARCH_TIMEOUT_MS) { inseeForceStop('Délai dépassé — réessaie.'); return; }
      var s = Math.floor(elapsed / 1000);
      inseeStatus.innerHTML = '<span class="spinner"></span> Recherche dans le Fichier des décès (INSEE)… (' + s + ' s, ' + transportTag() + ')';
      if (progressEl) progressEl.value = Math.min(100, (elapsed / SEARCH_TIMEOUT_MS) * 100);
    };
    if (progressEl) progressEl.classList.remove('hidden');
    draw();
    inseeTimer = setInterval(draw, 300);
    function stop() {
      if (inseeTimer) { clearInterval(inseeTimer); inseeTimer = null; }
      if (progressEl) progressEl.classList.add('hidden');
      inseeCurrentCtrl = null; inseeStartTime = null;
    }
    var year = (p.naissance && p.naissance.date) ? p.naissance.date.slice(0, 4) : '';
    var myGen = ++inseeGen;
    InseeDeces.search(p.prenom, p.nom, year, function (ctrl) { inseeCurrentCtrl = ctrl; }).then(function (matches) {
      if (myGen !== inseeGen) return;
      stop();
      var name = Store.fullName(p);
      toast('INSEE (décès) : ' + matches.length + ' résultat(s) pour « ' + name + ' »' +
        (onlineDlg.open ? '' : ' — rouvre la recherche pour voir.'));
      if (!matches.length) { inseeStatus.textContent = 'Aucun résultat dans le Fichier des décès pour « ' + name + ' ».'; return; }
      inseeStatus.textContent = matches.length + ' résultat(s) — actes d\'état civil :';
      matches.forEach(function (f) {
        var info = fmtInsee(f);
        var gains = fieldGains(p, f);
        var li = document.createElement('li');
        li.innerHTML = avatarHTML(f) +
          '<div style="flex:1 1 auto;min-width:0">' +
          '<div class="person-line-name">' + escapeHtml(info.name) + '</div>' +
          '<div class="person-line-sub">' + escapeHtml(info.sub) + '</div>' +
          gainsHTML(gains) + '</div>' +
          '<button class="btn btn-sm btn-accent" type="button">Compléter</button>';
        li.querySelector('button').addEventListener('click', function () {
          completeIntoInsee(f, li, p.id);
        });
        inseeResults.appendChild(li);
      });
    }).catch(function (err) {
      if (myGen !== inseeGen) return;
      stop();
      inseeStatus.textContent = 'Fichier des décès indisponible : ' + err.message;
    });
  }

  // Complète la fiche ciblée avec un résultat INSEE (mêmes règles que
  // completeInto : on ne remplace jamais un champ déjà renseigné).
  function completeIntoInsee(f, li, targetId) {
    var btn = li.querySelector('button');
    btn.disabled = true; btn.textContent = '…';
    var target = state.persons[targetId];
    if (!target) return;
    if (!target.prenom) target.prenom = f.prenom;
    if (!target.nom) target.nom = f.nom;
    if (target.sexe === '?' && f.sexe && f.sexe !== '?') target.sexe = f.sexe;
    target.naissance = target.naissance || { date: '', lieu: '' };
    target.deces = target.deces || { date: '', lieu: '' };
    if (!target.naissance.date) target.naissance.date = f.naissance.date;
    if (!target.naissance.lieu) target.naissance.lieu = f.naissance.lieu;
    if (!target.deces.date) target.deces.date = f.deces.date;
    if (!target.deces.lieu) target.deces.lieu = f.deces.lieu;
    if (!target.decede) target.decede = true;
    if (f.notes && (target.notes || '').indexOf(f.notes) === -1) {
      target.notes = target.notes ? target.notes + '\n' + f.notes : f.notes;
    }
    Store.save(state);
    refreshAll();
    toast('✓ Fiche complétée depuis le Fichier des décès (INSEE) : ' + Store.fullName(target));
    btn.textContent = '✓ Complété';
    openDetail(target.id);
  }

  function importFromWikiTree(key, li) {
    var withRel = $('#wtWithRelatives').checked;
    var btn = li.querySelector('button');
    wtBusy(true, 'Import des données…');
    btn.disabled = true; btn.textContent = 'Import…';
    WikiTree.getRelatives(key).then(function (rel) {
      // Index des personnes déjà importées (par identifiant WikiTree) pour éviter les doublons.
      var byKey = {};
      Object.keys(state.persons).forEach(function (id) {
        var w = state.persons[id].wikitree;
        if (w) byKey[w] = state.persons[id];
      });
      function ensure(profile) {
        if (!profile || !profile.Name) return null;
        if (byKey[profile.Name]) return byKey[profile.Name];
        var p = Store.addPerson(state, WikiTree.toFields(profile));
        byKey[profile.Name] = p;
        return p;
      }
      var main = ensure(rel.person);
      if (withRel) {
        var father = ensure(rel.parents[rel.fatherId]);
        var mother = ensure(rel.parents[rel.motherId]);
        var pIds = [];
        if (father) pIds.push(father.id);
        if (mother) pIds.push(mother.id);
        if (pIds.length) main.parentIds = pIds;
        if (father && mother) Store.findOrCreateUnion(state, [father.id, mother.id]);
        var spouseIds = Object.keys(rel.spouses || {})
          .map(function (k) { return ensure(rel.spouses[k]); })
          .filter(Boolean).map(function (s) { return s.id; });
        spouseIds.forEach(function (sid) { Store.findOrCreateUnion(state, [main.id, sid]); });
        Object.keys(rel.children || {}).forEach(function (k) {
          var c = ensure(rel.children[k]);
          if (!c) return;
          var partners = spouseIds.length ? [main.id, spouseIds[0]] : [main.id];
          var u = Store.findOrCreateUnion(state, partners);
          Store.addChildToUnion(state, u.id, c.id);
        });
      }
      // Recentre la VUE sur la personne importée, sans toucher à la racine
      // persistée : elle ne change que si l'utilisateur le demande explicitement
      // (bouton « Définir comme racine »).
      viewRoot = main.id;
      rootHistory = [];
      Store.save(state);
      refreshAll();
      wtBusy(false);
      wtStatus.textContent = 'Importé : ' + Store.fullName(main) + (withRel ? ' (avec ses proches)' : '') + '. Vue recentrée.';
      btn.textContent = '✓ Importé';
      toast('✓ Importé depuis WikiTree : ' + Store.fullName(main));
    }).catch(function (err) {
      wtBusy(false);
      btn.disabled = false; btn.textContent = 'Importer';
      wtStatus.textContent = 'Échec de l’import : ' + err.message;
    });
  }

  // Complète une fiche EXISTANTE avec un profil WikiTree (ne crée pas de doublon
  // de la personne visée) et raccroche éventuellement ses proches.
  function completeInto(key, li, targetId) {
    var btn = li.querySelector('button');
    btn.disabled = true; btn.textContent = '…';
    wtBusy(true, 'Complétion des données…');
    WikiTree.getRelatives(key).then(function (rel) {
      var target = state.persons[targetId];
      if (!target) throw new Error('Fiche à compléter introuvable');
      var f = WikiTree.toFields(rel.person);
      if (!target.prenom) target.prenom = f.prenom;
      if (!target.nom) target.nom = f.nom;
      if (target.sexe === '?' && f.sexe && f.sexe !== '?') target.sexe = f.sexe;
      target.naissance = target.naissance || { date: '', lieu: '' };
      target.deces = target.deces || { date: '', lieu: '' };
      if (!target.naissance.date) target.naissance.date = f.naissance.date;
      if (!target.naissance.lieu) target.naissance.lieu = f.naissance.lieu;
      if (!target.deces.date) target.deces.date = f.deces.date;
      if (!target.deces.lieu) target.deces.lieu = f.deces.lieu;
      if (!target.decede && f.decede) target.decede = true;
      if (!target.wikitree) target.wikitree = f.wikitree;
      if (f.notes && (target.notes || '').indexOf(f.notes) === -1) {
        target.notes = target.notes ? target.notes + '\n' + f.notes : f.notes;
      }

      if ($('#wtWithRelatives').checked) {
        var byKey = {};
        Object.keys(state.persons).forEach(function (id) {
          var w = state.persons[id].wikitree;
          if (w) byKey[w] = state.persons[id];
        });
        function ensure(profile) {
          if (!profile || !profile.Name) return null;
          if (byKey[profile.Name]) return byKey[profile.Name];
          var p = Store.addPerson(state, WikiTree.toFields(profile));
          byKey[profile.Name] = p;
          return p;
        }
        // Parents : seulement si la fiche n'en a pas déjà (on n'écrase rien).
        if (!(target.parentIds || []).length) {
          var father = ensure(rel.parents[rel.fatherId]);
          var mother = ensure(rel.parents[rel.motherId]);
          var slot = 0;
          if (father) { Store.setParent(state, target.id, father.id, slot++); }
          if (mother) { Store.setParent(state, target.id, mother.id, slot++); }
        }
        var spouseIds = Object.keys(rel.spouses || {})
          .map(function (k) { return ensure(rel.spouses[k]); })
          .filter(Boolean).map(function (s) { return s.id; });
        spouseIds.forEach(function (sid) { Store.findOrCreateUnion(state, [target.id, sid]); });
        Object.keys(rel.children || {}).forEach(function (k) {
          var c = ensure(rel.children[k]);
          if (!c) return;
          var partners = spouseIds.length ? [target.id, spouseIds[0]] : [target.id];
          var u = Store.findOrCreateUnion(state, partners);
          Store.addChildToUnion(state, u.id, c.id);
        });
      }

      Store.save(state);
      refreshAll();
      wtBusy(false);
      toast('✓ Fiche complétée depuis WikiTree : ' + Store.fullName(target));
      onlineDlg.close();
      wtTargetId = null;
      openDetail(target.id);
    }).catch(function (err) {
      wtBusy(false);
      btn.disabled = false; btn.textContent = 'Compléter';
      wtStatus.textContent = 'Échec : ' + err.message;
      toast('Complétion échouée : ' + err.message, 'error');
    });
  }

  // --- Correspondances WikiTree suggérées (façon « Smart Match » MyHeritage,
  // mais manuel : on cherche pour toi, tu décides pour chaque suggestion) ---

  // Personnes sans lien WikiTree déjà établi, les plus incomplètes en premier
  // (probablement les plus utiles à compléter). Plafonné : chaque recherche
  // est un appel réseau, pas question d'en lancer des centaines d'un coup.
  function candidatesForOnlineMatch(limit) {
    return Store.allPersons(state)
      .filter(function (p) { return !p.wikitree && (p.prenom || p.nom); })
      .sort(function (a, b) {
        // Priorité aux fiches qui ONT une date de naissance : c'est ce qui
        // permet à pickBestMatch() de retenir une correspondance avec
        // confiance (même année). Sans aucune date, WikiTree renvoie souvent
        // plusieurs homonymes indépartageables → recherche pour rien. En
        // cherchant d'abord les fiches datées, les premiers résultats
        // exploitables arrivent bien plus vite.
        function hasDate(p) { return !!(p.naissance && p.naissance.date); }
        var ad = hasDate(a) ? 1 : 0, bd = hasDate(b) ? 1 : 0;
        if (ad !== bd) return bd - ad;
        function completeness(p) {
          var s = 0;
          if (p.naissance && p.naissance.date) s++;
          if (p.deces && p.deces.date) s++;
          if (p.sexe && p.sexe !== '?') s++;
          return s;
        }
        return completeness(a) - completeness(b);
      })
      .slice(0, limit);
  }

  // Correspondances écartées par l'utilisateur (« Signaler incohérence »),
  // par personne : on ne les represente plus jamais tant qu'on ne trouve pas
  // autre chose. Clé séparée, jamais incluse dans les exports.
  var WT_REJECTED_KEY = 'genealogie:wtRejected:v1';
  function loadRejected() {
    try { return JSON.parse(localStorage.getItem(WT_REJECTED_KEY)) || {}; } catch (e) { return {}; }
  }
  function saveRejected(map) {
    try { localStorage.setItem(WT_REJECTED_KEY, JSON.stringify(map)); } catch (e) {}
  }
  function rejectedKeysFor(personId) { return loadRejected()[personId] || []; }
  function addRejected(personId, key) {
    var map = loadRejected();
    var list = map[personId] || [];
    if (list.indexOf(key) === -1) list.push(key);
    map[personId] = list;
    saveRejected(map);
  }

  // Ne retient qu'une correspondance NON AMBIGUË parmi les résultats WikiTree :
  // même année de naissance des deux côtés, ou candidat unique si la fiche
  // locale n'a pas de date — en écartant les candidats déjà signalés comme
  // incohérents pour cette personne (sinon ils reviendraient à l'identique).
  function pickBestMatch(p, matches, rejectedKeys) {
    var candidates = matches.filter(function (m) { return rejectedKeys.indexOf(m.Name) === -1; });
    var localYear = p.naissance && p.naissance.date ? p.naissance.date.slice(0, 4) : '';
    if (localYear) {
      return candidates.filter(function (m) {
        var y = m.BirthDate && m.BirthDate !== '0000-00-00' ? m.BirthDate.slice(0, 4) : '';
        return y === localYear;
      })[0] || null;
    }
    return candidates.length === 1 ? candidates[0] : null;
  }

  // Cherche sur WikiTree pour chaque personne du lot (3 recherches en
  // parallèle max) et ne retient qu'une correspondance non ambiguë (voir
  // pickBestMatch) — sinon on ignore silencieusement : mieux vaut rater une
  // suggestion que proposer un mauvais rapprochement.
  // onResult(item) est appelé DÈS qu'une correspondance est trouvée (pas
  // besoin d'attendre la fin du lot pour voir les premiers résultats — un
  // lot de 10 recherches peut prendre du temps si l'une d'elles traîne).
  function scanOnlineSuggestions(persons, onProgress, onResult) {
    var CONCURRENCY = 6; // plus de recherches en vol = premiers résultats plus vite
    var results = [];
    var idx = 0, done = 0;
    return new Promise(function (resolve) {
      function next() {
        if (idx >= persons.length) return;
        var p = persons[idx++];
        WikiTree.search(p.prenom || '', p.nom || '', 5).then(function (matches) {
          var best = pickBestMatch(p, matches, rejectedKeysFor(p.id));
          if (best) {
            var item = { personId: p.id, match: best };
            results.push(item);
            if (onResult) onResult(item);
          }
        }).catch(function () { /* recherche individuelle ratée : on l'ignore, ce n'est qu'une suggestion */ })
          .then(function () {
            done++;
            if (onProgress) onProgress(done, persons.length);
            if (idx < persons.length) next();
            else if (done === persons.length) resolve(results);
          });
      }
      if (!persons.length) { resolve(results); return; }
      for (var i = 0; i < Math.min(CONCURRENCY, persons.length); i++) next();
    });
  }

  // Construit la ligne d'une suggestion (avatar, apports, actions). Réutilisé
  // pour l'affichage initial et pour remplacer une ligne après un signalement.
  function buildSuggestionRow(item) {
    var p = state.persons[item.personId];
    if (!p) return null;
    var info = fmtMatch(item.match);
    var gains = fieldGains(p, WikiTree.toFields(item.match));
    var li = document.createElement('li');
    li.innerHTML = avatarHTML(p) +
      '<div style="flex:1 1 auto;min-width:0">' +
      '<div class="person-line-name">' + escapeHtml(Store.fullName(p)) + ' → ' + escapeHtml(info.name) + '</div>' +
      '<div class="person-line-sub">' + escapeHtml(info.sub) + '</div>' +
      gainsHTML(gains) + '</div>' +
      '<button class="btn btn-sm btn-accent" type="button" data-role="complete">Compléter</button>' +
      '<button class="btn btn-sm btn-ghost" type="button" data-role="reject" title="Signaler que ce n’est pas la bonne personne et en chercher une autre">⚠️</button>' +
      '<button class="btn btn-sm btn-ghost" type="button" data-role="ignore">Ignorer</button>';
    li.querySelector('[data-role="complete"]').addEventListener('click', function () { completeInto(item.match.Name, li, item.personId); });
    li.querySelector('[data-role="ignore"]').addEventListener('click', function () { li.remove(); });
    li.querySelector('[data-role="reject"]').addEventListener('click', function () { reportMatchInconsistency(item, li); });
    return li;
  }

  // « Signaler incohérence » : cette correspondance n'est pas la bonne
  // personne. On la met de côté (elle ne reviendra plus pour cette fiche) et
  // on relance une recherche WikiTree en tâche de fond, sans bloquer le reste
  // de l'écran, pour proposer une autre correspondance si une existe.
  function reportMatchInconsistency(item, li) {
    addRejected(item.personId, item.match.Name);
    var p = state.persons[item.personId];
    var sub = li.querySelector('.person-line-sub');
    li.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
    if (sub) sub.innerHTML = '<span class="spinner"></span> Recherche d’une autre correspondance…';
    if (!p) { li.remove(); return; }
    WikiTree.search(p.prenom || '', p.nom || '', 5).then(function (matches) {
      var best = pickBestMatch(p, matches, rejectedKeysFor(p.id));
      if (!best) {
        if (sub) sub.textContent = 'Aucune autre correspondance trouvée.';
        ['complete', 'reject'].forEach(function (role) {
          var b = li.querySelector('[data-role="' + role + '"]');
          if (b) b.remove();
        });
        var ignoreBtn = li.querySelector('[data-role="ignore"]');
        if (ignoreBtn) { ignoreBtn.disabled = false; ignoreBtn.textContent = 'Fermer'; }
        return;
      }
      var fresh = buildSuggestionRow({ personId: item.personId, match: best });
      if (fresh) li.replaceWith(fresh); else li.remove();
    }).catch(function () {
      if (sub) sub.textContent = 'Échec de la nouvelle recherche — réessaie plus tard.';
      li.querySelectorAll('button').forEach(function (b) { b.disabled = false; });
    });
  }

  function findOnlineSuggestions() {
    var btn = $('#btnFindOnlineSuggestions');
    var status = $('#onlineSuggestStatus');
    var listEl = $('#onlineSuggestList');
    var candidates = candidatesForOnlineMatch(10);
    if (!candidates.length) { status.textContent = 'Toutes les fiches ont déjà un lien WikiTree (ou aucune personne à vérifier).'; return; }
    btn.disabled = true;
    listEl.innerHTML = '';
    var found = 0, doneCount = 0;
    function drawStatus() {
      status.innerHTML = '<span class="spinner"></span> Vérification de ' + candidates.length + ' fiche(s)… (' + doneCount + '/' + candidates.length + ')' +
        (found ? ' — ' + found + ' trouvée(s) pour l’instant' : '');
    }
    drawStatus();
    scanOnlineSuggestions(candidates, function (done) {
      doneCount = done;
      drawStatus();
    }, function (item) {
      // Affiché dès qu'une correspondance est trouvée, sans attendre la fin
      // du lot — une recherche peut mettre jusqu'à 30 s (timeout), pas
      // question de faire attendre pour les résultats déjà là.
      found++;
      var li = buildSuggestionRow(item);
      if (li) listEl.appendChild(li);
      drawStatus();
    }).then(function (results) {
      btn.disabled = false;
      status.textContent = results.length
        ? results.length + ' correspondance(s) suggérée(s) sur ' + candidates.length + ' fiche(s) vérifiée(s).'
        : 'Aucune correspondance non ambiguë trouvée sur ' + candidates.length + ' fiche(s) vérifiée(s).';
    });
  }

  $('#btnFindOnlineSuggestions').addEventListener('click', findOnlineSuggestions);

  $('#btnRescan').addEventListener('click', renderSuggestions);
  $('#btnOnlineSearch').addEventListener('click', openOnlineSearch);
  // En mode « compléter cette fiche », un relance manuelle (bouton ou Entrée)
  // doit aussi relancer la recherche INSEE : sinon elle ne s'affiche qu'à
  // l'ouverture automatique du dialogue et disparaît de fait dès qu'on
  // retape/relance la recherche soi-même.
  function triggerOnlineSearch() {
    // Voir completeFromWikiTree : sources isolées, l'une ne doit jamais
    // pouvoir empêcher l'autre de se lancer.
    if (wtTargetId && state.persons[wtTargetId]) {
      try { searchInsee(state.persons[wtTargetId]); } catch (e) { inseeForceStop('Erreur interne : ' + e.message); }
    }
    try { runOnlineSearch(); } catch (e) { wtForceStop('Erreur interne : ' + e.message); }
  }
  $('#wtSearchBtn').addEventListener('click', triggerOnlineSearch);
  $('#wtClose').addEventListener('click', function () { onlineDlg.close(); });
  $('#wtQuery').addEventListener('keydown', function (e) { if (e.key === 'Enter') triggerOnlineSearch(); });

  // --- Version affichée ---------------------------------------------------

  var APP_VERSION = '1.4.32';
  var vTop = $('#appVersion'); if (vTop) vTop.textContent = 'v' + APP_VERSION;
  var vSet = $('#appVersionSettings'); if (vSet) vSet.textContent = APP_VERSION;

  // --- PWA / démarrage ----------------------------------------------------

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }

  refreshAll();
})();
