// C4/C8 da auditoria: `found` da sonda só de evidência NOVA e viável (upgrade
// exige a faixa alvo; ausência exige seeders>0) e coalescing da colheita em voo
// (sonda que chega durante a colheita da MESMA obra não cria segunda entrada).
// Sem rede real: só o `fetch`/`jackett.search` de coalescing é dublê; o worker
// roda o de produção.
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
import * as harvestWorker from '../src/providers/harvest-worker.js';
import * as activity from '../src/providers/activity.js';
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
test('item aberto 8: pedido comum durante colheita regular roda UMA vez e esvazia a fila no sucesso', async () => {
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
      if (calls === 1) {
        harvestQueue.enqueue({ imdbId: MOVIE, type: 'movie', season: null, episode: null, reason: 'miss' });
      }
      return [];
    }) as typeof jackett.search;
    try {
      await harvester.tick();
      assert.equal(calls, 1, 'uma única colheita — o pedido comum coalesceu na obra em voo');
      assert.equal(harvestQueue.depth(), 0, 'a execução completa satisfez o pedido coalescido');
    } finally {
      jackett.search = originalSearch;
      stub.restore();
    }
  } finally {
    restore(s);
  }
});

test('item aberto 8: capped devolve UMA entrada com o motivo mais forte fundido', async () => {
  const s = setup();
  const originalSearch = jackett.search;
  // `maxPerHour` não é gerenciado pelo setup daqui — sem restaurar, o teto vaza.
  const savedMaxPerHour = config.harvest.maxPerHour;
  try {
    meta();
    config.jackett.indexers = ['cap-a', 'cap-b'];
    config.jackett.indexOnlyIndexers = [];
    config.harvest.maxPerHour = harvestWorker.queriesThisHour() + 1; // 1ª consulta roda, 2ª bate teto
    harvestQueue.clearQueue();
    harvestQueue.enqueue({ imdbId: MOVIE, type: 'movie', season: null, episode: null, reason: 'miss' });
    let calls = 0;
    const stub = netStub(emptyJackett);
    jackett.search = (async () => {
      calls += 1;
      if (calls === 1) {
        harvestQueue.enqueue({ imdbId: MOVIE, type: 'movie', season: null, episode: null, reason: 'next-episode' });
      }
      return [];
    }) as typeof jackett.search;
    try {
      await harvester.tick();
      const fila = harvestQueue.preview(10).filter((e) => e.imdbId === MOVIE);
      assert.equal(fila.length, 1, 'a obra cortada volta como UMA entrada, sem duplicar o pedido');
      assert.equal(fila[0].reason, 'next-episode', 'motivo de maior precedência fundido');
    } finally {
      jackett.search = originalSearch;
      stub.restore();
    }
  } finally {
    config.harvest.maxPerHour = savedMaxPerHour;
    restore(s);
  }
});

test('item aberto 8: preempção devolve UMA entrada com o motivo fundido e preserva resumed', async () => {
  const s = setup();
  const originalSearch = jackett.search;
  try {
    meta();
    config.jackett.indexers = ['pre-a', 'pre-b'];
    config.jackett.indexOnlyIndexers = [];
    config.harvest.idleWindowMs = 60_000;
    harvestQueue.clearQueue();
    harvestQueue.enqueue({ imdbId: MOVIE, type: 'movie', season: null, episode: null, reason: 'popular' });
    let calls = 0;
    const stub = netStub(emptyJackett);
    jackett.search = (async () => {
      calls += 1;
      if (calls === 1) {
        // Tráfego chega no meio da obra: a 2ª consulta é barrada (preempção).
        activity.noteUserRequest();
        harvestQueue.enqueue({ imdbId: MOVIE, type: 'movie', season: null, episode: null, reason: 'next-episode' });
      }
      return [];
    }) as typeof jackett.search;
    try {
      await harvester.tick();
      assert.equal(calls, 1, 'a preempção barra a consulta seguinte');
      const fila = harvestQueue.preview(10).filter((e) => e.imdbId === MOVIE);
      assert.equal(fila.length, 1, 'uma única entrada devolvida');
      assert.equal(fila[0].reason, 'next-episode', 'o motivo mais forte viaja com a obra');
      assert.equal(fila[0].resumed, true, 'a obra retomada é marcada para o painel');
    } finally {
      jackett.search = originalSearch;
      stub.restore();
    }
  } finally {
    restore(s);
  }
});

test('item aberto 8: run dirigido NÃO satisfaz pedido completo coalescido — volta como miss', async () => {
  const s = setup();
  try {
    meta();
    harvestQueue.clearQueue();
    let first = true;
    const stub = netStub(() => {
      if (first) {
        first = false;
        harvestQueue.enqueue({ imdbId: MOVIE, type: 'movie', season: null, episode: null, reason: 'miss' });
      }
      return emptyJackett();
    });
    const before = metrics.snapshot().counters['harvest.coalesced.full-requeued'] || 0;
    try {
      brProbe.requestBrProbe(work);
      await harvester.tick();
      assert.equal(brProbe.probeBlocksSeeds(work), false, 'a sonda finalizou (o run dirigido rodou)');
      const fila = harvestQueue.preview(10).filter((e) => e.imdbId === MOVIE);
      assert.equal(fila.length, 1, 'o pedido completo continua na fila como UMA entrada');
      assert.equal(fila[0].reason, 'miss', 'o subset dirigido não cobre a colheita completa');
      assert.equal(fila[0].brProbe, undefined, 'a sonda já finalizou; o resíduo é colheita completa');
      assert.ok((metrics.snapshot().counters['harvest.coalesced.full-requeued'] || 0) > before, 'conta o reencaminhamento');
    } finally {
      stub.restore();
    }
  } finally {
    restore(s);
  }
});

test('item aberto 8: run dirigido CORTADO pelo teto reencaminha o pedido FULL (não rebaixa a dirigida)', async () => {
  const s = setup();
  // `maxPerHour` não é gerenciado pelo setup daqui — sem restaurar, o teto vaza.
  const savedMaxPerHour = config.harvest.maxPerHour;
  try {
    meta();
    // Espelha o capped de br-probe-worker: teto em `queriesThisHour()+1`,
    // fixado ANTES do tick (o worker captura o teto vivo) — a 2ª bate.
    config.harvest.maxPerHour = Math.max(1, harvestWorker.queriesThisHour() + 1);
    config.jackett.indexOnlyIndexers = ['cap-a', 'cap-b'];
    config.jackett.ptBrIndexers = ['cap-a', 'cap-b'];
    harvestQueue.clearQueue();
    let first = true;
    const stub = netStub(() => {
      if (first) {
        first = false;
        harvestQueue.enqueue({ imdbId: MOVIE, type: 'movie', season: null, episode: null, reason: 'miss' });
      }
      return emptyJackett();
    });
    try {
      brProbe.requestBrProbe(work);
      await harvester.tick();
      assert.equal(brProbe.__probeStateForTest(work), 'capped', 'o teto finaliza a sonda como capped');
      const fila = harvestQueue.preview(10).filter((e) => e.imdbId === MOVIE);
      assert.equal(fila.length, 1, 'UMA entrada devolvida');
      assert.equal(fila[0].reason, 'miss', 'o pedido FULL sobrevive ao teto');
      assert.equal(fila[0].brProbe, undefined, 'e NÃO vira retry dirigido — isso rebaixaria a colheita');
      assert.ok((metrics.snapshot().counters['harvest.coalesced.full-kept'] || 0) > 0, 'conta a preservação');
    } finally {
      stub.restore();
    }
  } finally {
    config.harvest.maxPerHour = savedMaxPerHour;
    restore(s);
  }
});

test('item aberto 8: run dirigido PREEMPTADO com pedido coalescido devolve UMA entrada FULL', async () => {
  const s = setup();
  const originalSearch = jackett.search;
  try {
    meta();
    // Dois alvos dirigidos: a 1ª consulta roda (FULL coalesce + tráfego) e a 2ª
    // é barrada. `jackett.search` é substituído para contar CONSULTAS (o search
    // real abre o degrau do título sem ano nos BR e confundiria a contagem).
    config.jackett.indexOnlyIndexers = ['pre-a', 'pre-b'];
    config.jackett.ptBrIndexers = ['pre-a', 'pre-b'];
    config.harvest.idleWindowMs = 60_000;
    harvestQueue.clearQueue();
    let calls = 0;
    const stub = netStub(emptyJackett);
    jackett.search = (async () => {
      calls += 1;
      if (calls === 1) {
        harvestQueue.enqueue({ imdbId: MOVIE, type: 'movie', season: null, episode: null, reason: 'next-episode' });
        activity.noteUserRequest();
      }
      return [];
    }) as typeof jackett.search;
    try {
      brProbe.requestBrProbe(work);
      await harvester.tick();
      assert.equal(calls, 1, 'a preempção barra a consulta seguinte');
      const fila = harvestQueue.preview(10).filter((e) => e.imdbId === MOVIE);
      assert.equal(fila.length, 1, 'UMA entrada devolvida');
      assert.equal(fila[0].reason, 'next-episode', 'o pedido mais forte (play real) vence o retorno');
      assert.equal(fila[0].brProbe, undefined, 'sem a flag dirigida — a colheita completa cobre o subset');
      assert.equal(fila[0].resumed, true, 'e a obra retomada é marcada para o painel');
    } finally {
      jackett.search = originalSearch;
      stub.restore();
    }
  } finally {
    restore(s);
  }
});
