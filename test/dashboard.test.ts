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
import { createTestServer, decodeConfig, encodeConfig, fakeResponse, withMockFetch } from './e2e/e2e-harness.js';
import { resetCatalogCache } from '../src/providers/jackett-catalog.js';

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
  resetCatalogCache();
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
       assert.equal(typeof body.metrics.gauges, 'object');
       assert.equal(typeof body.autofetch, 'object');
       assert.equal(typeof body.magnetdb, 'object');
       assert.equal(typeof body.magnetdb.enabled, 'boolean');
       assert.equal(typeof body.magnetdb.byAdapter, 'object');
       assert.equal(typeof body.magnetdb.ttlRemainingSeconds, 'object');
       assert.equal(typeof body.magnetdb.l1Entries, 'number');
       assert.equal(typeof body.magnetdb.l1Max, 'number');
       assert.equal(typeof body.magnetdb.evictedQuota, 'number');
       // Painel MagnetDB: L1 (ocupação real) ≠ amostra do processo.
       assert.equal(typeof body.magnetdb.l1Entries, 'number');
       assert.equal(typeof body.magnetdb.l1Max, 'number');
       assert.equal(typeof body.magnetdb.evictedQuota, 'number');
       assert.equal(typeof body.magnetdb.sizeAlive, 'number');
       assert.equal(typeof body.magnetdb.sizeBad, 'number');
       assert.equal(typeof body.magnetdb.sizeLie, 'number');
       assert.ok(Array.isArray(body.harvest.queuePreview));
       assert.ok(Array.isArray(body.harvest.lastWorks));
       assert.equal(typeof body.f3, 'object');
       assert.equal(typeof body.f3.enabled, 'boolean');
       assert.equal(typeof body.f3.baselineAt, 'number');
       assert.ok(body.f3.latest === null || typeof body.f3.latest === 'object');
      assert.ok(Array.isArray(body.indexers), 'catálogo de indexers entra como lista');
      // Mock do harness responde Torznab vazio (live) → medido morto = false.
      // Fallback→naomedido fica no teste de jackett-catalog (rede falha).
      assert.equal(body.general.services.jackett, false);
      assert.ok(body.indexers.every((idx: any) => idx.flagSlow === null || typeof idx.flagSlow === 'boolean'));
      assert.ok(
        body.indexers.length === 0 ||
          body.indexers.every((idx: any) => ['aberto', 'fechado', 'naomedido'].includes(idx.breaker?.state)),
      );
      assert.ok(Array.isArray(body.resolvers), 'resolvers BR saem como lista');
      assert.ok(body.resolvers.every((resolver: any) => resolver.embedded === false));
      assert.deepEqual(body.resolvers.map((resolver: any) => resolver.port), [8737, 8738, 8739, 8740, 8741]);
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

test('GET /dashboard-status.json: catálogo fallback → services.jackett naomedido', async () => {
  config.jackett.testToken = TOKEN;
  resetCatalogCache();
  try {
    await withMockFetch([{
      match: () => true,
      handler: async () => { throw new Error('ECONNREFUSED'); },
    }], async () => {
      const res = await server.request('GET', '/dashboard-status.json', {
        headers: { 'X-Indexer-Test-Token': TOKEN },
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.general.services.jackett, 'naomedido');
      assert.ok(res.json.indexers.length > 0, 'fallback ainda lista IDs do .env');
    });
  } finally {
    config.jackett.testToken = '';
    resetCatalogCache();
  }
});

test('dashboard permanece ES5 e renderiza a observabilidade do Magnet DB', () => {
  const html = readFileSync(new URL('../src/public/dashboard.html', import.meta.url), 'utf8');
  const panels = readFileSync(new URL('../src/public/dashboard-panels.js', import.meta.url), 'utf8');
  // Wiring no HTML: container da métrica + módulo panels na ordem certa.
  assert.match(html, /id="cacheMetrics"/);
  assert.match(html, /src="\/dashboard-panels\.js"/);
  assert.match(html, /src="\/dashboard-boot\.js"/);
  assert.doesNotMatch(html, /<script>\s*"use strict"/);
  assert.doesNotMatch(html, /function renderMagnetDb\(/);
  assert.doesNotMatch(html, /function renderGeneral\(/);
  assert.doesNotMatch(html, /function bind\(/);
  // Observabilidade Magnet DB mora em panels (Fase 1 painel).
  assert.match(panels, /function renderMagnetDb\(data, counters, uptimeS\)/);
  assert.match(panels, /function renderGeneral\(/);
  assert.match(panels, /debrid\.check\.cached/);
  assert.match(panels, /source\.byAdapter/);
  assert.match(panels, /source\.search/);
  assert.match(panels, /L1 mag \(ocupação\)/);
  assert.match(panels, /amostra processo \(≠ L1\)/);
  assert.match(panels, /amostra bad \(play sem vídeo\)/);
  assert.match(panels, /descartados dead \(autofetch ≠ bad\)/);
  assert.match(panels, /source\.l1Entries/);
  assert.match(panels, /source\.evictedQuota/);
  assert.doesNotMatch(panels, /\b(?:const|let)\b|=>|\?\.|\?\?/);
  assert.doesNotMatch(html, /\b(?:const|let)\b|=>|\?\.|\?\?/);
});

// Runtime Fake DOM de renderMagnetDb/renderAutofetchPanel: ver
// test/dashboard-panels-extract.test.ts (teto de linhas).

// displayValue vive no dashboard-core.js extraído (Fase 3) e nada roda no load
// lá — só declarações — então o teste EXECUTA o módulo em vez de regexar o
// texto. Os dois casos abaixo são bugs pré-existentes que a extração tornou
// visíveis, confirmados no DOM ao vivo pelo QA antes do conserto.
test('displayValue do dashboard-core: data é sufixo -at e uptimeS vem em segundos', () => {
  const code = readFileSync(new URL('../src/public/dashboard-core.js', import.meta.url), 'utf8');
  const api = new Function(code + '\nreturn { displayValue: displayValue };')() as {
    displayValue: (key: string, value: unknown) => string;
  };

  // Chave que TERMINA em "at" continua data (generatedAt, lastRunAt, lastWriteAt).
  assert.match(api.displayValue('generatedAt', 1700000000000), /^\d{2}\/\d{2}\/\d{4}/);

  // Chave que só CONTÉM "at" não é data: com o indexOf antigo, hitRate,
  // deadlineMetadata e brLate pintavam 31/12/1969, 21:00:00 no painel.
  assert.equal(api.displayValue('hitRate', 0.311), '0.311');
  assert.equal(api.displayValue('deadlineMetadata', 7), '7');
  assert.equal(api.displayValue('brLate', 3), '3');

  // uptimeS chega em SEGUNDOS de metrics.ts; formatDuration espera ms. Sem a
  // conversão, 3612 s de container renderizava "3.6 s" (erro de 1000x).
  assert.equal(api.displayValue('uptimeS', 3612), '60 min 12 s');
});

test('dashboard renderiza o painel do Chupim e navegação por abas em ES5', () => {
  const html = readFileSync(new URL('../src/public/dashboard.html', import.meta.url), 'utf8');
  const afJs = readFileSync(new URL('../src/public/dashboard-autofetch.js', import.meta.url), 'utf8');
  assert.match(html, /id="tabGeral"/);
  assert.match(html, /id="tabAutofetch"/);
  assert.match(html, /id="viewGeral"/);
  assert.match(html, /id="viewAutofetch"/);
  assert.match(html, /src="\/dashboard-autofetch\.js"/);
  assert.match(afJs, /function renderAutofetchPanel/);
  assert.match(afJs, /function saveAutofetchConfig/);
  assert.match(afJs, /function resetAutofetchConfig/);
  assert.match(afJs, /function toggleAutofetchPause/);
  assert.match(afJs, /function drainAutofetchQueues/);
  assert.match(afJs, /function applyAutofetchPreset/);
  assert.doesNotMatch(afJs, /\b(?:const|let)\b|=>|\?\.|\?\?/, 'dashboard-autofetch.js continua ES5');
});

test('dashboard renderiza o painel do Colhedor / Harvester em ES5', () => {
  const html = readFileSync(new URL('../src/public/dashboard.html', import.meta.url), 'utf8');
  const harvestJs = readFileSync(new URL('../src/public/dashboard-harvest.js', import.meta.url), 'utf8');
  assert.match(html, /id="tabColhedor"/);
  assert.match(html, /id="viewColhedor"/);
  assert.match(html, /id="harvestPauseBanner"/);
  assert.match(html, /id="harvestLiveMetrics"/);
  assert.match(html, /src="\/dashboard-harvest\.js"/);
  assert.match(harvestJs, /function renderHarvesterPanel/);
  assert.match(harvestJs, /function saveHarvesterConfig/);
  assert.match(harvestJs, /function resetHarvesterConfig/);
  assert.match(harvestJs, /function toggleHarvesterPause/);
  assert.match(harvestJs, /function drainHarvesterQueue/);
  assert.match(harvestJs, /function clearHarvesterQueue/);
  assert.match(harvestJs, /function applyHarvesterPreset/);
  assert.doesNotMatch(harvestJs, /\b(?:const|let)\b|=>|\?\.|\?\?/);
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
