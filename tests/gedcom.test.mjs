import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';

test('GEDCOM : export puis import conserve personnes, dates et filiations', () => {
  const { Store, Gedcom } = load(['store.js', 'gedcom.js']);
  const s = Store.emptyState();
  const pere = Store.addPerson(s, { prenom: 'Jean', nom: 'Dupont', sexe: 'H', naissance: { date: '1900-03-04', lieu: 'Lyon' } });
  const mere = Store.addPerson(s, { prenom: 'Hélène', nom: 'Durand', sexe: 'F', decede: true, deces: { date: '1980', lieu: 'Paris' } });
  const u = Store.findOrCreateUnion(s, [pere.id, mere.id]);
  const enfant = Store.addPerson(s, { prenom: 'Paul', nom: 'Dupont', sexe: 'H' });
  Store.addChildToUnion(s, u.id, enfant.id);

  const text = Gedcom.exportGEDCOM(s);
  assert.match(text, /^0 HEAD/);
  const back = Gedcom.parseGEDCOM(text);
  const persons = Object.values(back.persons);
  assert.equal(persons.length, 3);
  const byName = (n) => persons.find((p) => Store.fullName(p) === n);
  const jean = byName('Jean Dupont'), helene = byName('Hélène Durand'), paul = byName('Paul Dupont');
  assert.ok(jean && helene && paul);
  assert.equal(jean.naissance.date, '1900-03-04');
  assert.equal(jean.naissance.lieu, 'Lyon');
  assert.equal(helene.deces.date, '1980');
  assert.ok(helene.decede);
  assert.deepEqual([...paul.parentIds].sort(), [jean.id, helene.id].sort());
});

test('GEDCOM : fusion d\'un import avec les données existantes', () => {
  const { Store, Gedcom } = load(['store.js', 'gedcom.js']);
  const s = Store.emptyState();
  Store.addPerson(s, { prenom: 'Jean', nom: 'Dupont', naissance: { date: '1900', lieu: '' } });
  const other = Store.emptyState();
  Store.addPerson(other, { prenom: 'Jean', nom: 'Dupont', naissance: { date: '1900', lieu: 'Lyon' } });
  Store.addPerson(other, { prenom: 'Marie', nom: 'Martin' });
  const imported = Gedcom.parseGEDCOM(Gedcom.exportGEDCOM(other));
  const stats = Store.mergeGedcom(s, imported);
  assert.equal(stats.matched, 1);
  assert.equal(stats.added, 1);
  const jean = Object.values(s.persons).find((p) => p.prenom === 'Jean');
  assert.equal(jean.naissance.lieu, 'Lyon');
});
