#!/usr/bin/env node
/**
 * Golden de `matchesBrTitle`: filtro estrito de título BR.
 *
 * Segue o padrão de `dump-title-normalization.mjs`: importa a função REAL do
 * dist, roda o corpus e grava `rust/golden/matches-br-title.jsonl` + manifest.
 *
 * Entrada JSON com `op=brTitle`. Saída `1`/`0`. Ano em texto (null vira "").
 * `allNames` é lista ou null. `cutTail` é sempre true (default do config).
 *
 * O golden foi gerado manualmente (corpus + JSONL) porque o dist não estava
 * disponível no momento da criação. Os valores esperados foram traçados dos
 * testes TypeScript em `test/br-title.test.ts` e `test/br-title-edition.test.ts`.
 *
 * Para regenerar a partir do dist vivo:
 *   node scripts/golden/dump-title-normalization.mjs --fn matches-br-title
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export default {
  id: 'matches-br-title/matchesBrTitle',
  name: 'matchesBrTitle',
  source: 'src/utils/release-title-rules.ts',
  artifact: 'dist/src/utils/release-title-rules.js',
  corpus: 'scripts/golden/corpus-matches-br-title.json',
  outJsonl: 'rust/golden/matches-br-title.jsonl',
  outManifest: 'rust/golden/matches-br-title.manifest.json',
  resolve: async () => {
    const mod = await import(pathToFileURL(path.join(REPO, 'dist/src/utils/release-title-rules.js')).href);
    const bit = (v) => (v ? '1' : '0');
    return (input) => {
      const c = JSON.parse(input);
      // Ano: string vazia representa null (como o TS faz String(year ?? ''))
      const year = c.year === '' ? null : c.year;
      const opts = {};
      if (c.isSeries === true) opts.isSeries = true;
      if (Array.isArray(c.allNames)) opts.allNames = c.allNames;
      return bit(mod.matchesBrTitle(c.title, c.name, year, opts));
    };
  },
};
