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
  function isValidDate(s) {
    if (!s) return true;
    var m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(s);
    if (!m) return false;
    if (m[2] && (+m[2] < 1 || +m[2] > 12)) return false;
    if (m[3] && (+m[3] < 1 || +m[3] > 31)) return false;
    return true;
  }

  var treeSvg = $('#treeSvg');
  var treeEmpty = $('#treeEmpty');
  var treeRootName = $('#treeRootName');
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
    if (p.naissance && p.naissance.date) return 'né(e) ' + p.naissance.date;
    if (p.naissance && p.naissance.lieu) return p.naissance.lieu;
    if (p.decede) return 'Décédé(e)';
    return '';
  }

  function detailMeta(p) {
    var parts = [];
    parts.push(p.sexe === 'H' ? 'Homme' : p.sexe === 'F' ? 'Femme' : 'Sexe non précisé');
    if (p.naissance && (p.naissance.date || p.naissance.lieu)) {
      parts.push('né(e) ' + [p.naissance.date ? 'le ' + p.naissance.date : '', p.naissance.lieu ? 'à ' + p.naissance.lieu : ''].filter(Boolean).join(' '));
    }
    if (p.decede || (p.deces && (p.deces.date || p.deces.lieu))) {
      parts.push('décédé(e) ' + [p.deces.date ? 'le ' + p.deces.date : '', p.deces.lieu ? 'à ' + p.deces.lieu : ''].filter(Boolean).join(' '));
    }
    return parts.join(' · ');
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

  function downloadFile(filename, content, mime) {
    var blob = new Blob([content], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
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
      treeRootName.textContent = '—';
      return;
    }
    if (!state.rootId || !state.persons[state.rootId]) state.rootId = Object.keys(state.persons)[0];
    var cr = currentRoot();
    treeRootName.textContent = Store.fullName(state.persons[cr]) +
      (cr !== state.rootId ? ' (racine : ' + Store.fullName(state.persons[state.rootId]) + ')' : '');
    panZoomCtl = Tree.render(treeSvg, state, { rootId: cr, mode: treeMode, maxGen: maxGen, onSelect: focusPerson, onOpen: openDetail });
    updateNav();
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

  function renderList() {
    var results = Store.searchPersons(state, searchInput.value);
    personList.innerHTML = '';
    personListEmpty.classList.toggle('hidden', results.length > 0);
    results.forEach(function (p) {
      var li = document.createElement('li');
      li.innerHTML = avatarHTML(p) +
        '<div><div class="person-line-name">' + escapeHtml(Store.fullName(p)) + '</div>' +
        '<div class="person-line-sub">' + escapeHtml(subLine(p)) + '</div></div>';
      li.addEventListener('click', function () { openDetail(p.id); });
      personList.appendChild(li);
    });
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

  function renderSuggestions() {
    var box = $('#suggestionsBox');
    if (!box) return;
    var issues = Store.scanIssues(state);
    var total = issues.duplicates.length + issues.noDates.length + issues.noSexe.length +
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
      $('#fNaissanceDate').value = existing && existing.naissance ? existing.naissance.date : '';
      $('#fNaissanceLieu').value = existing && existing.naissance ? existing.naissance.lieu : '';
      $('#fDecesDate').value = existing && existing.deces ? existing.deces.date : '';
      $('#fDecesLieu').value = existing && existing.deces ? existing.deces.lieu : '';
      $('#fNotes').value = existing ? existing.notes : '';

      var resolved = false;
      function finish(val) { if (resolved) return; resolved = true; resolve(val); }

      function onSubmit(e) {
        e.preventDefault();
        var nDate = $('#fNaissanceDate').value.trim();
        var dDate = $('#fDecesDate').value.trim();
        // Validation douce : vide, ou AAAA / AAAA-MM / AAAA-MM-JJ. On bloque la
        // saisie invalide (elle casserait tri et fusion) sans fermer la fenêtre.
        if (!isValidDate(nDate) || !isValidDate(dDate)) {
          alert('Date invalide. Formats acceptés : AAAA, AAAA-MM ou AAAA-MM-JJ (ex. 1889-04-20).');
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
      '<p class="detail-meta">' + escapeHtml(detailMeta(p)) + '</p></div></div>';

    if (p.notes) html += '<div class="detail-section"><h3>Notes</h3><div class="detail-notes">' + escapeHtml(p.notes) + '</div></div>';

    html += relSection('Parents', parents, 'Ajouter un parent', 'add-parent', 'parent');
    html += relSection('Conjoint(s)', spouses, 'Ajouter un conjoint', 'add-spouse', 'spouse');
    html += relSection('Enfants', children, 'Ajouter un enfant', 'add-child', 'child');
    if (siblings.length) html += relSection('Frères et sœurs', siblings, null, null);

    html += '<div class="detail-actions">' +
      '<button class="btn" data-act="edit">Modifier</button>' +
      '<button class="btn" data-act="complete-online">🔎 Compléter en ligne</button>' +
      '<button class="btn" data-act="find-duplicates">🔗 Doublons locaux</button>' +
      '<button class="btn" data-act="center">Centrer la vue ici</button>' +
      '<button class="btn" data-act="set-home">🏠 Définir comme racine</button>' +
      '<button class="btn btn-danger" data-act="delete">Supprimer</button>' +
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
      var li = document.createElement('li');
      li.innerHTML = '<div><div class="person-line-name">' + escapeHtml(Store.fullName(c.person)) + '</div>' +
        '<div class="person-line-sub">' + escapeHtml(detailMeta(c.person)) + '</div></div>' +
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

  // Indicateur d'avancement de la recherche en ligne (elle peut être lente) :
  // spinner + compteur de secondes, bouton désactivé le temps de l'appel.
  function wtBusy(on, label) {
    var btn = $('#wtSearchBtn');
    if (btn) btn.disabled = on;
    if (wtTimer) { clearInterval(wtTimer); wtTimer = null; }
    if (on) {
      var t0 = Date.now();
      var draw = function () {
        var s = Math.floor((Date.now() - t0) / 1000);
        wtStatus.innerHTML = '<span class="spinner"></span> ' + escapeHtml(label) + ' (' + s + ' s)';
      };
      draw();
      wtTimer = setInterval(draw, 500);
    }
  }

  function openOnlineSearch() {
    wtTargetId = null;
    wtResults.innerHTML = '';
    wtStatus.textContent = '';
    renderSearchHistory();
    onlineDlg.showModal();
  }

  // Lance la recherche WikiTree pré-remplie avec le nom de la personne, en mode
  // « compléter cette fiche » (BDD gratuite, en complément du rapprochement local).
  function completeFromWikiTree(personId) {
    var p = state.persons[personId];
    if (!p) return;
    wtTargetId = personId;
    $('#wtQuery').value = Store.fullName(p);
    wtResults.innerHTML = '';
    wtStatus.textContent = 'Recherche d’une correspondance pour « ' + Store.fullName(p) + ' »…';
    onlineDlg.showModal();
    runOnlineSearch();
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
    WikiTree.search(fn, ln, 25).then(function (matches) {
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
        var li = document.createElement('li');
        li.innerHTML = avatarHTML({ prenom: m.FirstName, nom: m.LastNameAtBirth || m.LastNameCurrent }) +
          '<div style="flex:1 1 auto;min-width:0">' +
          '<div class="person-line-name">' + escapeHtml(info.name) + '</div>' +
          '<div class="person-line-sub">' + escapeHtml(info.sub) + '</div></div>' +
          '<button class="btn btn-sm btn-accent" type="button">' + (completing ? 'Compléter' : 'Importer') + '</button>';
        li.querySelector('button').addEventListener('click', function () {
          if (wtTargetId) completeInto(m.Name, li, wtTargetId);
          else importFromWikiTree(m.Name, li);
        });
        wtResults.appendChild(li);
      });
    }).catch(function (err) {
      wtBusy(false);
      logSearch(q, null, err.message);
      wtStatus.textContent = 'Échec de la recherche : ' + err.message;
      toast('Recherche WikiTree échouée : ' + err.message, 'error');
    });
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
      state.rootId = main.id;
      viewRoot = main.id;
      rootHistory = [];
      Store.save(state);
      refreshAll();
      wtBusy(false);
      wtStatus.textContent = 'Importé : ' + Store.fullName(main) + (withRel ? ' (avec ses proches)' : '') + '. Arbre recentré.';
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

  // Cherche sur WikiTree pour chaque personne du lot (3 recherches en
  // parallèle max) et ne retient qu'une correspondance NON AMBIGUË : même
  // année de naissance des deux côtés, ou candidat unique si la fiche locale
  // n'a pas de date (sinon on ignore silencieusement — mieux vaut rater une
  // suggestion que proposer un mauvais rapprochement).
  function scanOnlineSuggestions(persons, onProgress) {
    var CONCURRENCY = 3;
    var results = [];
    var idx = 0, done = 0;
    return new Promise(function (resolve) {
      function next() {
        if (idx >= persons.length) return;
        var p = persons[idx++];
        WikiTree.search(p.prenom || '', p.nom || '', 5).then(function (matches) {
          var localYear = p.naissance && p.naissance.date ? p.naissance.date.slice(0, 4) : '';
          var best = null;
          if (localYear) {
            best = matches.filter(function (m) {
              var y = m.BirthDate && m.BirthDate !== '0000-00-00' ? m.BirthDate.slice(0, 4) : '';
              return y === localYear;
            })[0] || null;
          } else if (matches.length === 1) {
            best = matches[0];
          }
          if (best) results.push({ personId: p.id, match: best });
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

  function renderOnlineSuggestions(list) {
    var ul = $('#onlineSuggestList');
    ul.innerHTML = '';
    list.forEach(function (item) {
      var p = state.persons[item.personId];
      if (!p) return;
      var info = fmtMatch(item.match);
      var li = document.createElement('li');
      li.innerHTML = avatarHTML(p) +
        '<div style="flex:1 1 auto;min-width:0">' +
        '<div class="person-line-name">' + escapeHtml(Store.fullName(p)) + ' → ' + escapeHtml(info.name) + '</div>' +
        '<div class="person-line-sub">' + escapeHtml(info.sub) + '</div></div>' +
        '<button class="btn btn-sm btn-accent" type="button">Compléter</button>' +
        '<button class="btn btn-sm btn-ghost" type="button">Ignorer</button>';
      var buttons = li.querySelectorAll('button');
      buttons[0].addEventListener('click', function () { completeInto(item.match.Name, li, item.personId); });
      buttons[1].addEventListener('click', function () { li.remove(); });
      ul.appendChild(li);
    });
  }

  function findOnlineSuggestions() {
    var btn = $('#btnFindOnlineSuggestions');
    var status = $('#onlineSuggestStatus');
    var candidates = candidatesForOnlineMatch(10);
    if (!candidates.length) { status.textContent = 'Toutes les fiches ont déjà un lien WikiTree (ou aucune personne à vérifier).'; return; }
    btn.disabled = true;
    $('#onlineSuggestList').innerHTML = '';
    status.innerHTML = '<span class="spinner"></span> Vérification de ' + candidates.length + ' fiche(s)… (0/' + candidates.length + ')';
    scanOnlineSuggestions(candidates, function (done, total) {
      status.innerHTML = '<span class="spinner"></span> Vérification de ' + total + ' fiche(s)… (' + done + '/' + total + ')';
    }).then(function (results) {
      btn.disabled = false;
      if (!results.length) { status.textContent = 'Aucune correspondance non ambiguë trouvée sur ' + candidates.length + ' fiche(s) vérifiée(s).'; return; }
      status.textContent = results.length + ' correspondance(s) suggérée(s) sur ' + candidates.length + ' fiche(s) vérifiée(s) :';
      renderOnlineSuggestions(results);
    });
  }

  $('#btnFindOnlineSuggestions').addEventListener('click', findOnlineSuggestions);

  $('#btnRescan').addEventListener('click', renderSuggestions);
  $('#btnOnlineSearch').addEventListener('click', openOnlineSearch);
  $('#wtSearchBtn').addEventListener('click', runOnlineSearch);
  $('#wtClose').addEventListener('click', function () { onlineDlg.close(); });
  $('#wtQuery').addEventListener('keydown', function (e) { if (e.key === 'Enter') runOnlineSearch(); });

  // --- Version affichée ---------------------------------------------------

  var APP_VERSION = '1.4.5';
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
