// Cohérence des listes de fichiers : chaque script chargé par index.html doit
// être mis en cache par le service worker (sinon l'app casse hors-ligne) et
// copié dans www/ par le build (sinon il manque dans l'APK et sur Pages).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { root } from './helpers.mjs';

const read = (f) => fs.readFileSync(join(root, f), 'utf8');
const scripts = [...read('index.html').matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
const shell = JSON.parse(read('sw.js').match(/const SHELL = (\[[\s\S]*?\]);/)[1].replace(/'/g, '"'));
const assets = [...read('scripts/build-www.mjs').match(/const assets = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

test('index.html charge des scripts', () => {
  assert.ok(scripts.includes('app.js'));
  assert.ok(scripts.includes('util.js'));
});

test('tous les scripts sont en cache hors-ligne (sw.js)', () => {
  for (const s of scripts) assert.ok(shell.includes(s), s + ' absent de SHELL dans sw.js');
});

test('tous les fichiers du shell sont copiés par le build', () => {
  for (const f of shell) {
    const top = f.split('/')[0];
    assert.ok(assets.includes(f) || assets.includes(top), f + ' absent de scripts/build-www.mjs');
    assert.ok(fs.existsSync(join(root, f)), f + ' introuvable');
  }
});

test('version identique dans package.json, app.js et sw.js', () => {
  const v = JSON.parse(read('package.json')).version;
  assert.match(read('app.js'), new RegExp("var APP_VERSION = '" + v.replace(/\./g, '\\.') + "';"));
  assert.match(read('sw.js'), new RegExp("const CACHE = 'genealogie-" + v.replace(/\./g, '\\.') + "';"));
});
