/* App — contrôleur principal de l'application indépendante « Arbre généalogique ». */
(function () {
  'use strict';

  var U = window.GenUtil;
  var $ = U.$, $all = U.$all;
  var isValidDate = U.isValidDate, formatDateFr = U.formatDateFr, parseDateFr = U.parseDateFr;
  var escapeHtml = U.escapeHtml, initials = U.initials, timeAgo = U.timeAgo;
  var splitNameQuery = U.splitNameQuery, groupLetter = U.groupLetter;
  var geneanetSearchUrl = U.geneanetSearchUrl, antenatiSearchUrl = U.antenatiSearchUrl;

  var state = Store.load();

  // Préférences d'affichage mémorisées d'une session à l'autre (onglet,
  // mode, générations, personne affichée, thème). Clé séparée des données
  // généalogiques : jamais exportée ni synchronisée. Tout accès est protégé
  // (navigation privée, stockage bloqué) : l'app fonctionne sans.
  var PREFS_KEY = 'genealogie:prefs:v1';
  function loadPrefs() {
    try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch (e) { return {}; }
  }
  var prefs = loadPrefs();
  function savePref(k, v) {
    prefs[k] = v;
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) {}
  }

  var treeMode = prefs.treeMode === 'descendants' ? 'descendants' : 'ancestors';
  var maxGen = (prefs.maxGen >= 1 && prefs.maxGen <= 7) ? prefs.maxGen : 4;
  var panZoomCtl = null;

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

  // Pictogramme ♂/♀ en médaillon sur l'avatar : identifie le sexe d'un
  // coup d'œil (couleur seule peu fiable — daltonisme, contraste faible).
  function avatarHTML(p) {
    var sexe = (p.sexe === 'H' || p.sexe === 'F') ? p.sexe : null;
    var badge = sexe ? '<span class="avatar-gender sexe-' + sexe + '">' + (sexe === 'H' ? '♂' : '♀') + '</span>' : '';
    return '<span class="avatar' + (sexe ? ' sexe-' + sexe : '') + '">' + escapeHtml(initials(p)) + badge + '</span>';
  }

  function subLine(p) {
    var ageInfo = Store.computeAge(p);
    var ageTxt = ageInfo ? ' · ' + ageInfo.age + ' ans' : '';
    if (p.naissance && p.naissance.date) return 'né(e) ' + formatDateFr(p.naissance.date) + ageTxt;
    if (p.naissance && p.naissance.lieu) return p.naissance.lieu + ageTxt;
    if (p.decede) return 'Décédé(e)' + ageTxt;
    return '';
  }

  // Version « puces » de detailMeta, pour l'en-tête de fiche : au lieu d'une
  // phrase dense tout en gris, chaque fait (naissance, décès, âge) devient
  // une puce séparée, plus aérée et facile à scanner. L'âge — donnée la plus
  // regardée d'un coup d'œil — ressort visuellement (puce accentuée) plutôt
  // que noyé entre parenthèses. Le sexe n'est plus répété en texte : il est
  // déjà visible sur l'avatar (pastille + pictogramme ♂/♀).
  function detailHeaderChips(p) {
    var ageInfo = Store.computeAge(p);
    var chips = [];
    if (p.naissance && (p.naissance.date || p.naissance.lieu)) {
      var birthTxt = [p.naissance.date ? formatDateFr(p.naissance.date) : '', p.naissance.lieu ? 'à ' + p.naissance.lieu : ''].filter(Boolean).join(' ');
      chips.push('<span class="chip chip-fact">🎂 Né(e) ' + escapeHtml(birthTxt) + '</span>');
    }
    if (p.decede || (p.deces && (p.deces.date || p.deces.lieu))) {
      var deathTxt = [p.deces.date ? formatDateFr(p.deces.date) : '', p.deces.lieu ? 'à ' + p.deces.lieu : ''].filter(Boolean).join(' ');
      chips.push('<span class="chip chip-fact">✝ Décédé(e) ' + escapeHtml(deathTxt) + '</span>');
      if (ageInfo && ageInfo.atDeath) chips.push('<span class="chip chip-age">' + ageInfo.age + ' ans</span>');
    } else if (ageInfo) {
      chips.push('<span class="chip chip-age">' + ageInfo.age + ' ans</span>');
    }
    if (!chips.length) {
      chips.push('<span class="chip chip-fact chip-empty">' + (p.sexe === 'H' ? 'Homme' : p.sexe === 'F' ? 'Femme' : 'Sexe non précisé') + '</span>');
    }
    return chips.join('');
  }

  function detailMeta(p) {
    var parts = [];
    parts.push(p.sexe === 'H' ? 'Homme' : p.sexe === 'F' ? 'Femme' : 'Sexe non précisé');
    if (p.naissance && (p.naissance.date || p.naissance.lieu)) {
      parts.push('né(e) ' + [p.naissance.date ? 'le ' + formatDateFr(p.naissance.date) : '', p.naissance.lieu ? 'à ' + p.naissance.lieu : ''].filter(Boolean).join(' '));
    }
    // Âge calculé quand possible (à ce jour si vivant·e, à la date du décès
    // sinon) — voir Store.computeAge : renvoie null plutôt qu'un âge
    // hasardeux si la date de décès manque pour une personne décédée.
    var ageInfo = Store.computeAge(p);
    if (p.decede || (p.deces && (p.deces.date || p.deces.lieu))) {
      var deathStr = 'décédé(e) ' + [p.deces.date ? 'le ' + formatDateFr(p.deces.date) : '', p.deces.lieu ? 'à ' + p.deces.lieu : ''].filter(Boolean).join(' ');
      if (ageInfo && ageInfo.atDeath) deathStr += ' (' + ageInfo.age + ' ans)';
      parts.push(deathStr);
    } else if (ageInfo) {
      parts.push(ageInfo.age + ' ans');
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
  // `action` (optionnel) : { label, fn } — bouton dans la notification (ex.
  // « Annuler » après une suppression). La notification reste alors affichée
  // plus longtemps. `opts.sticky` : ne disparaît qu'au clic (erreurs graves).
  // Les notifications sont placées DANS la fenêtre modale ouverte au premier
  // plan s'il y en a une : une <dialog> modale rend le reste de la page
  // inerte, et le bouton « Annuler » d'une notification restée dans <body>
  // serait visible mais impossible à cliquer. Elles reviennent dans <body>
  // (ou la fenêtre suivante) quand la fenêtre se ferme.
  function toastHost() {
    var open = $all('dialog[open]');
    return open.length ? open[open.length - 1] : document.body;
  }
  function rehomeToasts() {
    if (!toastWrap) return;
    var host = toastHost();
    if (toastWrap.parentNode !== host) host.appendChild(toastWrap);
  }
  // Ouverture / fermeture de n'importe quelle fenêtre (attribut « open »).
  if (window.MutationObserver) {
    new MutationObserver(rehomeToasts).observe(document.body, { attributes: true, attributeFilter: ['open'], subtree: true });
  }

  function toast(msg, kind, action, opts) {
    opts = opts || {};
    if (!toastWrap) {
      toastWrap = document.createElement('div');
      toastWrap.className = 'toast-wrap';
      toastWrap.setAttribute('role', 'status');
      toastWrap.setAttribute('aria-live', 'polite');
    }
    rehomeToasts();
    var t = document.createElement('div');
    t.className = 'toast' + (kind ? ' toast-' + kind : '');
    var txt = document.createElement('span');
    txt.textContent = msg;
    t.appendChild(txt);
    function dismiss() { t.classList.remove('show'); setTimeout(function () { t.remove(); }, 300); }
    if (action) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'toast-action';
      b.textContent = action.label;
      b.addEventListener('click', function (e) { e.stopPropagation(); dismiss(); action.fn(); });
      t.appendChild(b);
    }
    t.addEventListener('click', dismiss);
    toastWrap.appendChild(t);
    setTimeout(function () { t.classList.add('show'); }, 10);
    if (!opts.sticky) setTimeout(dismiss, action ? 10000 : 6000);
    return t;
  }

  // Échec d'enregistrement (quota plein, stockage bloqué) : prévenir
  // clairement, UNE fois par série d'échecs — sinon la modification est
  // perdue sans que personne ne le sache.
  var storageErrorShown = false;
  Store.onError(function (kind) {
    if (storageErrorShown) return;
    storageErrorShown = true;
    var msg = kind === 'quota'
      ? '⚠️ Espace de stockage plein : la dernière modification n’a PAS été enregistrée. Exporte une sauvegarde (Réglages → Sauvegarde) sans attendre.'
      : '⚠️ Enregistrement impossible sur cet appareil : la dernière modification n’a PAS été enregistrée. Exporte une sauvegarde sans attendre.';
    var t = toast(msg, 'error', { label: 'Exporter', fn: function () { exportJsonFile(); } }, { sticky: true });
    t.addEventListener('click', function () { storageErrorShown = false; });
  });

  // Annulation de la dernière opération lourde (suppression, fusion,
  // détachement, import, restauration, réinitialisation) : on garde une
  // copie de l'état juste avant, et la notification propose « Annuler ».
  // Une sauvegarde automatique est aussi forcée (Store.checkpoint) : même
  // après la disparition de la notification, l'état précédent reste
  // restaurable depuis Réglages → Sauvegardes automatiques.
  function withUndo(label, doneMsg, fn) {
    var snapshot = JSON.stringify(state);
    Store.checkpoint(label);
    var result = fn();
    toast(doneMsg, '', {
      label: 'Annuler',
      fn: function () {
        state = JSON.parse(snapshot);
        Store.save(state);
        if (detailDialog.open) closeDetail();
        refreshAll();
        toast('↺ Action annulée.');
      }
    });
    return result;
  }

  // Ouvre une URL externe (site tiers) dans une VRAIE fenêtre/tâche séparée,
  // pas dans la WebView de l'app elle-même (casserait la SPA). Une vraie
  // navigation d'ancre (pas window.open, pas le plugin Browser/Custom Tabs)
  // est la voie standard Capacitor : toute navigation vers un domaine hors
  // de l'app est déléguée par le pont natif au navigateur système comme
  // application à part entière — avec sa propre entrée dans le multitâche
  // Android — contrairement aux Custom Tabs (@capacitor/browser) qui
  // restent rattachées à la tâche de l'app (pas de FLAG_ACTIVITY_NEW_TASK
  // posé côté plugin : constaté dans son code source, ce qui explique
  // pourquoi ça ne s'ouvrait pas dans une fenêtre vraiment séparée).
  function openExternal(url) {
    var a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // Android ne permet à aucune app tierce de déclencher l'écran divisé par
  // code (pas d'API publique pour ça sur un téléphone standard, en dehors
  // du geste système « Applications récentes ») : on ne peut donc pas
  // « activer » le multi-fenêtres depuis l'app, seulement l'expliquer, une
  // seule fois, au moment où ça devient utile. Message générique (pas de nom
  // de site) car partagé par tous les liens externes (Geneanet, Antenati…).
  var SPLIT_SCREEN_TIP_KEY = 'genealogie:geneanetTipShown:v1';
  function showSplitScreenTipOnce() {
    try {
      if (localStorage.getItem(SPLIT_SCREEN_TIP_KEY)) return;
      localStorage.setItem(SPLIT_SCREEN_TIP_KEY, '1');
      toast('💡 Astuce : pour comparer côte à côte, ouvre les Applications récentes, maintiens l’icône du site tout juste ouvert, puis choisis « Écran divisé » et sélectionne Arbre généalogique.');
    } catch (e) {}
  }
  function openGeneanetForPerson(p) {
    var spouse = Store.getSpouses(state, p.id)[0];
    var conjoint = spouse ? { prenom: spouse.prenom, nom: spouse.nom } : null;
    openExternal(geneanetSearchUrl(p.prenom, p.nom, p.naissance && p.naissance.date, conjoint));
    showSplitScreenTipOnce();
  }

  function applyGeneanetPaste(text) {
    var parsed = U.parseGeneanetProfile(text);
    // `prenom` seul seul ne suffit pas : c'est aussi le repli quand la 1ère
    // ligne ne matche pas le motif « Prénom NOM » (elle est alors reprise
    // telle quelle) — un texte quelconque, sans rapport avec Geneanet,
    // passerait sinon pour « reconnu » du seul fait d'avoir une 1ère ligne.
    if (!parsed.nom && !parsed.naissance && !parsed.deces) {
      toast('Texte non reconnu — vérifie que c’est bien collé depuis une fiche Geneanet.', 'error');
      return false;
    }
    if (parsed.prenom) $('#fPrenom').value = parsed.prenom;
    if (parsed.nom) $('#fNom').value = parsed.nom;
    if (parsed.sexe) $('#fSexe').value = parsed.sexe;
    if (parsed.naissance) {
      if (parsed.naissance.date) $('#fNaissanceDate').value = formatDateFr(parsed.naissance.date);
      if (parsed.naissance.lieu) $('#fNaissanceLieu').value = parsed.naissance.lieu;
    }
    if (parsed.deces) {
      $('#fDecede').checked = true;
      if (parsed.deces.date) $('#fDecesDate').value = formatDateFr(parsed.deces.date);
      if (parsed.deces.lieu) $('#fDecesLieu').value = parsed.deces.lieu;
    }
    toast('✓ Champs remplis depuis Geneanet — vérifie avant d’enregistrer.');
    return true;
  }
  function openAntenatiForPerson(p) {
    openExternal(antenatiSearchUrl(p.prenom, p.nom));
    showSplitScreenTipOnce();
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

  // Rendu À LA DEMANDE : une modification marque les trois vues « à
  // rafraîchir », mais seule la vue visible est redessinée tout de suite ;
  // les autres le seront quand on y reviendra. Évite de recalculer à chaque
  // modification la liste complète et le scan des doublons (Réglages) alors
  // qu'on est sur l'arbre.
  var VIEWS = ['tree', 'list', 'settings'];
  var currentView = VIEWS.indexOf(prefs.view) !== -1 ? prefs.view : 'tree';
  var dirty = { tree: true, list: true, settings: true };

  function isActive(name) { return currentView === name; }

  function renderView(name) {
    if (name === 'tree') renderTree();
    else if (name === 'list') renderList();
    else if (name === 'settings') renderSettings();
  }

  function switchView(name) {
    if (VIEWS.indexOf(name) === -1) name = 'tree';
    currentView = name;
    savePref('view', name);
    $all('.view').forEach(function (v) { v.classList.toggle('active', v.id === 'view-' + name); });
    $all('.bottombar button').forEach(function (b) {
      var on = b.dataset.view === name;
      b.classList.toggle('active', on);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    // Réglages : toujours recalculé à l'ouverture (suggestions, sauvegardes
    // et statut de synchro à jour) — le scan lui-même est mis en cache tant
    // que les données n'ont pas changé (voir renderSuggestions).
    if (dirty[name] || name === 'settings') renderView(name);
  }

  // Profondeur RÉELLE de générations disponibles (ascendants ou descendants
  // selon le mode) à partir d'une racine — évite un curseur allant
  // jusqu'à 7 générations par défaut alors que les données n'en contiennent
  // que 2 ou 3. Protection anti-cycle par CHEMIN (pas un set global) pour ne
  // pas sous-compter une branche légitime qui recroise un même ancêtre par
  // un autre chemin (mariage entre cousins).
  // Plafonnée à MAX_GEN (le curseur ne va pas au-delà) : le parcours s'arrête
  // dès cette profondeur atteinte, au lieu d'explorer toute la base (coût
  // exponentiel sur un grand arbre avec implexe). Résultat mis en cache
  // jusqu'à la prochaine modification des données.
  var MAX_GEN = 7;
  var depthCache = {};
  var depthCacheRev = -1;
  function realGenDepth(rootId, mode) {
    var rev = Store.getRevision();
    if (rev !== depthCacheRev) { depthCache = {}; depthCacheRev = rev; }
    var key = mode + '|' + rootId;
    if (depthCache[key] != null) return depthCache[key];
    var maxSeen = 0;
    function rec(id, depth, path) {
      if (!id || maxSeen >= MAX_GEN) return;
      maxSeen = Math.max(maxSeen, depth);
      if (depth >= MAX_GEN || path[id]) return;
      path[id] = true;
      var nextIds = mode === 'descendants'
        ? Store.getChildren(state, id).map(function (c) { return c.id; })
        : (state.persons[id] ? (state.persons[id].parentIds || []) : []);
      nextIds.forEach(function (nid) { rec(nid, depth + 1, path); });
      delete path[id];
    }
    rec(rootId, 0, {});
    depthCache[key] = maxSeen;
    return maxSeen;
  }

  function renderTree() {
    if (!isActive('tree')) { dirty.tree = true; return; }
    dirty.tree = false;
    var hasPersons = Object.keys(state.persons).length > 0;
    treeEmpty.classList.toggle('hidden', hasPersons);
    if (!hasPersons) {
      while (treeSvg.firstChild) treeSvg.removeChild(treeSvg.firstChild);
      renderBreadcrumb();
      return;
    }
    if (!state.rootId || !state.persons[state.rootId]) state.rootId = Object.keys(state.persons)[0];
    var cr = currentRoot();

    var genRangeEl = $('#genRange');
    if (genRangeEl) {
      var realDepth = Math.min(MAX_GEN, Math.max(1, realGenDepth(cr, treeMode)));
      genRangeEl.max = realDepth;
      var shownGen = Math.min(maxGen, realDepth);
      genRangeEl.value = shownGen;
      var genValueEl = $('#genValue');
      if (genValueEl) genValueEl.textContent = shownGen;
    }

    // Navigation au clavier : si le focus était dans l'arbre (nœud activé
    // par Entrée), on le replace sur la personne désormais au centre.
    var hadFocus = treeSvg.contains(document.activeElement);
    panZoomCtl = Tree.render(treeSvg, state, { rootId: cr, mode: treeMode, maxGen: Math.min(maxGen, MAX_GEN), onSelect: focusPerson, onOpen: openDetail });
    if (hadFocus) {
      var rootNode = treeSvg.querySelector('.tree-node.is-root');
      if (rootNode) rootNode.focus();
    }
    renderBreadcrumb();
    updateNav();
  }

  // --- Vue en éventail (ascendants, pensée pour l'impression) ------------

  function openFanChart() {
    var cr = currentRoot();
    if (!cr || !state.persons[cr]) { alert('Ajoute au moins une personne avant de générer l’éventail.'); return; }
    var svgEl = $('#fanChartSvg');
    var info = FanChart.render(svgEl, state, cr, {});
    var infoEl = $('#fanChartInfo');
    if (infoEl) {
      var txt = ' — ' + info.generations + ' génération(s) d’ascendants';
      // La profondeur réelle des données peut dépasser ce qui reste lisible
      // sur le graphique (voir FanChart.pickGenerationCount) : le signaler
      // plutôt que de laisser croire que tout a été affiché.
      if (info.realDepth > info.generations) {
        txt += ' (limité pour rester lisible — ' + info.realDepth + ' connues au total)';
      }
      infoEl.textContent = txt;
    }
    $('#fanChartOverlay').classList.remove('hidden');
  }
  function closeFanChart() { $('#fanChartOverlay').classList.add('hidden'); }

  $('#btnFanChart').addEventListener('click', openFanChart);
  $('#btnFanClose').addEventListener('click', closeFanChart);
  $('#btnFanPrint').addEventListener('click', function () { window.print(); });
  $('#btnFanExportSvg').addEventListener('click', function () {
    var svgEl = $('#fanChartSvg');
    var xml = new XMLSerializer().serializeToString(svgEl);
    if (!/^<\?xml/.test(xml)) xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + xml;
    downloadFile('eventail-genealogique.svg', xml, 'image/svg+xml');
  });

  // Fil d'Ariane du chemin parcouru (rootHistory + position courante) :
  // chaque étape est cliquable et ramène directement dessus, plus rapide que
  // de cliquer plusieurs fois sur « Retour ».
  function renderBreadcrumb() {
    var nav = $('#treeBreadcrumb');
    if (!nav) return;
    if (!state.rootId || !state.persons[state.rootId]) { nav.innerHTML = ''; return; }
    var trail = rootHistory.concat([currentRoot()]);
    // Chemin long : on n'affiche que le point de départ, « … » et les
    // dernières étapes (sinon le fil occupait plusieurs lignes d'écran).
    var CRUMBS_TAIL = 3;
    var hiddenFrom = trail.length > CRUMBS_TAIL + 2 ? 1 : -1;
    var hiddenTo = trail.length - CRUMBS_TAIL;
    nav.innerHTML = trail.map(function (id, i) {
      if (hiddenFrom !== -1 && i >= hiddenFrom && i < hiddenTo) {
        return i === hiddenFrom ? '<span class="crumb-sep" aria-hidden="true">›</span><span class="crumb-more" title="' + (hiddenTo - hiddenFrom) + ' étape(s) masquée(s)">…</span>' : '';
      }
      var p = state.persons[id];
      var label = escapeHtml(p ? Store.fullName(p) : '?');
      var isLast = i === trail.length - 1;
      var sep = i > 0 ? '<span class="crumb-sep" aria-hidden="true">›</span>' : '';
      return sep + '<button type="button" class="crumb' + (isLast ? ' current' : '') + '" data-idx="' + i + '"' +
        (isLast ? ' disabled aria-current="location"' : '') + '>' + label + '</button>';
    }).join('');
  }
  // Un seul écouteur délégué (le fil est reconstruit à chaque rendu).
  $('#treeBreadcrumb').addEventListener('click', function (e) {
    var b = e.target.closest('.crumb:not(.current)');
    if (b) goToBreadcrumb(+b.dataset.idx);
  });

  // NAVIGATION vs RACINE.
  //
  // `state.rootId` = la PERSONNE RACINE (point d'ancrage, PERSISTÉE, définie dans
  // Réglages ou via « Définir comme racine »). Elle ne change PAS quand on
  // explore l'arbre. `viewRoot` = le centre d'affichage COURANT (navigation,
  // transitoire, non sauvegardé) : cliquer une pastille déplace la vue sans
  // perdre la racine. On revient à la racine d'un bouton 🏠, et à la personne
  // précédente d'un bouton Retour.
  var viewRoot = prefs.viewRoot || null;   // restauré : on retrouve la vue de la dernière session
  var rootHistory = [];

  function currentRoot() {
    return (viewRoot && state.persons[viewRoot]) ? viewRoot : state.rootId;
  }

  function updateNav() {
    var back = $('#btnTreeBack');
    if (back) back.disabled = rootHistory.length === 0;
    var home = $('#btnTreeHome');
    if (home) home.disabled = !state.rootId || currentRoot() === state.rootId;
    if ((prefs.viewRoot || null) !== (viewRoot || null)) savePref('viewRoot', viewRoot);
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

  // Liste des personnes : construite en une seule chaîne HTML (un seul
  // passage dans le DOM), écouteurs DÉLÉGUÉS sur la liste (au lieu de 4 par
  // ligne), et affichage par pages de LIST_PAGE lignes — une base de
  // plusieurs milliers de personnes reste fluide à la saisie.
  var LIST_PAGE = 200;
  var listLimit = LIST_PAGE;
  var listResults = [];
  var listGroupStart = {};   // lettre → index de la 1re personne du groupe

  function renderAlphaStrip(letters) {
    var box = $('#alphaStrip');
    if (!box) return;
    // Peu d'intérêt à naviguer par lettre sur une petite liste.
    if (letters.length < 4) { box.innerHTML = ''; return; }
    box.innerHTML = letters.map(function (g) {
      return '<button type="button" data-letter="' + g + '" aria-label="Aller à la lettre ' + g + '">' + g + '</button>';
    }).join('');
  }
  $('#alphaStrip').addEventListener('click', function (e) {
    var b = e.target.closest('[data-letter]');
    if (!b) return;
    var letter = b.dataset.letter;
    // Groupe pas encore affiché (au-delà de la page courante) : on étend
    // l'affichage jusqu'à lui avant de s'y rendre.
    if (!document.getElementById('plh-' + letter) && listGroupStart[letter] != null) {
      listLimit = Math.ceil((listGroupStart[letter] + 1) / LIST_PAGE) * LIST_PAGE + LIST_PAGE;
      drawList();
    }
    var el = document.getElementById('plh-' + letter);
    if (el) el.scrollIntoView({ block: 'start' });
  });

  // Bascule vers l'onglet Arbre, centré sur cette personne (navigation
  // depuis la liste, sans passer par la fiche détail).
  function viewInTree(id) {
    navigateTo(id);
    switchView('tree');
  }

  function renderList() {
    if (!isActive('list')) { dirty.list = true; return; }
    dirty.list = false;
    listResults = Store.searchPersons(state, searchInput.value).sort(function (a, b) {
      var ka = (a.nom || a.prenom || ''), kb = (b.nom || b.prenom || '');
      var c = ka.localeCompare(kb, 'fr', { sensitivity: 'base' });
      return c !== 0 ? c : Store.fullName(a).localeCompare(Store.fullName(b), 'fr', { sensitivity: 'base' });
    });
    drawList();
  }

  function drawList() {
    var results = listResults;
    personListEmpty.classList.toggle('hidden', results.length > 0);
    var letters = [];
    listGroupStart = {};
    results.forEach(function (p, i) {
      var g = groupLetter(p.nom || p.prenom);
      if (listGroupStart[g] == null) { listGroupStart[g] = i; letters.push(g); }
    });
    var html = '';
    var lastGroup = null;
    var shown = Math.min(results.length, listLimit);
    for (var i = 0; i < shown; i++) {
      var p = results[i];
      var g = groupLetter(p.nom || p.prenom);
      if (g !== lastGroup) {
        lastGroup = g;
        html += '<li class="person-list-header" id="plh-' + g + '">' + g + '</li>';
      }
      var name = escapeHtml(Store.fullName(p));
      html += '<li data-id="' + escapeHtml(p.id) + '" tabindex="0">' + avatarHTML(p) +
        '<div class="person-line-main"><div class="person-line-name">' + name + '</div>' +
        '<div class="person-line-sub">' + escapeHtml(subLine(p)) + '</div></div>' +
        '<button class="person-nav-btn" type="button" data-nav="wikitree" title="Rechercher cette personne en ligne (WikiTree)" aria-label="Rechercher ' + name + ' sur WikiTree">🔍</button>' +
        '<button class="person-nav-btn" type="button" data-nav="geneanet" title="Chercher sur Geneanet" aria-label="Chercher ' + name + ' sur Geneanet">🌐</button>' +
        '<button class="person-nav-btn" type="button" data-nav="tree" title="Voir dans l’arbre" aria-label="Voir ' + name + ' dans l’arbre">🌳</button>' +
        '</li>';
    }
    if (results.length > shown) {
      var more = Math.min(LIST_PAGE, results.length - shown);
      html += '<li class="person-list-more"><button type="button" class="btn btn-sm" data-more="1">Afficher ' + more +
        ' de plus (' + (results.length - shown) + ' restante(s))</button></li>';
    }
    personList.innerHTML = html;
    renderAlphaStrip(letters);
  }

  personList.addEventListener('click', function (e) {
    if (e.target.closest('[data-more]')) { listLimit += LIST_PAGE; drawList(); return; }
    var li = e.target.closest('li[data-id]');
    if (!li) return;
    var p = state.persons[li.dataset.id];
    if (!p) return;
    var nav = e.target.closest('[data-nav]');
    if (!nav) { openDetail(p.id); return; }
    if (nav.dataset.nav === 'wikitree') completeFromWikiTree(p.id);
    else if (nav.dataset.nav === 'geneanet') openGeneanetForPerson(p);
    else if (nav.dataset.nav === 'tree') viewInTree(p.id);
  });
  personList.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || e.target.tagName !== 'LI' || !e.target.dataset.id) return;
    e.preventDefault();
    openDetail(e.target.dataset.id);
  });

  function renderSettings() {
    if (!isActive('settings')) { dirty.settings = true; return; }
    dirty.settings = false;
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
    // Sections repliées : leur contenu (scan des doublons notamment) n'est
    // calculé qu'à l'ouverture — voir les écouteurs « toggle » ci-dessous.
    if ($('#grpQuality').open) renderSuggestions();
    if ($('#grpData').open) renderBackups();
  }

  // Sections repliables des Réglages : état ouvert/fermé mémorisé.
  var openGroups = prefs.groups || {};
  $all('.settings-group').forEach(function (d) {
    var key = d.dataset.group;
    if (openGroups[key]) d.open = true;
    d.addEventListener('toggle', function () {
      openGroups[key] = d.open;
      savePref('groups', openGroups);
      if (!d.open) return;
      if (key === 'quality') renderSuggestions();
      if (key === 'data') renderBackups();
    });
  });

  // --- Sauvegardes automatiques (avant chaque écriture, rotation à 10) ---

  // Liste asynchrone (IndexedDB) : un jeton écarte le résultat d'un appel
  // devenu obsolète si l'onglet a été re-rendu entre-temps.
  var backupsToken = 0;
  function renderBackups() {
    var listEl = $('#backupsList');
    if (!listEl) return;
    var token = ++backupsToken;
    Store.listBackups().then(function (backups) {
      if (token !== backupsToken) return;
      if (!backups.length) {
        listEl.innerHTML = '<li class="empty-hint" style="cursor:default">Aucune sauvegarde automatique pour l’instant.</li>';
        return;
      }
      listEl.innerHTML = backups.map(function (b, i) {
        return '<li><div class="person-line-main"><div class="person-line-name">' + escapeHtml(timeAgo(b.at)) +
          (b.label ? ' <span class="muted">· ' + escapeHtml(b.label) + '</span>' : '') + '</div>' +
          '<div class="person-line-sub">' + b.count + ' personne(s) · ' + escapeHtml(new Date(b.at).toLocaleString('fr-FR')) + '</div></div>' +
          '<button class="btn btn-sm btn-ghost" type="button" data-restore="' + i + '">↺ Restaurer</button></li>';
      }).join('');
    });
  }
  $('#backupsList').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-restore]');
    if (!btn) return;
    var i = Number(btn.dataset.restore);
    if (!confirm('Restaurer cette version ? Les données actuelles seront remplacées (tu pourras annuler juste après).')) return;
    Store.restoreBackup(i).then(function (restored) {
      if (!restored) { alert('Sauvegarde illisible.'); return; }
      withUndo('avant restauration', '✓ Version restaurée.', function () {
        state = restored;
        Store.save(state);
      });
      refreshAll();
    });
  });

  // --- Suggestions : scan de l'arbre (doublons, fiches incomplètes, dates) ---

  var SUGGEST_CAP = 8;

  function personChips(ids, extraClass) {
    var shown = ids.slice(0, SUGGEST_CAP);
    var html = shown.map(function (id) {
      var p = state.persons[id];
      if (!p) return '';
      return '<span class="chip chip-name' + (extraClass ? ' ' + extraClass : '') + '" data-open="' + escapeHtml(id) + '">' + escapeHtml(Store.fullName(p)) + '</span>';
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

  // Le scan (doublons approximatifs notamment) est le calcul le plus lourd de
  // l'app : mis en cache tant que les données n'ont pas changé (révision du
  // Store). « Rescanner » force le recalcul.
  var issuesCache = null, issuesRev = -1;
  function renderSuggestions(force) {
    var box = $('#suggestionsBox');
    if (!box) return;
    if (force === true || !issuesCache || issuesRev !== Store.getRevision()) {
      issuesCache = Store.scanIssues(state);
      issuesRev = Store.getRevision();
    }
    var issues = issuesCache;
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
        html += '<span class="chip chip-add" data-dup="' + escapeHtml(d.a) + '">' +
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
        html += '<span class="chip chip-name" data-open="' + escapeHtml(b.id) + '" title="' + escapeHtml(b.reason) + '">' + escapeHtml(Store.fullName(p)) + '</span>';
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

  // Seules les FUZZY_CAP paires les plus probables sont affichées (liste
  // déjà triée par score) : en afficher des milliers figeait l'onglet.
  var FUZZY_CAP = 20;
  function renderFuzzyDuplicates(fuzzy) {
    var ul = $('#fuzzyDupList');
    if (!ul) return;
    ul.innerHTML = '';
    fuzzy.slice(0, FUZZY_CAP).forEach(function (d) {
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
        withUndo('avant fusion', '✓ Fusionné : ' + Store.fullName(keep), function () {
          Store.mergePersons(state, keepId, dropId);
        });
        refreshAll();
      });
      li.querySelector('[data-role="ignore"]').addEventListener('click', function () { li.remove(); });
      ul.appendChild(li);
    });
    if (fuzzy.length > FUZZY_CAP) {
      var more = document.createElement('li');
      more.className = 'empty-hint';
      more.style.cursor = 'default';
      more.textContent = '+' + (fuzzy.length - FUZZY_CAP) + ' autre(s) paire(s), moins probables — fusionne ou ignore celles-ci puis rescanne.';
      ul.appendChild(more);
    }
  }

  // Marque toutes les vues à rafraîchir, ne redessine que la vue visible.
  function refreshAll() {
    dirty.tree = dirty.list = dirty.settings = true;
    renderView(currentView);
  }

  // --- Formulaire personne (créer / modifier) --------------------------

  // `prefill` (utilisé seulement pour une NOUVELLE personne, ignoré en
  // modification) : reprend la recherche qui a mené ici — évite de retaper
  // un nom qu'on vient déjà de chercher sans le trouver (ex. « + Nouvelle
  // personne » depuis le sélecteur parent/conjoint/enfant).
  function openPersonForm(existing, prefill) {
    return new Promise(function (resolve) {
      var dlg = $('#personDialog');
      var form = $('#personForm');
      var btnCancel = $('#btnPersonCancel');
      $('#personFormTitle').textContent = existing ? 'Modifier la personne' : 'Nouvelle personne';
      $('#fPrenom').value = existing ? existing.prenom : ((prefill && prefill.prenom) || '');
      $('#fNom').value = existing ? existing.nom : ((prefill && prefill.nom) || '');
      $('#fSexe').value = existing ? existing.sexe : ((prefill && prefill.sexe) || '?');
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
        // Insensible aux accents et à l'ordre des mots (« helene dupont »
        // trouve « Hélène Dupont »).
        var terms = Store.foldText(q).split(/\s+/).filter(Boolean);
        if (terms.length) list = list.filter(function (p) {
          var name = Store.foldText(Store.fullName(p));
          return terms.every(function (t) { return name.indexOf(t) !== -1; });
        });
        return list.sort(function (a, b) { return Store.fullName(a).localeCompare(Store.fullName(b)); });
      }
      var PICKER_MAX = 100;

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
        // Plafonné : au-delà, affiner la recherche (liste inutilisable sinon).
        listEl.innerHTML = results.slice(0, PICKER_MAX).map(function (p) {
          return '<li data-id="' + escapeHtml(p.id) + '" tabindex="0">' + avatarHTML(p) +
            '<div><div class="person-line-name">' + escapeHtml(Store.fullName(p)) + '</div>' +
            '<div class="person-line-sub">' + escapeHtml(subLine(p)) + '</div></div></li>';
        }).join('') + (results.length > PICKER_MAX
          ? '<li class="empty-hint" style="cursor:default">… ' + (results.length - PICKER_MAX) + ' autre(s) : précise la recherche.</li>'
          : '');
      }
      function onListClick(e) {
        var li = e.target.closest('li[data-id]');
        if (li) closeAndResolve({ id: li.dataset.id });
      }
      function onListKey(e) {
        if (e.key === 'Enter' && e.target.dataset && e.target.dataset.id) { e.preventDefault(); closeAndResolve({ id: e.target.dataset.id }); }
      }

      function closeAndResolve(val) { handled = true; dlg.close(); finish(val); }

      function onSearch() { renderOptions(); }
      function onNew() {
        handled = true;
        var q = (search.value || '').trim();
        var parsed = q ? splitNameQuery(q) : null;
        var prefill = {};
        if (parsed) { prefill.prenom = parsed.fn; prefill.nom = parsed.ln; }
        if (opts.newSexe) prefill.sexe = opts.newSexe;
        dlg.close();
        openPersonForm(null, Object.keys(prefill).length ? prefill : null).then(function (person) {
          finish(person ? { id: person.id } : null);
        });
      }
      function onCancel() { closeAndResolve(null); }
      function onClose() { if (!handled) finish(null); cleanup(); }
      function cleanup() {
        search.removeEventListener('input', onSearch);
        listEl.removeEventListener('click', onListClick);
        listEl.removeEventListener('keydown', onListKey);
        newBtn.removeEventListener('click', onNew);
        cancelBtn.removeEventListener('click', onCancel);
        dlg.removeEventListener('close', onClose);
      }

      search.addEventListener('input', onSearch);
      listEl.addEventListener('click', onListClick);
      listEl.addEventListener('keydown', onListKey);
      newBtn.addEventListener('click', onNew);
      cancelBtn.addEventListener('click', onCancel);
      dlg.addEventListener('close', onClose);

      renderOptions();
      dlg.showModal();
    });
  }

  // --- Fiche détail (navigation + actions de parenté) --------------------

  // addSpecs : liste de { label, action, sexe } — plusieurs boutons d'ajout
  // possibles (ex. « Père » / « Mère » séparés plutôt qu'un « Parent »
  // générique) ; sexe (optionnel) préremplit le sexe sur la fiche de la
  // nouvelle personne créée depuis ce bouton précis.
  function relSection(title, list, addSpecs, unlinkKind) {
    var chips = list.map(function (p) {
      var name = '<span class="chip-name" data-open="' + escapeHtml(p.id) + '">' + escapeHtml(Store.fullName(p)) + '</span>';
      var rm = unlinkKind ? '<button class="chip-x" type="button" title="Détacher" data-unlink="' + unlinkKind + '" data-id="' + escapeHtml(p.id) + '">×</button>' : '';
      return '<span class="chip">' + name + rm + '</span>';
    }).join('');
    var addChips = (addSpecs || []).map(function (spec) {
      return '<span class="chip chip-add" data-act="' + spec.action + '"' + (spec.sexe ? ' data-sexe="' + spec.sexe + '"' : '') + '>+ ' + escapeHtml(spec.label) + '</span>';
    }).join('');
    var emptyHint = (!list.length && !(addSpecs && addSpecs.length)) ? '<span class="muted">—</span>' : '';
    return '<div class="detail-section"><h3>' + title + '</h3><div class="chip-row">' + chips + addChips + emptyHint + '</div></div>';
  }

  function renderDetail(personId) {
    var p = state.persons[personId];
    if (!p) return;
    var parents = Store.getParents(state, personId);
    var spouses = Store.getSpouses(state, personId);
    var children = Store.getChildren(state, personId);
    var siblings = Store.getSiblings(state, personId);

    var html = '<div class="detail-header">' + avatarHTML(p) +
      '<div class="detail-header-info"><p class="detail-name">' + escapeHtml(Store.fullName(p)) +
      (p.wikitree ? ' <span class="detail-badge" title="Liée à un profil WikiTree">🔗 WikiTree</span>' : '') +
      '</p><div class="chip-row detail-chips">' + detailHeaderChips(p) + '</div></div></div>';

    // Les liens de famille directs sont l'info la plus indispensable d'une
    // fiche : regroupés dans un bloc distinct, juste sous l'en-tête, avant
    // tout le reste (notes, frères/sœurs en retrait plus bas — voir CSS
    // .detail-core / .detail-section-muted).
    // Père / mère proposés séparément (plutôt qu'un « parent » générique) :
    // évite d'avoir à ouvrir la fiche ensuite juste pour préciser le sexe.
    // Seul le rôle manquant est proposé si un parent d'un sexe donné existe déjà.
    var parentSpecs = [];
    if (parents.length < 2) {
      var hasFather = parents.some(function (par) { return par.sexe === 'H'; });
      var hasMother = parents.some(function (par) { return par.sexe === 'F'; });
      if (!hasFather) parentSpecs.push({ label: 'Ajouter un père', action: 'add-parent', sexe: 'H' });
      if (!hasMother) parentSpecs.push({ label: 'Ajouter une mère', action: 'add-parent', sexe: 'F' });
    }
    // Le libellé (conjoint/conjointe) et le sexe préconisé pour la nouvelle
    // fiche s'accordent avec le sexe déjà défini de la personne courante.
    var spouseSpec = { label: 'Ajouter un conjoint', action: 'add-spouse', sexe: null };
    if (p.sexe === 'H') spouseSpec = { label: 'Ajouter une conjointe', action: 'add-spouse', sexe: 'F' };
    else if (p.sexe === 'F') spouseSpec = { label: 'Ajouter un conjoint', action: 'add-spouse', sexe: 'H' };

    html += '<div class="detail-core">' +
      relSection('Parents', parents, parentSpecs, 'parent') +
      relSection('Conjoint(s)', spouses, [spouseSpec], 'spouse') +
      relSection('Enfants', children, [{ label: 'Ajouter un enfant', action: 'add-child', sexe: null }], 'child') +
      '</div>';

    if (siblings.length) {
      html += '<div class="detail-section-muted">' + relSection('Frères et sœurs', siblings, null, null) + '</div>';
    }
    if (p.notes) {
      html += '<div class="detail-section-muted"><div class="detail-section"><h3>Notes</h3><div class="detail-notes">' + escapeHtml(p.notes) + '</div></div></div>';
    }

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
        '<button class="btn btn-ghost btn-sm" data-act="open-geneanet" title="Ouvre la recherche Geneanet dans le navigateur, préremplie">🌐 Chercher sur Geneanet</button>' +
        '<button class="btn btn-ghost btn-sm" data-act="open-antenati" title="Ouvre la recherche nominative du Portale Antenati (archives d’état civil italiennes), préremplie">🇮🇹 Chercher sur Antenati</button>' +
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

  function addParentFlow(personId, sexe) {
    var p = state.persons[personId];
    if ((p.parentIds || []).length >= 2) { alert('Cette personne a déjà deux parents enregistrés.'); return; }
    var exclude = [personId].concat(descendantIds(personId));
    var title = sexe === 'H' ? 'Choisir le père' : sexe === 'F' ? 'Choisir la mère' : 'Choisir le parent';
    pickPerson({ title: title, excludeIds: exclude, newSexe: sexe }).then(function (res) {
      if (!res) return;
      var slot = (p.parentIds || []).length;
      Store.setParent(state, personId, res.id, slot);
      renderDetail(personId);
      refreshAll();
    });
  }

  function addSpouseFlow(personId, sexe) {
    var title = sexe === 'H' ? 'Choisir le conjoint' : sexe === 'F' ? 'Choisir la conjointe' : 'Choisir le conjoint';
    pickPerson({ title: title, excludeIds: [personId], newSexe: sexe }).then(function (res) {
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
        withUndo('avant fusion', '✓ Fiches fusionnées : ' + Store.fullName(c.person), function () {
          Store.mergePersons(state, c.person.id, id);   // garde l'existante, absorbe l'autre
        });
        dlg.close();
        refreshAll();
        openDetail(c.person.id);
      });
      listEl.appendChild(li);
    });
    dlg.showModal();
  }
  $('#matchKeep').addEventListener('click', function () { $('#matchDialog').close(); });

  function handleDetailAction(act, personId, sexe) {
    var p = state.persons[personId];
    if (!p) return;
    if (act === 'edit') {
      openPersonForm(p).then(function (updated) { if (updated) { renderDetail(personId); refreshAll(); proposeMatch(personId); } });
    } else if (act === 'center') {
      closeDetail(); navigateTo(personId);
    } else if (act === 'set-home') {
      closeDetail(); setHome(personId);
    } else if (act === 'delete') {
      if (confirm('Supprimer ' + Store.fullName(p) + ' ? Cette action retire aussi ses liens de parenté (tu pourras annuler juste après).')) {
        withUndo('avant suppression', '🗑 ' + Store.fullName(p) + ' supprimé(e).', function () {
          Store.deletePerson(state, personId);
        });
        closeDetail();
        refreshAll();
      }
    } else if (act === 'add-parent') {
      addParentFlow(personId, sexe);
    } else if (act === 'add-spouse') {
      addSpouseFlow(personId, sexe);
    } else if (act === 'add-child') {
      addChildFlow(personId);
    } else if (act === 'complete-online') {
      completeFromWikiTree(personId);
    } else if (act === 'find-duplicates') {
      proposeMatch(personId, true);
    } else if (act === 'open-geneanet') {
      openGeneanetForPerson(p);
    } else if (act === 'open-antenati') {
      openAntenatiForPerson(p);
    }
  }

  function unlinkRelation(kind, personId, otherId) {
    var other = state.persons[otherId];
    var label = { parent: 'Parent', spouse: 'Conjoint(e)', child: 'Enfant' }[kind] || 'Lien';
    withUndo('avant détachement', label + ' détaché' + (other ? ' : ' + Store.fullName(other) : '') + '.', function () {
      if (kind === 'parent') Store.removeParent(state, personId, otherId);
      else if (kind === 'spouse') Store.unlinkSpouse(state, personId, otherId);
      else if (kind === 'child') Store.unlinkChild(state, personId, otherId);
    });
    renderDetail(personId);
    refreshAll();
  }

  detailContent.addEventListener('click', function (e) {
    var rmBtn = e.target.closest('[data-unlink]');
    if (rmBtn) { unlinkRelation(rmBtn.dataset.unlink, detailContent.dataset.personId, rmBtn.dataset.id); return; }
    var openBtn = e.target.closest('[data-open]');
    if (openBtn) { renderDetail(openBtn.dataset.open); return; }
    var actBtn = e.target.closest('[data-act]');
    if (actBtn) handleDetailAction(actBtn.dataset.act, detailContent.dataset.personId, actBtn.dataset.sexe || null);
  });
  $('#btnDetailClose').addEventListener('click', closeDetail);

  // --- Barre de navigation + arbre ---------------------------------------

  $all('.bottombar button').forEach(function (b) {
    b.addEventListener('click', function () { switchView(b.dataset.view); });
  });

  $all('#modeSwitch button').forEach(function (b) {
    b.addEventListener('click', function () {
      treeMode = b.dataset.mode;
      savePref('treeMode', treeMode);
      syncModeSwitch();
      renderTree();
    });
  });

  function syncModeSwitch() {
    $all('#modeSwitch button').forEach(function (x) {
      var on = x.dataset.mode === treeMode;
      x.classList.toggle('active', on);
      x.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  syncModeSwitch();

  $('#genRange').addEventListener('input', function (e) {
    maxGen = parseInt(e.target.value, 10);
    savePref('maxGen', maxGen);
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

  // Recherche différée (150 ms après la dernière frappe) : pas de tri ni de
  // reconstruction complète de la liste à chaque touche.
  searchInput.addEventListener('input', U.debounce(function () {
    listLimit = LIST_PAGE;
    renderList();
    var lv = $('#view-list'); if (lv) lv.scrollTop = 0;
  }, 150));
  rootSelect.addEventListener('change', function () {
    setHome(rootSelect.value);
  });

  // --- Réglages : sauvegarde / GEDCOM / réinitialisation -----------------

  function exportJsonFile() {
    downloadFile('arbre-genealogique.json', Store.exportJSON(state), 'application/json');
  }
  $('#btnExportJson').addEventListener('click', exportJsonFile);
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
        if (confirm('Remplacer les données actuelles par ce fichier ? (tu pourras annuler juste après, ou restaurer depuis les sauvegardes automatiques)')) {
          withUndo('avant import JSON', '✓ Données importées.', function () {
            state = imported;
            Store.save(state);
          });
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

  // Coller depuis Geneanet : une zone de texte à coller manuellement (long
  // appui → Coller) plutôt que navigator.clipboard.readText() — cette API
  // demande une permission pas toujours disponible dans la WebView Android,
  // et l'app n'embarque pas le plugin Capacitor Clipboard. Un appui long
  // marche partout, sans rien à négocier.
  $('#btnPasteGeneanet').addEventListener('click', function () {
    var ta = $('#pasteGeneanetArea');
    ta.value = '';
    $('#pasteGeneanetDialog').showModal();
    ta.focus();
  });
  $('#btnPasteGeneanetCancel').addEventListener('click', function () { $('#pasteGeneanetDialog').close(); });
  $('#btnPasteGeneanetApply').addEventListener('click', function () {
    if (applyGeneanetPaste($('#pasteGeneanetArea').value)) $('#pasteGeneanetDialog').close();
  });

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
      Store.checkpoint('avant fusion GEDCOM');
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
      if (!confirm('Remplacer les données actuelles par ce fichier GEDCOM ? (tu pourras annuler juste après, ou restaurer depuis les sauvegardes automatiques)')) return;
      withUndo('avant import GEDCOM', '✓ Fichier GEDCOM importé.', function () {
        state = imported;
        Store.save(state);
      });
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
    if (confirm('Supprimer toutes les personnes et unions de cet appareil ? (tu pourras annuler juste après, ou restaurer depuis les sauvegardes automatiques)')) {
      withUndo('avant réinitialisation', 'Toutes les données ont été effacées.', function () {
        state = Store.emptyState();
        Store.save(state);
      });
      viewRoot = null;
      rootHistory = [];
      refreshAll();
    }
  });

  $('#btnRescan').addEventListener('click', function () { renderSuggestions(true); });

  // Recherche en ligne (WikiTree / INSEE) : implémentée dans online.js,
  // chargé après ce fichier et branché sur GenApp.online.
  function completeFromWikiTree(personId) {
    if (GenApp.online) GenApp.online.completeFromWikiTree(personId);
  }

  // --- Thème (auto / clair / sombre) --------------------------------------

  // « auto » suit le réglage du système (prefers-color-scheme) ; sinon on
  // force via l'attribut data-theme sur <html> (voir styles.css).
  function applyTheme(theme) {
    var t = theme === 'light' || theme === 'dark' ? theme : 'auto';
    if (t === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
    var dark = t === 'dark' || (t === 'auto' && !(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches));
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#1c1410' : '#f6efe4');
    var sel = $('#themeSelect');
    if (sel) sel.value = t;
  }
  applyTheme(prefs.theme);
  var themeSel = $('#themeSelect');
  if (themeSel) themeSel.addEventListener('change', function () {
    savePref('theme', themeSel.value);
    applyTheme(themeSel.value);
  });
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: light)');
    var onScheme = function () { applyTheme(prefs.theme); };
    if (mq.addEventListener) mq.addEventListener('change', onScheme); else if (mq.addListener) mq.addListener(onScheme);
  }

  // --- Version affichée ---------------------------------------------------

  var APP_VERSION = '1.6.0';
  var vTop = $('#appVersion'); if (vTop) vTop.textContent = 'v' + APP_VERSION;
  var vSet = $('#appVersionSettings'); if (vSet) vSet.textContent = APP_VERSION;

  // --- PWA : mise à jour ----------------------------------------------------

  // Le service worker sert l'app depuis son cache (hors-ligne). Quand une
  // nouvelle version est publiée, elle s'installe en arrière-plan puis
  // ATTEND : on affiche un bandeau « Nouvelle version — Recharger » plutôt
  // que de basculer à l'insu de l'utilisateur (ou d'attendre un 2e lancement).
  // Rechargement uniquement à la demande : à la 1re visite, le service
  // worker prend aussi le contrôle de la page (clients.claim → événement
  // controllerchange) et un rechargement à ce moment-là ferait perdre ce que
  // l'utilisateur est en train de saisir.
  var updateRequested = false;
  function showUpdateBanner(worker) {
    if ($('#updateBanner')) return;
    var bar = document.createElement('div');
    bar.id = 'updateBanner';
    bar.className = 'update-banner';
    bar.setAttribute('role', 'status');
    bar.innerHTML = '<span>Nouvelle version disponible.</span>' +
      '<button type="button" class="btn btn-sm btn-accent" data-act="reload">Recharger</button>' +
      '<button type="button" class="btn btn-sm btn-ghost" data-act="later" aria-label="Plus tard">✕</button>';
    bar.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act === 'reload') {
        Store.flush();
        updateRequested = true;
        worker.postMessage({ type: 'SKIP_WAITING' });
      } else {
        bar.remove();
      }
    });
    document.body.appendChild(bar);
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').then(function (reg) {
        if (reg.waiting && navigator.serviceWorker.controller) showUpdateBanner(reg.waiting);
        reg.addEventListener('updatefound', function () {
          var nw = reg.installing;
          if (!nw) return;
          nw.addEventListener('statechange', function () {
            // Une installation alors qu'un SW contrôle déjà la page = mise à
            // jour (et non 1re installation).
            if (nw.state === 'installed' && navigator.serviceWorker.controller) showUpdateBanner(nw);
          });
        });
        // Vérifie les mises à jour au retour sur l'app (PWA restée ouverte).
        document.addEventListener('visibilitychange', function () {
          if (document.visibilityState === 'visible') reg.update().catch(function () {});
        });
      }).catch(function () {});
      var reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (!updateRequested || reloading) return;
        reloading = true;
        location.reload();
      });
    });
  }

  // --- Interface exposée à online.js -----------------------------------------

  var GenApp = window.GenApp = {
    get state() { return state; },
    toast: toast,
    refreshAll: refreshAll,
    openDetail: openDetail,
    openExternal: openExternal,
    showSplitScreenTipOnce: showSplitScreenTipOnce,
    avatarHTML: avatarHTML,
    gainsHTML: gainsHTML,
    fieldGains: fieldGains,
    // Recentre la vue sur une personne (après un import), sans toucher à la
    // racine persistée.
    showInTree: function (id) { viewRoot = id; rootHistory = []; updateNav(); },
    online: null
  };

  switchView(currentView);
})();
