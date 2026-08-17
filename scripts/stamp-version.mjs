// Injecte la version de package.json dans les sources statiques :
//   - app.js  : var APP_VERSION = '<version>'
//   - sw.js   : const CACHE = 'genealogie-<version>'  (busting du cache à chaque release)
// Une seule source de vérité = package.json. Lancé par `npm run build` et par le CI.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(fs.readFileSync(join(root, 'package.json'), 'utf8')).version;

function patch(file, re, replacement) {
  const path = join(root, file);
  const src = fs.readFileSync(path, 'utf8');
  if (!re.test(src)) { console.warn('⚠ stamp: motif introuvable dans ' + file); return; }
  const out = src.replace(re, replacement);
  if (out !== src) fs.writeFileSync(path, out);
}

patch('app.js', /var APP_VERSION = '[^']*';/, "var APP_VERSION = '" + version + "';");
patch('sw.js', /const CACHE = '[^']*';/, "const CACHE = 'genealogie-" + version + "';");
console.log('Version tamponnée : ' + version);
