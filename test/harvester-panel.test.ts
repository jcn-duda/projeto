import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import config from '../src/config.js';
import * as harvesterLive from '../src/utils/harvester-live.js';
import * as metrics from '../src/utils/metrics.js';
import { refreshHarvestStatus, resetHarvestBridgeForTests } from '../src/utils/harvest-native.js';
import { stubFetch } from './helpers/stub.js';
import { createTestServer } from './e2e/e2e-harness.js';

const TOKEN = 'tok-harvester-test';
let server: any;
let savedToken: string;

before(async () => {
  savedToken = config.jackett.testToken;
  config.jackett.testToken = '';
  server = await createTestServer(createApp().app);
});

after(async () => {
  await server.close();
  config.jackett.testToken = savedToken;
});

beforeEach(() => {
  harvesterLive.reset();
  resetHarvestBridgeForTests();
});

test('GET /harvester redireciona 302 para /painel#colhedor', async () => {
  const res = await server.request('GET', '/harvester');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/painel#colhedor');
});

test('POST /dashboard-action.json com harvest-config-get exige token', async () => {
  config.jackett.testToken = TOKEN;
  try {
    const semToken = await server.request('POST', '/dashboard-action.json', {
      body: { action: 'harvest-config-get' },
    });
    assert.equal(semToken.status, 401);

    const comToken = await server.request('POST', '/dashboard-action.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { action: 'harvest-config-get' },
    });
    assert.equal(comToken.status, 200);
    assert.equal(comToken.json.ok, true);
    assert.ok(comToken.json.config);
    assert.ok(comToken.json.config.effective);
    assert.ok(Array.isArray(comToken.json.config.schema));
  } finally {
    config.jackett.testToken = '';
  }
});

test('POST /dashboard-action.json harvester-pause comuta estado de pausa no gateway', async () => {
  config.jackett.testToken = TOKEN;
  // A ordem vai pela ponte (`POST /harvest/pause`); o gateway devolve o efetivo.
  const stub = stubFetch((url, init) => {
    const body = JSON.parse(String(init?.body || '{}'));
    return { ok: true, status: 200, json: async () => ({ paused: body.paused === true }) };
  });
  try {
    const resPause = await server.request('POST', '/dashboard-action.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { action: 'harvester-pause', paused: true },
    });
    assert.equal(resPause.status, 200);
    assert.equal(resPause.json.ok, true);
    assert.equal(resPause.json.paused, true);

    const resResume = await server.request('POST', '/dashboard-action.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { action: 'harvester-pause', paused: false },
    });
    assert.equal(resResume.status, 200);
    assert.equal(resResume.json.ok, true);
    assert.equal(resResume.json.paused, false);
    assert.equal(stub.calls.length, 2, 'as duas ordens foram ao gateway');
  } finally {
    stub.restore();
    config.jackett.testToken = '';
  }
});

test('POST /dashboard-action.json harvester-clear-queue exige confirm e limpa a fila do gateway', async () => {
  config.jackett.testToken = TOKEN;
  const stub = stubFetch((url) => {
    if (url.endsWith('/harvest/clear')) {
      return { ok: true, status: 200, json: async () => ({ cleared: 2 }) };
    }
    // O refresh pós-limpeza lê o estado; não interessa ao veredito aqui.
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true, enabled: true, paused: false, intervalMs: 30000, maxPerHour: 100,
        queriesThisHour: 0, depth: 0, inflight: false, preview: [], last: [],
        counters: { drained: 0, failed: 0 }, store: 'harvest.db',
      }),
    };
  });
  try {
    const semConfirm = await server.request('POST', '/dashboard-action.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { action: 'harvester-clear-queue' },
    });
    assert.equal(semConfirm.status, 400);

    const comConfirm = await server.request('POST', '/dashboard-action.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { action: 'harvester-clear-queue', confirm: true },
    });
    assert.equal(comConfirm.status, 200);
    assert.equal(comConfirm.json.ok, true);
    assert.equal(comConfirm.json.cleared, 2, 'o número vem do gateway, não de uma fila local');
    assert.ok(stub.calls.some((c) => c.url.endsWith('/harvest/clear')), 'a ordem chegou à ponte');
  } finally {
    stub.restore();
    config.jackett.testToken = '';
  }
});

test('POST /dashboard-action.json harvest-config-set valida e aplica clamps', async () => {
  config.jackett.testToken = TOKEN;
  try {
    const invalidKey = await server.request('POST', '/dashboard-action.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { action: 'harvest-config-set', patch: { chaveInvalida: 999 } },
    });
    assert.equal(invalidKey.status, 400);
    assert.equal(invalidKey.json.error, 'validation_error');

    const validPatch = await server.request('POST', '/dashboard-action.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: {
        action: 'harvest-config-set',
        patch: {
          harvestMaxPerHour: 300,
          harvestQueueMax: 50,
          seedEnabled: false,
        },
      },
    });
    assert.equal(validPatch.status, 200);
    assert.equal(validPatch.json.ok, true);
    assert.equal(validPatch.json.effective.harvestMaxPerHour, 300);
    assert.equal(validPatch.json.effective.harvestQueueMax, 50);
    assert.equal(validPatch.json.effective.seedEnabled, false);
    assert.ok(validPatch.json.overriddenKeys.includes('harvestMaxPerHour'));
  } finally {
    config.jackett.testToken = '';
  }
});

test('POST /dashboard-action.json harvest-config-reset exige confirm e restaura .env', async () => {
  config.jackett.testToken = TOKEN;
  try {
    harvesterLive.set({ harvestMaxPerHour: 400 });

    const semConfirm = await server.request('POST', '/dashboard-action.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { action: 'harvest-config-reset' },
    });
    assert.equal(semConfirm.status, 400);

    const comConfirm = await server.request('POST', '/dashboard-action.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { action: 'harvest-config-reset', confirm: true },
    });
    assert.equal(comConfirm.status, 200);
    assert.equal(comConfirm.json.ok, true);
    assert.equal(comConfirm.json.effective.harvestMaxPerHour, config.harvest.maxPerHour);
  } finally {
    config.jackett.testToken = '';
  }
});

test('dashboard-status: harvest._origem marca fila durável e enabled amostra', async () => {
  config.jackett.testToken = TOKEN;
  const stub = stubFetch((url) => {
    if (url.endsWith('/harvest')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true, enabled: true, paused: false, intervalMs: 30000, maxPerHour: 100,
          queriesThisHour: 7, depth: 3, inflight: false, preview: [], last: [],
          counters: { drained: 2, failed: 0 }, store: 'harvest.db',
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  try {
    await refreshHarvestStatus();
    const res = await server.request('GET', '/dashboard-status.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
    });
    assert.equal(res.status, 200);
    const h = res.json.harvest as any;
    assert.ok(h._origem, '_origem presente');
    assert.equal(h._origem.queriesThisHour, 'duravel');
    assert.equal(h._origem.queueDepth, 'duravel');
    assert.equal(h._origem.enabled, 'amostra');
    assert.equal(h._origem.lastRunAt, 'amostra');
    assert.equal(h._origem.paused, 'amostra');
    assert.equal(h.queriesThisHour, 7);
    assert.equal(h.queueDepth, 3);
    assert.equal(h.enabled, true);
  } finally {
    stub.restore();
    resetHarvestBridgeForTests();
    config.jackett.testToken = '';
  }
});

test('rotas escopadas /:userConfig/harvester, status e action suportam Colhedor', async () => {
  const userConfig = 'eyJwIjoiamFja2V0dCJ9';
  config.jackett.testToken = TOKEN;
  try {
    const resRedirect = await server.request('GET', `/${userConfig}/harvester`);
    assert.equal(resRedirect.status, 302);
    assert.equal(resRedirect.headers.get('location'), `/${userConfig}/painel#colhedor`);

    const resStatus = await server.request('GET', `/${userConfig}/dashboard-status.json`, {
      headers: { 'X-Indexer-Test-Token': TOKEN },
    });
    assert.equal(resStatus.status, 200);
    assert.ok(resStatus.json.harvest);
    assert.ok(resStatus.json.harvest.config);

    const resAction = await server.request('POST', `/${userConfig}/dashboard-action.json`, {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { action: 'harvest-config-get' },
    });
    assert.equal(resAction.status, 200);
    assert.equal(resAction.json.ok, true);
    assert.equal(resAction.json.action, 'harvest-config-get');
  } finally {
    config.jackett.testToken = '';
  }
});

test('dashboard-status: harvest.done/harvest.empty viajam nos counters', async () => {
  config.jackett.testToken = TOKEN;
  try {
    const before = metrics.snapshot().counters;
    metrics.count('harvest.done', 3);
    metrics.count('harvest.empty', 1);
    const res = await server.request('GET', '/dashboard-status.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
    });
    assert.equal(res.status, 200);
    const counters = (res.json.metrics && res.json.metrics.counters) || {};
    assert.equal((counters['harvest.done'] || 0) - (before['harvest.done'] || 0), 3, 'harvest.done visível no payload');
    assert.equal((counters['harvest.empty'] || 0) - (before['harvest.empty'] || 0), 1, 'harvest.empty visível no payload');
  } finally {
    config.jackett.testToken = '';
  }
});
