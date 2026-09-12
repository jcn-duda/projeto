import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import { createApp } from '../src/app.js';
import config from '../src/config.js';
import * as cache from '../src/utils/cache.js';
import { createTestServer, encodeConfig } from './e2e/e2e-harness.js';
import { loadDashboardModules, resetDashboardEnvironment } from './helpers/dashboard.js';

const TOKEN = 'tok-modernization-test';
let server: any;
const saved: Record<string, any> = {};

before(async () => {
  saved.testToken = config.jackett.testToken;
  saved.jackettApiKey = config.jackett.apiKey;
  config.jackett.testToken = '';
  config.jackett.apiKey = '';
  server = await createTestServer(createApp().app);
});

after(async () => {
  await server.close();
  config.jackett.testToken = saved.testToken;
  config.jackett.apiKey = saved.jackettApiKey;
});

// ---------------------------------------------------------------------------
// Servidor: rota única de ações, 503/401/execução e métricas L2.
// ---------------------------------------------------------------------------

test('POST /dashboard-action.json: 503 sem token configurado', async () => {
  const res = await server.request('POST', '/dashboard-action.json', { body: { action: 'clear-cache' } });
  assert.equal(res.status, 503);
  assert.equal(res.json.ok, false);
});

test('POST /dashboard-action.json: 401 sem token ou token errado', async () => {
  config.jackett.testToken = TOKEN;
  try {
    assert.equal((await server.request('POST', '/dashboard-action.json', { body: { action: 'clear-cache' } })).status, 401);
    assert.equal((await server.request('POST', '/dashboard-action.json', { headers: { 'X-Indexer-Test-Token': 'tok-invalido' }, body: { action: 'clear-cache' } })).status, 401);
  } finally {
    config.jackett.testToken = '';
  }
});

test('POST /dashboard-action.json: ação executa ponta a ponta', async () => {
  config.jackett.testToken = TOKEN;
  try {
    cache.set('raw:modern-test', { a: 1 }, 60);
    assert.ok(cache.size() > 0);
    const res = await server.request('POST', '/dashboard-action.json', { headers: { 'X-Indexer-Test-Token': TOKEN }, body: { action: 'clear-cache', confirm: true } });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.action, 'clear-cache');
    assert.equal(res.json.entriesAfter, 0);
  } finally {
    config.jackett.testToken = '';
  }
});

test('POST /:userConfig/dashboard-action.json responde contextualizado', async () => {
  config.jackett.testToken = TOKEN;
  try {
    const userCfg = encodeConfig({ maxResults: 15 });
    const res = await server.request('POST', `/${userCfg}/dashboard-action.json`, { headers: { 'X-Indexer-Test-Token': TOKEN }, body: { action: 'clear-cache', confirm: true } });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
  } finally {
    config.jackett.testToken = '';
  }
});

test('POST /dashboard-actions (plural) não existe', async () => {
  config.jackett.testToken = TOKEN;
  try {
    assert.equal((await server.request('POST', '/dashboard-actions', { headers: { 'X-Indexer-Test-Token': TOKEN }, body: { action: 'clear-cache', confirm: true } })).status, 404);
  } finally {
    config.jackett.testToken = '';
  }
});

test('cache.l2Stats(): métricas non-blocking do SQLite L2', () => {
  const stats = cache.l2Stats();
  assert.ok(typeof stats === 'object' && stats !== null);
  for (const key of ['fileSizeBytes', 'walSizeBytes', 'freelistCount', 'pendingWrites']) assert.ok(key in stats, key);
  assert.ok(!('freelistPages' in stats));
  assert.ok(!('pendingFlush' in stats));
  assert.equal((stats as any)._origem.fileSizeBytes, 'duravel');
  assert.equal((stats as any)._origem.pendingWrites, 'amostra');
  assert.equal(typeof stats.fileSizeBytes, 'number');
});

test('GET /dashboard-status.json inclui cache.l2', async () => {
  config.jackett.testToken = TOKEN;
  try {
    const res = await server.request('GET', '/dashboard-status.json', { headers: { 'X-Indexer-Test-Token': TOKEN } });
    assert.equal(res.status, 200);
    assert.ok(res.json.cache && typeof res.json.cache.l2 === 'object');
    for (const key of ['fileSizeBytes', 'walSizeBytes', 'pendingWrites']) assert.ok(key in res.json.cache.l2, key);
  } finally {
    config.jackett.testToken = '';
  }
});

test('GET /test-indexer.json e /test-resolver.json aceitam parâmetros', async () => {
  config.jackett.testToken = TOKEN;
  try {
    const idx = await server.request('GET', '/test-indexer.json?id=bludv-cardigann&q=avatar&type=series', { headers: { 'X-Indexer-Test-Token': TOKEN } });
    assert.ok([200, 502, 504].includes(idx.status));
    assert.ok('indexer' in idx.json);
    const res = await server.request('GET', '/test-resolver.json?id=vacatorrent&q=avatar', { headers: { 'X-Indexer-Test-Token': TOKEN } });
    assert.ok([200, 502, 504].includes(res.status));
    assert.ok('resolver' in res.json);
  } finally {
    config.jackett.testToken = '';
  }
});

// ---------------------------------------------------------------------------
// Cliente: coletor de issues do banner (módulo ESM real).
// ---------------------------------------------------------------------------

test('Vetor 1: indexador offline gera issue mesmo sem breaker aberto', async () => {
  const { dom, mods } = await resetDashboardEnvironment();
  const issues = mods.statusIssues.collectStatusIssues({ indexers: [{ id: 'track1', name: 'Track1', online: false, breaker: { state: 'fechado', open: false } }], resolvers: [], debrid: null });
  assert.ok(issues.some((i: any) => i.text.includes('Track1') && i.text.includes('offline')));
  dom.cleanup();
});

test('Vetor 2: indexador recém-iniciado (breaker naomedido) permanece neutro', async () => {
  const { dom, mods } = await resetDashboardEnvironment();
  const issues = mods.statusIssues.collectStatusIssues({ indexers: [{ id: 'track2', name: 'Track2', breaker: { state: 'naomedido' } }], resolvers: [], debrid: null });
  assert.equal(issues.filter((i: any) => i.state === 'warn').length, 0);
  dom.cleanup();
});

test('Vetor 3: resolver quebrado/offline gera issue', async () => {
  const { dom, mods } = await resetDashboardEnvironment();
  const issues = mods.statusIssues.collectStatusIssues({ indexers: [], resolvers: [{ id: 'res1', label: 'Res 1', broken: true }, { id: 'res2', label: 'Res 2', online: false }], debrid: null });
  assert.ok(issues.some((i: any) => i.text.includes('Res 1')));
  assert.ok(issues.some((i: any) => i.text.includes('Res 2')));
  dom.cleanup();
});

test('Vetor 4: conta de debrid warn gera issue no banner', async () => {
  const { dom, mods } = await resetDashboardEnvironment();
  const issues = mods.statusIssues.collectStatusIssues({
    indexers: [], resolvers: [],
    debrid: { account: { service: 'realdebrid', ok: true, warn: true, label: 'RealDebrid' }, accounts: { realdebrid: { service: 'realdebrid', ok: true, warn: true, label: 'RealDebrid' } } },
  });
  assert.ok(issues.some((i: any) => i.text.includes('RealDebrid') && i.text.includes('aviso operacional')));
  dom.cleanup();
});

// Os quatro campos do L2 declaram procedência (durable × sample) via o mesmo
// helper; o painel consome metricMaybeOrigem em cada um.
test('painel: os quatro campos do L2 declaram procedência', async () => {
  const { dom, mods } = await resetDashboardEnvironment();
  mods.panelsL2.renderCache(
    { namespaces: [], l2: { _origem: { fileSizeBytes: 'duravel', walSizeBytes: 'duravel', freelistCount: 'duravel', pendingWrites: 'amostra' }, fileSizeBytes: 2048, walSizeBytes: 0, freelistCount: 0, pendingWrites: 0 } },
    {},
  );
  const l2 = dom.byId['cacheMetrics'].children.filter((item: any) => item.children && String(item.children[0] && item.children[0].textContent).includes('L2'));
  assert.equal(l2.length, 4);
  for (const item of l2) assert.ok(item.children[1].title.length > 0);
  dom.cleanup();
});

test('módulos do dashboard não usam innerHTML para dados', async () => {
  const mods = await loadDashboardModules();
  assert.equal(typeof mods.magnets.renderMagnetDb, 'function');
  // O único innerHTML do painel é o <option> estático do seletor de namespace
  // (status-actions): dados de rede nunca viram HTML.
  const { readFileSync } = await import('node:fs');
  const statusActions = readFileSync(new URL('../../src/client/dashboard/status-actions.ts', import.meta.url), 'utf8');
  const uses = statusActions.match(/innerHTML\s*=[^;]+;/g) || [];
  assert.equal(uses.length, 1);
  assert.doesNotMatch(uses[0], /\+/);
});
