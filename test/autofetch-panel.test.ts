import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import config from '../src/config.js';
import debrid from '../src/debrid/index.js';
import type { DebridAdapter } from '../types/domain.js';
import * as autofetchLive from '../src/utils/autofetch-live.js';
import * as autofetch from '../src/providers/autofetch.js';
import * as suppressed from '../src/providers/autofetch-suppressed.js';
import * as harvesterDebrid from '../src/utils/harvester-debrid-live.js';
import { DESTRUCTIVE_ACTIONS } from '../src/routes/dashboard-actions.js';
import { accountScope } from '../src/utils/request-key.js';
import * as cache from '../src/utils/cache.js';
import { createTestServer } from './e2e/e2e-harness.js';

const TOKEN = 'tok-autofetch-test';
let server: any;
let savedToken: string;

// --- Fila de remoções represadas (autofetch-suppressed) --------------------

// Adapter fake da conta do operador: `accountStatus` é o que o resolveQuota
// exige; o `removeTorrent` stubado por teste prova que o drain do painel chega
// ao serviço com o knob global DESLIGADO (a porta supervisionada).
const SUP_ADAPTER = {
  id: 'supfake', label: 'SupFake', short: 'SF', cacheCheck: false, keyUrl: '' as unknown as string,
  checkCached: async () => new Set<string>(), resolveLink: async () => null,
  accountStatus: async () => ({ ok: true }), removeTorrent: async () => true,
} as unknown as DebridAdapter;

const OPERATOR_KEY = 'chave-operador-suppressed-teste';
const OPERATOR_ACCOUNT = accountScope(OPERATOR_KEY);
const SUP_HASHES = ['1'.repeat(40), '2'.repeat(40), '3'.repeat(40)];

function seedSuppressed(hashes: string[]) {
  for (const h of hashes) suppressed.noteSuppressed('supfake', OPERATOR_ACCOUNT, h, `id-${h[0]}`);
}

function cleanSuppressed(hashes: string[]) {
  for (const h of hashes) suppressed.forgetSuppressed('supfake', OPERATOR_ACCOUNT, h);
}

// Bloco debrid salvo/restaurado por teste; a conta do operador vem do .env com
// o gate aberto (o caminho que o resolveQuota usa sem override do painel).
function debridState() {
  const saved = { service: config.debrid.service, apiKey: config.debrid.apiKey, allow: config.debrid.allowEnvKey, op: config.debrid.operatorEnvAccount, knob: config.debrid.removeById };
  harvesterDebrid.resetForTest();
  return {
    open() { config.debrid.service = 'supfake'; config.debrid.apiKey = OPERATOR_KEY; config.debrid.allowEnvKey = true; config.debrid.operatorEnvAccount = false; },
    close() { config.debrid.service = ''; config.debrid.apiKey = ''; config.debrid.allowEnvKey = false; config.debrid.operatorEnvAccount = false; },
    restore() {
      config.debrid.service = saved.service; config.debrid.apiKey = saved.apiKey; config.debrid.allowEnvKey = saved.allow;
      config.debrid.operatorEnvAccount = saved.op; config.debrid.removeById = saved.knob;
      harvesterDebrid.resetForTest();
    },
  };
}

before(async () => {
  savedToken = config.jackett.testToken;
  config.jackett.testToken = '';
  debrid.BY_ID.set(SUP_ADAPTER.id, SUP_ADAPTER);
  server = await createTestServer(createApp().app);
});

after(async () => {
  await server.close();
  debrid.BY_ID.delete(SUP_ADAPTER.id);
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

test('autofetch.snapshot: _origem marca queues e deadBlacklist duravel', () => {
  const snap = autofetch.snapshot();
  assert.ok(snap._origem, '_origem presente');
  assert.equal(snap._origem.queues, 'duravel');
  assert.equal(snap._origem.deadBlacklistCount, 'duravel');
  assert.equal(snap._origem.budget, 'amostra');
  assert.equal(snap._origem.accountGate, 'amostra');
  assert.equal(snap._origem.suppressed, 'duravel', 'fila represada é varredura do L1');
  assert.equal(typeof snap.suppressed, 'number', 'agregado da fila represada presente');
  // Campos existentes intactos (contrato aditivo).
  assert.equal(typeof snap.deadBlacklistCount, 'number');
  assert.ok(snap.queues && typeof snap.queues.count === 'number');
  assert.ok(snap.budget && typeof snap.budget.used === 'number');
  assert.ok(snap.accountGate && typeof snap.accountGate.pauseAt === 'number');
});

// --- Fila de remoções represadas (autofetch-suppressed) --------------------

test('autofetch-suppressed-get/drain sem conta de operador: 400 com o fix da aba do Colhedor', async () => {
  assert.ok(DESTRUCTIVE_ACTIONS.has('autofetch-suppressed-drain'), 'drain é destrutiva');
  assert.equal(DESTRUCTIVE_ACTIONS.has('autofetch-suppressed-get'), false, 'get é leitura');
  const st = debridState();
  config.jackett.testToken = TOKEN;
  try {
    st.close();
    for (const action of ['autofetch-suppressed-get', 'autofetch-suppressed-drain']) {
      const res = await server.request('POST', '/dashboard-action.json', {
        headers: { 'X-Indexer-Test-Token': TOKEN },
        body: { action, confirm: true },
      });
      assert.equal(res.status, 400, `${action} sem conta recusa`);
      assert.equal(res.json.ok, false);
      assert.equal(res.json.reason, 'sem-conta-operador');
      assert.ok(String(res.json.fix).includes('Conta de debrid do Colhedor'), `fix aponta a aba (${action})`);
    }
  } finally {
    st.restore();
    config.jackett.testToken = '';
  }
});

test('dashboard-status.json traz autofetch.suppressed com DEBRID_REMOVE_BY_ID desligado', async () => {
  const savedKnob = config.debrid.removeById;
  config.debrid.removeById = false;
  config.jackett.testToken = TOKEN;
  try {
    seedSuppressed(SUP_HASHES.slice(0, 1));
    const res = await server.request('GET', '/dashboard-status.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
    });
    assert.equal(res.status, 200);
    assert.ok(res.json.autofetch.suppressed >= 1, 'a fila aparece mesmo sem o knob');
    assert.equal(res.json.autofetch._origem.suppressed, 'duravel');
  } finally {
    config.jackett.testToken = '';
    config.debrid.removeById = savedKnob;
    cleanSuppressed(SUP_HASHES.slice(0, 1));
  }
});

test('autofetch-suppressed-get devolve pending/elegiveis/adapter sem ecoar credencial', async () => {
  const st = debridState();
  config.jackett.testToken = TOKEN;
  try {
    st.open();
    config.debrid.removeById = false;
    seedSuppressed(SUP_HASHES.slice(0, 2));
    const res = await server.request('POST', '/dashboard-action.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { action: 'autofetch-suppressed-get' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.adapter, 'supfake');
    assert.equal(res.json.pending, 2, 'profundidade completa da conta do operador');
    assert.equal(res.json.elegiveis, 2, 'todos elegíveis (nenhum em backoff)');
    assert.equal('total' in res.json, false, 'o agregado de todas as contas mora só no snapshot');
    const body = JSON.stringify(res.json);
    assert.equal(body.includes(OPERATOR_KEY), false, 'não ecoa a chave');
    assert.equal(body.includes(OPERATOR_ACCOUNT), false, 'não ecoa o hash da conta');
  } finally {
    cleanSuppressed(SUP_HASHES.slice(0, 2));
    st.restore();
    config.jackett.testToken = '';
  }
});

test('autofetch-suppressed-drain exige confirm, honra max e drena sem ligar o knob', async () => {
  const removidos: Array<string | number> = [];
  SUP_ADAPTER.removeTorrent = async (_apiKey: string, id: string | number) => { removidos.push(id); return true; };
  const st = debridState();
  config.jackett.testToken = TOKEN;
  try {
    st.open();
    config.debrid.removeById = false; // a porta do painel NÃO exige o knob global
    seedSuppressed(SUP_HASHES);
    const semConfirm = await server.request('POST', '/dashboard-action.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { action: 'autofetch-suppressed-drain' },
    });
    assert.equal(semConfirm.status, 400);
    assert.equal(semConfirm.json.error, 'confirmation_required');
    assert.equal(removidos.length, 0, 'nada toca o serviço sem confirm');

    const drenado = await server.request('POST', '/dashboard-action.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { action: 'autofetch-suppressed-drain', confirm: true, max: 2 },
    });
    assert.equal(drenado.status, 200);
    assert.equal(drenado.json.ok, true);
    assert.equal(drenado.json.elegiveis, 3, 'a fila inteira estava elegível');
    assert.equal(drenado.json.removidas, 2, 'max do corpo vence o teto da passagem');
    assert.equal(drenado.json.restantes, 1, 'o que sobrou fica declarado');
    assert.equal(removidos.length, 2, 'removeTorrent chamou só pelo teto');
    assert.equal(suppressed.countSuppressed('supfake', OPERATOR_ACCOUNT), 1);
    const body = JSON.stringify(drenado.json);
    assert.equal(body.includes(OPERATOR_KEY), false, 'resposta não ecoa a chave');
    assert.equal(body.includes(OPERATOR_ACCOUNT), false, 'resposta não ecoa o hash da conta');

    const segundo = await server.request('POST', '/dashboard-action.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { action: 'autofetch-suppressed-drain', confirm: true },
    });
    assert.equal(segundo.status, 200);
    assert.equal(segundo.json.removidas, 1, 'segunda passagem drena o restante');
    assert.equal(segundo.json.restantes, 0);
  } finally {
    cleanSuppressed(SUP_HASHES);
    st.restore();
    config.jackett.testToken = '';
  }
});

