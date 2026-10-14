/**
 * Entrada de registro do golden de `src/utils/multiwork-pack.ts`. Para entrar
 * no `FUNCTIONS` de dump-title-normalization.mjs (linha de import + chave),
 * ver o gerador `gen-multiwork-pack.mjs`, que consome esta mesma entrada.
 *
 * Entrada JSON com `op`: root (collectionRoot), rootTokens (collectionRootTokens
 * em lista unida por espaço), covers (coversYear, 1/0), evidence (packYearSource,
 * texto) e admits (admitsMultiWorkPack, 1/0). `item` é o RawItem (pode ser null);
 * `year` pode ser número, texto ou null, como no TS.
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export default {
  id: 'multiwork-pack/admission',
  name: 'multiWorkPack',
  source: 'src/utils/multiwork-pack.ts',
  artifact: 'dist/src/utils/multiwork-pack.js',
  corpus: 'scripts/golden/corpus-multiwork-pack.json',
  outJsonl: 'rust/golden/multiwork-pack.jsonl',
  outManifest: 'rust/golden/multiwork-pack.manifest.json',
  resolve: async () => {
    const mod = await import(pathToFileURL(path.join(REPO, 'dist/src/utils/multiwork-pack.js')).href);
    const bit = (v) => (v ? '1' : '0');
    return (input) => {
      const c = JSON.parse(input);
      const yearText = c.year === undefined || c.year === null ? null : c.year;
      switch (c.op) {
        case 'root':
          return mod.collectionRoot(c.name);
        case 'rootTokens':
          return mod.collectionRootTokens(c.name).join(' ');
        case 'covers':
          return bit(mod.coversYear(c.text, yearText));
        case 'evidence':
          return mod.packYearSource(c.item ?? null);
        case 'admits':
          return bit(mod.admitsMultiWorkPack(c.item ?? null, {
            multiWork: c.multiWork ?? null,
            year: yearText,
            isSeries: c.isSeries === true,
            names: c.names ?? [],
          }));
        default:
          throw new Error(`op desconhecida: ${c.op}`);
      }
    };
  },
};
