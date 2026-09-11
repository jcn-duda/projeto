import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
process.env.CACHE_PERSIST = 'false';
import { createApp } from '../src/app.js';
import config from '../src/config.js';
import debrid from '../src/debrid/index.js';
import type { DebridAdapter } from '../types/domain.js';
import * as cache from '../src/utils/cache.js';
import { streamsCacheKey } from '../src/utils/request-key.js';
import rdWarmer from '../src/providers/rd-warmer.js';
import { createTestServer, decodeConfig, encodeConfig, fakeResponse, withMockFetch } from './e2e/e2e-harness.js';

const SWEEP_ADAPTER = {
  id: 'sweepfake',
  label: 'SweepFake',
  short: 'SW',
  cacheCheck: false,
  keyUrl: '' as unknown as string,
  checkCached: async () => new Set<string>(),
  resolveLink: async () => null,
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

test('POST clear-cache com confirm: true esvazia o cache e devolve a contagem', async () => {
  config.jackett.testToken = TOKEN;
  try {
    await withMockFetch([], async () => {
      cache.set('raw:dashboard-probe', { ok: 1 }, 60);
      assert.ok(cache.size() > 0, 'sembrado antes de limpiar');

      const res = await server.request('POST', '/dashboard-action.json', {
        headers: { 'X-Indexer-Test-Token': TOKEN },
        body: { action: 'clear-cache', confirm: true },
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.ok, true);
      assert.equal(res.json.action, 'clear-cache');
      assert.ok(res.json.entriesBefore >= 1, 'a contagem anterior refuje o sembrado');
      assert.equal(res.json.entriesAfter, 0, 'o cache queda limpio');
      assert.equal(cache.size(), 0, 'o clear limpió o store de verdade');
    });
  } finally {
    config.jackett.testToken = '';
  }
});

test('POST clear-cache por namespace preserva os outros namespaces', async () => {
  config.jackett.testToken = TOKEN;
  try {
    cache.set('raw:dashboard-scope', { ok: 1 }, 60);
    cache.set('idx:dashboard-scope', { ok: 1 }, 60);
    const res = await server.request('POST', '/dashboard-action.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { action: 'clear-cache', confirm: true, scope: { namespace: 'raw' } },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.scope, { kind: 'namespace', namespace: 'raw' });
    assert.equal(cache.get('raw:dashboard-scope'), null);
    assert.deepEqual(cache.get('idx:dashboard-scope'), { ok: 1 });
  } finally {
    cache.clear();
    config.jackett.testToken = '';
  }
});

test('POST clear-cache por instalação apaga somente streams do segmento corrente', async () => {
  config.jackett.testToken = TOKEN;
  const segmentA = encodeConfig({ m: 2, ds: 'sweepfake', dk: 'conta-a' });
  const segmentB = encodeConfig({ m: 4, ds: 'sweepfake', dk: 'conta-b' });
  const optionsA = decodeConfig(segmentA);
  const optionsB = decodeConfig(segmentB);
  assert.ok(optionsA && optionsB);
  const keyA = streamsCacheKey('movie', 'tt1000001', optionsA);
  const keyB = streamsCacheKey('movie', 'tt1000002', optionsB);
  try {
    cache.set(keyA, { streams: [] }, 60);
    cache.set(keyB, { streams: [] }, 60);
    const res = await server.request('POST', `/${segmentA}/dashboard-action.json`, {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { action: 'clear-cache', confirm: true, scope: { installation: true } },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.scope, { kind: 'installation' });
    assert.equal(cache.get(keyA), null);
    assert.deepEqual(cache.get(keyB), { streams: [] });
  } finally {
    cache.clear();
    config.jackett.testToken = '';
  }
});

test('POST clear-cache rejeita escopo inválido sem apagar entradas', async () => {
  config.jackett.testToken = TOKEN;
  try {
    cache.set('raw:dashboard-invalid-scope', { ok: 1 }, 60);
    const res = await server.request('POST', '/dashboard-action.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { action: 'clear-cache', confirm: true, scope: { namespace: '../raw' } },
    });
    assert.equal(res.status, 400);
    assert.deepEqual(cache.get('raw:dashboard-invalid-scope'), { ok: 1 });
  } finally {
    cache.clear();
    config.jackett.testToken = '';
  }
});

test('POST sweep-dead: 200 ok:true con adaptador configurado e ok:false sem config (com confirm: true)', async () => {
  config.jackett.testToken = TOKEN;
  config.debrid.service = 'sweepfake';
  config.debrid.apiKey = 'chave-operador';
  try {
    // Sin rede: o sweepDead do adaptador falso responde de memoria.
    const com = await server.request('POST', '/dashboard-action.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { action: 'sweep-dead', confirm: true },
    });
    assert.equal(com.status, 200);
    assert.equal(com.json.ok, true, 'o adaptador corrente varriu de verdade');
    assert.equal(com.json.action, 'sweep-dead');
    assert.deepEqual(com.json.result, { varridos: 2, falhas: 0 });

    // Sem serviço: sweepDeadEnv devuelve null, ação reconocida mas no-op.
    config.debrid.service = '';
    const semConfig = await server.request('POST', '/dashboard-action.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { action: 'sweep-dead', confirm: true },
    });
    assert.equal(semConfig.status, 200, 'ação conocida responde 200 mesmo sem poder correr');
    assert.equal(semConfig.json.ok, false);
    assert.equal(semConfig.json.result, null);
    assert.match(semConfig.json.error, /indisponível/);
  } finally {
    config.debrid.service = '';
    config.debrid.apiKey = '';
    config.jackett.testToken = '';
  }
});

test('POST /dashboard-action.json devolve 400 para ação desconocida', async () => {
  config.jackett.testToken = TOKEN;
  try {
    const res = await server.request('POST', '/dashboard-action.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { action: 'borrar-todo' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.ok, false);
    assert.match(res.json.error, /ação|acción|desconhecida/i);
  } finally {
    config.jackett.testToken = '';
  }
});

test('ações operacionais do dashboard são idempotentes ou no-op seguro', async () => {
  config.jackett.testToken = TOKEN;
  try {
    await withMockFetch([], async () => {
      const pause = await server.request('POST', '/dashboard-action.json', {
        headers: { 'X-Indexer-Test-Token': TOKEN },
        body: { action: 'harvester-pause', paused: true },
      });
      assert.equal(pause.status, 200);
      assert.equal(pause.json.paused, true);

      const drain = await server.request('POST', '/dashboard-action.json', {
        headers: { 'X-Indexer-Test-Token': TOKEN },
        body: { action: 'harvester-drain' },
      });
      assert.equal(drain.status, 200);
      assert.equal(drain.json.drained, 0);

      const inventory = await server.request('POST', '/dashboard-action.json', {
        headers: { 'X-Indexer-Test-Token': TOKEN },
        body: { action: 'refresh-inventory' },
      });
      assert.equal(inventory.status, 200);
      assert.equal(inventory.json.refreshed, 0);

      const all = await server.request('POST', '/dashboard-action.json', {
        headers: { 'X-Indexer-Test-Token': TOKEN },
        body: { action: 'test-all-indexers' },
      });
      assert.equal(all.status, 200);
      assert.equal(all.json.total, all.json.results.length);
      assert.ok(all.json.total >= 0, 'catálogo pode usar o fallback local quando o mock não devolve XML');

      await server.request('POST', '/dashboard-action.json', {
        headers: { 'X-Indexer-Test-Token': TOKEN },
        body: { action: 'harvester-pause', paused: false },
      });
    });
  } finally {
    config.jackett.testToken = '';
  }
});

test('ações warm-pause, warm-resume e warm-drain operam sobre o rdWarmer', async () => {
  config.jackett.testToken = TOKEN;
  try {
    const pause = await server.request('POST', '/dashboard-action.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { action: 'warm-pause' },
    });
    assert.equal(pause.status, 200);
    assert.equal(pause.json.ok, true);
    assert.equal(pause.json.action, 'warm-pause');
    assert.equal(pause.json.paused, true);
    assert.equal(rdWarmer.status().paused, true);

    const resume = await server.request('POST', '/dashboard-action.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { action: 'warm-resume' },
    });
    assert.equal(resume.status, 200);
    assert.equal(resume.json.ok, true);
    assert.equal(resume.json.action, 'warm-resume');
    assert.equal(resume.json.paused, false);
    assert.equal(rdWarmer.status().paused, false);

    const drain = await server.request('POST', '/dashboard-action.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { action: 'warm-drain', max: 5 },
    });
    assert.equal(drain.status, 200);
    assert.equal(drain.json.ok, true);
    assert.equal(drain.json.action, 'warm-drain');
    assert.equal(typeof drain.json.processed, 'number');
    assert.equal(typeof drain.json.queueRemaining, 'number');
  } finally {
    config.jackett.testToken = '';
  }
});

// ---------------------------------------------------------------------------
// Teste direto dos resolvedores BR (GET /test-resolver.json): mesmo esqueleto
// de token do test-indexer, mas o alvo é o resolvedor embutido — o probe fala
// com a porta local do card, então o fetch mockado é o da porta do resolver.
// ---------------------------------------------------------------------------

test('GET /test-resolver.json: 503 sem token, 401 com token errado e ?token= rejeitado', async () => {
  // Estado do before(): sem token configurado, rota desligada.
  const semToken = await server.request('GET', '/test-resolver.json?id=bludv');
  assert.equal(semToken.status, 503);
  assert.equal(semToken.json.ok, false);
  assert.match(semToken.json.error, /diagnóstico/);

  config.jackett.testToken = TOKEN;
  try {
    const errado = await server.request('GET', '/test-resolver.json?id=bludv', {
      headers: { 'X-Indexer-Test-Token': 'tok-errado' },
    });
    assert.equal(errado.status, 401);

    const semHeader = await server.request('GET', '/test-resolver.json?id=bludv');
    assert.equal(semHeader.status, 401);

    const naQuery = await server.request('GET', `/test-resolver.json?id=bludv&token=${TOKEN}`);
    assert.equal(naQuery.status, 401, 'token na query é ignorado; só o header conta');
  } finally {
    config.jackett.testToken = '';
  }
});

test('GET /test-resolver.json: 400 para id desconhecido', async () => {
  config.jackett.testToken = TOKEN;
  try {
    const res = await server.request('GET', '/test-resolver.json?id=nao-existe', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.ok, false);
    assert.match(res.json.error, /resolvedor desconhecido/);
  } finally {
    config.jackett.testToken = '';
  }
});

test('GET /test-resolver.json: probe ok conta as class="release" do HTML e o status mergeia a medição', async () => {
  config.jackett.testToken = TOKEN;
  const port = config.resolvers.ports.bludv + config.resolvers.portOffset;
  try {
    await withMockFetch([
      {
        match: (url: string) => url.includes(`:${port}/search`),
        handler: '<html><div class="release">a</div><div class="release">b</div></html>',
      },
    ], async (mock) => {
      const res = await server.request('GET', '/test-resolver.json?id=bludv&q=teste', {
        headers: { 'X-Indexer-Test-Token': TOKEN },
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.resolver, 'bludv');
      assert.equal(res.json.ok, true);
      assert.equal(res.json.results, 2, 'uma ocorrência de class="release" por release');
      assert.equal(typeof res.json.ms, 'number');
      assert.match(res.json.host, /^https?:\/\//, 'host é o domínio ativo do resolvedor');
      assert.equal(res.json.error, undefined);

      const probe = mock.calls.find((call) => call.url.includes('/search'));
      assert.ok(probe, 'probe fez o fetch interno na porta do resolvedor');
      assert.ok(probe.url.includes(`:${port}/search`), 'porta é a do resolver (base + offset)');
      assert.ok(probe.url.endsWith(`q=${encodeURIComponent('teste')}`), 'query viaja no parâmetro q');
    });

    await withMockFetch([], async () => {
      const st = await server.request('GET', '/dashboard-status.json', {
        headers: { 'X-Indexer-Test-Token': TOKEN },
      });
      assert.equal(st.status, 200);
      const entry = st.json.resolvers.find((resolver: any) => resolver.id === 'bludv');
      assert.equal(entry.status, 'ok');
      assert.equal(entry.results, 2);
      assert.ok(entry.checkedAt, 'medição carrega o momento');
      assert.equal(typeof entry.lastMs, 'number');
      assert.equal(entry.lastError, null);
    });
  } finally {
    config.jackett.testToken = '';
  }
});

test('GET /test-resolver.json: 502 do resolvedor vira ok:false com o corpo do erro no status', async () => {
  config.jackett.testToken = TOKEN;
  const port = config.resolvers.ports.nerdfilmes + config.resolvers.portOffset;
  try {
    await withMockFetch([
      {
        match: (url: string) => url.includes(`:${port}/search`),
        handler: () => fakeResponse('FALHA-PROPOSITAL-DO-SITE', { status: 502 }),
      },
    ], async () => {
      const res = await server.request('GET', '/test-resolver.json?id=nerdfilmes&q=x', {
        headers: { 'X-Indexer-Test-Token': TOKEN },
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.resolver, 'nerdfilmes');
      assert.equal(res.json.ok, false);
      assert.equal(res.json.results, null);
      assert.match(res.json.error, /FALHA-PROPOSITAL-DO-SITE/, 'corpo do erro volta truncável e diagnosticável');
    });

    await withMockFetch([], async () => {
      const st = await server.request('GET', '/dashboard-status.json', {
        headers: { 'X-Indexer-Test-Token': TOKEN },
      });
      const entry = st.json.resolvers.find((resolver: any) => resolver.id === 'nerdfilmes');
      // 'error' (não 'erro'): o stateName() do painel reconhece 'error' e pinta
      // o card de vermelho; 'erro' voltaria ao cinza "não medido".
      assert.equal(entry.status, 'error');
      assert.equal(entry.results, null);
      assert.match(entry.lastError, /FALHA-PROPOSITAL-DO-SITE/);
    });
  } finally {
    config.jackett.testToken = '';
  }
});

