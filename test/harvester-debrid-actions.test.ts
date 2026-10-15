import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import { createApp } from '../src/app.js';
import config from '../src/config.js';
import * as cache from '../src/utils/cache.js';
import { prefix } from '../src/utils/cache-keys.js';
import * as secretBox from '../src/utils/secret-box.js';
import * as harvesterDebrid from '../src/utils/harvester-debrid-live.js';
import { DESTRUCTIVE_ACTIONS } from '../src/routes/dashboard-actions.js';
import { createTestServer } from './e2e/e2e-harness.js';

const TOKEN = 'tok-harvester-debrid';
const SECRET = 'segredo-do-operador-de-teste';
const PANEL_KEY = 'chave-painel-42-abcdef';
const ENV_KEY = 'chave-env-do-operador';

let server: any;
const saved: Record<string, any> = {};

before(async () => {
  saved.testToken = config.jackett.testToken;
  saved.service = config.debrid.service;
  saved.apiKey = config.debrid.apiKey;
  saved.allowEnvKey = config.debrid.allowEnvKey;
  saved.operatorEnvAccount = config.debrid.operatorEnvAccount;
  saved.resolveSecret = config.debrid.resolveSecret;

  // Estado base de operador: conta do .env utilizável via gate (allowEnvKey).
  config.jackett.testToken = '';
  config.debrid.service = 'alldebrid';
  config.debrid.apiKey = ENV_KEY;
  config.debrid.allowEnvKey = true;
  config.debrid.operatorEnvAccount = false;
  config.debrid.resolveSecret = SECRET;

  server = await createTestServer(createApp().app);
});

after(async () => {
  await server.close();
  config.jackett.testToken = saved.testToken;
  config.debrid.service = saved.service;
  config.debrid.apiKey = saved.apiKey;
  config.debrid.allowEnvKey = saved.allowEnvKey;
  config.debrid.operatorEnvAccount = saved.operatorEnvAccount;
  config.debrid.resolveSecret = saved.resolveSecret;
  harvesterDebrid.resetForTest();
});

beforeEach(() => {
  cache.clear();
  harvesterDebrid.resetForTest();
});

test('harvester-debrid: get e set exigem o token de diagnóstico', async () => {
  config.jackett.testToken = TOKEN;
  try {
    for (const action of ['harvester-debrid-get', 'harvester-debrid-set']) {
      const semToken = await server.request('POST', '/dashboard-action.json', { body: { action } });
      assert.equal(semToken.status, 401, `${action} sem token é rejeitado`);
    }
  } finally {
    config.jackett.testToken = '';
  }
});

test('harvester-debrid: get devolve snapshot seguro com a conta do .env', async () => {
  config.jackett.testToken = TOKEN;
  try {
    const res = await server.request('POST', '/dashboard-action.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { action: 'harvester-debrid-get' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.action, 'harvester-debrid-get');
    const cfg = res.json.config;
    assert.ok(cfg);
    assert.equal(cfg.service, 'alldebrid');
    assert.equal(cfg.source, 'env');
    assert.equal(cfg.keySet, true);
    assert.equal(cfg.last4, ENV_KEY.slice(-4));
    assert.ok(cfg.fingerprint);
    assert.equal(cfg.capabilities.quotaWarn, true);
    assert.equal(cfg.capabilities.brWarm, false);
    assert.equal('key' in cfg, false, 'nunca há campo "key" no snapshot');
    assert.equal(JSON.stringify(res.json).includes(ENV_KEY), false, 'corpo não ecoa a chave crua');
  } finally {
    config.jackett.testToken = '';
  }
});

test('harvester-debrid: set sem RESOLVE_SECRET recusa com 400 e não grava', async () => {
  config.jackett.testToken = TOKEN;
  config.debrid.resolveSecret = '';
  try {
    const res = await server.request('POST', '/dashboard-action.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { action: 'harvester-debrid-set', service: 'realdebrid', key: PANEL_KEY },
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.ok, false);
    assert.equal(res.json.reason, 'resolve_secret_required');
    assert.equal(harvesterDebrid.get(), null);
  } finally {
    config.debrid.resolveSecret = SECRET;
    config.jackett.testToken = '';
  }
});

test('harvester-debrid: set com serviço desconhecido recusa com 400', async () => {
  config.jackett.testToken = TOKEN;
  try {
    const res = await server.request('POST', '/dashboard-action.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { action: 'harvester-debrid-set', service: 'nope', key: PANEL_KEY },
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.reason, 'servico-desconhecido');
  } finally {
    config.jackett.testToken = '';
  }
});

test('harvester-debrid: set grava selo, resposta é segura e get confirma', async () => {
  config.jackett.testToken = TOKEN;
  try {
    const res = await server.request('POST', '/dashboard-action.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { action: 'harvester-debrid-set', service: 'realdebrid', key: PANEL_KEY },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    const cfg = res.json.config;
    assert.equal(cfg.source, 'panel');
    assert.equal(cfg.service, 'realdebrid');
    assert.equal(cfg.keySet, true);
    assert.equal(cfg.last4, PANEL_KEY.slice(-4));
    assert.equal(cfg.capabilities.brWarm, true);
    assert.equal(JSON.stringify(res.json).includes(PANEL_KEY), false, 'resposta não ecoa a chave crua');

    // Persistido selado (memória + cache), nunca em claro.
    const stored = harvesterDebrid.get();
    assert.ok(stored);
    assert.equal(stored!.service, 'realdebrid');
    assert.equal(secretBox.open(stored!.sealedKey), PANEL_KEY);
    const rawCache = cache.get(`${prefix('cfg')}harvesterDebrid`) as { sealedKey?: string } | null;
    assert.ok(rawCache);
    assert.equal(secretBox.isSealed(rawCache!.sealedKey), true);

    // Um segundo get devolve o mesmo blob seguro.
    const get2 = await server.request('POST', '/dashboard-action.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { action: 'harvester-debrid-get' },
    });
    assert.equal(get2.status, 200);
    assert.equal(get2.json.config.last4, PANEL_KEY.slice(-4));
    assert.equal(JSON.stringify(get2.json).includes(PANEL_KEY), false);
  } finally {
    config.jackett.testToken = '';
  }
});

test('harvester-debrid: reset via chave vazia restaura a conta do .env', async () => {
  config.jackett.testToken = TOKEN;
  try {
    assert.equal(harvesterDebrid.set('realdebrid', PANEL_KEY).ok, true);
    assert.equal(harvesterDebrid.get()?.service, 'realdebrid');

    const res = await server.request('POST', '/dashboard-action.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { action: 'harvester-debrid-set', service: 'realdebrid', key: '' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(harvesterDebrid.get(), null, 'override removido');
    const cfg = res.json.config;
    assert.equal(cfg.source, 'env', 'volta a enxergar a conta do .env');
    assert.equal(cfg.service, 'alldebrid');
    assert.equal(JSON.stringify(res.json).includes(PANEL_KEY), false);
  } finally {
    config.jackett.testToken = '';
  }
});

test('harvester-debrid: dashboard-status expõe identidade segura e o serviço resolvido', async () => {
  config.jackett.testToken = TOKEN;
  try {
    // Painel grava TorBox: o quota-warn resolvido passa a ser torbox.
    const set = await server.request('POST', '/dashboard-action.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { action: 'harvester-debrid-set', service: 'torbox', key: PANEL_KEY },
    });
    assert.equal(set.status, 200);

    const st = await server.request('GET', '/dashboard-status.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
    });
    assert.equal(st.status, 200);
    const harvest = st.json.harvest;
    assert.ok(harvest.debridAccount, 'bloco harvest.debridAccount presente');
    assert.equal(harvest.debridAccount.source, 'panel');
    assert.equal(harvest.debridAccount.service, 'torbox');
    assert.equal(harvest.debridAccount.keySet, true);
    assert.equal(harvest.debridAccount.capabilities.brWarm, false);
    assert.equal(JSON.stringify(harvest).includes(PANEL_KEY), false, 'status não ecoa a chave crua');
    assert.equal(harvest.debridResolved, 'torbox', 'serviço que o quota-warn usaria agora');
  } finally {
    config.jackett.testToken = '';
  }
});

test('harvester-debrid: ações NÃO são destrutivas (sem confirm) e não entram na allowlist destrutiva', async () => {
  config.jackett.testToken = TOKEN;
  try {
    assert.equal(DESTRUCTIVE_ACTIONS.has('harvester-debrid-get'), false);
    assert.equal(DESTRUCTIVE_ACTIONS.has('harvester-debrid-set'), false);

    // Sem `confirm` (exigido pelas destrutivas) o set funciona normalmente.
    const res = await server.request('POST', '/dashboard-action.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { action: 'harvester-debrid-set', service: 'realdebrid', key: PANEL_KEY },
    });
    assert.equal(res.status, 200);
  } finally {
    config.jackett.testToken = '';
  }
});