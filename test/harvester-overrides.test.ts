import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import * as cache from '../src/utils/cache.js';
import config from '../src/config.js';
config.seed.enabled = false;
import { prefix } from '../src/utils/cache-keys.js';
import harvester from '../src/providers/harvester.js';
import rdWarmer from '../src/providers/rd-warmer.js';
import { stubFetch } from './helpers/stub.js';
import * as harvesterLive from '../src/utils/harvester-live.js';
test('M1: override live de harvestMaxPerHour e harvestIdleWindowMs afeta harvestOne diretamente', async () => {
  harvesterLive.reset();
  const saved = {
    maxPerHour: config.harvest.maxPerHour,
    idleWindowMs: config.harvest.idleWindowMs,
    indexerDelayMs: config.harvest.indexerDelayMs,
    indexers: config.jackett.indexers,
    apiKey: config.jackett.apiKey,
  };
  try {
    // Config estática define teto alto (100) e janela 0
    config.harvest.maxPerHour = 100;
    config.harvest.idleWindowMs = 0;
    config.harvest.indexerDelayMs = 0;
    config.jackett.indexers = ['idx-a', 'idx-b', 'idx-c'];
    config.jackett.apiKey = '';

    // Override live define teto baixo (1 consulta)
    const before = (harvester.status() as any).queriesThisHour;
    harvesterLive.set({ harvestMaxPerHour: before + 1 });

    cache.set('meta:movie:tt9500070', { name: 'Live Override Movie', year: '2024', type: 'movie' }, 3600);
    harvester.clearQueue();
    harvester.enqueue({ imdbId: 'tt9500070', type: 'movie', reason: `live-${Date.now()}` } as any);

    await harvester.tick();

    const st: any = harvester.status();
    assert.equal(st.queriesThisHour, before + 1, 'harvestOne respeitou o teto do override live (1)');
    assert.equal(st.queueDepth, 1, 'obra cortada voltou para a fila');
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

test('M2: rdWarmer recebe releases ordenadas por score (80 > 40 > 5)', async () => {
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

  const hBrDub = '1'.repeat(40);
  const hGlobDub = '2'.repeat(40);
  const hLeg = '3'.repeat(40);

  const stub = stubFetch((url: string) => {
    if (url.includes('api.themoviedb.org')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          movie_results: [
            {
              title: 'Filme Score Sort',
              original_title: 'Score Sort Movie',
              release_date: '2024-01-01',
            },
          ],
        }),
      };
    }
    if (url.includes('/api/v2.0/indexers/')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          Results: [
            // Ordem de retorno invertida: primeiro legendado (5), depois glob (40), depois BR (80)
            {
              Title: 'Score Sort Movie (2024) 1080p English Subbed',
              MagnetUri: `magnet:?xt=urn:btih:${hLeg}&dn=Filme.Leg`,
              Seeders: 20,
              Tracker: 'thepiratebay',
            },
            {
              Title: 'Score Sort Movie (2024) 1080p Dual Audio',
              MagnetUri: `magnet:?xt=urn:btih:${hGlobDub}&dn=Filme.Glob`,
              Seeders: 10,
              Tracker: 'thepiratebay',
              dubbed: true,
              isBr: false,
            },
            {
              Title: 'Filme Score Sort (2024) 1080p DUAL Dublado',
              MagnetUri: `magnet:?xt=urn:btih:${hBrDub}&dn=Filme.BR`,
              Seeders: 5,
              Tracker: 'comandotorrents',
              isBr: true,
            },
          ],
        }),
      };
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
    config.jackett.indexers = ['test-score-sort'];
    config.jackett.apiKey = 'fake-key';
    config.tmdb.apiKey = 'fake-key';

    cache.set('meta:movie:tt9500072', { name: 'Score Sort Movie', year: '2024', type: 'movie' }, 3600);
    harvester.clearQueue();
    harvester.enqueue({ imdbId: 'tt9500072', type: 'movie', reason: `score-order-${Date.now()}` } as any);
    await harvester.tick();

    const warmQueue = (cache.get(`${prefix('rdq')}wq`) || []) as any[];
    assert.equal(warmQueue.length, 3);
    assert.equal(warmQueue[0].hash, hBrDub, 'BR Dublado (score 80) vem em primeiro');
    assert.equal(warmQueue[1].hash, hGlobDub, 'Dublado global (score 40) vem em segundo');
    assert.equal(warmQueue[2].hash, hLeg, 'Legendado (score 5) vem em terceiro');
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

test('M3: checkQuotaWarning respeita o cooldown de cache e não repete accountStatus', async () => {
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
      return { magnets: 950, ready: 10, active: 5 };
    },
  };
  debridModule.BY_ID.set('alldebrid', mockAdapter as any);

  try {
    cache.clearNamespace('harvest');
    cache.clearNamespace('notify');
    config.harvest.idleWindowMs = 0;
    config.notify.enabled = true;
    config.notify.webhookUrl = 'http://127.0.0.1:9999/webhook';
    config.notify.magnetsWarn = 900;
    config.debrid.service = 'alldebrid';
    config.debrid.apiKey = 'fake-key';
    config.debrid.allowEnvKey = true;
    config.harvest.quotaWarnCooldownMs = 3600_000;

    // 1ª execução do tick chama accountStatus e grava marcador
    await harvester.tick();
    assert.equal(accountStatusCalls, 1, 'primeiro tick chamou accountStatus');
    assert.ok(cache.get(`${prefix('harvest')}quotaWarn`), 'marcador gravado no cache');

    // 2ª execução dentro do cooldown não deve chamar accountStatus novamente
    await harvester.tick();
    assert.equal(accountStatusCalls, 1, 'segundo tick respeitou cooldown e não chamou accountStatus');
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

test('M4: bludv é consultado com fallback para query original quando ptQuery é nulo', async () => {
  const saved = {
    maxPerHour: config.harvest.maxPerHour,
    idleWindowMs: config.harvest.idleWindowMs,
    indexerDelayMs: config.harvest.indexerDelayMs,
    indexers: config.jackett.indexers,
    apiKey: config.jackett.apiKey,
    bludvEnabled: config.bludv.enabled,
    bludvBaseUrl: config.bludv.baseUrl,
  };

  const searchedUrls: string[] = [];
  const stub = stubFetch((url: string) => {
    if (url.includes('api.themoviedb.org')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          movie_results: [
            {
              // Título pt igual ao original -> ptQuery vira null
              title: 'Original Title Only',
              original_title: 'Original Title Only',
              release_date: '2024-01-01',
            },
          ],
        }),
      };
    }
    if (url.includes('/?s=')) {
      searchedUrls.push(url);
      return { ok: true, status: 200, text: async () => '<div class="post"></div>' };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });

  try {
    config.harvest.maxPerHour = 100;
    config.harvest.idleWindowMs = 0;
    config.harvest.indexerDelayMs = 0;
    config.jackett.indexers = [];
    config.jackett.apiKey = '';
    config.bludv.enabled = true;
    config.bludv.baseUrl = 'http://fake-bludv.local';

    cache.set('meta:movie:tt9500075', { name: 'Original Title Only', year: '2024', type: 'movie' }, 3600);
    harvester.clearQueue();
    harvester.enqueue({ imdbId: 'tt9500075', type: 'movie', reason: `bludv-fallback-${Date.now()}` } as any);
    await harvester.tick();

    assert.ok(searchedUrls.length > 0, 'bludv foi consultado');
    assert.ok(searchedUrls[0].includes('Original%20Title%20Only'), 'consultou bludv com a query original');
  } finally {
    stub.restore();
    config.harvest.maxPerHour = saved.maxPerHour;
    config.harvest.idleWindowMs = saved.idleWindowMs;
    config.harvest.indexerDelayMs = saved.indexerDelayMs;
    config.jackett.indexers = saved.indexers;
    config.jackett.apiKey = saved.apiKey;
    config.bludv.enabled = saved.bludvEnabled;
    config.bludv.baseUrl = saved.bludvBaseUrl;
    harvester.clearQueue();
  }
});
