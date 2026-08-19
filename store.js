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
  var pendingState = null;
  function writeNow(state) {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      console.error('Sauvegarde impossible', e);
    }
  }
  function save(state) {
    pendingState = state;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveTimer = null;
      writeNow(pendingState);
      pendingState = null;
    }, 150);
  }
  // Écrit immédiatement une éventuelle sauvegarde en attente. Indispensable
  // avant fermeture/mise en arrière-plan : sur mobile/PWA la page peut être
  // suspendue avant le déclenchement du timer différé (→ perte de la dernière
  // modification). Appelé sur pagehide/visibilitychange/beforeunload.
  function flush() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (pendingState) { writeNow(pendingState); pendingState = null; }
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flush();
    });
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

  // Détache UN parent d'un enfant (sans supprimer personne). L'enfant reste relié
  // au parent restant (union solo) s'il y en a un.
  function removeParent(state, childId, parentId) {
    var c = state.persons[childId];
    if (!c) return;
    Object.keys(state.unions).forEach(function (uidKey) {
      var u = state.unions[uidKey];
      if (u.partnerIds.indexOf(parentId) !== -1 && u.childIds.indexOf(childId) !== -1) {
        u.childIds = u.childIds.filter(function (x) { return x !== childId; });
        if (u.partnerIds.length === 0 && u.childIds.length === 0) delete state.unions[uidKey];
      }
    });
    c.parentIds = (c.parentIds || []).filter(function (x) { return x !== parentId; });
    if (c.parentIds.length === 1) {
      var solo = findOrCreateUnion(state, [c.parentIds[0]]);
      addChildToUnion(state, solo.id, childId);
    }
    save(state);
  }

  // Détache un conjoint. L'union devient solo si elle a des enfants, sinon elle
  // disparaît. Les enfants perdent ce parent-là mais gardent l'autre.
  function unlinkSpouse(state, aId, bId) {
    Object.keys(state.unions).forEach(function (uidKey) {
      var u = state.unions[uidKey];
      if (u.partnerIds.indexOf(aId) !== -1 && u.partnerIds.indexOf(bId) !== -1) {
        u.partnerIds = u.partnerIds.filter(function (x) { return x !== bId; });
        var b = state.persons[bId];
        if (b) b.unionIds = b.unionIds.filter(function (x) { return x !== uidKey; });
        u.childIds.forEach(function (cid) {
          var c = state.persons[cid];
          if (c) c.parentIds = c.parentIds.filter(function (x) { return x !== bId; });
        });
        if (u.partnerIds.length === 0 && u.childIds.length === 0) {
          delete state.unions[uidKey];
          var a = state.persons[aId];
          if (a) a.unionIds = a.unionIds.filter(function (x) { return x !== uidKey; });
        }
      }
    });
    save(state);
  }

  // Détache un enfant d'un parent (retire l'enfant des unions de ce parent).
  function unlinkChild(state, parentId, childId) {
    Object.keys(state.unions).forEach(function (uidKey) {
      var u = state.unions[uidKey];
      if (u.partnerIds.indexOf(parentId) !== -1 && u.childIds.indexOf(childId) !== -1) {
        removeChildFromUnion(state, uidKey, childId);
      }
    });
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

  // --- Fusion de deux arbres (ex. deux exports GEDCOM de logiciels différents) ---
  // Rapproche les personnes par nom + année de naissance (à défaut, par nom seul
  // si sans ambiguïté). Ne supprime ni n'écrase jamais une donnée existante :
  // complète seulement les champs vides et ajoute les personnes/unions inconnues.

  function stripAccents(s) {
    return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
  }

  function normalizeName(s) {
    return stripAccents(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function birthYear(p) {
    var m = p.naissance && p.naissance.date ? /(\d{4})/.exec(p.naissance.date) : null;
    return m ? m[1] : '';
  }

  function personKey(p) {
    return { name: normalizeName((p.prenom || '') + ' ' + (p.nom || '')), year: birthYear(p) };
  }

  function fillBlank(existing, field, value) {
    if (!existing[field] && value) existing[field] = value;
  }

  function yearOf(dateStr) {
    var m = dateStr ? /(\d{4})/.exec(dateStr) : null;
    return m ? m[1] : '';
  }

  // Score de rapprochement entre une personne entrante et une personne existante
  // DE MÊME NOM. Positif = c'est probablement la même ; négatif = probablement
  // deux personnes différentes (années de naissance/décès qui se contredisent).
  // `contradiction` = au moins une donnée forte diverge (à ne pas fusionner à la
  // légère). Compare la date COMPLÈTE quand les deux la portent (bonus fort).
  function matchScore(ip, ep) {
    var s = 0, contradiction = false;
    var iyN = yearOf(ip.naissance && ip.naissance.date), eyN = yearOf(ep.naissance && ep.naissance.date);
    if (iyN && eyN) {
      if (iyN === eyN) {
        s += 3;
        var idN = ip.naissance.date, edN = ep.naissance.date;
        if (idN.length > 4 && edN.length > 4 && idN === edN) s += 3; // jour+mois identiques
      } else { s -= 5; contradiction = true; }
    }
    var ipl = normalizeName(ip.naissance && ip.naissance.lieu), epl = normalizeName(ep.naissance && ep.naissance.lieu);
    if (ipl && epl && ipl === epl) s += 2;
    var iyD = yearOf(ip.deces && ip.deces.date), eyD = yearOf(ep.deces && ep.deces.date);
    if (iyD && eyD) {
      if (iyD === eyD) s += 2;
      else { s -= 3; contradiction = true; }
    }
    return { score: s, contradiction: contradiction };
  }

  // Complète un champ événement (naissance/décès) et signale un conflit si les
  // deux côtés portent une valeur DIFFÉRENTE (on garde l'existant, on n'écrase
  // jamais, mais on le compte pour le rapport).
  function fillEventField(existing, incoming, field, stats, details, who) {
    var ev0 = existing[field] || (existing[field] = { date: '', lieu: '' });
    var iv = incoming[field] || { date: '', lieu: '' };
    ['date', 'lieu'].forEach(function (f) {
      if (!iv[f]) return;
      if (!ev0[f]) ev0[f] = iv[f];
      else if (ev0[f] !== iv[f]) {
        stats.conflicts++;
        if (details.length < 40) {
          details.push(who + ' — ' + field + ' ' + f + ' : « ' + ev0[f] + ' » vs « ' + iv[f] + ' »');
        }
      }
    });
  }

  // Cherche dans l'arbre les personnes qui ressemblent à `fields` (même nom
  // normalisé, sans contradiction d'années). Sert à proposer un rapprochement au
  // moment où l'on ajoute/modifie une fiche, pour éviter les doublons.
  function findSimilar(state, fields, excludeId) {
    var name = personKey(fields).name;
    if (!name) return [];
    var out = [];
    Object.keys(state.persons).forEach(function (id) {
      if (id === excludeId) return;
      var ep = state.persons[id];
      if (personKey(ep).name !== name) return;
      var r = matchScore(fields, ep);
      if (r.contradiction) return;   // années qui se contredisent → autre personne
      out.push({ person: ep, score: r.score });
    });
    out.sort(function (a, b) { return b.score - a.score; });
    return out;
  }

  // Fusionne deux fiches DÉJÀ dans l'arbre : `dropId` est absorbée par `keepId`
  // (champs complétés, relations reportées, unions dédoublonnées), puis supprimée.
  function mergePersons(state, keepId, dropId) {
    if (keepId === dropId) return;
    var keep = state.persons[keepId], drop = state.persons[dropId];
    if (!keep || !drop) return;

    fillBlank(keep, 'prenom', drop.prenom);
    fillBlank(keep, 'nom', drop.nom);
    if (keep.sexe === '?' && drop.sexe && drop.sexe !== '?') keep.sexe = drop.sexe;
    keep.naissance = keep.naissance || { date: '', lieu: '' };
    keep.deces = keep.deces || { date: '', lieu: '' };
    fillBlank(keep.naissance, 'date', drop.naissance && drop.naissance.date);
    fillBlank(keep.naissance, 'lieu', drop.naissance && drop.naissance.lieu);
    fillBlank(keep.deces, 'date', drop.deces && drop.deces.date);
    fillBlank(keep.deces, 'lieu', drop.deces && drop.deces.lieu);
    if (!keep.decede && drop.decede) keep.decede = true;
    if (drop.notes && (keep.notes || '').indexOf(drop.notes) === -1) {
      keep.notes = keep.notes ? keep.notes + '\n' + drop.notes : drop.notes;
    }

    function uniq(a) { return a.filter(function (x, i) { return x != null && a.indexOf(x) === i; }); }

    Object.keys(state.unions).forEach(function (uidKey) {
      var u = state.unions[uidKey];
      u.partnerIds = uniq(u.partnerIds.map(function (x) { return x === dropId ? keepId : x; }));
      u.childIds = uniq(u.childIds.map(function (x) { return x === dropId ? keepId : x; }));
      u.childIds = u.childIds.filter(function (c) { return u.partnerIds.indexOf(c) === -1; });
    });
    Object.keys(state.persons).forEach(function (pid) {
      var p = state.persons[pid];
      p.parentIds = uniq((p.parentIds || []).map(function (x) { return x === dropId ? keepId : x; }))
        .filter(function (x) { return x !== pid; });
    });
    delete state.persons[dropId];

    // Dédoublonne les unions devenues identiques (mêmes partenaires) en fusionnant
    // leurs enfants.
    var seen = {};
    Object.keys(state.unions).forEach(function (uidKey) {
      var u = state.unions[uidKey];
      var key = u.partnerIds.slice().sort().join('|');
      if (key !== '' && seen[key]) {
        var master = state.unions[seen[key]];
        master.childIds = uniq(master.childIds.concat(u.childIds));
        fillBlank(master, 'dateDebut', u.dateDebut);
        fillBlank(master, 'lieuDebut', u.lieuDebut);
        delete state.unions[uidKey];
      } else if (key !== '') {
        seen[key] = uidKey;
      }
    });
    Object.keys(state.unions).forEach(function (uidKey) {
      var u = state.unions[uidKey];
      if (u.partnerIds.length === 0 && u.childIds.length === 0) delete state.unions[uidKey];
    });
    // Reconstruit les unionIds à partir des unions restantes.
    Object.keys(state.persons).forEach(function (pid) { state.persons[pid].unionIds = []; });
    Object.keys(state.unions).forEach(function (uidKey) {
      state.unions[uidKey].partnerIds.forEach(function (pid) {
        var p = state.persons[pid];
        if (p && p.unionIds.indexOf(uidKey) === -1) p.unionIds.push(uidKey);
      });
    });
    if (state.rootId === dropId) state.rootId = keepId;
    save(state);
  }

  // Passe l'arbre au crible et remonte des pistes d'amélioration :
  // doublons probables, fiches incomplètes, dates suspectes, personnes isolées.
  // Lecture seule — ne modifie rien, se relance à la demande (pas de tâche de
  // fond : un calcul complet sur plusieurs milliers de personnes prend
  // quelques millisecondes, donc « scanner » = recalculer à chaque ouverture).
  function scanIssues(state) {
    var persons = allPersons(state);
    var thisYear = new Date().getFullYear();

    // Regroupe par nom normalisé avant de comparer : une comparaison exhaustive
    // (chaque personne contre toutes les autres, comme findSimilar) est en O(n²)
    // et devient inutilisable au-delà de quelques centaines de personnes. Deux
    // personnes ne peuvent être des doublons que si elles partagent le même nom
    // normalisé, donc on ne compare qu'à l'intérieur de chaque groupe.
    var byName = {};
    persons.forEach(function (p) {
      var name = personKey(p).name;
      if (!name) return;
      (byName[name] = byName[name] || []).push(p);
    });
    var duplicates = [];
    Object.keys(byName).forEach(function (name) {
      var group = byName[name];
      if (group.length < 2) return;
      for (var i = 0; i < group.length; i++) {
        for (var j = i + 1; j < group.length; j++) {
          var r = matchScore(group[i], group[j]);
          if (!r.contradiction) duplicates.push({ a: group[i].id, b: group[j].id, score: r.score });
        }
      }
    });
    duplicates.sort(function (x, y) { return y.score - x.score; });

    var noDates = [], noSexe = [], isolated = [], badDates = [];
    persons.forEach(function (p) {
      var bY = yearOf(p.naissance && p.naissance.date);
      var dY = yearOf(p.deces && p.deces.date);
      if (!bY && !dY) noDates.push(p.id);
      if (!p.sexe || p.sexe === '?') noSexe.push(p.id);
      if (!(p.parentIds || []).length && !(p.unionIds || []).length) isolated.push(p.id);

      if (bY && dY && +dY < +bY) badDates.push({ id: p.id, reason: 'décès (' + dY + ') avant naissance (' + bY + ')' });
      if (bY && +bY > thisYear) badDates.push({ id: p.id, reason: 'naissance dans le futur (' + bY + ')' });
      if (bY && !dY && !p.decede && (thisYear - bY) > 115) {
        badDates.push({ id: p.id, reason: 'né(e) il y a ' + (thisYear - bY) + ' ans, non marqué(e) décédé(e)' });
      }
    });

    return {
      duplicates: duplicates,
      noDates: noDates,
      noSexe: noSexe,
      isolated: isolated,
      badDates: badDates
    };
  }

  function mergeGedcom(state, incoming) {
    var idMap = {};
    var stats = { matched: 0, added: 0, unions: 0, conflicts: 0, details: [] };

    // Index des personnes existantes par nom normalisé (plusieurs par nom possible).
    var byName = {};
    Object.keys(state.persons).forEach(function (id) {
      var name = personKey(state.persons[id]).name;
      (byName[name] = byName[name] || []).push(id);
    });

    Object.keys(incoming.persons).forEach(function (iid) {
      var ip = incoming.persons[iid];
      var name = personKey(ip).name;
      var cands = byName[name] || [];
      var matchId = null;

      if (cands.length) {
        var scored = cands.map(function (id) {
          var r = matchScore(ip, state.persons[id]);
          return { id: id, score: r.score, contradiction: r.contradiction };
        }).sort(function (a, b) { return b.score - a.score; });
        var best = scored[0], second = scored[1];
        var unambiguous = !second || best.score > second.score;
        if (best.score > 0 && unambiguous) {
          matchId = best.id;                 // rapprochement sûr (données concordantes)
        } else if (cands.length === 1 && !best.contradiction) {
          matchId = best.id;                 // nom unique, aucune contradiction
        }
        // sinon : ambigu ou contradictoire → on ne fusionne pas, on ajoute (compté)
        if (!matchId) {
          stats.conflicts++;
          if (stats.details.length < 40) {
            stats.details.push('« ' + fullName(ip) + ' » : rapprochement ambigu (' + cands.length + ' homonyme(s)) → ajouté séparément');
          }
        }
      }

      if (matchId) {
        var existing = state.persons[matchId];
        fillBlank(existing, 'prenom', ip.prenom);
        fillBlank(existing, 'nom', ip.nom);
        if (existing.sexe === '?' && ip.sexe && ip.sexe !== '?') existing.sexe = ip.sexe;
        fillEventField(existing, ip, 'naissance', stats, stats.details, fullName(existing));
        fillEventField(existing, ip, 'deces', stats, stats.details, fullName(existing));
        if (!existing.decede && ip.decede) existing.decede = true;
        if (ip.notes && (existing.notes || '').indexOf(ip.notes) === -1) {
          existing.notes = existing.notes ? existing.notes + '\n' + ip.notes : ip.notes;
        }
        idMap[iid] = matchId;
        stats.matched++;
      } else {
        var created = addPerson(state, {
          prenom: ip.prenom, nom: ip.nom, sexe: ip.sexe,
          naissance: { date: ip.naissance ? ip.naissance.date : '', lieu: ip.naissance ? ip.naissance.lieu : '' },
          deces: { date: ip.deces ? ip.deces.date : '', lieu: ip.deces ? ip.deces.lieu : '' },
          decede: !!ip.decede, notes: ip.notes || ''
        });
        idMap[iid] = created.id;
        stats.added++;
      }
    });

    Object.keys(incoming.unions).forEach(function (uidKey) {
      var u = incoming.unions[uidKey];
      var partnerIds = u.partnerIds.map(function (pid) { return idMap[pid]; }).filter(Boolean);
      if (!partnerIds.length) return;
      var union = findOrCreateUnion(state, partnerIds);
      fillBlank(union, 'dateDebut', u.dateDebut);
      fillBlank(union, 'lieuDebut', u.lieuDebut);
      (u.childIds || []).forEach(function (cid) {
        var mapped = idMap[cid];
        if (!mapped) return;
        var child = state.persons[mapped];
        var existingParents = child.parentIds || [];
        var newParents = partnerIds.filter(function (pid) { return existingParents.indexOf(pid) === -1; });
        if (existingParents.length + newParents.length > 2) {
          // Cet enfant a déjà 2 parents différents ailleurs : on ne relie pas cette
          // union comme filiation pour éviter de fausser l'arbre (conflit de source).
          stats.conflicts++;
          if (stats.details.length < 40) {
            stats.details.push('« ' + fullName(child) + ' » : déjà 2 parents → filiation du fichier ignorée');
          }
          return;
        }
        addChildToUnion(state, union.id, mapped);
      });
      stats.unions++;
    });

    save(state);
    return stats;
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
    flush: flush,
    addPerson: addPerson,
    updatePerson: updatePerson,
    deletePerson: deletePerson,
    findOrCreateUnion: findOrCreateUnion,
    updateUnion: updateUnion,
    deleteUnion: deleteUnion,
    addChildToUnion: addChildToUnion,
    removeChildFromUnion: removeChildFromUnion,
    removeParent: removeParent,
    unlinkSpouse: unlinkSpouse,
    unlinkChild: unlinkChild,
    findSimilar: findSimilar,
    mergePersons: mergePersons,
    scanIssues: scanIssues,
    setParent: setParent,
    mergeGedcom: mergeGedcom,
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
