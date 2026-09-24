// Charge les scripts « navigateur » de l'app (IIFE qui s'attachent à
// `window`) dans un contexte isolé, avec des doublures minimales du DOM et
// de localStorage. Chaque appel = un contexte neuf (tests indépendants).
import vm from 'node:vm';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function memoryStorage(opts = {}) {
  const data = new Map();
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => {
      if (opts.failOn && opts.failOn(k, v)) {
        const e = new Error('quota');
        e.name = 'QuotaExceededError';
        throw e;
      }
      data.set(k, String(v));
    },
    removeItem: (k) => { data.delete(k); },
  };
}

export function load(files, { localStorage = memoryStorage() } = {}) {
  const noop = () => {};
  const ctx = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage,
    addEventListener: noop,
    document: { addEventListener: noop, querySelector: () => null, querySelectorAll: () => [] },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of files) {
    vm.runInContext(fs.readFileSync(join(root, f), 'utf8'), ctx, { filename: f });
  }
  return ctx;
}

// Les objets créés dans le contexte vm ont d'autres prototypes : on les
// repasse par JSON avant une comparaison stricte.
export const plain = (x) => JSON.parse(JSON.stringify(x));

export const tick = () => new Promise((r) => setTimeout(r, 0));
