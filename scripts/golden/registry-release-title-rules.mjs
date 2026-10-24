/**
 * Entrada de registro do golden de `src/utils/release-title-rules.ts` (funções
 * puras: matchesTitleStructure, shortNameIdentity, matchesShortNameIdentity).
 * Consumida por `gen-release-title-rules.mjs`.
 *
 * Entrada JSON com `op`: shortName (shortNameIdentity: skip | no-token |
 * prefix|want|run), identity (shortNameIdentity + matchesShortNameIdentity, 1/0)
 * e structure (matchesTitleStructure, 1/0). `year` pode ser string, número ou
 * null, como no TS; `own` null vira `null` (o TS usa o título) e lista (mesmo
 * vazia) vira lista.
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export default {
  id: 'release-title-rules/guards',
  name: 'releaseTitleRules',
  source: 'src/utils/release-title-rules.ts',
  artifact: 'dist/src/utils/release-title-rules.js',
  corpus: 'scripts/golden/corpus-release-title-rules.json',
  outJsonl: 'rust/golden/release-title-rules.jsonl',
  outManifest: 'rust/golden/release-title-rules.manifest.json',
  resolve: async () => {
    const mod = await import(pathToFileURL(path.join(REPO, 'dist/src/utils/release-title-rules.js')).href);
    const bit = (v) => (v ? '1' : '0');
    const yearOf = (v) => (v === undefined ? null : v);
    const ownOf = (v) => (v === undefined || v === null ? null : v);
    return (input) => {
      const c = JSON.parse(input);
      switch (c.op) {
        case 'shortName': {
          const r = mod.shortNameIdentity(c.name);
          if (r.kind === 'skip' || r.kind === 'no-token') return r.kind;
          return `prefix|${r.want}|${r.run.join(' ')}`;
        }
        case 'identity': {
          const check = mod.shortNameIdentity(c.name);
          return bit(mod.matchesShortNameIdentity(c.title, check, ownOf(c.own), c.dn ?? ''));
        }
        case 'structure':
          return bit(mod.matchesTitleStructure(c.title, c.name, yearOf(c.year), {
            isSeries: c.isSeries === true,
            tokens: ownOf(c.own),
          }));
        default:
          throw new Error(`op desconhecida: ${c.op}`);
      }
    };
  },
};
