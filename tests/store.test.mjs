import test from 'node:test';
import assert from 'node:assert/strict';
import { load, memoryStorage, plain, tick } from './helpers.mjs';

const KEY = 'genealogie:data:v1';
const LEGACY_BACKUPS = 'genealogie:backups:v1';

function family(Store) {
  const s = Store.emptyState();
  const pere = Store.addPerson(s, { prenom: 'Jean', nom: 'Dupont', sexe: 'H', naissance: { date: '1900', lieu: 'Lyon' } });
  const mere = Store.addPerson(s, { prenom: 'Hélène', nom: 'Durand', sexe: 'F', naissance: { date: '1902-05-01', lieu: 'Évreux' } });
  const u = Store.findOrCreateUnion(s, [pere.id, mere.id]);
  const enfant = Store.addPerson(s, { prenom: 'Paul', nom: 'Dupont', sexe: 'H', naissance: { date: '1930', lieu: '' } });
  Store.addChildToUnion(s, u.id, enfant.id);
  return { s, pere, mere, enfant, u };
}

test('liens de parenté : parents, enfants, conjoints', () => {
  const { Store } = load(['store.js']);
  const { s, pere, mere, enfant } = family(Store);
  assert.deepEqual(plain(Store.getParents(s, enfant.id).map((p) => p.id)).sort(), [pere.id, mere.id].sort());
  assert.deepEqual(plain(Store.getChildren(s, pere.id).map((p) => p.id)), [enfant.id]);
  assert.deepEqual(plain(Store.getSpouses(s, mere.id).map((p) => p.id)), [pere.id]);
});

test('recherche insensible aux accents, multi-termes, lieux et années', () => {
  const { Store } = load(['store.js']);
  const { s, mere } = family(Store);
  assert.deepEqual(plain(Store.searchPersons(s, 'helene').map((p) => p.id)), [mere.id]);
  assert.deepEqual(plain(Store.searchPersons(s, 'HÉLÈNE durand').map((p) => p.id)), [mere.id]);
  assert.deepEqual(plain(Store.searchPersons(s, 'evreux').map((p) => p.id)), [mere.id]);
  assert.equal(Store.searchPersons(s, '1930').length, 1);
  assert.equal(Store.searchPersons(s, 'dupont').length, 2);
  assert.equal(Store.searchPersons(s, '').length, 3);
  assert.equal(Store.searchPersons(s, 'inconnu').length, 0);
});

test('suppression : les liens vers la personne disparaissent', () => {
  const { Store } = load(['store.js']);
  const { s, pere, enfant } = family(Store);
  Store.deletePerson(s, pere.id);
  assert.equal(s.persons[pere.id], undefined);
  assert.ok(!s.persons[enfant.id].parentIds.includes(pere.id));
});

test('fusion de doublons : complète et raccroche les branches', () => {
  const { Store } = load(['store.js']);
  const { s, pere, enfant } = family(Store);
  const doublon = Store.addPerson(s, { prenom: 'Jean', nom: 'Dupont', sexe: 'H', naissance: { date: '1900', lieu: '' }, notes: 'Menuisier' });
  const issues = Store.scanIssues(s);
  assert.ok(issues.duplicates.some((d) => [d.a, d.b].sort().join() === [pere.id, doublon.id].sort().join()));
  Store.mergePersons(s, pere.id, doublon.id);
  assert.equal(s.persons[doublon.id], undefined);
  assert.equal(s.persons[pere.id].notes, 'Menuisier');
  assert.ok(s.persons[enfant.id].parentIds.includes(pere.id));
});

test('scan : dates incohérentes signalées', () => {
  const { Store } = load(['store.js']);
  const s = Store.emptyState();
  const p = Store.addPerson(s, { prenom: 'A', nom: 'B', naissance: { date: '1950', lieu: '' }, deces: { date: '1940', lieu: '' }, decede: true });
  const bad = Store.scanIssues(s).badDates;
  assert.equal(bad.length, 1);
  assert.equal(bad[0].id, p.id);
});

test('export / import JSON : aller-retour sans perte', () => {
  const { Store } = load(['store.js']);
  const { s } = family(Store);
  assert.deepEqual(plain(Store.importJSON(Store.exportJSON(s))), plain(s));
  assert.throws(() => Store.importJSON('{"foo":1}'));
});

test('persistance : flush écrit immédiatement, load relit', () => {
  const ls = memoryStorage();
  const { Store } = load(['store.js'], { localStorage: ls });
  const { s } = family(Store);
  Store.save(s);
  Store.flush();
  const again = load(['store.js'], { localStorage: ls }).Store.load();
  assert.equal(Object.keys(again.persons).length, 3);
});

test('révision : incrémentée à chaque modification', () => {
  const { Store } = load(['store.js']);
  const r0 = Store.getRevision();
  const s = Store.emptyState();
  Store.addPerson(s, { prenom: 'X' });
  assert.ok(Store.getRevision() > r0);
});

test('sauvegardes auto : espacées dans le temps, forcées par checkpoint', async () => {
  // Pas d'IndexedDB sous Node → repli localStorage (même logique d'espacement).
  const ls = memoryStorage();
  const { Store } = load(['store.js'], { localStorage: ls });
  const s = Store.emptyState();
  Store.addPerson(s, { prenom: 'Un' });
  Store.flush();                                   // 1re écriture : rien à sauvegarder
  Store.addPerson(s, { prenom: 'Deux' });
  Store.flush();                                   // remplace des données → 1re sauvegarde
  await tick();
  assert.equal(JSON.parse(ls.getItem(LEGACY_BACKUPS)).length, 1);

  Store.addPerson(s, { prenom: 'Trois' });
  Store.flush();                                   // < 5 min : pas de nouvelle sauvegarde
  await tick();
  assert.equal(JSON.parse(ls.getItem(LEGACY_BACKUPS)).length, 1);

  Store.checkpoint('avant suppression');
  Store.addPerson(s, { prenom: 'Quatre' });
  Store.flush();                                   // forcée
  await tick();
  const list = JSON.parse(ls.getItem(LEGACY_BACKUPS));
  assert.equal(list.length, 2);
  assert.equal(list[0].label, 'avant suppression');

  const backups = await Store.listBackups();
  assert.equal(backups[0].count, 3);
  const restored = await Store.restoreBackup(0);
  assert.equal(Object.keys(restored.persons).length, 3);
});

test('quota plein : l\'erreur est remontée à l\'app (pas de perte silencieuse)', () => {
  let full = false;
  const ls = memoryStorage({ failOn: (k) => full && k === KEY });
  const { Store } = load(['store.js'], { localStorage: ls });
  const errors = [];
  Store.onError((kind) => errors.push(kind));
  const s = Store.emptyState();
  Store.addPerson(s, { prenom: 'Un' });
  Store.flush();
  full = true;
  Store.addPerson(s, { prenom: 'Deux' });
  Store.flush();
  assert.deepEqual(errors, ['quota']);
});

test('quota plein : les anciennes sauvegardes sont libérées pour sauver les données', () => {
  const ls = memoryStorage({ failOn: (k) => k === KEY && ls.data.has(LEGACY_BACKUPS) });
  ls.data.set(LEGACY_BACKUPS, '[]');
  const { Store } = load(['store.js'], { localStorage: ls });
  const errors = [];
  Store.onError((kind) => errors.push(kind));
  const s = Store.emptyState();
  Store.addPerson(s, { prenom: 'Un' });
  Store.flush();
  assert.deepEqual(errors, []);
  assert.ok(ls.getItem(KEY));
});
