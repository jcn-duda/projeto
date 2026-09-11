// Integração real do ciclo BR-gap, do índice ao corte final:
//  1. `attemptIndexFastPath` servido do índice SEM BR dublado enfileira no
//     colhedor com reason br-gap (dedupe por obra+razão) e conta TENTATIVA —
//     `harvester.enqueue` é fogo-e-esquece, não devolve boolean;
//  2. índice COM BR dublado não enfileira (control served);
//  3. os index-only não entram pelo caminho ao vivo (a busca servida do índice
//     consulta os BR ao vivo, nunca os index-only);
//  4. `harvestOne` dispara a invalidação de streams quando a colheita faz o
//     índice transicionar a BR dublado comprovado;
//  5. release do índice (`idxReleasesToRaw`) BR dublada com 0 seeders sobrevive
//     ao piso no `sortAndLimit`, marcada para que o download siga exigendo
//     swarm.
//
// Os módulos são OS REAIS (cache, release-index, harvest-queue, metrics,
// search-index-path, jackett via fetch dublê): só a rede é falsa.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import config from '../src/config.js';
import * as cache from '../src/utils/cache.js';
import { prefix } from '../src/utils/cache-keys.js';
import * as metrics from '../src/utils/metrics.js';
import * as runtime from '../src/runtime.js';
import * as releaseIndex from '../src/utils/release-index.js';
import * as harvestQueue from '../src/providers/harvest-queue.js';
import * as harvestWorker from '../src/providers/harvest-worker.js';
import * as harvesterLive from '../src/utils/harvester-live.js';
import { attemptIndexFastPath } from '../src/providers/search-index-path.js';
import { idxReleasesToRaw } from '../src/providers/search-pool-coverage.js';
import { hasBrDubbed } from '../src/utils/br-gap.js';
import { sortAndLimit, toStremioStream } from '../src/utils/format.js';
import { stubFetch } from './helpers/stub.js';
import type { RawItem } from '../types/domain.js';

const counter = (key: string) => metrics.snapshot().counters[key] || 0;
const deltaOf = (key: string) => {
  const beforeCount = counter(key);
  return () => counter(key) - beforeCount;
};

// O mesmo arranque da busca real: jackettIndexers com BR cards + um global +
// um index-only. `attemptIndexFastPath` corre dentro de runtime.run.
function runSearch(type: string, imdbId: string) {
  return runtime.run(
    {
      opts: {
        ...runtime.defaults(),
        providers: ['jackett'],
        jackettIndexers: ['bludv-cardigann', 'thepiratebay', 'apachetorrent', 'nerdfilmes'],
      },
      encoded: 'cfg',
    },
    () => attemptIndexFastPath({
      query: 'Test Title',
      type,
      id: imdbId,
      imdbId,
      season: null,
      episode: null,
      ptQuery: null,
      matchContext: {
        names: ['Test Title'],
        year: '2024',
        isSeries: type === 'series',
        season: null,
        episode: null,
      } as any,
      sweepQuery: null,
      deadlineAt: Date.now() + 9000,
      isDemo: false,
      firstObserver: null,
    }),
  );
}

function queueOf(imdbId: string): any[] {
  const fila = (cache.get(`${prefix('harvest')}q`) || []) as any[];
  return fila.filter((e: any) => e && e.imdbId === imdbId);
}

// Jackett DUBLÊ: indexers vazios, o resto responde 200 vazio.
function jackettVazio(url: string) {
  if (url.includes('/api/v2.0/indexers/')) {
    return { ok: true, status: 200, json: async () => ({ Results: [] }) };
  }
  return { ok: true, status: 200, json: async () => ({}) };
}

let savedApiKey = '';

before(() => {
  savedApiKey = config.jackett.apiKey;
  config.jackett.apiKey = 'fake-key';
});

after(() => {
  config.jackett.apiKey = savedApiKey;
});

function cleanUp(stub: { restore(): void }) {
  stub.restore();
  harvestQueue.clearQueue();
  cache.clear();
}

test('br-gap: índice sem BR enfileira UNA vez (dedupe), conta tentativa e não consulta index-only', async () => {
  const stub = stubFetch(jackettVazio);
  const OBRA = 'tt9000211';
  try {
    releaseIndex.record(OBRA, {}, [
      { title: 'Test Title 2024 1080p WEB-DL', infoHash: '11'.repeat(20), seeders: 120, indexer: 'thepiratebay' },
    ], {});
    harvestQueue.clearQueue();
    const dAttempt = deltaOf('search.idx.brGap.attempt');

    await runSearch('movie', OBRA);
    await runSearch('movie', OBRA);

    assert.equal(dAttempt(), 2, 'cada abertura servida do índice sem BR conta a TENTATIVA (enqueue é void)');
    const fila = queueOf(OBRA);
    assert.equal(fila.length, 1, 'o dedupe por obra+razão colapsa as duas aberturas');
    assert.equal(fila[0].reason, 'br-gap');

    // Caminho crítico: os BR cards vivos são consultados, os index-only NUNCA.
    const urls = stub.calls.map((c) => c.url);
    assert.ok(
      urls.some((u) => u.includes('/indexers/bludv-cardigann/') || u.includes('/indexers/nerdfilmes/')),
      'o BR ao vivo ainda roda sobre o índice (enriquecimento)',
    );
    for (const idx of config.jackett.indexOnlyIndexers) {
      assert.ok(!urls.some((u) => u.includes(`/indexers/${idx}/`)), `${idx} fica fora da busca viva`);
    }
  } finally {
    cleanUp(stub);
  }
});

test('br-gap: índice com BR dublado NÃO enfileira (control served)', async () => {
  const stub = stubFetch(jackettVazio);
  const OBRA = 'tt9000212';
  try {
    releaseIndex.record(OBRA, {}, [
      {
        title: 'Test Title 2024 1080p DUBLADO',
        infoHash: '22'.repeat(20),
        seeders: 1,
        isBr: true,
        indexer: 'redetorrent',
      },
    ], {});
    harvestQueue.clearQueue();
    const dAttempt = deltaOf('search.idx.brGap.attempt');
    const dServed = deltaOf('search.idx.brGap.served');

    await runSearch('movie', OBRA);

    assert.equal(dAttempt(), 0, 'com BR no índice não há tentativa de enqueue');
    assert.equal(dServed(), 1, 'o control conta served');
    assert.equal(queueOf(OBRA).length, 0, 'nada enfileirado');
  } finally {
    cleanUp(stub);
  }
});

test('índice → sortAndLimit: release BR dublada com 0 seeders sobrevive ao piso', async () => {
  const OBRA = 'tt9000213';
  try {
    releaseIndex.record(OBRA, {}, [
      {
        title: 'Test Title 2024 1080p DUBLADO',
        infoHash: '33'.repeat(20),
        seeders: 0,
        isBr: true,
        indexer: 'redetorrent',
      },
      { title: 'Test Title 2024 1080p WEB-DL', infoHash: '44'.repeat(20), seeders: 88, indexer: 'thepiratebay' },
    ], {});

    const raw = idxReleasesToRaw(releaseIndex.lookup(OBRA, {}));
    const streams = raw.map((it) => toStremioStream(it as RawItem)).filter(Boolean) as any[];
    const br = streams.find((s: any) => s._br === true);
    assert.equal(br != null, true, 'release BR nasce do índice');
    assert.equal(br._dubbed, true, 'e declara dublado');

    const out = sortAndLimit(streams, { minSeeders: 1, maxResults: 20 });
    const waivered = out.find((s: any) => s.infoHash === br.infoHash);
    assert.equal(waivered != null, true, '0 seeders não mata a BR dublada vinda do índice');
    assert.equal(waivered._seedFloorWaived, true, 'viaja marcada para que o download siga exigendo piso');
  } finally {
    cache.clear();
  }
});

const TITULO_BR_REAL = 'Event Horizon 1997 1080p BDRip DUBLADO PT BR';

test('harvestOne: transição do índice a BR dublado invalida streams da obra', async () => {
  const saved = {
    indexers: config.jackett.indexers,
    ptBrIndexers: config.jackett.ptBrIndexers,
    apiKey: config.jackett.apiKey,
    tmdbApiKey: config.tmdb.apiKey,
    maxPerHour: config.harvest.maxPerHour,
    idleWindowMs: config.harvest.idleWindowMs,
    indexerDelayMs: config.harvest.indexerDelayMs,
  };
  const stub = stubFetch((url: string) => {
    if (url.includes('api.themoviedb.org')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          movie_results: [
            { id: 1, title: 'Event Horizon', original_title: 'Event Horizon', release_date: '1997-08-15' },
          ],
          tv_results: [],
        }),
      };
    }
    if (url.includes('/api/v2.0/indexers/')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          Results: [
            {
              Title: TITULO_BR_REAL,
              Seeders: 1,
              MagnetUri: `magnet:?xt=urn:btih:${'55'.repeat(20)}&dn=Event+Horizon+1997+1080p+BDRip+DUBLADO+PT+BR`,
              Category: [2000],
            },
          ],
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  const OBRA = 'tt9500061';
  try {
    config.jackett.indexers = ['glob-br'];
    config.jackett.ptBrIndexers = [];
    config.jackett.apiKey = 'fake-key';
    config.tmdb.apiKey = 'fake-key';
    config.harvest.maxPerHour = 50;
    config.harvest.idleWindowMs = 0;
    config.harvest.indexerDelayMs = 0;
    cache.set('meta:movie:' + OBRA, { name: 'Event Horizon', year: '1997', type: 'movie' }, 3600);
    // O índice já cobria a obra SEM BR (só global EN) e a busca guardou listas.
    releaseIndex.record(OBRA, {}, [
      { title: 'Event Horizon 1997 1080p WEB-DL', infoHash: '66'.repeat(20), seeders: 40, indexer: 'thepiratebay' },
    ], {});
    cache.set(`${prefix('streams')}movie:${OBRA}:{}:account:a`, { streams: [{ name: 'x' }] }, 3600);

    const dTrans = deltaOf('harvest.transition.br');
    const dInvalidated = deltaOf('harvest.transition.br.invalidated');

    const result = await harvestWorker.harvestOne({
      imdbId: OBRA,
      type: 'movie',
      season: null,
      episode: null,
      reason: 'transição-test',
      enqueuedAt: Date.now(),
    } as any);

    assert.equal(result.ok, true, 'colheita concluída');
    assert.equal(dTrans(), 1, 'a transição a BR dublado comprovado foi detectada');
    assert.equal(dInvalidated(), 1, 'a clave de streams da obra foi invalidada');
    assert.equal(cache.get(`${prefix('streams')}movie:${OBRA}:{}:account:a`), null, 'lista pronta descartada');
    assert.equal(hasBrDubbed(releaseIndex.lookupQuiet(OBRA, {})), true, 'o índice passou a cobrir BR dublado');
  } finally {
    stub.restore();
    harvestQueue.clearQueue();
    cache.clear();
    harvesterLive.reset();
    config.jackett.indexers = saved.indexers;
    config.jackett.ptBrIndexers = saved.ptBrIndexers;
    config.jackett.apiKey = saved.apiKey;
    config.tmdb.apiKey = saved.tmdbApiKey;
    config.harvest.maxPerHour = saved.maxPerHour;
    config.harvest.idleWindowMs = saved.idleWindowMs;
    config.harvest.indexerDelayMs = saved.indexerDelayMs;
  }
});
