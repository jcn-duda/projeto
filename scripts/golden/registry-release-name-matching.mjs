/**
 * Entrada de registro do golden de `src/utils/release-name-matching.ts`. Para
 * entrar no `FUNCTIONS` de dump-title-normalization.mjs (linha de import + chave),
 * ver o gerador `gen-release-name-matching.mjs`, que consome esta mesma entrada.
 *
 * Entrada JSON com `op`: matches (matchesName, 1/0; `tokens` null ou lista),
 * coverage (nameCoverageTokens, tokens unidos por espaço), multiWork
 * (isMultiWorkCollection, 1/0), root (franchiseRoot, texto), roots
 * (franchiseRoots, JSON array), endsSeq (endsWithSequenceMarker, 1/0) e run
 * (containsTokenRun, 1/0).
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export default {
  id: 'release-name-matching/helpers',
  name: 'releaseNameMatching',
  source: 'src/utils/release-name-matching.ts',
  artifact: 'dist/src/utils/release-name-matching.js',
  corpus: 'scripts/golden/corpus-release-name-matching.json',
  outJsonl: 'rust/golden/release-name-matching.jsonl',
  outManifest: 'rust/golden/release-name-matching.manifest.json',
  resolve: async () => {
    const mod = await import(pathToFileURL(path.join(REPO, 'dist/src/utils/release-name-matching.js')).href);
    const bit = (v) => (v ? '1' : '0');
    return (input) => {
      const c = JSON.parse(input);
      switch (c.op) {
        case 'matches':
          return bit(mod.matchesName(c.title, c.name, c.tokens ?? null));
        case 'coverage':
          return mod.nameCoverageTokens(c.name).join(' ');
        case 'multiWork':
          return bit(mod.isMultiWorkCollection(c.title));
        case 'root':
          return mod.franchiseRoot(c.title);
        case 'roots':
          return JSON.stringify(mod.franchiseRoots(c.names ?? []));
        case 'endsSeq':
          return bit(mod.endsWithSequenceMarker(c.title));
        case 'run':
          return bit(mod.containsTokenRun(c.title, c.root));
        default:
          throw new Error(`op desconhecida: ${c.op}`);
      }
    };
  },
};
