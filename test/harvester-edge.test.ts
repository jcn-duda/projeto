import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import * as cache from '../src/utils/cache.js';
import config from '../src/config.js';
config.seed.enabled = false;
import { prefix } from '../src/utils/cache-keys.js';
import harvester from '../src/providers/harvester.js';
import rdWarmer from '../src/providers/rd-warmer.js';
import * as activity from '../src/providers/activity.js';
import { stubFetch } from './helpers/stub.js';
import * as harvesterLive from '../src/utils/harvester-live.js';
import * as metrics from '../src/utils/metrics.js';
import * as releaseIndex from '../src/utils/release-index.js';
test('M6: obra cortada 4 vezes emite a métrica harvest.capped.dropped', async () => {
  const saved = {
    maxPerHour: config.harvest.maxPerHour,
    idleWindowMs: config.harvest.idleWindowMs,
    indexerDelayMs: config.harvest.indexerDelayMs,
    indexers: config.jackett.indexers,
    apiKey: config.jackett.apiKey,
  };
  try {
    harvesterLive.reset();
    metrics.reset();
    config.harvest.idleWindowMs = 0;
    config.harvest.indexerDelayMs = 0;
    config.jackett.indexers = ['idx-a', 'idx-b', 'idx-c'];
    config.jackett.apiKey = '';

    cache.set('meta:movie:tt9500080', { name: 'Capped Obra', year: '2024', type: 'movie' }, 3600);
    harvester.clearQueue();
    harvester.enqueue({ imdbId: 'tt9500080', type: 'movie', reason: `capped-dropped-${Date.now()}` } as any);

    // Executa 4 ciclos cortando pelo teto
    for (let i = 0; i < 4; i++) {
      const before = (harvester.status() as any).queriesThisHour;
      harvesterLive.set({ harvestMaxPerHour: before + 1 });
      await harvester.tick();
    }

    const snap = metrics.snapshot().counters;
    assert.equal(snap['harvest.capped.dropped'], 1, 'contou harvest.capped.dropped ao descartar após 3 retentativas');
    assert.equal((harvester.status() as any).queueDepth, 0, 'obra foi descartada da fila');
  } finally {
    harvesterLive.reset();
    config.harvest.maxPerHour = saved.maxPerHour;
    config.harvest.idleWindowMs = saved.idleWindowMs;
    config.harvest.indexerDelayMs = saved.indexerDelayMs;
    config.jackett.indexers = saved.indexers;
    config.jackett.apiKey = saved.apiKey;
    harvester.clearQueue();
  }
});

test('M6b: capped.dropped limpa partial da série semeada (raiz)', async () => {
  // Série semeada (sem season) grava partial na raiz; capped.dropped precisa
  // clearPartial para o fast-path de S1E1 não ficar bloqueado ~30d.
  const saved = {
    maxPerHour: config.harvest.maxPerHour,
    idleWindowMs: config.harvest.idleWindowMs,
    indexerDelayMs: config.harvest.indexerDelayMs,
    indexers: config.jackett.indexers,
    apiKey: config.jackett.apiKey,
  };
  try {
    harvesterLive.reset();
    metrics.reset();
    config.harvest.idleWindowMs = 0;
    config.harvest.indexerDelayMs = 0;
    config.jackett.indexers = ['idx-a', 'idx-b', 'idx-c'];
    config.jackett.apiKey = '';

    const imdbId = 'tt9500081';
    cache.set(`meta:series:${imdbId}`, { name: 'Serie Semeada', year: '2024', type: 'series' }, 3600);
    releaseIndex.record(imdbId, {}, [{
      title: 'Serie Semeada 1ª Temporada DUBLADO',
      infoHash: 'f1'.repeat(20),
      seeders: 1,
      size: 1e9,
      indexer: 'seed',
      isBr: true,
    }], { partial: true });
    assert.equal(releaseIndex.isPartial(imdbId, { season: 1, episode: 1 }), true, 'raiz parcial bloqueia episódio');

    harvester.clearQueue();
    harvester.enqueue({ imdbId, type: 'series', reason: `capped-partial-${Date.now()}` } as any);

    for (let i = 0; i < 4; i++) {
      const before = (harvester.status() as any).queriesThisHour;
      harvesterLive.set({ harvestMaxPerHour: before + 1 });
      await harvester.tick();
    }

    assert.equal(metrics.snapshot().counters['harvest.capped.dropped'], 1, 'dropou após 4 caps');
    assert.equal(releaseIndex.isPartial(imdbId, { season: 1, episode: 1 }), false, 'clearPartial liberou fast-path');
  } finally {
    harvesterLive.reset();
    config.harvest.maxPerHour = saved.maxPerHour;
    config.harvest.idleWindowMs = saved.idleWindowMs;
    config.harvest.indexerDelayMs = saved.indexerDelayMs;
    config.jackett.indexers = saved.indexers;
    config.jackett.apiKey = saved.apiKey;
    harvester.clearQueue();
  }
});

test('M3 edge case: checkQuotaWarning com quotaWarnCooldownMs=0 executa a cada tick sem gravar marcador', async () => {
  const saved = {
    notifyEnabled: config.notify.enabled,
    webhookUrl: config.notify.webhookUrl,
    magnetsWarn: config.notify.magnetsWarn,
    service: config.debrid.service,
    apiKey: config.debrid.apiKey,
    allowEnvKey: config.debrid.allowEnvKey,
    quotaWarnCooldownMs: config.harvest.quotaWarnCooldownMs,
    idleWindowMs: config.harvest.idleWindowMs,
  };

  let accountStatusCalls = 0;
  const debridModule = (await import('../src/debrid/index.js')).default;
  const originalAdapter = debridModule.BY_ID.get('alldebrid');
  const mockAdapter = {
    ...originalAdapter,
    id: 'alldebrid',
    accountStatus: async () => {
      accountStatusCalls += 1;
      return { magnets: 800, ready: 10, active: 5 };
    },
  };
  debridModule.BY_ID.set('alldebrid', mockAdapter as any);

  try {
    cache.clearNamespace('harvest');
    config.harvest.idleWindowMs = 0;
    config.notify.enabled = true;
    config.notify.webhookUrl = 'http://127.0.0.1:9999/webhook';
    config.notify.magnetsWarn = 900;
    config.debrid.service = 'alldebrid';
    config.debrid.apiKey = 'fake-key';
    config.debrid.allowEnvKey = true;
    config.harvest.quotaWarnCooldownMs = 0; // Cooldown desligado

    await harvester.tick();
    assert.equal(accountStatusCalls, 1, 'primeiro tick chamou accountStatus');
    assert.equal(cache.get(`${prefix('harvest')}quotaWarn`), null, 'marcador não é gravado quando cooldown é 0');

    await harvester.tick();
    assert.equal(accountStatusCalls, 2, 'segundo tick chamou accountStatus novamente');
  } finally {
    if (originalAdapter) debridModule.BY_ID.set('alldebrid', originalAdapter);
    config.notify.enabled = saved.notifyEnabled;
    config.notify.webhookUrl = saved.webhookUrl;
    config.notify.magnetsWarn = saved.magnetsWarn;
    config.debrid.service = saved.service;
    config.debrid.apiKey = saved.apiKey;
    config.debrid.allowEnvKey = saved.allowEnvKey;
    config.harvest.quotaWarnCooldownMs = saved.quotaWarnCooldownMs;
    config.harvest.idleWindowMs = saved.idleWindowMs;
  }
});

test('M3 edge case: checkQuotaWarning quando accountStatus lança erro não grava marcador', async () => {
  const saved = {
    notifyEnabled: config.notify.enabled,
    webhookUrl: config.notify.webhookUrl,
    magnetsWarn: config.notify.magnetsWarn,
    service: config.debrid.service,
    apiKey: config.debrid.apiKey,
    allowEnvKey: config.debrid.allowEnvKey,
    quotaWarnCooldownMs: config.harvest.quotaWarnCooldownMs,
    idleWindowMs: config.harvest.idleWindowMs,
  };

  let accountStatusCalls = 0;
  const debridModule = (await import('../src/debrid/index.js')).default;
  const originalAdapter = debridModule.BY_ID.get('alldebrid');
  const mockAdapter = {
    ...originalAdapter,
    id: 'alldebrid',
    accountStatus: async () => {
      accountStatusCalls += 1;
      throw new Error('AllDebrid network error');
    },
  };
  debridModule.BY_ID.set('alldebrid', mockAdapter as any);

  try {
    cache.clearNamespace('harvest');
    config.harvest.idleWindowMs = 0;
    config.notify.enabled = true;
    config.notify.webhookUrl = 'http://127.0.0.1:9999/webhook';
    config.notify.magnetsWarn = 900;
    config.debrid.service = 'alldebrid';
    config.debrid.apiKey = 'fake-key';
    config.debrid.allowEnvKey = true;
    config.harvest.quotaWarnCooldownMs = 3600_000;

    await harvester.tick();
    assert.equal(accountStatusCalls, 1, 'primeiro tick tentou chamar accountStatus');
    assert.equal(cache.get(`${prefix('harvest')}quotaWarn`), null, 'marcador não foi gravado após falha');

    await harvester.tick();
    assert.equal(accountStatusCalls, 2, 'segundo tick tentou chamar novamente após falha anterior');
  } finally {
    if (originalAdapter) debridModule.BY_ID.set('alldebrid', originalAdapter);
    config.notify.enabled = saved.notifyEnabled;
    config.notify.webhookUrl = saved.webhookUrl;
    config.notify.magnetsWarn = saved.magnetsWarn;
    config.debrid.service = saved.service;
    config.debrid.apiKey = saved.apiKey;
    config.debrid.allowEnvKey = saved.allowEnvKey;
    config.harvest.quotaWarnCooldownMs = saved.quotaWarnCooldownMs;
    config.harvest.idleWindowMs = saved.idleWindowMs;
  }
});

test('M2 edge case: rdWarmer com mais de 10 releases enfileira estritamente as top 10 com maior score', async () => {
  const saved = {
    maxPerHour: config.harvest.maxPerHour,
    idleWindowMs: config.harvest.idleWindowMs,
    indexerDelayMs: config.harvest.indexerDelayMs,
    indexers: config.jackett.indexers,
    apiKey: config.jackett.apiKey,
    tmdbApiKey: config.tmdb.apiKey,
    rdWarmEnabled: config.debrid.rdWarm.enabled,
    debridService: config.debrid.service,
  };

  // Cria 5 BR dublado (80), 5 dublado global (40) e 5 legendado (5) = 15 releases com hashes válidos
  const brHashes = ['11', '12', '13', '14', '15'].map((h) => h.repeat(20));
  const globHashes = ['21', '22', '23', '24', '25'].map((h) => h.repeat(20));
  const legHashes = ['31', '32', '33', '34', '35'].map((h) => h.repeat(20));
  const tags = ['WEB-DL', 'BluRay', 'REMUX', 'WEBRip', 'HDRip'];

  const results: any[] = [
    // 5 legendadas primeiro
    ...legHashes.map((h, i) => ({
      Title: `Movie Big (2024) 1080p ${tags[i]} English Subbed`,
      MagnetUri: `magnet:?xt=urn:btih:${h}&dn=Movie.Big`,
      Seeders: 20,
      Tracker: 'thepiratebay',
    })),
    // 5 globais dublados
    ...globHashes.map((h, i) => ({
      Title: `Movie Big (2024) 1080p ${tags[i]} Dual Audio`,
      MagnetUri: `magnet:?xt=urn:btih:${h}&dn=Movie.Big`,
      Seeders: 10,
      Tracker: 'thepiratebay',
      dubbed: true,
      isBr: false,
    })),
    // 5 BR dublados
    ...brHashes.map((h, i) => ({
      Title: `Filme Big (2024) 1080p ${tags[i]} DUAL Dublado`,
      MagnetUri: `magnet:?xt=urn:btih:${h}&dn=Filme.Big`,
      Seeders: 5,
      Tracker: 'comandotorrents',
      isBr: true,
    })),
  ];

  const stub = stubFetch((url: string) => {
    if (url.includes('api.themoviedb.org')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          movie_results: [{ title: 'Filme Big', original_title: 'Movie Big', release_date: '2024-01-01' }],
        }),
      };
    }
    if (url.includes('/api/v2.0/indexers/')) {
      return { ok: true, status: 200, json: async () => ({ Results: results }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });

  try {
    cache.clearNamespace('rdc');
    cache.clearNamespace('rdq');
    rdWarmer.reset();
    config.debrid.rdWarm.enabled = true;
    config.debrid.service = 'realdebrid';

    config.harvest.maxPerHour = 100;
    config.harvest.idleWindowMs = 0;
    config.harvest.indexerDelayMs = 0;
    config.jackett.indexers = ['test-score-top10'];
    config.jackett.apiKey = 'fake-key';
    config.tmdb.apiKey = 'fake-key';

    cache.set('meta:movie:tt9500095', { name: 'Movie Big', year: '2024', type: 'movie' }, 3600);
    harvester.clearQueue();
    harvester.enqueue({ imdbId: 'tt9500095', type: 'movie', reason: `score-top10-${Date.now()}` } as any);
    await harvester.tick();

    const warmQueue = (cache.get(`${prefix('rdq')}wq`) || []) as any[];
    assert.equal(warmQueue.length, 10, 'apenas 10 releases foram enfileiradas no rdWarmer');
    // As 5 de score 80 e as 5 de score 40 devem estar na fila; nenhuma de score 5 deve ter entrado
    for (const h of brHashes) {
      assert.ok(warmQueue.some((e) => e.hash === h && e.score === 80), `BR dublado ${h} está na fila com score 80`);
    }
    for (const h of globHashes) {
      assert.ok(warmQueue.some((e) => e.hash === h && e.score === 40), `Dublado global ${h} está na fila com score 40`);
    }
    for (const h of legHashes) {
      assert.ok(!warmQueue.some((e) => e.hash === h), `Legendado de menor score ${h} foi descartado do top 10`);
    }
  } finally {
    stub.restore();
    config.harvest.maxPerHour = saved.maxPerHour;
    config.harvest.idleWindowMs = saved.idleWindowMs;
    config.harvest.indexerDelayMs = saved.indexerDelayMs;
    config.jackett.indexers = saved.indexers;
    config.jackett.apiKey = saved.apiKey;
    config.tmdb.apiKey = saved.tmdbApiKey;
    config.debrid.rdWarm.enabled = saved.rdWarmEnabled;
    config.debrid.service = saved.debridService;
    rdWarmer.reset();
    harvester.clearQueue();
  }
});

test('preempção NÃO incrementa harvested; conclusão incrementa 1', async () => {
  // imdbId próprio: recentWorks é módulo e ids de outros testes podem
  // contaminar lastWorks se reusados.
  const imdbId = 'tt9500149';
  const saved = {
    maxPerHour: config.harvest.maxPerHour, idleWindowMs: config.harvest.idleWindowMs, indexerDelayMs: config.harvest.indexerDelayMs,
    indexers: config.jackett.indexers, apiKey: config.jackett.apiKey, tmdbApiKey: config.tmdb.apiKey,
    rawMaxItems: config.rawCache.maxItems, rdWarmEnabled: config.debrid.rdWarm.enabled,
    ptSweepGlobal: config.jackett.ptSweepGlobal,
  };
  let noteTraffic = true;
  const stub = stubFetch((url: string) => {
    if (url.includes('/api/v2.0/indexers/')) {
      if (noteTraffic) activity.noteUserRequest();
      return { ok: true, status: 200, json: async () => ({ Results: [] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  try {
    harvesterLive.reset();
    config.harvest.maxPerHour = 1000;
    config.harvest.idleWindowMs = 100;
    config.harvest.indexerDelayMs = 0;
    config.jackett.indexers = ['harv-a', 'harv-b'];
    config.jackett.apiKey = 'chave-de-teste';
    config.jackett.ptSweepGlobal = false;
    config.tmdb.apiKey = '';
    config.rawCache.maxItems = 0;
    config.debrid.rdWarm.enabled = false;
    harvester.setPaused(false);
    harvester.clearQueue();
    cache.clearNamespace('harvest');

    cache.set(`meta:movie:${imdbId}`, { name: 'Harvest Count Movie', year: '2024', type: 'movie' }, 3600);
    harvester.enqueue({ imdbId, type: 'movie', reason: `harvested-${Date.now()}` } as any);

    // Tráfego residual de testes anteriores precisa expirar, senão o guard do
    // tick aborta ANTES do harvestOne e o preempt mid-obra não roda.
    await new Promise((r) => setTimeout(r, 120));
    const before = (harvester.status() as any).harvested;
    await harvester.tick();
    assert.equal((harvester.status() as any).harvested, before, 'tick preemptado NÃO sobe harvested');
    assert.equal(((harvester.status() as any).lastWorks || []).some((w: any) => w.imdbId === imdbId), false,
      'meia-colheita não entra em lastWorks');

    noteTraffic = false;
    await new Promise((r) => setTimeout(r, 120));
    await harvester.tick();
    assert.equal((harvester.status() as any).harvested, before + 1, 'conclusão sobe harvested em 1');
  } finally {
    stub.restore();
    config.harvest.maxPerHour = saved.maxPerHour; config.harvest.idleWindowMs = saved.idleWindowMs; config.harvest.indexerDelayMs = saved.indexerDelayMs;
    config.jackett.indexers = saved.indexers; config.jackett.apiKey = saved.apiKey; config.tmdb.apiKey = saved.tmdbApiKey;
    config.rawCache.maxItems = saved.rawMaxItems; config.debrid.rdWarm.enabled = saved.rdWarmEnabled;
    config.jackett.ptSweepGlobal = saved.ptSweepGlobal;
    harvesterLive.reset(); harvester.clearQueue();
  }
});

