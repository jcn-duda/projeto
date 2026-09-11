import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createApp } from '../src/app.js';
import config from '../src/config.js';
import * as harvesterLive from '../src/utils/harvester-live.js';
import harvester from '../src/providers/harvester.js';
import * as metrics from '../src/utils/metrics.js';
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

test('harvester.status: _origem marca queriesThisHour e queueDepth duravel', () => {
  const st = harvester.status() as any;
  assert.ok(st._origem, '_origem presente');
  assert.equal(st._origem.queriesThisHour, 'duravel');
  assert.equal(st._origem.queueDepth, 'duravel');
  assert.equal(st._origem.enabled, 'amostra');
  assert.equal(st._origem.lastRunAt, 'amostra');
  assert.equal(st._origem.paused, 'amostra');
  // Campos existentes intactos (contrato aditivo).
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



test('dashboard-status: harvest.done/harvest.empty viajam nos counters para o painel ES5', async () => {
  config.jackett.testToken = TOKEN;
  try {
    // O bloco metrics.counters do /dashboard-status.json já embarca as métricas
    // (diagnostics.ts); o painel ES5 (dashboard-harvest.js) só precisa ler as chaves.
    // aqui se prova que elas chegam no payload e que o módulo referencia as duas.
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

    // Renderização: os cards existem no HTML; as chaves estão no módulo harvest.
    const html = readFileSync(new URL('../src/public/dashboard.html', import.meta.url), 'utf8');
    const harvestJs = readFileSync(new URL('../src/public/dashboard-harvest.js', import.meta.url), 'utf8');
    assert.match(html, /id="harvestMetricDone"/);
    assert.match(html, /id="harvestMetricEmpty"/);
    assert.match(harvestJs, /ctr\["harvest\.done"\]/);
    assert.match(harvestJs, /ctr\["harvest\.empty"\]/);
  } finally {
    config.jackett.testToken = '';
  }
});

test('dashboard.html: os controles novos do colhedor têm ID, entram em harvestKeys e o JS segue ES5', () => {
  const html = readFileSync(new URL('../src/public/dashboard.html', import.meta.url), 'utf8');
  const harvestJs = readFileSync(new URL('../src/public/dashboard-harvest.js', import.meta.url), 'utf8');
  // IDs dos dois controles novos introduzidos na Fase 3.2.
  assert.match(html, /id="harvest_harvestBrFirst"/);
  assert.match(html, /id="harvest_harvestBrMaxWaitMs"/);
  assert.match(html, /id="env_harvest_harvestBrFirst"/);
  assert.match(html, /id="env_harvest_harvestBrMaxWaitMs"/);

  // A lista de chaves que o painel serializa precisa cobrir os dois campos.
  const harvestKeysMatch = harvestJs.match(/var harvestKeys\s*=\s*\[([^\]]*)\]/);
  assert.ok(harvestKeysMatch, 'harvestKeys declarado no dashboard-harvest.js');
  const keys = harvestKeysMatch![1].split(',').map((s) => s.replace(/["'\s]/g, '')).filter(Boolean);
  assert.ok(keys.includes('harvestBrFirst'), 'harvestBrFirst entra em harvestKeys');
  assert.ok(keys.includes('harvestBrMaxWaitMs'), 'harvestBrMaxWaitMs entra em harvestKeys');

  // Só o toggle (booleano) pertence a booleanHarvestKeys; o prazo é numérico.
  const boolMatch = harvestJs.match(/var booleanHarvestKeys\s*=\s*\[([^\]]*)\]/);
  assert.ok(boolMatch, 'booleanHarvestKeys declarado no dashboard-harvest.js');
  const bools = boolMatch![1].split(',').map((s) => s.replace(/["'\s]/g, '')).filter(Boolean);
  assert.ok(bools.includes('harvestBrFirst'), 'harvestBrFirst é booleano');
  assert.ok(!bools.includes('harvestBrMaxWaitMs'), 'harvestBrMaxWaitMs é numérico e fora de booleanHarvestKeys');

  assert.doesNotMatch(harvestJs, /\b(?:const|let)\b|=>|\?\.|\?\?/, 'dashboard-harvest.js continua ES5 (WebView de Smart TV)');
  assert.doesNotMatch(html, /\b(?:const|let)\b|=>|\?\.|\?\?/, 'dashboard.html continua ES5 (WebView de Smart TV)');
});

test('dashboard.html: o preset de referência aplica os campos novos (ES5 literais)', () => {
  const harvestJs = readFileSync(new URL('../src/public/dashboard-harvest.js', import.meta.url), 'utf8');
  assert.match(harvestJs, /\$\("harvest_harvestBrFirst"\)\.checked = true/);
  assert.match(harvestJs, /\$\("harvest_harvestBrMaxWaitMs"\)\.value = 21600000/);
});

// ---------------------------------------------------------------------------
// Conta de debrid do Colhedor (API de fundo): seção do painel. Contrato do
// backend em harvester-debrid-live.ts — snapshot nunca ecoa a chave crua;
// `harvester-debrid-set` com key vazio restaura o .env; o teste da chave
// reutiliza o `debrid-account-test`. Aqui: HTML, JS, ES5 e sem vazamento.
// ---------------------------------------------------------------------------

function harvestDebridHtml(): string {
  return readFileSync(new URL('../src/public/dashboard.html', import.meta.url), 'utf8');
}

function harvestDebridJs(): string {
  // A lógica da conta de debrid do Colhedor foi extraída para um módulo
  // próprio (dashboard-harvest-debrid.js) por causa do teto de 400 linhas do
  // dashboard-harvest.js; os testes regexam os DOIS como um bloco contíguo.
  const main = readFileSync(new URL('../src/public/dashboard-harvest.js', import.meta.url), 'utf8');
  const debrid = readFileSync(new URL('../src/public/dashboard-harvest-debrid.js', import.meta.url), 'utf8');
  return main + '\n' + debrid;
}

test('dashboard.html: seção Conta de debrid do Colhedor com IDs e password sem valor pré-preenchido', () => {
  const html = harvestDebridHtml();
  for (const id of [
    'harvestDebridTitle', 'harvestDebridStatus', 'harvestDebridService', 'harvestDebridKey',
    'harvestDebridCaps', 'harvestDebridTestBtn', 'harvestDebridSaveBtn', 'harvestDebridResetBtn',
    'harvestDebridFeedback', 'harvestDebridOutput',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `id ${id} presente`);
  }
  // Credencial: password, autocomplete off e NUNCA valor no HTML (nada de
  // pre-preencher a chave do .env nem ecoar o que foi digitado).
  const key = html.match(/<input id="harvestDebridKey"[^>]*>/)![0];
  assert.match(key, /type="password"/);
  assert.match(key, /autocomplete="off"/);
  assert.doesNotMatch(key, /value="/);
  // Botões da seção: Testar, Salvar e Restaurar .env.
  assert.match(html, /<button id="harvestDebridTestBtn" type="button">Testar chave<\/button>/);
  assert.match(html, /<button id="harvestDebridSaveBtn" class="primary" type="button">Salvar conta<\/button>/);
  assert.match(html, /<button id="harvestDebridResetBtn" class="danger" type="button">Restaurar \.env<\/button>/);
});

test('dashboard-boot.js: liga os controles da conta de debrid do Colhedor', () => {
  const boot = readFileSync(new URL('../src/public/dashboard-boot.js', import.meta.url), 'utf8');
  assert.match(boot, /fillHarvestDebridServices\(\)/, 'select preenchido no boot');
  assert.match(boot, /updateHarvestDebridCaps\(\)/, 'prévia de capacidades no boot');
  assert.match(boot, /\$\("harvestDebridService"\)\.addEventListener\("change", updateHarvestDebridCaps\)/);
  assert.match(boot, /\$\("harvestDebridTestBtn"\)\.addEventListener\("click", function \(\) \{ testHarvestDebridKey\(/);
  assert.match(boot, /\$\("harvestDebridSaveBtn"\)\.addEventListener\("click", function \(\) \{ saveHarvestDebrid\(/);
  assert.match(boot, /\$\("harvestDebridResetBtn"\)\.addEventListener\("click", function \(\) \{ resetHarvestDebrid\(/);
});

test('dashboard-harvest.js: snapshot mascarado renderizado, ES5 e sem innerHTML', () => {
  const js = harvestDebridJs();
  // O render é alimentado pelo bloco harvest do dashboard-status.
  assert.match(js, /renderHarvestDebridAccount\(harvest\.debridAccount, harvest\.debridResolved\)/);
  // Status mascarado: bullets + last4 + fingerprint; origem e capabilities.
  assert.match(js, /"•••• " \+ valueText\(a\.last4\)/);
  assert.match(js, /harvestDebridStat\("Impressão digital", a\.fingerprint\)/);
  assert.match(js, /harvestDebridStat\("Origem", harvestDebridSourceLabel\(a\.source\)\)/);
  assert.match(js, /harvestDebridStat\("quota-warn", caps\.quotaWarn === true \? "sim" : "não"\)/);
  assert.match(js, /harvestDebridStat\("aquecimento RD", caps\.brWarm === true \? "sim" : "não"\)/);
  assert.doesNotMatch(js, /\b(?:const|let)\b|=>|\?\.|\?\?/, 'dashboard-harvest.js continua ES5');
  assert.doesNotMatch(js, /innerHTML/, 'render só por textContent/appendChild');
});

test('dashboard-harvest.js: capacidades vêm do backend (capabilitiesByService), sem tabela duplicada', () => {
  const js = harvestDebridJs();
  // Não há mais mapa hardcoded; o render alimenta HD_CAPS_BY_SERVICE do
  // snapshot (mesma fonte do deriveCapabilities do backend, sem drift).
  assert.doesNotMatch(js, /HD_CAPABILITIES\s*=\s*\{/, 'sem mapa de capacidades hardcoded');
  assert.match(js, /HD_CAPS_BY_SERVICE/, 'mapa derivado do backend presente');
  assert.match(js, /a\.capabilitiesByService/, 'render lê capabilitiesByService do snapshot');
  // A prévia usa o mapa derivado; serviço sem registro cai no seguro "não".
  assert.match(js, /HD_CAPS_BY_SERVICE\[String\(\$\("harvestDebridService"\)\.value \|\| ""\)\] \|\| null/);
  assert.match(js, /capacidades: aguardando status/, 'primeiro paint não afirma capacidade antes do snapshot');
});

test('dashboard-harvest.js: aviso de selo órfão (RESOLVE_SECRET alterado) quando sealBroken', () => {
  const js = harvestDebridJs();
  assert.match(js, /a\.sealBroken/, 'render lê sealBroken do snapshot');
  assert.match(js, /harvestDebridSealWarn/, 'aviso de selo órfão presente');
  // Só mostra quando source=panel e sealBroken; caso contrário oculta o banner.
  assert.match(js, /a\.source === "panel" && a\.sealBroken/);
});

test('dashboard-harvest.js: reset pede confirmação antes do POST com key vazio (restaura .env)', () => {
  const js = harvestDebridJs();
  const idx = js.indexOf('function resetHarvestDebrid');
  assert.ok(idx !== -1, 'resetHarvestDebrid presente');
  const body = js.slice(idx, idx + 400);
  const confirmIdx = body.indexOf('window.confirm');
  const setIdx = body.indexOf('harvestDebridSet("",');
  assert.ok(confirmIdx !== -1 && setIdx !== -1 && confirmIdx < setIdx, 'confirm antes do POST');
  // key vazio no POST é o caminho de restaurar o .env no contrato do backend.
  assert.match(js, /harvester-debrid-set", \{ action: "harvester-debrid-set", service: service, key: key \}/);
});

test('dashboard-harvest.js: a chave sai do input em todo desfecho e nunca vira conteúdo renderizado', () => {
  const js = harvestDebridJs();
  // Limpeza do input nos desfechos de teste E de salvar/restaurar (cada
  // .then de resultado chama clearHarvestDebridKey).
  const limpezas = js.match(/clearHarvestDebridKey\(\)/g) || [];
  assert.ok(limpezas.length >= 2, `input limpo em todo desfecho (achou ${limpezas.length})`);
  // A leitura do input vira só corpo do POST (gates + payload); nada dela em
  // textContent/appendChild/className.
  assert.match(js, /var key = readHarvestDebridKey\(\)/);
  assert.match(js, /key: key \}/, 'a chave só viaja no corpo da ação');
  assert.doesNotMatch(js, /textContent\s*=\s*[^;\n]*\bkey\b/, 'a chave nunca entra em textContent');
  assert.doesNotMatch(js, /appendChild\([^;\n]*\bkey\b/, 'a chave nunca entra no DOM');
  // Erro do set mostra reason legível + fix (resolve_secret_required com conserto).
  assert.match(js, /HD_REASON_LABELS\[data\.reason\] \|\| valueText\(data\.reason\)/);
  assert.match(js, /"resolve_secret_required": "RESOLVE_SECRET ausente no \.env"/);
});
