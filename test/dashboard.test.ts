import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Persistência desligada ANTES dos requires: o app real abre o módulo de cache
// e o data/cache.db do repo não pode ser tocado pelos testes.
process.env.CACHE_PERSIST = 'false';

import { createApp } from '../src/app.js';
import config from '../src/config.js';
import debrid from '../src/debrid/index.js';
import type { DebridAdapter } from '../types/domain.js';
import * as cache from '../src/utils/cache.js';
import { streamsCacheKey } from '../src/utils/request-key.js';
import rdWarmer from '../src/providers/rd-warmer.js';
import { createTestServer, decodeConfig, encodeConfig, withMockFetch } from './e2e/e2e-harness.js';

// Adaptador fake gravado no registry real: o clear-cache é puro estado em
// memória, mas o sweep-dead só devuelve ok:true de verdade se o serviço
// corrente tem sweepDead. Entra no before e sai no after.
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
  // O token de diagnóstico e a conta efetivos vêm do .env do operador; os
  // testes decidem tudo en memoria, mas o ambiente precisa nacer neutro (e
  // voltar ao que era no after). Jackett chave precisa estar presente senão o
  // catálogo da rota retorna fallback sem fetch; serviço zerado evita que o
  // accountStatus arriesgue rede fora do mock.
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
  // usados por sweepDeadEnv(); os valores reais vêm do .env.
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

// ---------------------------------------------------------------------------
// Reinado por token: mismo esqueleto que os outros endpoints de diagnóstico.
// ---------------------------------------------------------------------------

test('GET /dashboard-status.json devolve 503 sem token configurado', async () => {
  const res = await server.request('GET', '/dashboard-status.json');
  assert.equal(res.status, 503);
  assert.match(res.json.error, /dashboard/);
});

test('POST /dashboard-action.json devolve 503 sem token configurado', async () => {
  const res = await server.request('POST', '/dashboard-action.json', {
    body: { action: 'clear-cache' },
  });
  assert.equal(res.status, 503);
  assert.equal(res.json.ok, false);
  assert.match(res.json.error, /dashboard/);
});

test('dashboard: 401 com token errado e sem cabeçalho (GET e POST)', async () => {
  config.jackett.testToken = TOKEN;
  try {
    const erradoGot = await server.request('GET', '/dashboard-status.json', {
      headers: { 'X-Indexer-Test-Token': 'tok-errado' },
    });
    assert.equal(erradoGot.status, 401);

    const semHeaderGot = await server.request('GET', '/dashboard-status.json');
    assert.equal(semHeaderGot.status, 401);

    const erradoPost = await server.request('POST', '/dashboard-action.json', {
      headers: { 'X-Indexer-Test-Token': 'tok-errado' },
      body: { action: 'borrar-todo' },
    });
    assert.equal(erradoPost.status, 401);

    const semHeaderPost = await server.request('POST', '/dashboard-action.json', {
      body: { action: 'clear-cache' },
    });
    assert.equal(semHeaderPost.status, 401);
  } finally {
    config.jackett.testToken = '';
  }
});

test('dashboard: ?token= nunca autentica (GET e POST)', async () => {
  config.jackett.testToken = TOKEN;
  try {
    const getQuery = await server.request('GET', `/dashboard-status.json?token=${TOKEN}`);
    assert.equal(getQuery.status, 401, 'query é ignorada; só o header conta');

    const postQuery = await server.request('POST', `/dashboard-action.json?token=${TOKEN}`, {
      body: { action: 'borrar-todo' },
    });
    assert.equal(postQuery.status, 401);
  } finally {
    config.jackett.testToken = '';
  }
});

test('GET /dashboard-status.json: 200 com token certo e formato consolidado sem segredos', async () => {
  config.jackett.testToken = TOKEN;
  const savedRuntimeConfig = {
    cachePersist: config.cache.persist,
    resolversEmbedded: config.resolvers.embedded,
    resolversPortOffset: config.resolvers.portOffset,
  };
  config.cache.persist = false;
  config.resolvers.embedded = false;
  config.resolvers.portOffset = 37;
  // Semillas nos campos que nenhun endpoint pode vazar: as credenciales do
  // debrid, o resolveSecret, a do Jackett e o próprio token da prova.
  config.debrid.apiKey = 'SUPER-DEBRID-SECRETO-123';
  config.debrid.resolveSecret = 'SUPER-RESOLVE-SECRETO-456';
  config.jackett.apiKey = 'SUPER-JACKETT-SECRETO-789';
  try {
    // O fetch do catálogo mora no mock; kein pedido sai do processo.
    await withMockFetch([], async () => {
      const res = await server.request('GET', '/dashboard-status.json', {
        headers: { 'X-Indexer-Test-Token': TOKEN },
      });
      assert.equal(res.status, 200);

      const body = res.json;
      assert.equal(typeof body.generatedAt, 'string');
      assert.equal(body.general.ok, true);
      assert.equal(typeof body.general.version, 'string');
      assert.equal(typeof body.general.uptimeS, 'number');
      assert.equal(typeof body.general.memory.rss, 'number');
      assert.equal(typeof body.general.search.deadlineMetadata, 'number');
      assert.equal(typeof body.general.search.deadlineProviders, 'number');
      assert.ok(body.general.search.metadataAvgMs === null || typeof body.general.search.metadataAvgMs === 'number');
      assert.equal(typeof body.cache.entries, 'number');
      assert.equal(typeof body.cache.hitRate, 'number');
      assert.equal(body.cache.persistent, false, 'dashboard lê a persistência centralizada');
      assert.equal(typeof body.metrics, 'object');
       assert.equal(typeof body.autofetch, 'object');
       assert.equal(typeof body.magnetdb, 'object');
       assert.equal(typeof body.magnetdb.enabled, 'boolean');
       assert.equal(typeof body.magnetdb.byAdapter, 'object');
       assert.equal(typeof body.magnetdb.ttlRemainingSeconds, 'object');
       assert.ok(Array.isArray(body.harvest.queuePreview));
       assert.ok(Array.isArray(body.harvest.lastWorks));
      assert.ok(Array.isArray(body.indexers), 'catálogo de indexers entra como lista');
      assert.ok(Array.isArray(body.resolvers), 'resolvers BR saem como lista');
      assert.ok(body.resolvers.every((resolver: any) => resolver.embedded === false));
      assert.deepEqual(body.resolvers.map((resolver: any) => resolver.port), [8737, 8738, 8739, 8740]);
      assert.equal(body.debrid.active, null, 'sen serviço não há debrid ativo');
       assert.ok(Array.isArray(body.debrid.services), 'el seletor de servicios mora en el registry');
       assert.deepEqual(body.debrid.accounts, {}, 'sem conta configurada não há serviço inventado');

      let secretVazou = false;
      for (const segredo of ['SUPER-DEBRID-SECRETO-123', 'SUPER-RESOLVE-SECRETO-456', 'SUPER-JACKETT-SECRETO-789', TOKEN]) {
        if (res.text.includes(segredo)) secretVazou = true;
      }
      assert.equal(secretVazou, false, 'nenhum segredo nem el token chega ao corpo');
    });
  } finally {
    config.debrid.apiKey = '';
    config.debrid.resolveSecret = '';
    config.jackett.apiKey = saved.jackettApiKey || 'jackett-key-teste';
    config.jackett.testToken = '';
    config.cache.persist = savedRuntimeConfig.cachePersist;
    config.resolvers.embedded = savedRuntimeConfig.resolversEmbedded;
    config.resolvers.portOffset = savedRuntimeConfig.resolversPortOffset;
  }
});

test('dashboard permanece ES5 e renderiza a observabilidade do Magnet DB', () => {
  const html = readFileSync(new URL('../src/public/dashboard.html', import.meta.url), 'utf8');
  assert.match(html, /function renderMagnetDb\(data, counters\)/);
  assert.match(html, /debrid\.check\.cached/);
  assert.match(html, /source\.byAdapter/);
  assert.match(html, /source\.search/);
  assert.doesNotMatch(html, /\b(?:const|let)\b|=>|\?\.|\?\?/);
});

// ---------------------------------------------------------------------------
// Accións do POST: clear-cache e sweep-dead (ambas 200 com token certo).
// ---------------------------------------------------------------------------

test('POST clear-cache e sweep-dead exigem confirm: true (Tarefa 2.8)', async () => {
  config.jackett.testToken = TOKEN;
  try {
    const semConfirmCache = await server.request('POST', '/dashboard-action.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { action: 'clear-cache' },
    });
    assert.equal(semConfirmCache.status, 400);
    assert.equal(semConfirmCache.json.ok, false);
    assert.equal(semConfirmCache.json.error, 'confirmation_required');

    const falseConfirmCache = await server.request('POST', '/dashboard-action.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { action: 'clear-cache', confirm: false },
    });
    assert.equal(falseConfirmCache.status, 400);
    assert.equal(falseConfirmCache.json.ok, false);
    assert.equal(falseConfirmCache.json.error, 'confirmation_required');

    const semConfirmSweep = await server.request('POST', '/dashboard-action.json', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { action: 'sweep-dead' },
    });
    assert.equal(semConfirmSweep.status, 400);
    assert.equal(semConfirmSweep.json.ok, false);
    assert.equal(semConfirmSweep.json.error, 'confirmation_required');
  } finally {
    config.jackett.testToken = '';
  }
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
