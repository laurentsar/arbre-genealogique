/* Online — recherche généalogique en ligne : WikiTree (import, complétion de
   fiche, correspondances suggérées) et Fichier des décès INSEE. Séparé du
   contrôleur principal (app.js) : ne dépend de lui que via window.GenApp
   (état courant, rendu, fiche, notifications). Chargé APRÈS app.js. */
(function () {
  'use strict';

  var App = window.GenApp;
  var U = window.GenUtil;
  var $ = U.$, $all = U.$all, escapeHtml = U.escapeHtml, timeAgo = U.timeAgo, splitNameQuery = U.splitNameQuery;
  var geneanetSearchUrl = U.geneanetSearchUrl, antenatiSearchUrl = U.antenatiSearchUrl;
  var avatarHTML = App.avatarHTML, gainsHTML = App.gainsHTML, fieldGains = App.fieldGains;
  var toast = App.toast, refreshAll = App.refreshAll, openDetail = App.openDetail;
  var openExternal = App.openExternal, showSplitScreenTipOnce = App.showSplitScreenTipOnce;


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
    // Repliée par défaut (<details> sans "open") : utile à retrouver, mais
    // ne doit pas encombrer la fenêtre de recherche à chaque ouverture.
    var html = '<details class="history-disclosure"><summary>Recherches récentes (' + list.length + ')</summary><div class="chip-row">';
    html += list.map(function (h) {
      var sub = h.error ? 'échec' : (h.count == null ? '' : h.count + ' résultat(s)');
      return '<span class="chip chip-name" data-history="' + escapeHtml(h.query) + '" title="' + escapeHtml(timeAgo(h.at) + (sub ? ' · ' + sub : '')) + '">' +
        escapeHtml(h.query) + '</span>';
    }).join('');
    html += '</div></details>';
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
    var p = App.state.persons[personId];
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

  // Champ de recherche GLOBAL (un seul champ) : dernier mot = nom, le reste
  // = prénom (un seul mot → traité comme nom, l'index principal de WikiTree).
  function splitNameQuery(q) {
    var parts = q.split(/\s+/);
    if (parts.length === 1) return { fn: '', ln: parts[0] };
    return { fn: parts.slice(0, -1).join(' '), ln: parts[parts.length - 1] };
  }

  function runOnlineSearch() {
    var q = ($('#wtQuery').value || '').trim();
    if (!q) { wtStatus.textContent = 'Saisis un nom (ou « prénom nom »).'; return; }
    var parsed = splitNameQuery(q);
    var fn = parsed.fn, ln = parsed.ln;
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
      var completing = !!wtTargetId;
      // En mode « compléter cette fiche », les correspondances déjà écartées
      // par l'utilisateur pour CETTE personne ne sont plus reproposées.
      var visibleMatches = completing
        ? matches.filter(function (m) { return rejectedKeysFor(wtTargetId).indexOf('wt:' + m.Name) === -1; })
        : matches;
      if (!visibleMatches.length) {
        wtStatus.textContent = matches.length ? 'Aucun résultat (les autres ont été écartés pour cette fiche).' : 'Aucun résultat.';
        return;
      }
      wtStatus.textContent = visibleMatches.length + ' résultat(s). ' +
        (completing ? 'Choisissez la correspondance pour compléter cette fiche :' : 'Choisissez qui importer :');
      visibleMatches.forEach(function (m) {
        var info = fmtMatch(m);
        var gains = (completing && App.state.persons[wtTargetId]) ? fieldGains(App.state.persons[wtTargetId], WikiTree.toFields(m)) : [];
        var li = document.createElement('li');
        li.innerHTML = avatarHTML({ prenom: m.FirstName, nom: m.LastNameAtBirth || m.LastNameCurrent }) +
          '<div style="flex:1 1 auto;min-width:0">' +
          '<div class="person-line-name">' + escapeHtml(info.name) + '</div>' +
          '<div class="person-line-sub">' + escapeHtml(info.sub) + '</div>' +
          gainsHTML(gains) + '</div>' +
          '<button class="btn btn-sm btn-accent" type="button" data-role="complete">' + (completing ? 'Compléter' : 'Importer') + '</button>' +
          (completing ? '<button class="btn btn-sm btn-ghost" type="button" data-role="dismiss" title="Ne plus proposer cette correspondance pour cette fiche">✕</button>' : '');
        li.querySelector('[data-role="complete"]').addEventListener('click', function () {
          if (wtTargetId) completeInto(m.Name, li, wtTargetId);
          else importFromWikiTree(m.Name, li);
        });
        var dismissBtn = li.querySelector('[data-role="dismiss"]');
        if (dismissBtn) dismissBtn.addEventListener('click', function () {
          addRejected(wtTargetId, 'wt:' + m.Name);
          li.remove();
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
      // Les correspondances déjà écartées par l'utilisateur pour CETTE
      // personne ne sont plus reproposées.
      var rejected = rejectedKeysFor(p.id);
      var visibleMatches = matches.filter(function (f) { return rejected.indexOf('insee:' + f.id) === -1; });
      if (!visibleMatches.length) {
        inseeStatus.textContent = matches.length
          ? 'Aucun résultat (les autres ont été écartés pour cette fiche).'
          : 'Aucun résultat dans le Fichier des décès pour « ' + name + ' ».';
        return;
      }
      inseeStatus.textContent = visibleMatches.length + ' résultat(s) — actes d\'état civil :';
      visibleMatches.forEach(function (f) {
        var info = fmtInsee(f);
        var gains = fieldGains(p, f);
        var li = document.createElement('li');
        li.innerHTML = avatarHTML(f) +
          '<div style="flex:1 1 auto;min-width:0">' +
          '<div class="person-line-name">' + escapeHtml(info.name) + '</div>' +
          '<div class="person-line-sub">' + escapeHtml(info.sub) + '</div>' +
          gainsHTML(gains) + '</div>' +
          '<button class="btn btn-sm btn-accent" type="button" data-role="complete">Compléter</button>' +
          '<button class="btn btn-sm btn-ghost" type="button" data-role="dismiss" title="Ne plus proposer cette correspondance pour cette fiche">✕</button>';
        li.querySelector('[data-role="complete"]').addEventListener('click', function () {
          completeIntoInsee(f, li, p.id);
        });
        li.querySelector('[data-role="dismiss"]').addEventListener('click', function () {
          addRejected(p.id, 'insee:' + f.id);
          li.remove();
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
    var btn = li.querySelector('[data-role="complete"]');
    btn.disabled = true; btn.textContent = '…';
    var target = App.state.persons[targetId];
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
    Store.save(App.state);
    refreshAll();
    toast('✓ Fiche complétée depuis le Fichier des décès (INSEE) : ' + Store.fullName(target));
    li.remove();
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
      Object.keys(App.state.persons).forEach(function (id) {
        var w = App.state.persons[id].wikitree;
        if (w) byKey[w] = App.state.persons[id];
      });
      function ensure(profile) {
        if (!profile || !profile.Name) return null;
        if (byKey[profile.Name]) return byKey[profile.Name];
        var p = Store.addPerson(App.state, WikiTree.toFields(profile));
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
        if (father && mother) Store.findOrCreateUnion(App.state, [father.id, mother.id]);
        var spouseIds = Object.keys(rel.spouses || {})
          .map(function (k) { return ensure(rel.spouses[k]); })
          .filter(Boolean).map(function (s) { return s.id; });
        spouseIds.forEach(function (sid) { Store.findOrCreateUnion(App.state, [main.id, sid]); });
        Object.keys(rel.children || {}).forEach(function (k) {
          var c = ensure(rel.children[k]);
          if (!c) return;
          var partners = spouseIds.length ? [main.id, spouseIds[0]] : [main.id];
          var u = Store.findOrCreateUnion(App.state, partners);
          Store.addChildToUnion(App.state, u.id, c.id);
        });
      }
      // Recentre la VUE sur la personne importée, sans toucher à la racine
      // persistée : elle ne change que si l'utilisateur le demande explicitement
      // (bouton « Définir comme racine »).
      App.showInTree(main.id);
      Store.save(App.state);
      refreshAll();
      wtBusy(false);
      wtStatus.textContent = 'Importé : ' + Store.fullName(main) + (withRel ? ' (avec ses proches)' : '') + '. Vue recentrée.';
      toast('✓ Importé depuis WikiTree : ' + Store.fullName(main));
      li.remove();
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
      var target = App.state.persons[targetId];
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
        Object.keys(App.state.persons).forEach(function (id) {
          var w = App.state.persons[id].wikitree;
          if (w) byKey[w] = App.state.persons[id];
        });
        function ensure(profile) {
          if (!profile || !profile.Name) return null;
          if (byKey[profile.Name]) return byKey[profile.Name];
          var p = Store.addPerson(App.state, WikiTree.toFields(profile));
          byKey[profile.Name] = p;
          return p;
        }
        // Parents : seulement si la fiche n'en a pas déjà (on n'écrase rien).
        if (!(target.parentIds || []).length) {
          var father = ensure(rel.parents[rel.fatherId]);
          var mother = ensure(rel.parents[rel.motherId]);
          var slot = 0;
          if (father) { Store.setParent(App.state, target.id, father.id, slot++); }
          if (mother) { Store.setParent(App.state, target.id, mother.id, slot++); }
        }
        var spouseIds = Object.keys(rel.spouses || {})
          .map(function (k) { return ensure(rel.spouses[k]); })
          .filter(Boolean).map(function (s) { return s.id; });
        spouseIds.forEach(function (sid) { Store.findOrCreateUnion(App.state, [target.id, sid]); });
        Object.keys(rel.children || {}).forEach(function (k) {
          var c = ensure(rel.children[k]);
          if (!c) return;
          var partners = spouseIds.length ? [target.id, spouseIds[0]] : [target.id];
          var u = Store.findOrCreateUnion(App.state, partners);
          Store.addChildToUnion(App.state, u.id, c.id);
        });
      }

      Store.save(App.state);
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
    return Store.allPersons(App.state)
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

  // Correspondances écartées par l'utilisateur (« Signaler incohérence », ou
  // le bouton ✕ « ne plus proposer » d'une recherche individuelle), par
  // personne : on ne les représente plus jamais tant qu'on ne trouve pas
  // autre chose. Clés préfixées par source ('wt:'/'insee:') pour partager le
  // même stockage sans collision. Clé séparée, jamais incluse dans les exports.
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
    var p = App.state.persons[item.personId];
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
    var p = App.state.persons[item.personId];
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

  $('#btnOnlineSearch').addEventListener('click', openOnlineSearch);
  // En mode « compléter cette fiche », un relance manuelle (bouton ou Entrée)
  // doit aussi relancer la recherche INSEE : sinon elle ne s'affiche qu'à
  // l'ouverture automatique du dialogue et disparaît de fait dès qu'on
  // retape/relance la recherche soi-même.
  function triggerOnlineSearch() {
    // Voir completeFromWikiTree : sources isolées, l'une ne doit jamais
    // pouvoir empêcher l'autre de se lancer.
    if (wtTargetId && App.state.persons[wtTargetId]) {
      try { searchInsee(App.state.persons[wtTargetId]); } catch (e) { inseeForceStop('Erreur interne : ' + e.message); }
    }
    try { runOnlineSearch(); } catch (e) { wtForceStop('Erreur interne : ' + e.message); }
  }
  $('#wtSearchBtn').addEventListener('click', triggerOnlineSearch);
  $('#wtGeneanetBtn').addEventListener('click', function () {
    var q = ($('#wtQuery').value || '').trim();
    var parsed = q ? splitNameQuery(q) : { fn: '', ln: '' };
    var target = wtTargetId ? App.state.persons[wtTargetId] : null;
    var naissanceDate = target && target.naissance ? target.naissance.date : '';
    var spouse = target ? Store.getSpouses(App.state, target.id)[0] : null;
    var conjoint = spouse ? { prenom: spouse.prenom, nom: spouse.nom } : null;
    openExternal(geneanetSearchUrl(parsed.fn, parsed.ln, naissanceDate, conjoint));
    showSplitScreenTipOnce();
  });
  var wtAntenatiBtn = $('#wtAntenatiBtn');
  if (wtAntenatiBtn) {
    wtAntenatiBtn.addEventListener('click', function () {
      var q = ($('#wtQuery').value || '').trim();
      var parsed = q ? splitNameQuery(q) : { fn: '', ln: '' };
      openExternal(antenatiSearchUrl(parsed.fn, parsed.ln));
      showSplitScreenTipOnce();
    });
  }
  $('#wtClose').addEventListener('click', function () { onlineDlg.close(); });
  $('#wtQuery').addEventListener('keydown', function (e) { if (e.key === 'Enter') triggerOnlineSearch(); });
  App.online = {
    completeFromWikiTree: completeFromWikiTree,
    openOnlineSearch: openOnlineSearch
  };
})();
