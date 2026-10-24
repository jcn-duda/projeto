// Integração real do índice ao corte final:
//  1. `harvestOne` dispara a invalidação de streams quando a colheita faz o
//     índice transicionar a BR dublado comprovado;
//  2. release do índice (`idxReleasesToRaw`) BR dublada com 0 seeders sobrevive
//     ao piso no `sortAndLimit`, marcada para que o download siga exigindo
//     swarm.
//
// R4: o ciclo br-gap da via antiga (`attemptIndexFastPath`) saiu com o módulo
// `search-index-path` — o índice é NATIVO e o enqueue br-gap mora no Rust.
// Aqui ficam só os elos que ainda são do Node (índice TS + worker).
// Os módulos são OS REAIS (release-index, harvest-queue, metrics): só a rede é
// falsa.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import config from '../src/config.js';
import * as cache from '../src/utils/cache.js';
import { prefix } from '../src/utils/cache-keys.js';
import * as metrics from '../src/utils/metrics.js';
import * as releaseIndex from '../src/utils/release-index.js';
import * as harvestQueue from '../src/providers/harvest-queue.js';
import * as harvestWorker from '../src/providers/harvest-worker.js';
import * as harvesterLive from '../src/utils/harvester-live.js';
import { idxReleasesToRaw } from '../src/providers/search-pool-coverage.js';
import { hasBrDubbed } from '../src/utils/br-gap.js';
import { sortAndLimit, toStremioStream } from './helpers/pipeline-oracle/format.js';
import { stubFetch } from './helpers/stub.js';
import { flushNativeStreamStores } from '../src/utils/streams-store-native.js';
import { createStreamsBridge } from './helpers/streams-bridge.js';
import type { RawItem } from '../types/domain.js';

const counter = (key: string) => metrics.snapshot().counters[key] || 0;
const deltaOf = (key: string) => {
  const beforeCount = counter(key);
  return () => counter(key) - beforeCount;
};

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
    assert.equal(br._dubClaim, true, 'e declara dublado (claim)');
    assert.equal(br._dubbed, false, 'sem fileEvidence ainda');

    const out = sortAndLimit(streams, { minSeeders: 1, maxResults: 20 });
    const waivered = out.find((s: any) => s.infoHash === br.infoHash);
    assert.equal(waivered != null, true, '0 seeders não mata a BR com claim vinda do índice');
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
  const handler = (url: string) => {
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
  };
  const stub = stubFetch(handler);
  const OBRA = 'tt9500061';
  // A lista pronta da obra vive no `streams.db` (F4.2(c)): o canário da
  // transição BR é o pedido de invalidação chegar à ponte e a entrada cair.
  const streamKey = `${prefix('streams')}movie:${OBRA}:{}:account:a`;
  const bridge = createStreamsBridge({
    entries: [{ type: 'movie', id: OBRA, key: streamKey, cache: { partial: false } }],
    onOther: handler,
  });
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
    assert.equal(dInvalidated(), 1, 'o pedido de invalidação da obra foi feito');
    await flushNativeStreamStores();
    assert.equal(bridge.has(streamKey), false, 'lista pronta descartada no streams.db');
    assert.equal(hasBrDubbed(releaseIndex.lookupQuiet(OBRA, {})), true, 'o índice passou a cobrir BR dublado');
  } finally {
    bridge.restore();
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
