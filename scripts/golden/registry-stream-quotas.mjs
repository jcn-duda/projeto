/**
 * Entrada de registro do golden de `src/utils/stream-quotas.ts` (só
 * `limitByIndexer`: as demais funções dependem de `streamQuality`, que ainda não
 * foi portado, ou de `dropTrace`/`onSelected`). Para entrar no `FUNCTIONS` de
 * dump-title-normalization.mjs (linha de import + chave), ver o gerador
 * `gen-stream-quotas.mjs`, que consome esta mesma entrada.
 *
 * Entrada JSON com `op: "indexer"`: `streams` (lista de `{indexer}`, mapeado
 * para `_indexer`), `maxPerIndexer`, `exempt` (índices de `streams`, viram o
 * Set de identidade do TS) e `indexerLimits`. Saída: JSON com os índices
 * mantidos, na ordem original.
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export default {
  id: 'stream-quotas/indexer',
  name: 'limitByIndexer',
  source: 'src/utils/stream-quotas.ts',
  artifact: 'dist/src/utils/stream-quotas.js',
  corpus: 'scripts/golden/corpus-stream-quotas.json',
  outJsonl: 'rust/golden/stream-quotas.jsonl',
  outManifest: 'rust/golden/stream-quotas.manifest.json',
  resolve: async () => {
    const mod = await import(pathToFileURL(path.join(REPO, 'dist/src/utils/stream-quotas.js')).href);
    return (input) => {
      const c = JSON.parse(input);
      if (c.op !== 'indexer') throw new Error(`op desconhecida: ${c.op}`);
      const streams = c.streams.map((s) => ({ _indexer: s.indexer ?? null }));
      const exempt = new Set((c.exempt ?? []).map((i) => {
        if (!streams[i]) throw new Error(`exempt fora do intervalo: ${i}`);
        return streams[i];
      }));
      const kept = mod.limitByIndexer(streams, c.maxPerIndexer ?? 0, exempt, c.indexerLimits ?? {});
      return JSON.stringify(kept.map((s) => streams.indexOf(s)));
    };
  },
};
