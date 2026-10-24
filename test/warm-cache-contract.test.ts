// Contrato SEM REDE do diagnóstico (Fase 5): `peekRawFor` e o recompute do
// trace SÓ podem ler o que está quente no cache local. Cada teste prova três
// coisas: zero `fetch`, zero `jackett.search` e zero efeito de leitura no L1
// (sem promote de LRU, sem `cache.hit`/`cache.miss`).
//
// O escritor do raw (`queryIndexer`) grava o ENVELOPE `{ items }`; o leitor
// aceitou só array cru por uma fatia inteira e o recompute perdia a base `raw`
// em silêncio. O teste 1 usa a busca REAL (fetch falso) para travar o formato
// do ESCRITOR — semear o shape "certo" à mão esconderia a divergência.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import config from '../src/config.js';
import jackett from '../src/providers/jackett.js';
import * as cache from '../src/utils/cache.js';
import * as metrics from '../src/utils/metrics.js';
import * as runtime from '../src/runtime.js';
import { recomputeOffline } from '../src/utils/trace-recompute.js';

const HASH = 'f'.repeat(40);
const RAW_PREFIX = 'raw:v1:jackett:';

function seededItem(title = 'Filme.2020.1080p.DUAL') {
  return { title, infoHash: HASH, seeders: 4, indexer: 'x', size: 1024 };
}

/** Qualquer rede aqui é falha do contrato, não resultado a tolerar. */
function fetchThatMustNotRun(): typeof globalThis.fetch {
  return (() => {
    throw new Error('fetch chamado num caminho que deveria ser cache-only');
  }) as unknown as typeof globalThis.fetch;
}

function liveJackettFetch(calls: { n: number }): typeof globalThis.fetch {
  return (async () => {
    calls.n += 1;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        Results: [
          {
            Title: 'Predador (1987) 1080p DUBLADO',
            Seeders: 3,
            MagnetUri: `magnet:?xt=urn:btih:${HASH}`,
            InfoHash: HASH,
          },
        ],
      }),
      text: async () => '',
    };
  }) as unknown as typeof globalThis.fetch;
}

/** Config de Jackett + cache limpos; restaura fetch, busca e url no fim. */
async function withMockJackett(
  fetchImpl: typeof globalThis.fetch,
  fn: () => Promise<void> | void,
): Promise<void> {
  const realFetch = globalThis.fetch;
  const realSearch = jackett.search;
  const saved = { url: config.jackett.url, apiKey: config.jackett.apiKey };
  config.jackett.url = 'http://jackett.test';
  config.jackett.apiKey = 'test-key';
  globalThis.fetch = fetchImpl;
  cache.clear();
  metrics.reset();
  try {
    await fn();
  } finally {
    cache.clear();
    globalThis.fetch = realFetch;
    jackett.search = realSearch;
    config.jackett.url = saved.url;
    config.jackett.apiKey = saved.apiKey;
  }
}

/** Trava rede: fetch lança e `jackett.search` lança. */
async function withNoNetwork(fn: () => void | Promise<void>): Promise<void> {
  const realFetch = globalThis.fetch;
  const realSearch = jackett.search;
  globalThis.fetch = fetchThatMustNotRun();
  jackett.search = () => {
    throw new Error('jackett.search chamado num caminho cache-only');
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
    jackett.search = realSearch;
  }
}

function cacheCounters() {
  return metrics.snapshot().counters;
}

test('peekRawFor lê o envelope { items } que a busca grava — sem fetch, hit ou LRU', async () => {
  const calls = { n: 0 };
  await withMockJackett(liveJackettFetch(calls), async () => {
    const found = await jackett.search('Predador 1987', 'movie', ['comandotorrents'], {
      matchContext: { names: ['Predador', 'Predator'], year: 1987, isSeries: false, season: null, episode: null },
    });
    assert.equal(found.length, 1, 'a busca ao vivo gravou o item');
    assert.equal(calls.n, 1);

    await withNoNetwork(() => {
      metrics.reset();
      const orderBefore = cache.keysMatching(RAW_PREFIX);
      const raw = jackett.peekRawFor(['comandotorrents'], 'Predador 1987', 'movie');
      const orderAfter = cache.keysMatching(RAW_PREFIX);

      assert.equal(raw.length, 1, 'envelope { items } do ESCRITOR é legível');
      assert.equal(String(raw[0].infoHash).toLowerCase(), HASH);
      assert.deepEqual(orderAfter, orderBefore, 'peek não promove LRU');
      assert.equal(cacheCounters()['cache.hit'] ?? 0, 0, 'peek não conta hit');
      assert.equal(cacheCounters()['cache.miss'] ?? 0, 0, 'peek não conta miss');
    });
  });
});

test('peekRawFor aceita array legado e ignora valor fora do contrato', async () => {
  await withMockJackett(fetchThatMustNotRun(), async () => {
    await withNoNetwork(() => {
      const key = jackett.rawKeysFor(['idx'], 'Filme 2020', 'movie')[0];

      cache.set(key, [seededItem()], 60);
      assert.equal(
        jackett.peekRawFor(['idx'], 'Filme 2020', 'movie').length,
        1,
        'array legado continua legível',
      );

      cache.set(key, { items: [seededItem(), seededItem('Outro')] }, 60);
      assert.equal(
        jackett.peekRawFor(['idx'], 'Filme 2020', 'movie').length,
        2,
        'envelope devolve todos os itens',
      );

      cache.set(key, { items: 'não é lista' }, 60);
      assert.equal(
        jackett.peekRawFor(['idx'], 'Filme 2020', 'movie').length,
        0,
        'lixo não vira item',
      );
    });
  });
});

test('recompute só lê cache quente: sem fetch, sem Jackett, sem hit e sem LRU', async () => {
  cache.clear();
  const usedKey = jackett.rawKeysFor(['torrentleech'], 'Filme 2020', 'movie')[0];
  const otherKey = jackett.rawKeysFor(['torrentleech'], 'Outro 2019', 'movie')[0];
  // Envelope do escritor de produção: é o que o recompute precisa enxergar.
  cache.set(usedKey, { items: [seededItem('Filme.2020.1080p.DUAL')] }, 900);
  cache.set(otherKey, { items: [] }, 900);

  // `defaults()` lê a config viva do autofetch com `cache.get` (miss esperado
  // na primeira leitura). É SETUP do contexto, não leitura do recompute: montar
  // antes do reset impede que a contabilidade do setup vire "miss do funil".
  const ctx = { opts: { ...runtime.defaults(), jackettIndexers: ['torrentleech'] }, encoded: 'diag' };

  await withNoNetwork(() => {
    const orderBefore = cache.keysMatching(RAW_PREFIX);
    metrics.reset();
    const out = runtime.run(ctx, () =>
      recomputeOffline('tt123', { season: null, episode: null }, ['Filme'], 2020),
    ) as ReturnType<typeof recomputeOffline>;
    const orderAfter = cache.keysMatching(RAW_PREFIX);

    assert.equal(out.built, true, 'matéria-prima quente vira itens');
    assert.ok(out.basis.includes('raw'), `basis deveria incluir raw: ${out.basis}`);
    assert.equal(out.items.length, 1);
    assert.equal(out.items[0].now.state, 'tocável');
    assert.deepEqual(orderAfter, orderBefore, 'recompute não promove LRU');
    assert.equal(cacheCounters()['cache.hit'] ?? 0, 0, 'recompute não conta hit');
    assert.equal(cacheCounters()['cache.miss'] ?? 0, 0, 'recompute não conta miss');
  });
});
