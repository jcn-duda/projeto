#!/usr/bin/env node
/**
 * Materializa os corpus do golden de cache:
 *   - scripts/golden/corpus-cache-keys.json
 *   - scripts/golden/corpus-cache-quotas.json
 *
 * Os casos são DERIVADOS do `dist` vivo (toda entrada de `NAMESPACE_VERSIONS` e
 * toda entrada de `QUOTAS` ganha caso), então adicionar um namespace no fonte
 * automaticamente amplia a cobertura do golden — e o `sourceSha256` do manifest
 * obriga a regenerar. O `expected` NÃO entra aqui: quem calcula é o oráculo em
 * `gen-cache.mjs`.
 *
 * Uso: `node scripts/golden/build-corpus-cache.mjs`
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import cacheKeys from './registry-cache-keys.mjs';
import cacheQuotas from './registry-cache-quotas.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const abs = (rel) => path.join(REPO, rel);

const HEADER = {
  [cacheKeys.corpus]: {
    version: 'corpus-cache-keys/1',
    note:
      'Casos de cache-keys.ts: NAMESPACE_VERSIONS (op versions), LEGACY_PREFIXES (op legacy), prefix() (op prefix), magMetaCountsKey() (op magmeta) e a composição de chave dos chamadores (op key). Namespace ausente da tabela não tem caso: o TS montaria ns:undefined:, o porte devolve vazio de propósito.',
  },
  [cacheQuotas.corpus]: {
    version: 'corpus-cache-quotas/1',
    note:
      'Casos de cache-quotas.ts: QUOTAS (op quotas), MAX_ENTRIES (op max), quotaFor (op quota), namespaceFor (op namespace) e a conta do universo que test/cache-namespaces.test.ts faz (ops universe/validate). incrementNamespace/removeFromStore/quotaOverflow dependem do store LRU e não têm caso.',
  },
};

async function writeCorpus(entry, cases) {
  const ids = new Set();
  for (const c of cases) {
    if (ids.has(c.id)) throw new Error(`id duplicado no corpus: ${c.id}`);
    ids.add(c.id);
  }
  const body = { ...HEADER[entry.corpus], cases };
  const out = abs(entry.corpus);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, Buffer.from(`${JSON.stringify(body, null, 2)}\n`, 'utf8'));
  console.log(`[corpus] ${entry.corpus}: ${cases.length} casos`);
}

async function main() {
  await writeCorpus(cacheKeys, await cacheKeys.cases());
  await writeCorpus(cacheQuotas, await cacheQuotas.cases());
}

main().catch((e) => {
  console.error(`[corpus] FALHA: ${e?.stack || e?.message || String(e)}`);
  process.exit(1);
});
