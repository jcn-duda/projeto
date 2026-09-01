import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import config from '../src/config.js';
import * as autofetchLive from '../src/utils/autofetch-live.js';
import * as autofetch from '../src/providers/autofetch.js';
import * as cache from '../src/utils/cache.js';
import { createTestServer } from './e2e/e2e-harness.js';

const TOKEN = 'tok-autofetch-test';
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
  autofetchLive.reset();
});

test('GET /autofetch redireciona 302 para /dashboard#autofetch', async () => {
  const res = await server.request('GET', '/autofetch');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/dashboard#autofetch');
});

test('POST /dashboard-action.json com autofetch-config-get exige token', async () => {
  config.jackett.testToken = TOKEN;
  try {
    const semToken = await server.request('POST', '/dashboard-action.json', {
      body: { action: 'autofetch-config-get' },
    });
    assert.equal(semToken.status, 401);

    const comToken = await server.request('POST', '/dashboard-action.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { action: 'autofetch-config-get' },
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

test('POST /dashboard-action.json autofetch-pause altera e reflete estado de pausa', async () => {
  config.jackett.testToken = TOKEN;
  try {
    const resPause = await server.request('POST', '/dashboard-action.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { action: 'autofetch-pause', paused: true },
    });
    assert.equal(resPause.status, 200);
    assert.equal(resPause.json.ok, true);
    assert.equal(resPause.json.paused, true);
    assert.equal(autofetchLive.isPaused(), true);

    const resResume = await server.request('POST', '/dashboard-action.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { action: 'autofetch-pause', paused: false },
    });
    assert.equal(resResume.status, 200);
    assert.equal(resResume.json.ok, true);
    assert.equal(resResume.json.paused, false);
    assert.equal(autofetchLive.isPaused(), false);
  } finally {
    config.jackett.testToken = '';
  }
});

test('POST /dashboard-action.json autofetch-drain exige confirm: true e esvazia filas', async () => {
  config.jackett.testToken = TOKEN;
  try {
    const semConfirm = await server.request('POST', '/dashboard-action.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { action: 'autofetch-drain' },
    });
    assert.equal(semConfirm.status, 400);
    assert.equal(semConfirm.json.error, 'confirmation_required');

    // Cria uma fila fake para drenar
    autofetch.writeQueue('test-search-key', [
      { infoHash: '0123456789abcdef0123456789abcdef01234567', name: 'Test Torrent' },
    ]);
    const snapBefore = autofetch.snapshot();
    assert.ok(snapBefore.queues.count >= 1);

    const comConfirm = await server.request('POST', '/dashboard-action.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { action: 'autofetch-drain', confirm: true },
    });
    assert.equal(comConfirm.status, 200);
    assert.equal(comConfirm.json.ok, true);
    assert.ok(comConfirm.json.items >= 1);

    const snapAfter = autofetch.snapshot();
    assert.equal(snapAfter.queues.items, 0);
  } finally {
    config.jackett.testToken = '';
  }
});

test('POST /dashboard-action.json autofetch-config-set aplica e valida patch', async () => {
  config.jackett.testToken = TOKEN;
  try {
    const resInvalid = await server.request('POST', '/dashboard-action.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: {
        action: 'autofetch-config-set',
        patch: { autoFetchMax: 'invalido', chaveRuim: 1 },
      },
    });
    assert.equal(resInvalid.status, 400);
    assert.equal(resInvalid.json.ok, false);
    assert.equal(resInvalid.json.error, 'validation_error');
    assert.ok(Array.isArray(resInvalid.json.errors));

    const resValid = await server.request('POST', '/dashboard-action.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: {
        action: 'autofetch-config-set',
        patch: { autoFetchMax: 2, autoFetchEnqueueMaxHour: 25 },
      },
    });
    assert.equal(resValid.status, 200);
    assert.equal(resValid.json.ok, true);
    assert.equal(resValid.json.effective.autoFetchMax, 2);
    assert.equal(resValid.json.effective.autoFetchEnqueueMaxHour, 25);
    assert.ok(resValid.json.overriddenKeys.includes('autoFetchMax'));
    assert.ok(resValid.json.overriddenKeys.includes('autoFetchEnqueueMaxHour'));
  } finally {
    config.jackett.testToken = '';
  }
});

test('POST /dashboard-action.json autofetch-config-reset exige confirm: true e restaura defaults', async () => {
  config.jackett.testToken = TOKEN;
  try {
    autofetchLive.set({ autoFetchMax: 1 });
    assert.equal(autofetchLive.effective().autoFetchMax, 1);

    const semConfirm = await server.request('POST', '/dashboard-action.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { action: 'autofetch-config-reset' },
    });
    assert.equal(semConfirm.status, 400);
    assert.equal(semConfirm.json.error, 'confirmation_required');

    const comConfirm = await server.request('POST', '/dashboard-action.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { action: 'autofetch-config-reset', confirm: true },
    });
    assert.equal(comConfirm.status, 200);
    assert.equal(comConfirm.json.ok, true);
    assert.equal(comConfirm.json.effective.autoFetchMax, config.debrid.autoFetchMax);
  } finally {
    config.jackett.testToken = '';
  }
});

test('rotas escopadas /:userConfig/autofetch, status e action suportam Chupim', async () => {
  const userConfig = 'eyJwIjoiamFja2V0dCJ9';
  config.jackett.testToken = TOKEN;
  try {
    const resRedirect = await server.request('GET', `/${userConfig}/autofetch`);
    assert.equal(resRedirect.status, 302);
    assert.equal(resRedirect.headers.get('location'), `/${userConfig}/dashboard#autofetch`);

    const resStatus = await server.request('GET', `/${userConfig}/dashboard-status.json`, {
      headers: { 'X-Indexer-Test-Token': TOKEN },
    });
    assert.equal(resStatus.status, 200);
    assert.ok(resStatus.json.autofetch);
    assert.ok(resStatus.json.autofetch.config);
    // Instrumentação da desistência: motivos por portão + últimos registros do
    // trace + estado do gate de ocupação — tudo atrás do mesmo token.
    assert.ok(resStatus.json.autofetch.skips, 'autofetch.skips presente');
    assert.ok(Array.isArray(resStatus.json.autofetch.lastSkips), 'autofetch.lastSkips é array');
    assert.ok(resStatus.json.autofetch.accountGate, 'autofetch.accountGate presente');
    assert.equal(typeof resStatus.json.autofetch.accountGate.pauseAt, 'number');

    const resAction = await server.request('POST', `/${userConfig}/dashboard-action.json`, {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { action: 'autofetch-config-get' },
    });
    assert.equal(resAction.status, 200);
    assert.equal(resAction.json.ok, true);
    assert.equal(resAction.json.action, 'autofetch-config-get');
  } finally {
    config.jackett.testToken = '';
  }
});

test('GET /dashboard-status.json sem token não expõe o bloco autofetch', async () => {
  config.jackett.testToken = TOKEN;
  try {
    const semToken = await server.request('GET', '/dashboard-status.json');
    assert.equal(semToken.status, 401);
    assert.ok(semToken.json.error);
  } finally {
    config.jackett.testToken = '';
  }
});

