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

  // Erreurs de persistance (quota plein, stockage bloqué…) : remontées à
  // l'app via Store.onError pour être AFFICHÉES — une sauvegarde qui échoue
  // en silence (console seule) fait perdre des modifications sans que
  // l'utilisateur ne s'en doute.
  var errorHandlers = [];
  function onError(fn) { errorHandlers.push(fn); }
  function reportError(kind, err) {
    console.error('Store: ' + kind, err);
    errorHandlers.forEach(function (fn) { try { fn(kind, err); } catch (e) {} });
  }
  function isQuotaError(e) {
    return !!e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014);
  }

  // --- Sauvegardes automatiques -------------------------------------------
  // Avant une écriture qui remplace les données persistées, l'ancien contenu
  // est conservé dans une file à part (protection contre une fausse manip).
  //
  // Stockées dans IndexedDB, PAS dans localStorage : localStorage est limité
  // à ~5 Mo par origine, et 10 copies complètes de l'arbre + l'arbre
  // lui-même le saturaient dès ~450 Ko de données (l'écriture PRINCIPALE
  // échouait alors). IndexedDB dispose d'un quota bien plus large et ses
  // écritures sont asynchrones (pas de gel de l'interface).
  //
  // Espacées dans le temps (BACKUP_INTERVAL_MS) plutôt qu'une par
  // modification : sinon 10 retouches successives d'une même fiche
  // évinçaient tout l'historique utile. Une sauvegarde est en revanche
  // FORCÉE avant une opération lourde (suppression, fusion, import,
  // restauration, réinitialisation) via Store.checkpoint().
  var LEGACY_BACKUP_KEY = 'genealogie:backups:v1';
  var BACKUP_MAX = 10;
  var BACKUP_INTERVAL_MS = 5 * 60 * 1000;
  var lastBackupAt = 0;
  var forceBackupLabel = null;

  var DB_NAME = 'genealogie';
  var DB_STORE = 'backups';
  var dbPromise = null;
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB indisponible')); return; }
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: 'id', autoIncrement: true });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    dbPromise.catch(function () {});
    return dbPromise;
  }
  function idbAll() {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var req = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).getAll();
        req.onsuccess = function () {
          resolve((req.result || []).sort(function (a, b) { return b.id - a.id; }));
        };
        req.onerror = function () { reject(req.error); };
      });
    });
  }
  function idbAdd(entry) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).add(entry);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    }).then(pruneBackups);
  }
  function pruneBackups() {
    return idbAll().then(function (list) {
      var extra = list.slice(BACKUP_MAX);
      if (!extra.length) return;
      return openDb().then(function (db) {
        return new Promise(function (resolve) {
          var tx = db.transaction(DB_STORE, 'readwrite');
          var st = tx.objectStore(DB_STORE);
          extra.forEach(function (e) { st.delete(e.id); });
          tx.oncomplete = function () { resolve(); };
          tx.onerror = function () { resolve(); };
        });
      });
    });
  }

  // Reprise des sauvegardes de l'ancien format (dans localStorage) : copiées
  // dans IndexedDB puis retirées de localStorage — libère d'un coup la
  // majeure partie du quota consommé. N'efface l'ancienne clé qu'une fois la
  // copie confirmée.
  function migrateLegacyBackups() {
    var raw;
    try { raw = localStorage.getItem(LEGACY_BACKUP_KEY); } catch (e) { return Promise.resolve(); }
    if (!raw) return Promise.resolve();
    var list;
    try { list = JSON.parse(raw) || []; } catch (e) { list = []; }
    // Du plus ancien au plus récent, pour conserver l'ordre des identifiants.
    return list.slice().reverse().reduce(function (p, b) {
      return p.then(function () {
        return idbAdd({ at: b.at, data: b.data, count: countPersons(b.data), label: '' });
      });
    }, Promise.resolve()).then(function () {
      try { localStorage.removeItem(LEGACY_BACKUP_KEY); } catch (e) {}
    }).catch(function (e) { console.warn('Migration des sauvegardes impossible', e); });
  }
  var ready = (typeof window === 'undefined') ? Promise.resolve() :
    migrateLegacyBackups().then(function () { return idbAll(); }).then(function (list) {
      if (list[0]) lastBackupAt = Math.max(lastBackupAt, new Date(list[0].at).getTime() || 0);
    }).catch(function () {});

  function countPersons(raw) {
    try { return Object.keys(JSON.parse(raw).persons || {}).length; } catch (e) { return 0; }
  }

  // Repli localStorage si IndexedDB est indisponible (navigation privée
  // stricte, WebView bridée) : même format qu'avant, mais on ne laisse
  // jamais une sauvegarde faire échouer l'écriture principale — en cas de
  // quota, on retire les plus anciennes jusqu'à ce que ça passe.
  function pushLegacyBackup(entry) {
    var list;
    try { list = JSON.parse(localStorage.getItem(LEGACY_BACKUP_KEY)) || []; } catch (e) { list = []; }
    list.unshift({ at: entry.at, data: entry.data, label: entry.label });
    list = list.slice(0, BACKUP_MAX);
    while (list.length) {
      try { localStorage.setItem(LEGACY_BACKUP_KEY, JSON.stringify(list)); return; } catch (e) {
        if (!isQuotaError(e)) return;
        list.pop();
      }
    }
    try { localStorage.removeItem(LEGACY_BACKUP_KEY); } catch (e) {}
  }

  function pushBackup(oldRaw, label) {
    try {
      if (!oldRaw) return;
      var count = countPersons(oldRaw);
      if (!count) return;
      var entry = { at: new Date().toISOString(), data: oldRaw, count: count, label: label || '' };
      lastBackupAt = Date.now();
      idbAdd(entry).catch(function () { pushLegacyBackup(entry); });
    } catch (e) {
      console.error('Sauvegarde automatique impossible', e);
    }
  }

  // Liste des sauvegardes, plus récente d'abord (asynchrone : IndexedDB).
  function listBackups() {
    return ready.then(idbAll).catch(function () {
      try { return JSON.parse(localStorage.getItem(LEGACY_BACKUP_KEY)) || []; } catch (e) { return []; }
    }).then(function (list) {
      return list.map(function (b) {
        return { at: b.at, count: b.count != null ? b.count : countPersons(b.data), label: b.label || '', data: b.data };
      });
    });
  }
  // Renvoie (promesse) l'état restauré, à assigner soi-même puis Store.save :
  // la fonction reste pure, l'appelant décide du re-rendu et de la confirmation.
  function restoreBackup(index) {
    return listBackups().then(function (list) {
      var entry = list[index];
      if (!entry) return null;
      try { return JSON.parse(entry.data); } catch (e) { return null; }
    });
  }

  // Force une sauvegarde de l'état persisté avant la prochaine écriture
  // (à appeler juste avant une opération lourde : suppression, fusion…).
  function checkpoint(label) { forceBackupLabel = label || 'avant modification'; }

  var saveTimer = null;
  var pendingState = null;
  function writeNow(state) {
    var oldRaw = null, newRaw;
    try {
      oldRaw = localStorage.getItem(KEY);
      newRaw = JSON.stringify(state);
    } catch (e) {
      reportError('lecture', e);
      return false;
    }
    if (oldRaw && oldRaw !== newRaw) {
      if (forceBackupLabel || Date.now() - lastBackupAt >= BACKUP_INTERVAL_MS) {
        pushBackup(oldRaw, forceBackupLabel);
      }
      forceBackupLabel = null;
    }
    try {
      localStorage.setItem(KEY, newRaw);
      return true;
    } catch (e) {
      if (isQuotaError(e)) {
        // Dernier recours : les anciennes sauvegardes (format localStorage)
        // prennent la place des données principales → on les libère.
        try { localStorage.removeItem(LEGACY_BACKUP_KEY); localStorage.setItem(KEY, newRaw); return true; } catch (e2) {
          reportError('quota', e2);
          return false;
        }
      }
      reportError('ecriture', e);
      return false;
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
    notifyChange();
  }
  // Écrit immédiatement une éventuelle sauvegarde en attente. Indispensable
  // avant fermeture/mise en arrière-plan : sur mobile/PWA la page peut être
  // suspendue avant le déclenchement du timer différé (→ perte de la dernière
  // modification). Appelé sur pagehide/visibilitychange/beforeunload.
  function flush() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (pendingState) { writeNow(pendingState); pendingState = null; }
  }
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flush();
    });
  }

  // Numéro de révision des données (incrémenté à chaque save) : permet aux
  // vues de mettre en cache des calculs coûteux (profondeur de l'arbre,
  // suggestions) et de ne les refaire que si les données ont changé.
  var revision = 0;
  function notifyChange() { revision++; }
  function getRevision() { return revision; }

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

  // Recherche insensible à la casse ET aux accents (« helene » trouve
  // « Hélène »), sur le nom, les lieux (naissance et décès), les notes et
  // les années (« 1889 » trouve les naissances/décès de 1889).
  function searchText(p) {
    return foldText([
      fullName(p),
      p.naissance && p.naissance.lieu, p.deces && p.deces.lieu,
      p.naissance && p.naissance.date, p.deces && p.deces.date,
      p.notes
    ].filter(Boolean).join(' \n '));
  }
  function searchPersons(state, query) {
    var terms = foldText(query).split(/\s+/).filter(Boolean);
    var list = allPersons(state);
    if (terms.length) {
      list = list.filter(function (p) {
        var hay = searchText(p);
        return terms.every(function (t) { return hay.indexOf(t) !== -1; });
      });
    }
    return list.sort(function (a, b) { return fullName(a).localeCompare(fullName(b)); });
  }

  // --- Fusion de deux arbres (ex. deux exports GEDCOM de logiciels différents) ---
  // Rapproche les personnes par nom + année de naissance (à défaut, par nom seul
  // si sans ambiguïté). Ne supprime ni n'écrase jamais une donnée existante :
  // complète seulement les champs vides et ajoute les personnes/unions inconnues.

  function stripAccents(s) {
    return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }
  // Texte « replié » pour la recherche : minuscules, sans accents.
  function foldText(s) { return stripAccents(s).toLowerCase().trim(); }

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

  // Âge calculé « quand possible » : à ce jour si vivant·e, à la date du
  // décès si décédé·e ET que cette date est connue (décédé·e sans date de
  // décès exploitable → pas d'âge fiable, renvoie null plutôt que deviner).
  // Renvoie { age, atDeath } ou null. Mois/jour manquants → 1er du mois/de
  // l'année (résultat approximatif mais raisonnable, pas de date invalide).
  function parseDateParts(iso) {
    var m = iso ? /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(iso) : null;
    if (!m) return null;
    return { y: +m[1], m: m[2] ? +m[2] : 1, d: m[3] ? +m[3] : 1 };
  }
  function computeAge(p) {
    var birth = p.naissance ? parseDateParts(p.naissance.date) : null;
    if (!birth) return null;
    var end, atDeath = false;
    if (p.decede) {
      var death = p.deces ? parseDateParts(p.deces.date) : null;
      if (!death) return null; // décédé·e mais date de décès inconnue : pas d'âge fiable
      end = death;
      atDeath = true;
    } else {
      var now = new Date();
      end = { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() };
    }
    var age = end.y - birth.y;
    if (end.m < birth.m || (end.m === birth.m && end.d < birth.d)) age--;
    if (age < 0 || age > 130) return null; // garde-fou : dates incohérentes
    return { age: age, atDeath: atDeath };
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
  function levenshtein(a, b) {
    var m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    var prev = [];
    for (var j = 0; j <= n; j++) prev[j] = j;
    for (var i = 1; i <= m; i++) {
      var cur = [i];
      for (j = 1; j <= n; j++) {
        cur[j] = a.charAt(i - 1) === b.charAt(j - 1) ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
      }
      prev = cur;
    }
    return prev[n];
  }

  // Doublons à ORTHOGRAPHE PROCHE (mais pas identique) : même nom de famille,
  // prénoms proches (fautes de frappe, troncatures, variantes — « Michèle » /
  // « Michelle », « Julien » / « Julien Marie »). Contrairement à scanIssues()
  // (noms strictement identiques), celui-ci accepte le bruit d'une comparaison
  // approximative — d'où des garde-fous plus stricts pour écarter les faux
  // positifs les plus fréquents (fratries homonymes du type François/Françoise,
  // Jean/Jeanne, très courantes et PAS des doublons) :
  //  - sexe connu et différent des deux côtés → jamais retenu, quel que soit le score
  //  - années de naissance/décès incompatibles (y compris naissance après le
  //    décès du candidat, ou l'inverse) → écarté
  // Le score priorise les cas où un des deux côtés est ISOLÉ (aucun parent ni
  // union) : c'est le signal le plus fort ET le plus actionnable — une fiche
  // vide ressemblant à une fiche complète est presque toujours un doublon
  // d'import, sans rien à perdre à la fusionner.
  // Performance : prénoms normalisés et années calculés UNE fois par personne
  // (et non à chaque paire), et filtres bon marché (sexe, années, écart de
  // longueur) appliqués AVANT la distance de Levenshtein — les groupes d'un
  // même nom de famille peuvent compter des centaines de personnes (≈ n²/2
  // paires). Les critères sont des filtres indépendants : les réordonner ne
  // change pas le résultat.
  function scanFuzzyDuplicates(state) {
    var persons = allPersons(state);
    var bySurname = {};
    persons.forEach(function (p) {
      var s = normalizeName(p.nom);
      if (!s) return;
      var fn = normalizeName(p.prenom);
      if (!fn || fn.length < 3) return; // vide ou trop court : trop de faux positifs
      (bySurname[s] = bySurname[s] || []).push({
        p: p, fn: fn,
        sexe: (p.sexe && p.sexe !== '?') ? p.sexe : '',
        by: yearOf(p.naissance && p.naissance.date),
        dy: yearOf(p.deces && p.deces.date),
        iso: !(p.parentIds || []).length && !(p.unionIds || []).length
      });
    });
    var out = [];
    Object.keys(bySurname).forEach(function (surname) {
      var group = bySurname[surname];
      if (group.length < 2) return;
      for (var i = 0; i < group.length; i++) {
        var A = group[i];
        for (var j = i + 1; j < group.length; j++) {
          var B = group[j];
          var fa = A.fn, fb = B.fn;
          if (fa === fb) continue; // déjà couvert par le scan exact
          if (A.sexe && B.sexe && A.sexe !== B.sexe) continue;
          var ya = A.by, yb = B.by, da = A.dy, db = B.dy;
          if (ya && yb && Math.abs(ya - yb) > 3) continue;
          if (da && db && Math.abs(da - db) > 5) continue;
          if (ya && db && +ya > +db) continue; // né(e) après le décès du candidat : générations différentes
          if (yb && da && +yb > +da) continue;

          var prefix = fa.indexOf(fb) === 0 || fb.indexOf(fa) === 0;
          if (!prefix && Math.abs(fa.length - fb.length) > 2) continue; // distance forcément > 2
          var dist = levenshtein(fa, fb);
          if (dist > 2 && !prefix) continue;

          var isoA = A.iso, isoB = B.iso;
          // Aucune fiche vide des deux côtés : le signal le plus fort (une
          // fiche vide qui ressemble à une fiche complète) est absent, donc on
          // ne garde que les vraies fautes de frappe (distance 1) — un simple
          // préfixe ou une distance 2 produit trop de faux positifs entre
          // membres distincts d'une même famille (ex. « Elise »/« Céline »,
          // ou « Marie »/« Marie-Françoise » qui sont souvent deux sœurs).
          if (!isoA && !isoB && dist > 1) continue;

          var score = 0;
          if (dist <= 1) score += 3; else if (dist === 2) score += 1;
          if (prefix) score += 1;
          if (isoA || isoB) score += 3;
          if (ya && yb && ya === yb) score += 3;
          if (score < 2) continue; // « faible » : trop peu fiable pour être proposé

          var confidence = score >= 6 ? 'forte' : score >= 4 ? 'moyenne-forte' : 'moyenne';
          out.push({ a: A.p.id, b: B.p.id, score: score, confidence: confidence, isolated: isoA || isoB });
        }
      }
    });
    out.sort(function (x, y) { return y.score - x.score; });
    return out;
  }

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
      fuzzyDuplicates: scanFuzzyDuplicates(state),
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
    onError: onError,
    checkpoint: checkpoint,
    getRevision: getRevision,
    foldText: foldText,
    listBackups: listBackups,
    restoreBackup: restoreBackup,
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
    computeAge: computeAge,
    allPersons: allPersons,
    searchPersons: searchPersons,
    exportJSON: exportJSON,
    importJSON: importJSON
  };
})(window);
