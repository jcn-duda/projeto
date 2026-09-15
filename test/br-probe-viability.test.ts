// C4/C8 da auditoria: `found` da sonda só de evidência NOVA e viável (upgrade
// exige a faixa alvo; ausência exige seeders>0) e coalescing da colheita em voo
// (sonda que chega durante a colheita da MESMA obra não cria segunda entrada).
// Sem rede real: só o `fetch` é dublê (o `jackett.search` do coalescing é
// substituído); o worker roda o de produção.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import config from '../src/config.js';
import * as cache from '../src/utils/cache.js';
import * as brProbe from '../src/providers/br-probe.js';
import * as harvestQueue from '../src/providers/harvest-queue.js';
import harvester from '../src/providers/harvester.js';
import * as harvesterLive from '../src/utils/harvester-live.js';
import * as autofetchLive from '../src/utils/autofetch-live.js';
import * as releaseIndex from '../src/utils/release-index.js';
import * as metrics from '../src/utils/metrics.js';
import jackett from '../src/providers/jackett.js';
import { stubFetch } from './helpers/stub.js';

const MOVIE = 'tt0107953';
const work = { type: 'movie' as const, imdbId: MOVIE, season: null, episode: null };

function setup() {
  const saved: any = {};
  for (const key of ['indexOnlyIndexers', 'ptBrIndexers', 'indexers', 'apiKey', 'ptSweepGlobal', 'breakerFailures'] as const) {
    saved[key] = (config.jackett as any)[key];
  }
  saved.tmdbApiKey = config.tmdb.apiKey;
  saved.releaseIndex = config.releaseIndex.enabled;
  saved.idleWindowMs = config.harvest.idleWindowMs;
  saved.indexerDelayMs = config.harvest.indexerDelayMs;

  config.jackett.indexOnlyIndexers = ['probe-idx'];
  config.jackett.ptBrIndexers = ['probe-idx'];
  config.jackett.indexers = ['probe-idx'];
  config.jackett.apiKey = 'fake-key';
  config.jackett.ptSweepGlobal = false;
  config.tmdb.apiKey = 'fake-key';
  config.releaseIndex.enabled = true;
  config.harvest.idleWindowMs = 0;
  config.harvest.indexerDelayMs = 0;
  autofetchLive.reset();
  harvesterLive.reset();
  cache.clear();
  harvestQueue.clearQueue();
  return saved;
}

function restore(saved: any) {
  for (const key of ['indexOnlyIndexers', 'ptBrIndexers', 'indexers', 'apiKey', 'ptSweepGlobal', 'breakerFailures'] as const) {
    (config.jackett as any)[key] = saved[key];
  }
  config.tmdb.apiKey = saved.tmdbApiKey;
  config.releaseIndex.enabled = saved.releaseIndex;
  config.harvest.idleWindowMs = saved.idleWindowMs;
  config.harvest.indexerDelayMs = saved.indexerDelayMs;
  autofetchLive.reset();
  harvesterLive.reset();
  cache.clear();
  harvestQueue.clearQueue();
}

const tmdbBody = (title: string, original: string) => ({
  movie_results: [{ id: 1, title, original_title: original, release_date: '2011-06-16' }],
  tv_results: [],
});

function netStub(jackettHandler: (url: string) => any) {
  return stubFetch((url: string) => {
    if (url.includes('api.themoviedb.org')) return { ok: true, status: 200, json: async () => tmdbBody('Probe Movie', 'Probe Movie') };
    if (url.includes('/api/v2.0/indexers/')) return jackettHandler(url);
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

const emptyJackett = () => ({ ok: true, status: 200, json: async () => ({ Results: [] }) });
const brResult = (title: string, hex: string) => ({
  ok: true,
  status: 200,
  json: async () => ({
    Results: [{ Title: title, Seeders: 5, Category: [2000], MagnetUri: `magnet:?xt=urn:btih:${hex}&dn=${encodeURIComponent(title)}` }],
  }),
});
const brResultSeeders = (title: string, hex: string, seeders: number) => ({
  ok: true,
  status: 200,
  json: async () => ({
    Results: [{ Title: title, Seeders: seeders, Category: [2000], MagnetUri: `magnet:?xt=urn:btih:${hex}&dn=${encodeURIComponent(title)}` }],
  }),
});

function meta() {
  cache.set(`meta:movie:${MOVIE}`, { name: 'Probe Movie', year: '2011', type: 'movie' }, 3600);
}

test('found exige evidência NOVA: BR antiga 0 seeders + resposta vazia = empty, nunca found', async () => {
  const s = setup();
  try {
    meta();
    // Índice já tem BR dublada ANTIGA, sem seeders — não serve de prova nova.
    releaseIndex.record(MOVIE, {}, [
      { title: 'Probe Movie 2011 720p DUBLADO', infoHash: 'aa'.repeat(20), seeders: 0, isBr: true, indexer: 'redetorrent' },
    ], {});
    const ok = netStub(emptyJackett);
    try {
      brProbe.requestBrProbe(work);
      await harvester.tick();
      assert.equal(brProbe.__probeStateForTest(work), 'empty', 'resposta válida sem BR nova vira empty');
      assert.equal(brProbe.probeBlocksSeeds(work), false, 'empty libera seeds');
    } finally {
      ok.restore();
    }
  } finally {
    restore(s);
  }
});

test('upgrade exige a faixa alvo: sonda que só acha 720p novo finaliza empty (found.unviable)', async () => {
  const s = setup();
  try {
    meta();
    releaseIndex.record(MOVIE, {}, [
      { title: 'Probe Movie 2011 720p DUBLADO', infoHash: 'aa'.repeat(20), seeders: 5, isBr: true, indexer: 'redetorrent' },
    ], {});
    const before = metrics.snapshot().counters['autofetch.brProbe.found.unviable'] || 0;
    const stub = netStub(() => brResult('Probe Movie 2011 720p DUBLADO', 'bb'.repeat(20)));
    try {
      brProbe.requestBrProbe(work);
      await harvester.tick();
      assert.equal(brProbe.__probeStateForTest(work), 'empty', '720p novo não fecha o upgrade de 1080p');
      assert.ok((metrics.snapshot().counters['autofetch.brProbe.found.unviable'] || 0) > before, 'conta found.unviable');
    } finally {
      stub.restore();
    }
  } finally {
    restore(s);
  }
});

test('BR nova sem seeders (0) não fecha found — conta unviable e finaliza empty', async () => {
  const s = setup();
  try {
    meta();
    const before = metrics.snapshot().counters['autofetch.brProbe.found.unviable'] || 0;
    const stub = netStub(() => brResultSeeders('Probe Movie 2011 1080p DUBLADO', 'cc'.repeat(20), 0));
    try {
      brProbe.requestBrProbe(work);
      await harvester.tick();
      assert.equal(brProbe.__probeStateForTest(work), 'empty', 'placeholders BR usam 1; 0 é inviável');
      assert.ok((metrics.snapshot().counters['autofetch.brProbe.found.unviable'] || 0) > before, 'conta found.unviable');
    } finally {
      stub.restore();
    }
  } finally {
    restore(s);
  }
});

test('coalescing: sonda que chega durante a colheita não cria segunda entrada', async () => {
  const s = setup();
  const originalSearch = jackett.search;
  try {
    meta();
    harvestQueue.clearQueue();
    harvestQueue.enqueue({ imdbId: MOVIE, type: 'movie', season: null, episode: null, reason: 'popular' });
    let calls = 0;
    const stub = netStub(emptyJackett);
    jackett.search = (async () => {
      calls += 1;
      if (calls === 1) brProbe.requestBrProbe(work); // chega DURANTE a colheita regular
      return [];
    }) as typeof jackett.search;
    try {
      await harvester.tick();
      assert.equal(calls, 1, 'uma única colheita — a sonda coalesceu na obra em voo');
      assert.equal(harvestQueue.depth(), 0, 'nenhuma segunda entrada na fila');
      assert.equal(brProbe.__probeStateForTest(work), 'empty', 'a colheita completa finalizou o estado');
    } finally {
      jackett.search = originalSearch;
      stub.restore();
    }
  } finally {
    restore(s);
  }
});
