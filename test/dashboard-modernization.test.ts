import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.CACHE_PERSIST = 'false';

import { createApp } from '../src/app.js';
import config from '../src/config.js';
import * as cache from '../src/utils/cache.js';
import { createTestServer, encodeConfig } from './e2e/e2e-harness.js';
import { PAGE_ASSETS } from '../src/routes/public.js';

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
// R3: ROTA ÚNICA de ações. O painel de magnets nasceu chamando
// /dashboard-actions (plural), o que exigia registrar um alias permanente do
// mesmo handler nas duas variantes. Uma string no cliente é mais barata que
// superfície pública duplicada, que sai de sincronia na próxima mudança de
// auth/limite/prefixo. Os testes abaixo cobrem a rota canônica E fixam a
// ausência do alias, para ele não voltar em silêncio.
// ---------------------------------------------------------------------------

test('POST /dashboard-action.json: 503 sem token configurado', async () => {
  const res = await server.request('POST', '/dashboard-action.json', {
    body: { action: 'clear-cache' },
  });
  assert.equal(res.status, 503);
  assert.equal(res.json.ok, false);
});

test('POST /dashboard-action.json: 401 sem token ou token errado', async () => {
  config.jackett.testToken = TOKEN;
  try {
    const semToken = await server.request('POST', '/dashboard-action.json', {
      body: { action: 'clear-cache' },
    });
    assert.equal(semToken.status, 401);

    const tokenErrado = await server.request('POST', '/dashboard-action.json', {
      headers: { 'X-Indexer-Test-Token': 'tok-invalido' },
      body: { action: 'clear-cache' },
    });
    assert.equal(tokenErrado.status, 401);
  } finally {
    config.jackett.testToken = '';
  }
});

test('POST /dashboard-action.json: ação executa ponta a ponta', async () => {
  config.jackett.testToken = TOKEN;
  try {
    cache.set('raw:modern-test', { a: 1 }, 60);
    assert.ok(cache.size() > 0);

    const res = await server.request('POST', '/dashboard-action.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { action: 'clear-cache', confirm: true },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.action, 'clear-cache');
    assert.equal(res.json.entriesAfter, 0);
  } finally {
    config.jackett.testToken = '';
  }
});

test('POST /:userConfig/dashboard-action.json: responde contextualizado', async () => {
  config.jackett.testToken = TOKEN;
  try {
    const userCfg = encodeConfig({ maxResults: 15 });
    const res = await server.request('POST', `/${userCfg}/dashboard-action.json`, {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { action: 'clear-cache', confirm: true },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.action, 'clear-cache');
  } finally {
    config.jackett.testToken = '';
  }
});

test('POST /dashboard-actions: alias plural não existe (rota única)', async () => {
  config.jackett.testToken = TOKEN;
  try {
    const res = await server.request('POST', '/dashboard-actions', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { action: 'clear-cache', confirm: true },
    });
    assert.equal(res.status, 404, 'só /dashboard-action.json responde ações');
    const userCfg = encodeConfig({ maxResults: 15 });
    const ctx = await server.request('POST', `/${userCfg}/dashboard-actions`, {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { action: 'clear-cache', confirm: true },
    });
    assert.notEqual(ctx.status, 200, 'variante com userConfig também sem alias');
  } finally {
    config.jackett.testToken = '';
  }
});

// ---------------------------------------------------------------------------
// R2: Métricas SQLite L2 no backend e /dashboard-status.json
// ---------------------------------------------------------------------------

test('cache.l2Stats(): exporta métricas non-blocking do SQLite L2', () => {
  const stats = cache.l2Stats();
  assert.ok(typeof stats === 'object' && stats !== null);
  assert.ok('fileSizeBytes' in stats);
  assert.ok('walSizeBytes' in stats);
  assert.ok('freelistCount' in stats);
  assert.ok('pendingWrites' in stats);
  // Um nome por número: apelido do mesmo valor vira dois campos para editar.
  assert.ok(!('freelistPages' in stats), 'sem apelido de freelistCount');
  assert.ok(!('pendingFlush' in stats), 'sem apelido de pendingWrites');
  // Procedências diferentes, rótulos diferentes: disco agora vs estado do processo.
  assert.equal((stats as any)._origem.fileSizeBytes, 'duravel');
  assert.equal((stats as any)._origem.pendingWrites, 'amostra');
  assert.equal(typeof stats.fileSizeBytes, 'number');
  assert.equal(typeof stats.walSizeBytes, 'number');
  assert.equal(typeof stats.freelistCount, 'number');
});

test('GET /dashboard-status.json: inclui objeto cache.l2 com métricas do L2', async () => {
  config.jackett.testToken = TOKEN;
  try {
    const res = await server.request('GET', '/dashboard-status.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
    });
    assert.equal(res.status, 200);
    assert.ok(res.json.cache && typeof res.json.cache.l2 === 'object');
    assert.ok('fileSizeBytes' in res.json.cache.l2);
    assert.ok('walSizeBytes' in res.json.cache.l2);
    assert.ok('pendingWrites' in res.json.cache.l2);
  } finally {
    config.jackett.testToken = '';
  }
});

// ---------------------------------------------------------------------------
// R3: Testes pontuais parametrizados (q e type)
// ---------------------------------------------------------------------------

test('GET /test-indexer.json aceita parâmetros q e type', async () => {
  config.jackett.testToken = TOKEN;
  try {
    const res = await server.request('GET', '/test-indexer.json?id=bludv-cardigann&q=avatar&type=series', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
    });
    assert.ok(res.status === 200 || res.status === 502 || res.status === 504);
    assert.ok('indexer' in res.json);
  } finally {
    config.jackett.testToken = '';
  }
});

test('GET /test-resolver.json aceita parâmetro q', async () => {
  config.jackett.testToken = TOKEN;
  try {
    const res = await server.request('GET', '/test-resolver.json?id=vacatorrent&q=avatar', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
    });
    assert.ok(res.status === 200 || res.status === 502 || res.status === 504);
    assert.ok('resolver' in res.json);
  } finally {
    config.jackett.testToken = '';
  }
});

// ---------------------------------------------------------------------------
// R4: 4 Vetores de discrepância banner vs card testados no coletor do frontend
// ---------------------------------------------------------------------------

function loadStatusSandbox() {
  const coreCode = readFileSync(new URL('../../src/public/dashboard-core.js', import.meta.url), 'utf8');
  const statusCode = readFileSync(new URL('../../src/public/dashboard-status.js', import.meta.url), 'utf8');
  const factory = new Function(
    'document',
    'window',
    coreCode + '\n' + statusCode + '\n' +
    'return { collectStatusIssues: collectStatusIssues };'
  ) as (doc: any, win: any) => { collectStatusIssues: (data: any) => any[] };
  const fakeDoc = {
    hidden: false,
    getElementById: () => null,
    createElement: () => ({ textContent: '', appendChild: () => {} }),
    addEventListener: () => {},
  };
  const fakeWin = {
    location: { pathname: '/dashboard' },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  };
  return factory(fakeDoc, fakeWin);
}

test('Vetor 1: Indexador offline gera issue de alerta mesmo se breaker não abriu', () => {
  const sandbox = loadStatusSandbox();
  const data = {
    ok: true,
    indexers: [
      { id: 'track1', name: 'Track1', online: false, breaker: { state: 'fechado', open: false } },
    ],
    resolvers: [],
    debrid: null,
  };
  const issues = sandbox.collectStatusIssues(data);
  assert.ok(issues.length > 0);
  assert.ok(issues.some((i: any) => i.text.indexOf('Track1') !== -1 && i.text.indexOf('offline') !== -1));
});

test('Vetor 2: Indexador recém-iniciado (breaker: naomedido) permanece neutro', () => {
  const sandbox = loadStatusSandbox();
  const data = {
    ok: true,
    indexers: [
      { id: 'track2', name: 'Track2', breaker: { state: 'naomedido' } },
    ],
    resolvers: [],
    debrid: null,
  };
  const issues = sandbox.collectStatusIssues(data);
  assert.equal(issues.filter((i: any) => i.state === 'warn').length, 0);
});

test('Vetor 3: Resolver quebrado ou offline gera issue de alerta', () => {
  const sandbox = loadStatusSandbox();
  const data = {
    ok: true,
    indexers: [],
    resolvers: [
      { id: 'res1', label: 'Res 1', broken: true },
      { id: 'res2', label: 'Res 2', online: false },
    ],
    debrid: null,
  };
  const issues = sandbox.collectStatusIssues(data);
  assert.ok(issues.some((i: any) => i.text.indexOf('Res 1') !== -1));
  assert.ok(issues.some((i: any) => i.text.indexOf('Res 2') !== -1));
});

test('Vetor 4: Conta de debrid com warn: true gera issue de alerta no banner', () => {
  const sandbox = loadStatusSandbox();
  const data = {
    ok: true,
    indexers: [],
    resolvers: [],
    debrid: {
      account: { service: 'realdebrid', ok: true, warn: true, label: 'RealDebrid' },
      accounts: {
        realdebrid: { service: 'realdebrid', ok: true, warn: true, label: 'RealDebrid' },
      },
    },
  };
  const issues = sandbox.collectStatusIssues(data);
  assert.ok(issues.some((i: any) => i.text.indexOf('RealDebrid') !== -1 && i.text.indexOf('aviso operacional') !== -1));
});

// ---------------------------------------------------------------------------
// R1: Rigor ES5 e Conformidade de Scripts/Markup
// ---------------------------------------------------------------------------

test('Frontend JS em src/public/ e dashboard.html seguem ES5 estrito', () => {
  const files = [
    'src/public/dashboard-core.js',
    'src/public/dashboard-status.js',
    'src/public/dashboard-panels.js',
    'src/public/dashboard-boot.js',
    'src/public/dashboard-magnets.js',
    'src/public/dashboard.html',
  ];
  const es6Regex = /\b(?:const|let)\b|=>|\?\.|\?\?/;
  for (const f of files) {
    const content = readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
    assert.doesNotMatch(content, es6Regex, `${f} não deve conter sintaxe ES6+`);
  }
});

test('dashboard-magnets.js: zero ocorrências de innerHTML', () => {
  const content = readFileSync(new URL('../../src/public/dashboard-magnets.js', import.meta.url), 'utf8');
  assert.doesNotMatch(content, /innerHTML/, 'dashboard-magnets.js deve usar textContent/DOM puro');
});

test('dashboard-status.js: exatamente 1 ocorrência de innerHTML (estático)', () => {
  const content = readFileSync(new URL('../../src/public/dashboard-status.js', import.meta.url), 'utf8');
  const matches = content.match(/innerHTML/g);
  assert.equal(matches ? matches.length : 0, 1, 'apenas 1 innerHTML estático permitido');
});

test('HTML: script ordering e elementos de modernização presentes', () => {
  const html = readFileSync(new URL('../../src/public/dashboard.html', import.meta.url), 'utf8');
  const catalogIdx = html.indexOf('dashboard-catalog.js');
  const magnetsIdx = html.indexOf('dashboard-magnets.js');
  const bootIdx = html.indexOf('dashboard-boot.js');

  assert.ok(catalogIdx !== -1 && magnetsIdx !== -1 && bootIdx !== -1);
  assert.ok(catalogIdx < magnetsIdx && magnetsIdx < bootIdx, 'magnets fica antes do boot');

  assert.match(html, /id="cacheSparkline"/);
  assert.match(html, /id="harvestSparkline"/);
  assert.match(html, /id="testIndexerQuery"/);
  assert.match(html, /id="testIndexerType"/);
  assert.match(html, /id="magnetInspectBtn"/);
  assert.match(html, /id="magnetClearBadBtn"/);
  assert.match(html, /id="magnetSummaryBtn"/);
});

test('PAGE_ASSETS em public.ts inclui dashboard-magnets.js', () => {
  assert.ok(PAGE_ASSETS.includes('dashboard-magnets.js'), 'dashboard-magnets.js deve estar na allowlist');
});

test('dashboard.css: estilos de abas móveis e sparkline SVG', () => {
  const css = readFileSync(new URL('../../src/public/dashboard.css', import.meta.url), 'utf8');
  assert.match(css, /@media\s*\(max-width:\s*650px\)/);
  assert.match(css, /\.sparkline-svg/);
  assert.match(css, /\.sparkline-path/);
  assert.match(css, /\.connection\.syncing/);
  assert.match(css, /\.last-updated\.stale/);
});

// O painel do Colhedor rotula os DOIS lados da procedência (duravel e amostra).
// O bloco L2 nasceu rotulando só a fila pendente, deixando os três medidos do
// disco sem procedência declarada — o leitor não distingue convenção de
// esquecimento. Os quatro passam pelo mesmo helper.
test('painel: os quatro campos do L2 declaram procedência, não só a fila', () => {
  const js = readFileSync(new URL('../src/public/dashboard-panels.js', import.meta.url), 'utf8');
  const bloco = js.slice(js.indexOf('Persistência L2 (SQLite)'));
  const trecho = bloco.slice(0, bloco.indexOf('renderCollection'));
  // Checagem literal, sem regex: o que importa é que a linha do campo chame o
  // helper com rótulo, e comparar substring evita escapar parêntese à toa.
  for (const campo of ['fileSizeBytes', 'walSizeBytes', 'freelistCount', 'pendingWrites']) {
    const linha = trecho
      .split('\n')
      .find((l) => l.includes('"' + campo + '"') && l.includes('metricMaybeOrigem'));
    assert.ok(linha, `${campo} deve passar por metricMaybeOrigem`);
  }
  const escapou = trecho
    .split('\n')
    .filter((l) => l.includes('metric(metrics, "L2 '));
  assert.equal(escapou.length, 0, 'nenhum campo L2 renderiza sem rótulo de procedência');
});
