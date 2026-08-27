import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import config from '../src/config.js';
import * as harvesterLive from '../src/utils/harvester-live.js';
import harvester from '../src/providers/harvester.js';
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
  harvester.setPaused(false);
});

test('GET /harvester redireciona 302 para /dashboard#colhedor', async () => {
  const res = await server.request('GET', '/harvester');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/dashboard#colhedor');
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

test('POST /dashboard-action.json harvester-pause comuta estado de pausa', async () => {
  config.jackett.testToken = TOKEN;
  try {
    const resPause = await server.request('POST', '/dashboard-action.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { action: 'harvester-pause', paused: true },
    });
    assert.equal(resPause.status, 200);
    assert.equal(resPause.json.ok, true);
    assert.equal(resPause.json.paused, true);
    assert.equal(harvesterLive.isPaused(), true);

    const resResume = await server.request('POST', '/dashboard-action.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { action: 'harvester-pause', paused: false },
    });
    assert.equal(resResume.status, 200);
    assert.equal(resResume.json.ok, true);
    assert.equal(resResume.json.paused, false);
    assert.equal(harvesterLive.isPaused(), false);
  } finally {
    config.jackett.testToken = '';
  }
});

test('POST /dashboard-action.json harvester-clear-queue exige confirm e esvazia a fila', async () => {
  config.jackett.testToken = TOKEN;
  try {
    harvester.enqueue({ imdbId: 'tt0111161', type: 'movie', reason: 'test' });

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
    assert.ok(typeof comConfirm.json.cleared === 'number');

    const st = harvester.status();
    assert.equal(st.queueDepth, 0);
  } finally {
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

test('rotas escopadas /:userConfig/harvester, status e action suportam Colhedor', async () => {
  const userConfig = 'eyJwIjoiamFja2V0dCJ9';
  config.jackett.testToken = TOKEN;
  try {
    const resRedirect = await server.request('GET', `/${userConfig}/harvester`);
    assert.equal(resRedirect.status, 302);
    assert.equal(resRedirect.headers.get('location'), `/${userConfig}/dashboard#colhedor`);

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

