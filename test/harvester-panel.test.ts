import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createApp } from '../src/app.js';
import config from '../src/config.js';
import * as harvesterLive from '../src/utils/harvester-live.js';
import harvester from '../src/providers/harvester.js';
import * as metrics from '../src/utils/metrics.js';
import { createTestServer } from './e2e/e2e-harness.js';
import { bootstrapDashboard, dashboardHtml, loadDashboardModules, resetDashboardEnvironment } from './helpers/dashboard.js';

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

test('harvester.status: _origem marca queriesThisHour e queueDepth duravel', () => {
  const st = harvester.status() as any;
  assert.ok(st._origem, '_origem presente');
  assert.equal(st._origem.queriesThisHour, 'duravel');
  assert.equal(st._origem.queueDepth, 'duravel');
  assert.equal(st._origem.enabled, 'amostra');
  assert.equal(st._origem.lastRunAt, 'amostra');
  assert.equal(st._origem.paused, 'amostra');
  assert.equal(typeof st.queriesThisHour, 'number');
  assert.equal(typeof st.queueDepth, 'number');
  assert.equal(typeof st.enabled, 'boolean');
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

// ---------------------------------------------------------------------------
// Cliente ESM real (sem `new Function`): painel do Colhedor e conta de debrid.
// ---------------------------------------------------------------------------

function flat(node: any): string {
  if (!node) return '';
  return [String(node.textContent || '')].concat((node.children || []).map(flat)).join(' ');
}

test('dashboard-status: harvest.done/harvest.empty viajam nos counters e o painel os pinta', async () => {
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
  const { dom, mods } = await resetDashboardEnvironment(dashboardHtml());
  mods.harvest.renderHarvesterPanel({ enabled: true, config: { effective: {}, envDefaults: {}, overriddenKeys: [] } }, { 'harvest.done': 3, 'harvest.empty': 1 }, 1000);
  assert.equal(dom.byId['harvestMetricDone'].textContent, '3');
  assert.equal(dom.byId['harvestMetricEmpty'].textContent, '1');
  dom.cleanup();
});

test('HARVEST_KEYS cobre harvestBrFirst/harvestBrMaxWaitMs; só o toggle é booleano', async () => {
  const mods = await loadDashboardModules();
  assert.ok(mods.harvest.HARVEST_KEYS.includes('harvestBrFirst'), 'harvestBrFirst em HARVEST_KEYS');
  assert.ok(mods.harvest.HARVEST_KEYS.includes('harvestBrMaxWaitMs'), 'harvestBrMaxWaitMs em HARVEST_KEYS');
  assert.ok(mods.harvest.BOOLEAN_HARVEST_KEYS.includes('harvestBrFirst'), 'harvestBrFirst é booleano');
  assert.ok(!mods.harvest.BOOLEAN_HARVEST_KEYS.includes('harvestBrMaxWaitMs'), 'harvestBrMaxWaitMs é numérico');
  const html = dashboardHtml();
  for (const id of ['harvest_harvestBrFirst', 'harvest_harvestBrMaxWaitMs', 'env_harvest_harvestBrFirst', 'env_harvest_harvestBrMaxWaitMs']) {
    assert.match(html, new RegExp('id="' + id + '"'), id);
  }
});

test('preset de referência aplica os campos novos (módulo real)', async () => {
  const { dom, mods } = await resetDashboardEnvironment(dashboardHtml());
  mods.harvestActions.applyHarvesterPreset('padrao');
  assert.equal(dom.byId['harvest_harvestBrFirst'].checked, true);
  assert.equal(dom.byId['harvest_harvestBrMaxWaitMs'].value, '21600000');
  dom.cleanup();
});

test('dashboard.html: seção Conta de debrid do Colhedor com IDs e password sem valor pré-preenchido', () => {
  const html = dashboardHtml();
  for (const id of [
    'harvestDebridTitle', 'harvestDebridStatus', 'harvestDebridService', 'harvestDebridKey',
    'harvestDebridCaps', 'harvestDebridTestBtn', 'harvestDebridSaveBtn', 'harvestDebridResetBtn',
    'harvestDebridFeedback', 'harvestDebridOutput',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `id ${id} presente`);
  }
  const key = html.match(/<input id="harvestDebridKey"[^>]*>/)![0];
  assert.match(key, /type="password"/);
  assert.match(key, /autocomplete="off"/);
  assert.doesNotMatch(key, /value="/);
  assert.match(html, /<button id="harvestDebridTestBtn" type="button">Testar chave<\/button>/);
  assert.match(html, /<button id="harvestDebridSaveBtn" class="primary" type="button">Salvar conta<\/button>/);
  assert.match(html, /<button id="harvestDebridResetBtn" class="danger" type="button">Restaurar \.env<\/button>/);
});

test('boot ESM liga os controles da conta de debrid do Colhedor', async () => {
  const { dom, mods } = await bootstrapDashboard(dashboardHtml());
  assert.equal(dom.byId['harvestDebridService'].children.length, 5, 'select preenchido no boot');
  // Clique real no Testar sem chave cai no gate do módulo — prova o wiring.
  dom.byId['harvestDebridTestBtn'].dispatch('click');
  assert.match(dom.byId['harvestDebridFeedback'].textContent, /Cole a chave de API para testar/);
  // change do select atualiza a prévia de capacidades.
  assert.doesNotThrow(() => dom.byId['harvestDebridService'].dispatch('change'));
  for (const fn of ['testHarvestDebridKey', 'saveHarvestDebrid', 'resetHarvestDebrid', 'updateHarvestDebridCaps']) {
    assert.equal(typeof mods.harvestDebrid[fn], 'function', fn);
  }
  dom.cleanup();
});

test('renderHarvestDebridAccount: snapshot mascarado, fingerprint, origem e capacidades', async () => {
  const { dom, mods } = await resetDashboardEnvironment(dashboardHtml());
  dom.element('harvestDebridService').value = 'alldebrid';
  mods.harvestDebrid.renderHarvestDebridAccount({
    source: 'panel', service: 'alldebrid', keySet: true, last4: '1234', fingerprint: 'deadbeef',
    updatedAt: 1700000000000, capabilities: { quotaWarn: true, brWarm: false },
    capabilitiesByService: { alldebrid: { quotaWarn: true, brWarm: true } },
  }, null);
  const texto = flat(dom.byId['harvestDebridStatus']);
  assert.match(texto, /•••• 1234/);
  assert.match(texto, /Impressão digital/);
  assert.match(texto, /deadbeef/);
  assert.match(texto, /Origem/);
  assert.match(texto, /painel \(override\)/);
  mods.harvestDebrid.updateHarvestDebridCaps();
  const caps = flat(dom.byId['harvestDebridCaps']);
  assert.match(caps, /quota-warn: sim/);
  assert.match(caps, /aquecimento RD: sim/);
  dom.cleanup();
});

test('harvest-debrid: sem mapa de capacidades o render não afirma nada', async () => {
  const { dom, mods } = await resetDashboardEnvironment(dashboardHtml());
  mods.harvestDebrid.updateHarvestDebridCaps();
  assert.match(flat(dom.byId['harvestDebridCaps']), /capacidades: aguardando status/);
  dom.cleanup();
});

test('harvest-debrid: selo órfão (sealBroken) acende o aviso; caso contrário oculta', async () => {
  const { dom, mods } = await resetDashboardEnvironment(dashboardHtml());
  mods.harvestDebrid.renderHarvestDebridAccount({ source: 'panel', sealBroken: true, service: 'alldebrid' }, null);
  assert.match(dom.byId['harvestDebridSealWarn'].className, /visible/);
  mods.harvestDebrid.renderHarvestDebridAccount({ source: 'env', service: 'alldebrid' }, null);
  assert.ok(!/visible/.test(dom.byId['harvestDebridSealWarn'].className));
  dom.cleanup();
});

test('resetHarvestDebrid confirma antes do POST com key vazio (restaura .env)', async () => {
  const { dom, mods } = await resetDashboardEnvironment(dashboardHtml());
  const requests: any[] = [];
  dom.setFetch((url: string, init: any) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, config: {} }) });
  });
  mods.state.DashState.token = 'tok';
  dom.element('harvestDebridService').value = 'alldebrid';
  dom.element('harvestDebridKey').value = '';
  mods.hooks.hooks.register('loadStatus', () => {});
  dom.window.confirm = () => false;
  mods.harvestDebrid.resetHarvestDebrid();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(requests.length, 0, 'cancelar não posta');
  dom.window.confirm = () => true;
  mods.harvestDebrid.resetHarvestDebrid();
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(requests[0].body.action, 'harvester-debrid-set');
  assert.equal(requests[0].body.key, '', 'key vazio restaura o .env');
  dom.cleanup();
});

test('a chave sai do input em todo desfecho e nunca vira conteúdo renderizado', async () => {
  const { dom, mods } = await resetDashboardEnvironment(dashboardHtml());
  const requests: any[] = [];
  dom.setFetch((url: string, init: any) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
  });
  mods.state.DashState.token = 'tok';
  dom.element('harvestDebridService').value = 'alldebrid';
  const secret = 'chave-harvest-secreta-9999';
  dom.element('harvestDebridKey').value = secret;
  mods.harvestDebrid.testHarvestDebridKey();
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(requests[0].body.action, 'debrid-account-test');
  assert.equal(requests[0].body.key, secret, 'a chave viaja só no corpo');
  assert.equal(dom.byId['harvestDebridKey'].value, '', 'input limpo em todo desfecho');
  const rendered = flat(dom.byId['harvestDebridOutput']) + ' ' + flat(dom.byId['harvestDebridFeedback']);
  assert.equal(rendered.includes(secret), false, 'a chave nunca vira conteúdo renderizado');
  dom.cleanup();
});

test('os módulos harvest/debrid não usam innerHTML', () => {
  for (const file of ['harvest.ts', 'harvest-actions.ts', 'harvest-debrid.ts']) {
    const src = readFileSync(new URL('../../src/client/dashboard/' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /innerHTML/, file + ' só usa textContent/appendChild');
  }
});
