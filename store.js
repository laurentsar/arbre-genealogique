/* Store — modèle de données et persistance (localStorage). Aucune dépendance,
   aucun code partagé avec le lecteur IPTV : application indépendante. */
(function (global) {
  'use strict';

  var KEY = 'genealogie:data:v1';

  function uid() {
    return 'id' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
  }

  function emptyState() {
    return { persons: {}, unions: {}, rootId: null, meta: { version: 1 } };
  }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return emptyState();
      var data = JSON.parse(raw);
      if (!data || typeof data !== 'object') return emptyState();
      data.persons = data.persons || {};
      data.unions = data.unions || {};
      data.meta = data.meta || { version: 1 };
      return data;
    } catch (e) {
      console.error('Chargement impossible, réinitialisation.', e);
      return emptyState();
    }
  }

  var saveTimer = null;
  function save(state) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try {
        localStorage.setItem(KEY, JSON.stringify(state));
      } catch (e) {
        console.error('Sauvegarde impossible', e);
      }
    }, 150);
  }

  function newPerson(fields) {
    return Object.assign({
      id: uid(),
      prenom: '',
      nom: '',
      sexe: '?',
      naissance: { date: '', lieu: '' },
      deces: { date: '', lieu: '' },
      decede: false,
      notes: '',
      parentIds: [],
      unionIds: []
    }, fields || {});
  }

  function addPerson(state, fields) {
    var p = newPerson(fields);
    state.persons[p.id] = p;
    if (!state.rootId) state.rootId = p.id;
    save(state);
    return p;
  }

  function updatePerson(state, id, fields) {
    var p = state.persons[id];
    if (!p) return null;
    Object.assign(p, fields);
    save(state);
    return p;
  }

  function deletePerson(state, id) {
    var p = state.persons[id];
    if (!p) return;
    // Détache des unions (en tant que partenaire ou enfant).
    Object.keys(state.unions).forEach(function (uidKey) {
      var u = state.unions[uidKey];
      u.partnerIds = u.partnerIds.filter(function (x) { return x !== id; });
      u.childIds = u.childIds.filter(function (x) { return x !== id; });
      if (u.partnerIds.length === 0 && u.childIds.length === 0) delete state.unions[uidKey];
    });
    // Retire des parentIds des autres personnes.
    Object.keys(state.persons).forEach(function (pid) {
      var other = state.persons[pid];
      other.parentIds = (other.parentIds || []).filter(function (x) { return x !== id; });
    });
    delete state.persons[id];
    if (state.rootId === id) {
      var rest = Object.keys(state.persons);
      state.rootId = rest.length ? rest[0] : null;
    }
    save(state);
  }

  function findOrCreateUnion(state, partnerIds) {
    var sorted = partnerIds.slice().sort();
    var found = Object.keys(state.unions).find(function (uidKey) {
      var u = state.unions[uidKey];
      var s = u.partnerIds.slice().sort();
      return s.length === sorted.length && s.every(function (v, i) { return v === sorted[i]; });
    });
    if (found) return state.unions[found];
    var u = {
      id: uid(),
      partnerIds: partnerIds.slice(),
      childIds: [],
      statut: '',
      dateDebut: '',
      lieuDebut: '',
      dateFin: ''
    };
    state.unions[u.id] = u;
    partnerIds.forEach(function (pid) {
      var p = state.persons[pid];
      if (p && p.unionIds.indexOf(u.id) === -1) p.unionIds.push(u.id);
    });
    save(state);
    return u;
  }

  function updateUnion(state, id, fields) {
    var u = state.unions[id];
    if (!u) return null;
    Object.assign(u, fields);
    save(state);
    return u;
  }

  function deleteUnion(state, id) {
    var u = state.unions[id];
    if (!u) return;
    u.partnerIds.forEach(function (pid) {
      var p = state.persons[pid];
      if (p) p.unionIds = p.unionIds.filter(function (x) { return x !== id; });
    });
    u.childIds.forEach(function (cid) {
      var c = state.persons[cid];
      if (c) c.parentIds = c.parentIds.filter(function (x) { return u.partnerIds.indexOf(x) === -1; });
    });
    delete state.unions[id];
    save(state);
  }

  function addChildToUnion(state, unionId, childId) {
    var u = state.unions[unionId];
    var c = state.persons[childId];
    if (!u || !c) return;
    if (u.childIds.indexOf(childId) === -1) u.childIds.push(childId);
    u.partnerIds.forEach(function (pid) {
      if (c.parentIds.indexOf(pid) === -1) c.parentIds.push(pid);
    });
    save(state);
  }

  function removeChildFromUnion(state, unionId, childId) {
    var u = state.unions[unionId];
    var c = state.persons[childId];
    if (!u) return;
    u.childIds = u.childIds.filter(function (x) { return x !== childId; });
    if (c) c.parentIds = c.parentIds.filter(function (x) { return u.partnerIds.indexOf(x) === -1; });
    save(state);
  }

  function setParent(state, childId, parentId, slot) {
    var c = state.persons[childId];
    if (!c) return;
    var parents = c.parentIds.slice();
    parents = parents.filter(function (x) { return x !== parentId; });
    while (parents.length < 2) parents.push(null);
    parents[slot] = parentId;
    c.parentIds = parents.filter(function (x) { return x; });
    // Assure une union entre les deux parents s'ils sont désormais tous deux connus.
    if (c.parentIds.length === 2) {
      var u = findOrCreateUnion(state, c.parentIds);
      addChildToUnion(state, u.id, childId);
    } else if (c.parentIds.length === 1) {
      var solo = findOrCreateUnion(state, [c.parentIds[0]]);
      addChildToUnion(state, solo.id, childId);
    }
    save(state);
  }

  // --- Requêtes de parenté -------------------------------------------------

  function getParents(state, id) {
    var p = state.persons[id];
    if (!p) return [];
    return (p.parentIds || []).map(function (pid) { return state.persons[pid]; }).filter(Boolean);
  }

  function getUnions(state, id) {
    var p = state.persons[id];
    if (!p) return [];
    return (p.unionIds || []).map(function (uid2) { return state.unions[uid2]; }).filter(Boolean);
  }

  function getSpouses(state, id) {
    var out = [];
    getUnions(state, id).forEach(function (u) {
      u.partnerIds.forEach(function (pid) {
        if (pid !== id) {
          var sp = state.persons[pid];
          if (sp) out.push(sp);
        }
      });
    });
    return out;
  }

  function getChildren(state, id) {
    var seen = {};
    var out = [];
    getUnions(state, id).forEach(function (u) {
      u.childIds.forEach(function (cid) {
        if (!seen[cid] && state.persons[cid]) {
          seen[cid] = true;
          out.push(state.persons[cid]);
        }
      });
    });
    return out;
  }

  function getSiblings(state, id) {
    var p = state.persons[id];
    if (!p) return [];
    var seen = {};
    var out = [];
    (p.parentIds || []).forEach(function (pid) {
      getChildren(state, pid).forEach(function (sib) {
        if (sib.id !== id && !seen[sib.id]) {
          seen[sib.id] = true;
          out.push(sib);
        }
      });
    });
    return out;
  }

  function fullName(p) {
    if (!p) return '?';
    return ((p.prenom || '') + ' ' + (p.nom || '')).trim() || '(sans nom)';
  }

  function allPersons(state) {
    return Object.keys(state.persons).map(function (id) { return state.persons[id]; });
  }

  function searchPersons(state, query) {
    var q = (query || '').trim().toLowerCase();
    var list = allPersons(state);
    if (!q) return list.sort(function (a, b) { return fullName(a).localeCompare(fullName(b)); });
    return list.filter(function (p) {
      return fullName(p).toLowerCase().indexOf(q) !== -1 ||
        (p.naissance.lieu || '').toLowerCase().indexOf(q) !== -1 ||
        (p.notes || '').toLowerCase().indexOf(q) !== -1;
    }).sort(function (a, b) { return fullName(a).localeCompare(fullName(b)); });
  }

  function exportJSON(state) {
    return JSON.stringify(state, null, 2);
  }

  function importJSON(text) {
    var data = JSON.parse(text);
    if (!data.persons || !data.unions) throw new Error('Fichier invalide : structure inattendue.');
    return data;
  }

  global.Store = {
    uid: uid,
    emptyState: emptyState,
    load: load,
    save: save,
    addPerson: addPerson,
    updatePerson: updatePerson,
    deletePerson: deletePerson,
    findOrCreateUnion: findOrCreateUnion,
    updateUnion: updateUnion,
    deleteUnion: deleteUnion,
    addChildToUnion: addChildToUnion,
    removeChildFromUnion: removeChildFromUnion,
    setParent: setParent,
    getParents: getParents,
    getUnions: getUnions,
    getSpouses: getSpouses,
    getChildren: getChildren,
    getSiblings: getSiblings,
    fullName: fullName,
    allPersons: allPersons,
    searchPersons: searchPersons,
    exportJSON: exportJSON,
    importJSON: importJSON
  };
})(window);
