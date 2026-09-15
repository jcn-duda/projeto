// Fase 4 (B1/C3/C4): o worker da sonda dirigida. Cobre a observabilidade por
// consulta que distingue `[]` autoritativo de falha engolida, o `partial`
// preservado do subset, a precedência found > capped e o mapeamento do tick.
// Sem rede real: só o `fetch` é dublê (o `jackett.search` é o de produção).
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import config from '../src/config.js';
import * as cache from '../src/utils/cache.js';
import * as brProbe from '../src/providers/br-probe.js';
import * as harvestQueue from '../src/providers/harvest-queue.js';
import harvester from '../src/providers/harvester.js';
import * as harvestWorker from '../src/providers/harvest-worker.js';
import * as harvesterLive from '../src/utils/harvester-live.js';
import * as autofetchLive from '../src/utils/autofetch-live.js';
import * as releaseIndex from '../src/utils/release-index.js';
import * as activity from '../src/providers/activity.js';
import jackett from '../src/providers/jackett.js';
import { stubFetch } from './helpers/stub.js';

const MOVIE = 'tt0107953';
const work = { type: 'movie' as const, imdbId: MOVIE, season: null, episode: null };

function setup() {
  const saved: any = {};
  for (const key of ['indexOnlyIndexers', 'ptBrIndexers', 'indexers', 'apiKey', 'ptSweepGlobal', 'breakerFailures'] as const) {
    saved[key] = (config.jackett as any)[key];
  }
  saved.seedEnabled = config.seed.enabled;
  saved.tmdbApiKey = config.tmdb.apiKey;
  saved.harvestEnabled = config.harvest.enabled;
  saved.maxPerHour = config.harvest.maxPerHour;
  saved.idleWindowMs = config.harvest.idleWindowMs;
  saved.indexerDelayMs = config.harvest.indexerDelayMs;
  saved.bludv = config.bludv.enabled;
  saved.rdWarm = config.debrid.rdWarm.enabled;
  saved.releaseIndex = config.releaseIndex.enabled;

  config.jackett.indexOnlyIndexers = ['probe-idx'];
  config.jackett.ptBrIndexers = ['probe-idx'];
  config.jackett.indexers = ['probe-idx'];
  config.jackett.apiKey = 'fake-key';
  config.jackett.ptSweepGlobal = false;
  config.tmdb.apiKey = 'fake-key';
  config.seed.enabled = false;
  config.harvest.enabled = true;
  config.harvest.maxPerHour = 100;
  config.harvest.idleWindowMs = 0;
  config.harvest.indexerDelayMs = 0;
  config.bludv.enabled = false;
  config.debrid.rdWarm.enabled = false;
  config.releaseIndex.enabled = true;
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
  config.seed.enabled = saved.seedEnabled;
  config.tmdb.apiKey = saved.tmdbApiKey;
  config.harvest.enabled = saved.harvestEnabled;
  config.harvest.maxPerHour = saved.maxPerHour;
  config.harvest.idleWindowMs = saved.idleWindowMs;
  config.harvest.indexerDelayMs = saved.indexerDelayMs;
  config.bludv.enabled = saved.bludv;
  config.debrid.rdWarm.enabled = saved.rdWarm;
  config.releaseIndex.enabled = saved.releaseIndex;
  autofetchLive.reset();
  harvesterLive.reset();
  cache.clear();
  harvestQueue.clearQueue();
}

const tmdbBody = (title: string, original: string) => ({
  movie_results: [{ id: 1, title, original_title: original, release_date: '2011-06-16' }],
  tv_results: [],
});

/** Dublê do fetch: TMDB responde o que o teste mandar; o endpoint do Jackett
 *  (e o resto) segue o handler passado. */
function netStub(jackettHandler: (url: string) => any, title = 'Probe Movie', original = 'Probe Movie') {
  return stubFetch((url: string) => {
    if (url.includes('api.themoviedb.org')) return { ok: true, status: 200, json: async () => tmdbBody(title, original) };
    if (url.includes('/api/v2.0/indexers/')) return jackettHandler(url);
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

const emptyJackett = () => ({ ok: true, status: 200, json: async () => ({ Results: [] }) });
const failedJackett = () => ({ ok: false, status: 500, json: async () => ({}) });

const brResult = (title: string, hex: string) => ({
  ok: true,
  status: 200,
  json: async () => ({
    Results: [{ Title: title, Seeders: 5, Category: [2000], MagnetUri: `magnet:?xt=urn:btih:${hex}&dn=${encodeURIComponent(title)}` }],
  }),
});

function meta(name: string) {
  cache.set(`meta:movie:${MOVIE}`, { name, year: '2011', type: 'movie' }, 3600);
}

test('jackett.search reporta responded: resposta válida x falha x breaker', async () => {
  const s = setup();
  const infos: any[] = [];
  const collect = { onQueryResult: (info: any) => infos.push(info) };
  try {
    const ok = netStub(emptyJackett);
    try {
      await jackett.search('probe-q-ok', 'movie', ['probe-idx'], collect);
      assert.deepEqual(infos, [{ indexer: 'probe-idx', responded: true }], 'HTTP 200 vazio é resposta VÁLIDA');
    } finally {
      ok.restore();
    }

    // Uma falha já abre o circuito (breakerFailures=1) — a 2ª chamada nem
    // consulta e reporta breaker, que o prova de resposta precisa distinguir.
    config.jackett.breakerFailures = 1;
    const fail = netStub(failedJackett);
    try {
      infos.length = 0;
      await jackett.search('probe-q-fail', 'movie', ['probe-idx'], collect);
      assert.deepEqual(infos, [{ indexer: 'probe-idx', responded: false, reason: 'error' }], 'HTTP 500 não é resposta');
      infos.length = 0;
      await jackett.search('probe-q-breaker', 'movie', ['probe-idx'], collect);
      assert.deepEqual(infos, [{ indexer: 'probe-idx', responded: false, reason: 'breaker' }], 'circuito aberto não é resposta');
    } finally {
      fail.restore();
    }
  } finally {
    restore(s);
  }
});

test('harvestOne dirigido: resposta vazia válida é responded; HTTP 500 engolido não', async () => {
  const s = setup();
  try {
    meta('Probe Movie');
    const ok = netStub(emptyJackett);
    try {
      const r = await harvestWorker.harvestOne({ imdbId: MOVIE, type: 'movie', season: null, episode: null, reason: 'br-gap', brProbe: true } as any);
      assert.equal(r.responded, 1, 'a consulta vazia respondeu');
      assert.equal(r.ok, true);
      assert.equal(r.brFound, false);
    } finally {
      ok.restore();
    }

    // `cache.clear()` entre os dois: o vazio VÁLIDO acima ficou no cache bruto
    // e um hit seria lido como resposta, mascarando a falha.
    cache.clear();
    meta('Probe Movie');
    const fail = netStub(failedJackett);
    try {
      const r = await harvestWorker.harvestOne({ imdbId: MOVIE, type: 'movie', season: null, episode: null, reason: 'br-gap-2', brProbe: true } as any);
      assert.equal(r.responded, 0, 'falha de rede não conta como resposta');
      assert.equal(r.ok, false);
    } finally {
      fail.restore();
    }
  } finally {
    restore(s);
  }
});

test('tick: falha engolida vira failed (retry curto); resposta vazia vira empty', async () => {
  const s = setup();
  try {
    meta('Probe Movie');
    const fail = netStub(failedJackett);
    try {
      brProbe.requestBrProbe(work);
      await harvester.tick();
      assert.equal(brProbe.__probeStateForTest(work), 'failed', 'nenhuma resposta real = failed');
      assert.equal(brProbe.requestBrProbe(work).skipped, 'retry', 'failed libera seeds com retry curto');
      assert.equal(brProbe.probeBlocksSeeds(work), false);
    } finally {
      fail.restore();
    }

    cache.clear();
    harvestQueue.clearQueue();
    const ok = netStub(emptyJackett);
    try {
      brProbe.requestBrProbe(work);
      await harvester.tick();
      assert.equal(brProbe.requestBrProbe(work).skipped, 'empty', 'resposta válida e nenhum BR = empty');
    } finally {
      ok.restore();
    }
  } finally {
    restore(s);
  }
});

test('tick: teto corta a passada com resposta válida e sem BR -> capped', async () => {
  const s = setup();
  try {
    meta('Probe Movie');
    const stub = netStub(emptyJackett);
    try {
      config.harvest.maxPerHour = harvestWorker.queriesThisHour() + 1;
      config.jackett.indexOnlyIndexers = ['cap-a', 'cap-b'];
      config.jackett.ptBrIndexers = ['cap-a', 'cap-b'];
      brProbe.requestBrProbe(work);
      await harvester.tick();
      assert.equal(brProbe.__probeStateForTest(work), 'capped', 'o teto mapeia para capped, não failed');
      assert.equal(brProbe.requestBrProbe(work).skipped, 'retry', 'capped libera seeds com retry curto');
      assert.equal(brProbe.probeBlocksSeeds(work), false);
    } finally {
      stub.restore();
    }
  } finally {
    restore(s);
  }
});

test('tick: brFound precede capped — achou BR mesmo com a passada cortada', async () => {
  const s = setup();
  try {
    meta('Probe Movie');
    const stub = netStub(() => brResult('Probe Movie 2011 1080p DUBLADO', 'ab'.repeat(20)));
    try {
      config.harvest.maxPerHour = harvestWorker.queriesThisHour() + 1; // 1ª consulta roda, 2ª bate teto
      config.jackett.indexOnlyIndexers = ['cap-a', 'cap-b'];
      config.jackett.ptBrIndexers = ['cap-a', 'cap-b'];
      brProbe.requestBrProbe(work);
      await harvester.tick();
      assert.equal(brProbe.requestBrProbe(work).skipped, 'found', 'found vence capped');
      assert.equal(releaseIndex.isPartial(MOVIE, {}), true, 'sem registro anterior, o subset dirigido é parcial');
    } finally {
      stub.restore();
    }
  } finally {
    restore(s);
  }
});

test('tick: tráfego recente NÃO pausa a sonda dirigida (urgência fura o gate de inatividade)', async () => {
  const s = setup();
  try {
    meta('Probe Movie');
    config.harvest.idleWindowMs = 60_000;
    activity.noteUserRequest(); // tráfego recente ANTES do tick
    const stub = netStub(emptyJackett);
    try {
      brProbe.requestBrProbe(work);
      await harvester.tick();
      assert.equal(brProbe.__probeStateForTest(work), 'empty', 'a sonda rodou mesmo com tráfego recente');
      assert.equal(harvestQueue.depth(), 0, 'obra não voltou à fila');
    } finally {
      stub.restore();
    }
  } finally {
    restore(s);
  }
});

test('tick: tráfego recente pausa obra REGULAR (o bypass é só da sonda dirigida)', async () => {
  const s = setup();
  try {
    meta('Probe Movie');
    config.harvest.idleWindowMs = 60_000;
    activity.noteUserRequest();
    const stub = netStub(emptyJackett);
    try {
      harvestQueue.enqueue({ imdbId: MOVIE, type: 'movie', season: null, episode: null, reason: 'popular' });
      await harvester.tick();
      assert.equal(harvestQueue.depth(), 1, 'obra regular continua na fila sob tráfego');
    } finally {
      stub.restore();
    }
  } finally {
    restore(s);
  }
});

test('tick: next-episode TAMBÉM respeita o freio de tráfego (colheita completa não fura)', async () => {
  const s = setup();
  try {
    meta('Probe Movie');
    config.harvest.idleWindowMs = 60_000;
    activity.noteUserRequest();
    const stub = netStub(emptyJackett);
    try {
      // `next-episode` é play real, mas a colheita dele é COMPLETA (~30
      // consultas): rodá-la durante o uso repetiria a disputa de
      // Jackett/FlareSolverr que o freio existe para evitar. Só a sonda
      // dirigida (~3 consultas) fura o gate.
      harvestQueue.enqueue({ imdbId: MOVIE, type: 'movie', season: null, episode: null, reason: 'next-episode' });
      await harvester.tick();
      assert.equal(harvestQueue.depth(), 1, 'next-episode continua na fila sob tráfego');
      const head = harvestQueue.preview(1)[0];
      assert.equal(head?.reason, 'next-episode', 'e segue no topo para a janela ociosa');
    } finally {
      stub.restore();
    }
  } finally {
    restore(s);
  }
});

test('sonda dirigida nunca limpa o partial: ausente nasce parcial; completo permanece', async () => {
  const s = setup();
  try {
    meta('Probe Movie');
    const stub = netStub(() => brResult('Probe Movie 2011 1080p DUBLADO', 'cd'.repeat(20)));
    try {
      const AUSENTE = 'tt9500701';
      cache.clear();
      cache.set(`meta:movie:${AUSENTE}`, { name: 'Probe Movie', year: '2011', type: 'movie' }, 3600);
      await harvestWorker.harvestOne({ imdbId: AUSENTE, type: 'movie', season: null, episode: null, reason: 'br-gap', brProbe: true } as any);
      assert.equal(releaseIndex.isPartial(AUSENTE, {}), true, 'sem registro anterior, o subset nasce parcial');

      const COMPLETO = 'tt9500702';
      releaseIndex.record(COMPLETO, {}, [
        { title: 'Probe Movie 2011 1080p DUBLADO', infoHash: 'ee'.repeat(20), seeders: 1, isBr: true, indexer: 'x' },
      ], {});
      assert.equal(releaseIndex.isPartial(COMPLETO, {}), false, 'sanidade: registro completo');
      cache.set(`meta:movie:${COMPLETO}`, { name: 'Probe Movie', year: '2011', type: 'movie' }, 3600);
      await harvestWorker.harvestOne({ imdbId: COMPLETO, type: 'movie', season: null, episode: null, reason: 'br-gap', brProbe: true } as any);
      assert.equal(releaseIndex.isPartial(COMPLETO, {}), false, 'a sonda não rebaixa registro completo para parcial');
    } finally {
      stub.restore();
    }
  } finally {
    restore(s);
  }
});

test('DUAL titulado em PT sem isBr ganha isBr no modo dirigido e vira found', async () => {
  const s = setup();
  try {
    meta('Lanternas Verdes');
    const stub = netStub(() => brResult('Lanternas Verdes 2011 1080p DUAL', 'ff'.repeat(20)), 'Lanternas Verdes', 'Green Lantern');
    try {
      const r = await harvestWorker.harvestOne({ imdbId: MOVIE, type: 'movie', season: null, episode: null, reason: 'br-gap', brProbe: true } as any);
      const idx = releaseIndex.lookup(MOVIE, {});
      assert.ok(idx.some((x) => x.isBr && x.dubbed), 'o DUAL pt virou release BR dublada no índice');
      assert.equal(r.brFound, true, 'e a sonda finaliza found');
    } finally {
      stub.restore();
    }
  } finally {
    restore(s);
  }
});
