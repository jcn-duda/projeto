// Contrato SEM REDE do diagnóstico (Fase 5): o recompute do trace SÓ pode ler o
// que está quente no store local. O teste prova três coisas: zero `fetch`, zero
// efeito no L1 do Node (o `raw` é RUST_OWNED — não há nem o que promover) e
// sem `cache.hit`/`cache.miss`.
//
// O ESCRITOR do raw (`queryIndexer` + a moldura de `jackett-query.ts`) saiu com a
// pilha TS do Jackett; o leitor ficou (`utils/trace-recompute.ts`, que mantém a
// própria moldura) e lê pela ponte napi (`raw-store-native.ts`). A chave é
// semeada pelo MESMO caminho do leitor, com o formato legado
// `raw:v1:jackett:<indexer>:<type>:<query>` — o que se testa aqui é o LEITOR.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as cache from '../src/utils/cache.js';
import * as metrics from '../src/utils/metrics.js';
import * as runtime from '../src/runtime.js';
import { recomputeOffline } from '../src/utils/trace-recompute.js';
import { rawSetForTest, rawStore } from '../src/utils/raw-store-native.js';

const HASH = 'f'.repeat(40);
const RAW_PREFIX = 'raw:v1:jackett:';

function seededItem(title = 'Filme.2020.1080p.DUAL') {
  return { title, infoHash: HASH, seeders: 4, indexer: 'x', size: 1024 };
}

/** Chave do raw como o escritor legado gravava (`jackett-query.rawKeysFor`). */
function rawKey(indexer: string, query: string, type = 'movie'): string {
  return `${RAW_PREFIX}${indexer}:${type}:${query}`;
}

/** Qualquer rede aqui é falha do contrato, não resultado a tolerar. */
function fetchThatMustNotRun(): typeof globalThis.fetch {
  return (() => {
    throw new Error('fetch chamado num caminho que deveria ser cache-only');
  }) as unknown as typeof globalThis.fetch;
}

/** Trava rede: fetch lança. */
async function withNoNetwork(fn: () => void | Promise<void>): Promise<void> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchThatMustNotRun();
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

function cacheCounters() {
  return metrics.snapshot().counters;
}

test('recompute só lê cache quente: sem fetch, sem hit e sem LRU', async () => {
  cache.clear();
  const usedKey = rawKey('torrentleech', 'Filme 2020');
  const otherKey = rawKey('torrentleech', 'Outro 2019');
  // Envelope do escritor de produção: é o que o recompute precisa enxergar.
  rawSetForTest(usedKey, { items: [seededItem('Filme.2020.1080p.DUAL')] }, 900);
  rawSetForTest(otherKey, { items: [] }, 900);

  // `defaults()` lê a config viva do autofetch com `cache.get` (miss esperado
  // na primeira leitura). É SETUP do contexto, não leitura do recompute: montar
  // antes do reset impede que a contabilidade do setup vire "miss do funil".
  const ctx = { opts: { ...runtime.defaults(), jackettIndexers: ['torrentleech'] }, encoded: 'diag' };

  await withNoNetwork(() => {
    const linesBefore = rawStore().len();
    metrics.reset();
    const out = runtime.run(ctx, () =>
      recomputeOffline('tt123', { season: null, episode: null }, ['Filme'], 2020),
    ) as ReturnType<typeof recomputeOffline>;

    assert.equal(out.built, true, 'matéria-prima quente vira itens');
    assert.ok(out.basis.includes('raw'), `basis deveria incluir raw: ${out.basis}`);
    assert.equal(out.items.length, 1);
    assert.equal(out.items[0].now.state, 'tocável');
    // L1 segue sem linha raw (dono único) e o store nativo não mudou.
    assert.deepEqual(cache.keysMatching(RAW_PREFIX), [], 'raw não sobe no L1 do Node');
    assert.equal(rawStore().len(), linesBefore, 'recompute não grava no raw');
    assert.equal(cacheCounters()['cache.hit'] ?? 0, 0, 'recompute não conta hit');
    assert.equal(cacheCounters()['cache.miss'] ?? 0, 0, 'recompute não conta miss');
  });
});
