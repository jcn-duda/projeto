import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import * as cache from '../src/utils/cache.js';
import config from '../src/config.js';
config.seed.enabled = false;
import harvester from '../src/providers/harvester.js';
import * as activity from '../src/providers/activity.js';
import { stubFetch } from './helpers/stub.js';
import { ptSweepQueryFor } from '../src/providers/search-plan.js';
import * as harvesterLive from '../src/utils/harvester-live.js';
import * as metrics from '../src/utils/metrics.js';
import * as harvestWorker from '../src/providers/harvest-worker.js';
import * as indexerStatus from '../src/providers/indexer-status.js';

function saveConfig() {
  return {
    maxPerHour: config.harvest.maxPerHour,
    idleWindowMs: config.harvest.idleWindowMs,
    indexerDelayMs: config.harvest.indexerDelayMs,
    indexers: config.jackett.indexers,
    ptBrIndexers: config.jackett.ptBrIndexers,
    apiKey: config.jackett.apiKey,
    tmdbApiKey: config.tmdb.apiKey,
  };
}

function restoreConfig(saved: ReturnType<typeof saveConfig>) {
  config.harvest.maxPerHour = saved.maxPerHour;
  config.harvest.idleWindowMs = saved.idleWindowMs;
  config.harvest.indexerDelayMs = saved.indexerDelayMs;
  config.jackett.indexers = saved.indexers;
  config.jackett.ptBrIndexers = saved.ptBrIndexers;
  config.jackett.apiKey = saved.apiKey;
  config.tmdb.apiKey = saved.tmdbApiKey;
}

const tmdbOk = () => ({
  ok: true,
  status: 200,
  json: async () => ({
    movie_results: [
      {
        title: 'Star Wars: O Ataque dos Clones',
        original_title: 'Star Wars: Episode II - Attack of the Clones',
        release_date: '2002-05-16',
      },
    ],
  }),
});

test('consulta com falha no Jackett conta no teto horário', async () => {
  const saved = saveConfig();
  const stub = stubFetch((url: string) => {
    if (url.includes('/api/v2.0/indexers/')) {
      return { ok: false, status: 500, json: async () => ({}) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  try {
    config.harvest.maxPerHour = 50;
    config.harvest.idleWindowMs = 0;
    config.harvest.indexerDelayMs = 0;
    config.jackett.indexers = ['fail-idx-1', 'fail-idx-2'];
    config.jackett.apiKey = 'fake-key';
    cache.set('meta:movie:tt9500050', { name: 'Fail Harvest Movie', year: '2024', type: 'movie' }, 3600);

    const before = (harvester.status() as any).queriesThisHour;
    harvester.enqueue({ imdbId: 'tt9500050', type: 'movie', reason: `miss-${Date.now()}` } as any);
    await harvester.tick();

    const after = (harvester.status() as any).queriesThisHour;
    assert.equal(after - before, 2, '2 consultas falhas foram debitadas do teto horário');
  } finally {
    stub.restore();
    restoreConfig(saved);
  }
});

test('varredura pt NÃO roda quando estouraria o teto horário', async () => {
  const saved = saveConfig();
  const stub = stubFetch((url: string) => {
    if (url.includes('api.themoviedb.org')) return tmdbOk();
    if (url.includes('/api/v2.0/indexers/')) {
      return { ok: true, status: 200, json: async () => ({ Results: [] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  try {
    // Com maxPerHour = before (sem saldo restante), a varredura não cabe e é suprimida.
    config.harvest.idleWindowMs = 0;
    config.harvest.indexerDelayMs = 0;
    config.jackett.indexers = ['glob-1', 'glob-2'];
    config.jackett.ptBrIndexers = [];
    config.jackett.apiKey = 'fake-key';
    config.tmdb.apiKey = 'fake-key';
    const before = (harvester.status() as any).queriesThisHour;
    config.harvest.maxPerHour = before;

    cache.set('meta:movie:tt9500051', { name: 'Star Wars: Episode II', year: '2002', type: 'movie' }, 3600);
    await harvestWorker.harvestOne({ imdbId: 'tt9500051', type: 'movie', reason: `miss-${Date.now()}` } as any);

    const expectedSweep = ptSweepQueryFor({
      titles: { pt: 'Star Wars: O Ataque dos Clones', original: 'Star Wars: Episode II - Attack of the Clones' },
    });
    const qOf = (u: string) => {
      try {
        return new URL(u).searchParams.get('Query') || '';
      } catch {
        return '';
      }
    };
    const jacketUrls = stub.calls.map((c) => c.url).filter((u) => u.includes('/api/v2.0/indexers/'));
    const sweepUrls = jacketUrls.filter((u) => qOf(u) === expectedSweep);
    assert.equal(sweepUrls.length, 0, 'varredura foi suprimida pelo teto');
  } finally {
    stub.restore();
    restoreConfig(saved);
  }
});

test('varredura pt-BR parcial: consulta apenas a fatia permitida e conta harvest.sweep.partial', async () => {
  const saved = saveConfig();
  const stub = stubFetch((url: string) => {
    if (url.includes('api.themoviedb.org')) return tmdbOk();
    if (url.includes('/api/v2.0/indexers/')) {
      return { ok: true, status: 200, json: async () => ({ Results: [] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  try {
    harvesterLive.reset();
    metrics.reset();
    config.harvest.idleWindowMs = 0;
    config.harvest.indexerDelayMs = 0;
    config.jackett.indexers = ['glob-1', 'glob-2', 'glob-3'];
    config.jackett.ptBrIndexers = [];
    config.jackett.apiKey = 'fake-key';
    config.tmdb.apiKey = 'fake-key';

    // Se temos 3 globais e o orçamento restante é 2, a fatia da varredura será 2 alvos (< 3).
    const before = (harvester.status() as any).queriesThisHour;
    harvesterLive.set({ harvestMaxPerHour: before + 2 });

    cache.set('meta:movie:tt9500055', { name: 'Star Wars: Episode II', year: '2002', type: 'movie' }, 3600);
    harvester.enqueue({ imdbId: 'tt9500055', type: 'movie', reason: `sweep-partial-${Date.now()}` } as any);
    await harvester.tick();

    const snap = metrics.snapshot().counters;
    assert.equal(snap['harvest.sweep'], 1, 'varredura executou');
    assert.equal(snap['harvest.sweep.partial'], 1, 'varredura parcial foi contabilizada');
  } finally {
    stub.restore();
    harvesterLive.reset();
    restoreConfig(saved);
  }
});

test('colhedor respeita intervalo indexerDelayMs entre consultas ao mesmo indexer', async () => {
  const saved = saveConfig();
  const timestamps: number[] = [];
  const stub = stubFetch((url: string) => {
    if (url.includes('api.themoviedb.org')) return tmdbOk();
    if (url.includes('/api/v2.0/indexers/glob-delay-idx/')) {
      timestamps.push(Date.now());
      return { ok: true, status: 200, json: async () => ({ Results: [] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  try {
    config.harvest.maxPerHour = 50;
    config.harvest.idleWindowMs = 0;
    config.harvest.indexerDelayMs = 60; // 60ms delay
    config.jackett.indexers = ['glob-delay-idx'];
    config.jackett.ptBrIndexers = [];
    config.jackett.apiKey = 'fake-key';
    config.tmdb.apiKey = 'fake-key';

    cache.set('meta:movie:tt9500052', { name: 'Star Wars: Episode II', year: '2002', type: 'movie' }, 3600);
    harvester.enqueue({ imdbId: 'tt9500052', type: 'movie', reason: `miss-${Date.now()}` } as any);
    await harvester.tick();

    assert.equal(timestamps.length, 2, '2 consultas feitas ao mesmo indexer (loop principal + varredura)');
    const delta = timestamps[1] - timestamps[0];
    assert.ok(delta >= 50, `esperou pelo menos indexerDelayMs entre as consultas (${delta}ms >= 50ms)`);
  } finally {
    stub.restore();
    restoreConfig(saved);
  }
});

test('atividade recente trava o colhedor (janela deslizante)', () => {
  // Sem tráfego nenhum: janela aberta.
  assert.equal(activity.recentUserTraffic(10 * 60_000), false);
  activity.noteUserRequest();
  assert.equal(activity.recentUserTraffic(10_000), true, 'tráfego dentro da janela trava');
  assert.equal(activity.hasUserTraffic(), true, 'marca de boot continua valendo para o warmup');
});

test('sliceSweepFatia rotaciona o ponto de partida da fatia parcial', () => {
  const targets = ['a', 'b', 'c'];
  // Cursor 0 e teto cortando em 2: começa do cabeça.
  assert.deepEqual(harvestWorker.sliceSweepFatia(targets, 2, 0), { fatia: ['a', 'b'], next: 2 });
  // Segunda chamada a partir do cursor avançado: envolve no fim do vetor.
  assert.deepEqual(harvestWorker.sliceSweepFatia(targets, 2, 2), { fatia: ['c', 'a'], next: 1 });
  // Teto que comporta tudo: fatia completa e cursor zera (comportamento antigo).
  assert.deepEqual(harvestWorker.sliceSweepFatia(targets, 3, 1), { fatia: ['a', 'b', 'c'], next: 0 });
  assert.deepEqual(harvestWorker.sliceSweepFatia(targets, 9, 2), { fatia: ['a', 'b', 'c'], next: 0 });
  // Sem alvo ou sem saldo: nada a consultar e cursor preservado.
  assert.deepEqual(harvestWorker.sliceSweepFatia([], 2, 4), { fatia: [], next: 4 });
  assert.deepEqual(harvestWorker.sliceSweepFatia(targets, 0, 1), { fatia: [], next: 1 });
});

test('breaker aberto não debita cota nem consulta indexer tripped', async () => {
  const saved = saveConfig();
  const stub = stubFetch((url: string) => {
    if (url.includes('api.themoviedb.org')) return tmdbOk();
    return { ok: false, status: 404, json: async () => ({}) };
  });
  try {
    // 3 falhas seguidas abrem o circuito (default breakerFailures=3). record()
    // recebe o field name `ok` (não `sourceOk`), como no jackett-breaker.test.ts.
    for (let i = 0; i < config.jackett.breakerFailures; i += 1) {
      indexerStatus.record('idx-x', { ok: false, results: 0, ms: 100, budgetMs: 4000 });
    }
    config.harvest.idleWindowMs = 0;
    config.harvest.indexerDelayMs = 0;
    config.jackett.indexers = ['idx-x'];
    config.jackett.apiKey = 'fake-key';
    config.tmdb.apiKey = 'fake-key';

    cache.set('meta:movie:tt9500058', { name: 'Star Wars: Episode II', year: '2002', type: 'movie' }, 3600);
    const before = (harvester.status() as any).queriesThisHour;
    await harvestWorker.harvestOne({ imdbId: 'tt9500058', type: 'movie', reason: `breaker-${Date.now()}` } as any);
    const after = (harvester.status() as any).queriesThisHour;

    assert.equal(after - before, 0, 'breaker aberto não debita cota');
    const jacketUrls = stub.calls.map((c) => c.url).filter((u) => u.includes('/api/v2.0/indexers/'));
    assert.equal(jacketUrls.length, 0, 'indexer tripped não é consultado (nem no loop nem na varredura)');
  } finally {
    stub.restore();
    indexerStatus.clear();
    restoreConfig(saved);
  }
});

test('varredura parcial rotaciona o alvo consultado entre obras (round-robin)', async () => {
  const saved = saveConfig();
  const stub = stubFetch((url: string) => {
    if (url.includes('api.themoviedb.org')) return tmdbOk();
    if (url.includes('/api/v2.0/indexers/')) return { ok: true, status: 200, json: async () => ({ Results: [] }) };
    return { ok: false, status: 404, json: async () => ({}) };
  });
  try {
    harvesterLive.reset();
    harvestWorker.resetSweepCursor();
    config.harvest.idleWindowMs = 0;
    config.harvest.indexerDelayMs = 0;
    config.jackett.indexers = ['glob-a', 'glob-b', 'glob-c'];
    config.jackett.ptBrIndexers = [];
    config.jackett.apiKey = 'fake-key';
    config.tmdb.apiKey = 'fake-key';

    cache.set('meta:movie:tt9500059', { name: 'Star Wars: Episode II', year: '2002', type: 'movie' }, 3600);
    cache.set('meta:movie:tt9500060', { name: 'Star Wars: Episode II', year: '2002', type: 'movie' }, 3600);
    const expectedSweep = ptSweepQueryFor({
      titles: { pt: 'Star Wars: O Ataque dos Clones', original: 'Star Wars: Episode II - Attack of the Clones' },
    });
    const qOf = (u: string) => {
      try {
        return new URL(u).searchParams.get('Query') || '';
      } catch {
        return '';
      }
    };
    const sweepUrls = (from: number) =>
      stub.calls
        .slice(from)
        .map((c) => c.url)
        .filter((u) => u.includes('/api/v2.0/indexers/') && qOf(u) === expectedSweep);

    // Obra 1: teto corta a varredura em 1 alvo a partir do cursor 0 → glob-a.
    let before = (harvester.status() as any).queriesThisHour;
    harvesterLive.set({ harvestMaxPerHour: before + 1 });
    let mark = stub.calls.length;
    await harvestWorker.harvestOne({ imdbId: 'tt9500059', type: 'movie', reason: `rr-1-${Date.now()}` } as any);
    let u1 = sweepUrls(mark);
    assert.ok(u1.some((u) => u.includes('/indexers/glob-a/')), `obra 1 varre glob-a; recebido: ${JSON.stringify(u1)}`);

    // Obra 2: teto corta em 1 alvo a partir do cursor avançado → glob-b.
    before = (harvester.status() as any).queriesThisHour;
    harvesterLive.set({ harvestMaxPerHour: before + 1 });
    mark = stub.calls.length;
    await harvestWorker.harvestOne({ imdbId: 'tt9500060', type: 'movie', reason: `rr-2-${Date.now()}` } as any);
    let u2 = sweepUrls(mark);
    assert.ok(u2.some((u) => u.includes('/indexers/glob-b/')), `obra 2 varre glob-b; recebido: ${JSON.stringify(u2)}`);
  } finally {
    stub.restore();
    harvesterLive.reset();
    harvestWorker.resetSweepCursor();
    restoreConfig(saved);
  }
});
