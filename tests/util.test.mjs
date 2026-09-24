import test from 'node:test';
import assert from 'node:assert/strict';
import { load, plain } from './helpers.mjs';

const { GenUtil: U } = load(['util.js']);

test('dates : saisie JJ/MM/AAAA ↔ format interne', () => {
  assert.equal(U.parseDateFr('20/04/1889'), '1889-04-20');
  assert.equal(U.parseDateFr('04/1889'), '1889-04');
  assert.equal(U.parseDateFr('1889'), '1889');
  assert.equal(U.parseDateFr('1889-04-20'), '1889-04-20');
  assert.equal(U.parseDateFr('  '), '');
  assert.equal(U.formatDateFr('1889-04-20'), '20/04/1889');
  assert.equal(U.formatDateFr('1889-04'), '04/1889');
  assert.equal(U.formatDateFr('vers 1889'), 'vers 1889');
});

test('dates : validation', () => {
  assert.ok(U.isValidDate(''));
  assert.ok(U.isValidDate('1889-12-31'));
  assert.ok(!U.isValidDate('1889-13'));
  assert.ok(!U.isValidDate('1889-02-32'));
  assert.ok(!U.isValidDate('20/04/1889'));
});

test('escapeHtml neutralise le HTML', () => {
  assert.equal(U.escapeHtml('<b a="1">\'&'), '&lt;b a=&quot;1&quot;&gt;&#39;&amp;');
  assert.equal(U.escapeHtml(null), '');
});

test('splitNameQuery : dernier mot = nom', () => {
  assert.deepEqual(plain(U.splitNameQuery('Jean Marie Dupont')), { fn: 'Jean Marie', ln: 'Dupont' });
  assert.deepEqual(plain(U.splitNameQuery('Dupont')), { fn: '', ln: 'Dupont' });
});

test('groupLetter : accents et ponctuation neutralisés', () => {
  assert.equal(U.groupLetter('Élodie'), 'E');
  assert.equal(U.groupLetter('"Corfic" Morvan'), 'C');
  assert.equal(U.groupLetter(''), '#');
  assert.equal(U.groupLetter('123'), '#');
});

test('fiche Geneanet collée : nom, sexe, dates et lieux', () => {
  const r = U.parseGeneanetProfile([
    'Josèphe VIDAILHET',
    'Née le 21 mars 1759 - Sarrancolin, 65408, Hautes-Pyrénées, France',
    'Décédée le 19 janvier 1832 - Arreau, France, à l\'âge de 72 ans',
  ].join('\n'));
  assert.equal(r.prenom, 'Josèphe');
  assert.equal(r.nom, 'VIDAILHET');
  assert.equal(r.sexe, 'F');
  assert.equal(r.naissance.date, '1759-03-21');
  assert.equal(r.naissance.lieu, 'Sarrancolin, 65408, Hautes-Pyrénées, France');
  assert.equal(r.deces.date, '1832-01-19');
  assert.equal(r.deces.lieu, 'Arreau, France');
});

test('fiche Geneanet : mois accentués (février, août, décembre)', () => {
  const r = U.parseGeneanetProfile('Jean MARTIN\nNé le 3 février 1801 - Pau\nDécédé le 15 août 1870 - Tarbes');
  assert.equal(r.sexe, 'H');
  assert.equal(r.naissance.date, '1801-02-03');
  assert.equal(r.deces.date, '1870-08-15');
});

test('URLs de recherche externes', () => {
  const g = U.geneanetSearchUrl('Jean', 'Dupont', '1889-04-20', { prenom: 'Marie', nom: 'Durand' });
  assert.match(g, /nom=Dupont/);
  assert.match(g, /naissance_annee=1889&naissance_mois=4&naissance_jour=20/);
  assert.match(g, /prenom_conjoint=Marie/);
  assert.equal(U.antenatiSearchUrl('Mario', 'Rossi'), 'https://antenati.cultura.gov.it/search-nominative/?cognome=Rossi&nome=Mario');
});

test('timeAgo', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  assert.equal(U.timeAgo('2026-01-01T11:59:30Z', now), 'à l’instant');
  assert.equal(U.timeAgo('2026-01-01T11:30:00Z', now), 'il y a 30 min');
  assert.equal(U.timeAgo('2025-12-30T12:00:00Z', now), 'il y a 2 j');
});
