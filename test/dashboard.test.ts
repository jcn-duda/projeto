import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.CACHE_PERSIST = 'false';

import { createApp } from '../src/app.js';
import config from '../src/config.js';
import debrid from '../src/debrid/index.js';
import type { DebridAdapter } from '../types/domain.js';
import { createTestServer, withMockFetch } from './e2e/e2e-harness.js';
import { resetCatalogCache } from '../src/providers/jackett-catalog.js';
import { loadDashboardModules } from './helpers/dashboard.js';

const SWEEP_ADAPTER = {
  id: 'sweepfake', label: 'SweepFake', short: 'SW', cacheCheck: false, keyUrl: '' as unknown as string,
  checkCached: async () => new Set<string>(), resolveLink: async () => null,
  sweepDead: async () => ({ varridos: 2, falhas: 0 }),
} as DebridAdapter;

const TOKEN = 'tok-dashboard';
let server: any;
const saved: Record<string, any> = {};

before(async () => {
  saved.testToken = config.jackett.testToken;
  saved.jackettApiKey = config.jackett.apiKey;
  saved.debridService = config.debrid.service;
  saved.debridApiKey = config.debrid.apiKey;
  saved.allowEnvKey = config.debrid.allowEnvKey;
  saved.sweepDead = config.debrid.sweepDead;
  saved.resolveSecret = config.debrid.resolveSecret;

  config.jackett.testToken = '';
  config.jackett.apiKey = 'jackett-key-teste';
  config.debrid.service = '';
  config.debrid.apiKey = '';
  config.debrid.resolveSecret = '';
  config.debrid.allowEnvKey = true;
  config.debrid.sweepDead = true;

  debrid.BY_ID.set(SWEEP_ADAPTER.id, SWEEP_ADAPTER);
  server = await createTestServer(createApp().app);
});

after(async () => {
  await server.close();
  debrid.BY_ID.delete(SWEEP_ADAPTER.id);
  config.jackett.testToken = saved.testToken;
  config.jackett.apiKey = saved.jackettApiKey;
  config.debrid.service = saved.debridService;
  config.debrid.apiKey = saved.debridApiKey;
  config.debrid.allowEnvKey = saved.allowEnvKey;
  config.debrid.sweepDead = saved.sweepDead;
  config.debrid.resolveSecret = saved.resolveSecret;
});

test('GET /dashboard-status.json devolve 503 sem token configurado', async () => {
  const res = await server.request('GET', '/dashboard-status.json');
  assert.equal(res.status, 503);
  assert.match(res.json.error, /dashboard/);
});

test('POST /dashboard-action.json devolve 503 sem token configurado', async () => {
  const res = await server.request('POST', '/dashboard-action.json', { body: { action: 'clear-cache' } });
  assert.equal(res.status, 503);
  assert.equal(res.json.ok, false);
  assert.match(res.json.error, /dashboard/);
});

test('dashboard: 401 com token errado e sem cabeçalho (GET e POST); ?token= nunca autentica', async () => {
  config.jackett.testToken = TOKEN;
  try {
    assert.equal((await server.request('GET', '/dashboard-status.json', { headers: { 'X-Indexer-Test-Token': 'tok-errado' } })).status, 401);
    assert.equal((await server.request('GET', '/dashboard-status.json')).status, 401);
    assert.equal((await server.request('POST', '/dashboard-action.json', { headers: { 'X-Indexer-Test-Token': 'tok-errado' }, body: { action: 'borrar-todo' } })).status, 401);
    assert.equal((await server.request('POST', '/dashboard-action.json', { body: { action: 'clear-cache' } })).status, 401);
    assert.equal((await server.request('GET', `/dashboard-status.json?token=${TOKEN}`)).status, 401);
    assert.equal((await server.request('POST', `/dashboard-action.json?token=${TOKEN}`, { body: { action: 'borrar-todo' } })).status, 401);
  } finally {
    config.jackett.testToken = '';
  }
});

test('GET /dashboard-status.json: 200 com token certo e formato consolidado sem segredos', async () => {
  config.jackett.testToken = TOKEN;
  resetCatalogCache();
  const savedRuntimeConfig = { cachePersist: config.cache.persist, resolversEmbedded: config.resolvers.embedded, resolversPortOffset: config.resolvers.portOffset };
  config.cache.persist = false;
  config.resolvers.embedded = false;
  config.resolvers.portOffset = 37;
  config.debrid.apiKey = 'SUPER-DEBRID-SECRETO-123';
  config.debrid.resolveSecret = 'SUPER-RESOLVE-SECRETO-456';
  config.jackett.apiKey = 'SUPER-JACKETT-SECRETO-789';
  try {
    await withMockFetch([], async () => {
      const res = await server.request('GET', '/dashboard-status.json', { headers: { 'X-Indexer-Test-Token': TOKEN } });
      assert.equal(res.status, 200);
      const body = res.json;
      assert.equal(typeof body.generatedAt, 'string');
      assert.equal(body.general.ok, true);
      assert.equal(typeof body.general.uptimeS, 'number');
      assert.equal(typeof body.general.memory.rss, 'number');
      assert.equal(typeof body.cache.hitRate, 'number');
      assert.equal(body.cache.persistent, false);
      for (const key of ['metrics', 'autofetch', 'magnetdb', 'f3']) assert.equal(typeof body[key], 'object', key);
      for (const key of ['enabled', 'byAdapter', 'ttlRemainingSeconds', 'l1Entries', 'l1Max', 'evictedQuota', 'sizeAlive', 'sizeBad', 'sizeLie']) {
        assert.ok(key in body.magnetdb, 'magnetdb.' + key);
      }
      assert.ok(Array.isArray(body.harvest.queuePreview));
      assert.ok(Array.isArray(body.indexers));
      assert.equal(body.general.services.jackett, false);
      assert.ok(Array.isArray(body.resolvers));
      assert.deepEqual(body.resolvers.map((r: any) => r.port), [8737, 8738, 8739, 8740, 8741, 8742]);
      assert.equal(body.debrid.active, null);
      assert.deepEqual(body.debrid.accounts, {});
      for (const segredo of ['SUPER-DEBRID-SECRETO-123', 'SUPER-RESOLVE-SECRETO-456', 'SUPER-JACKETT-SECRETO-789', TOKEN]) {
        assert.equal(res.text.includes(segredo), false, 'segredo não vaza: ' + segredo);
      }
    });
  } finally {
    config.debrid.apiKey = '';
    config.debrid.resolveSecret = '';
    config.jackett.apiKey = saved.jackettApiKey || 'jackett-key-teste';
    config.jackett.testToken = '';
    config.cache.persist = savedRuntimeConfig.cachePersist;
    config.resolvers.embedded = savedRuntimeConfig.resolversEmbedded;
    config.resolvers.portOffset = savedRuntimeConfig.resolversPortOffset;
  }
});

test('GET /dashboard-status.json: catálogo fallback → services.jackett naomedido', async () => {
  config.jackett.testToken = TOKEN;
  resetCatalogCache();
  try {
    await withMockFetch([{ match: () => true, handler: async () => { throw new Error('ECONNREFUSED'); } }], async () => {
      const res = await server.request('GET', '/dashboard-status.json', { headers: { 'X-Indexer-Test-Token': TOKEN } });
      assert.equal(res.status, 200);
      assert.equal(res.json.general.services.jackett, 'naomedido');
      assert.ok(res.json.indexers.length > 0);
    });
  } finally {
    config.jackett.testToken = '';
    resetCatalogCache();
  }
});

test('displayValue: data é sufixo -at e uptimeS vem em segundos', async () => {
  const mods = await loadDashboardModules();
  assert.match(mods.render.displayValue('generatedAt', 1700000000000), /^\d{2}\/\d{2}\/\d{4}/);
  assert.equal(mods.render.displayValue('hitRate', 0.311), '0.311');
  assert.equal(mods.render.displayValue('deadlineMetadata', 7), '7');
  assert.equal(mods.render.displayValue('brLate', 3), '3');
  assert.equal(mods.render.displayValue('uptimeS', 3612), '60 min 12 s');
});

test('painel do Chupim e do Colhedor: HTML com os ids e módulos com os handlers', async () => {
  const html = readFileSync(new URL('../src/public/dashboard.html', import.meta.url), 'utf8');
  const mods = await loadDashboardModules();
  for (const id of ['tabGeral', 'tabAutofetch', 'viewGeral', 'viewAutofetch', 'afMetricSuppressed', 'tabColhedor', 'viewColhedor', 'harvestPauseBanner', 'harvestLiveMetrics']) {
    assert.match(html, new RegExp('id="' + id + '"'), id + ' no HTML');
  }
  assert.match(html, /Remoções represadas \(aguardando decisão\)/);
  for (const fn of ['renderAutofetchPanel']) assert.equal(typeof mods.autofetch[fn], 'function');
  for (const fn of ['saveAutofetchConfig', 'resetAutofetchConfig', 'toggleAutofetchPause', 'drainAutofetchQueues', 'applyAutofetchPreset']) assert.equal(typeof mods.autofetchActions[fn], 'function', fn);
  for (const fn of ['renderHarvesterPanel']) assert.equal(typeof mods.harvest[fn], 'function');
  for (const fn of ['saveHarvesterConfig', 'resetHarvesterConfig', 'toggleHarvesterPause', 'drainHarvesterQueue', 'clearHarvesterQueue', 'applyHarvesterPreset']) assert.equal(typeof mods.harvestActions[fn], 'function', fn);
});

test('POST clear-cache e sweep-dead exigem confirm: true', async () => {
  config.jackett.testToken = TOKEN;
  try {
    for (const action of ['clear-cache', 'sweep-dead']) {
      const semConfirm = await server.request('POST', '/dashboard-action.json', { headers: { 'X-Indexer-Test-Token': TOKEN }, body: { action } });
      assert.equal(semConfirm.status, 400);
      assert.equal(semConfirm.json.error, 'confirmation_required');
      const falseConfirm = await server.request('POST', '/dashboard-action.json', { headers: { 'X-Indexer-Test-Token': TOKEN }, body: { action, confirm: false } });
      assert.equal(falseConfirm.status, 400);
      assert.equal(falseConfirm.json.error, 'confirmation_required');
    }
  } finally {
    config.jackett.testToken = '';
  }
});
