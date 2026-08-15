/* App — contrôleur principal de l'application indépendante « Arbre généalogique ». */
(function () {
  'use strict';

  var state = Store.load();
  var treeMode = 'ancestors';
  var maxGen = 4;
  var panZoomCtl = null;

  function $(sel) { return document.querySelector(sel); }
  function $all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

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
    treeRootName.textContent = Store.fullName(state.persons[state.rootId]);
    panZoomCtl = Tree.render(treeSvg, state, { rootId: state.rootId, mode: treeMode, maxGen: maxGen, onSelect: openDetail });
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
        var fields = {
          prenom: $('#fPrenom').value.trim(),
          nom: $('#fNom').value.trim(),
          sexe: $('#fSexe').value,
          decede: $('#fDecede').checked,
          naissance: { date: $('#fNaissanceDate').value.trim(), lieu: $('#fNaissanceLieu').value.trim() },
          deces: { date: $('#fDecesDate').value.trim(), lieu: $('#fDecesLieu').value.trim() },
          notes: $('#fNotes').value.trim()
        };
        var person = existing ? Store.updatePerson(state, existing.id, fields) : Store.addPerson(state, fields);
        finish(person);
        dlg.close();
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

  function relSection(title, list, addLabel, addAction) {
    var chips = list.map(function (p) {
      return '<span class="chip" data-open="' + p.id + '">' + escapeHtml(Store.fullName(p)) + '</span>';
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

    html += relSection('Parents', parents, 'Ajouter un parent', 'add-parent');
    html += relSection('Conjoint(s)', spouses, 'Ajouter un conjoint', 'add-spouse');
    html += relSection('Enfants', children, 'Ajouter un enfant', 'add-child');
    if (siblings.length) html += relSection('Frères et sœurs', siblings, null, null);

    html += '<div class="detail-actions">' +
      '<button class="btn" data-act="edit">Modifier</button>' +
      '<button class="btn" data-act="root">Centrer l’arbre ici</button>' +
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

  function addParentFlow(personId) {
    var p = state.persons[personId];
    if ((p.parentIds || []).length >= 2) { alert('Cette personne a déjà deux parents enregistrés.'); return; }
    var exclude = [personId].concat(Store.getChildren(state, personId).map(function (c) { return c.id; }));
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

  function handleDetailAction(act, personId) {
    var p = state.persons[personId];
    if (!p) return;
    if (act === 'edit') {
      openPersonForm(p).then(function (updated) { if (updated) { renderDetail(personId); refreshAll(); } });
    } else if (act === 'root') {
      state.rootId = personId; Store.save(state); closeDetail(); refreshAll();
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
    }
  }

  detailContent.addEventListener('click', function (e) {
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
    pickPerson({ title: 'Centrer l’arbre sur…', allowNew: false }).then(function (res) {
      if (!res) return;
      state.rootId = res.id; Store.save(state); renderTree();
    });
  });

  $('#btnZoomIn').addEventListener('click', function () { if (panZoomCtl) panZoomCtl.zoomIn(); });
  $('#btnZoomOut').addEventListener('click', function () { if (panZoomCtl) panZoomCtl.zoomOut(); });
  $('#btnZoomReset').addEventListener('click', function () { if (panZoomCtl) panZoomCtl.reset(); });

  function addPersonFlow() {
    openPersonForm(null).then(function (p) { if (p) refreshAll(); });
  }
  $('#btnAddPerson').addEventListener('click', addPersonFlow);
  $('#btnEmptyAdd').addEventListener('click', addPersonFlow);

  searchInput.addEventListener('input', renderList);
  rootSelect.addEventListener('change', function () {
    state.rootId = rootSelect.value; Store.save(state); renderTree();
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
        if (confirm('Remplacer les données actuelles par ce fichier GEDCOM ? Cette action est irréversible.')) {
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

  $('#btnReset').addEventListener('click', function () {
    if (confirm('Supprimer toutes les personnes et unions de cet appareil ? Cette action est irréversible.')) {
      state = Store.emptyState();
      Store.save(state);
      refreshAll();
    }
  });

  // --- PWA / démarrage ----------------------------------------------------

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }

  refreshAll();
})();
