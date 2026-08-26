// Assemble le dossier `www/` (webDir Capacitor) à partir des fichiers
// statiques servis à la racine. Pas de bundler : simple copie ciblée.
import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const www = join(root, 'www');

// Fichiers/dossiers embarqués dans l'app (mêmes assets que GitHub Pages).
const assets = [
  'index.html',
  'styles.css',
  'app.js',
  'gedcom.js',
  'store.js',
  'tree.js',
  'fanchart.js',
  'wikitree.js',
  'insee.js',
  'backend.js',
  'sw.js',
  'manifest.webmanifest',
  'img',
];

await rm(www, { recursive: true, force: true });
await mkdir(www, { recursive: true });
for (const name of assets) {
  await cp(join(root, name), join(www, name), { recursive: true });
}

// Config backend (secret) : présente uniquement pour un build PRIVÉ (famille),
// avec les URLs absolues de l'instance HA. Absente des builds publics
// (github.io / CI) → backend.js reste inerte (app localStorage seule).
if (existsSync(join(root, 'backend-config.js'))) {
  await cp(join(root, 'backend-config.js'), join(www, 'backend-config.js'));
  console.log('backend-config.js inclus → build privé connecté au backend HA.');
}

console.log(`www/ construit (${assets.length} entrées).`);
