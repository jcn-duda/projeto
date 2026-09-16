import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import config from '../src/config.js';
import { createTestServer } from './e2e/e2e-harness.js';
import { ALL_BLOCKS, contaBlock, computeStatusPayload, accountTimeout } from '../src/routes/dashboard-status-blocks.js';
import { magnetdbSummary } from '../src/client/painel/view-magnets.js';
import { cacheSummary } from '../src/client/painel/view-cache.js';
import { autoFetchTeto } from '../src/client/painel/view-chupim.js';

test('ALL_BLOCKS contém todos os blocos esperados (incluindo conta e gate)', () => {
  assert.ok(ALL_BLOCKS.includes('conta'));
  assert.ok(ALL_BLOCKS.includes('gate'));
  assert.ok(ALL_BLOCKS.includes('general'));
  assert.ok(ALL_BLOCKS.includes('debrid'));
  assert.ok(ALL_BLOCKS.includes('autofetch'));
  assert.ok(ALL_BLOCKS.includes('harvest'));
});

test('/dashboard-status.json sem ?blocos= devolve payload completo byte-compatível', async () => {
  const savedToken = config.jackett.testToken;
  config.jackett.testToken = 'test-token-status';
  const server = await createTestServer(createApp().app);
  try {
    const res = await server.request('GET', '/dashboard-status.json', {
      headers: { 'x-indexer-test-token': 'test-token-status' },
    });
    assert.equal(res.status, 200);
    assert.ok(res.json.generatedAt, 'precisa ter generatedAt');
    assert.equal(res.json.blocos, undefined, 'sem ?blocos= não deve ter campo blocos');
    assert.ok(res.json.general, 'deve conter general');
    assert.ok(res.json.debrid, 'deve conter debrid');
    assert.ok(res.json.metrics, 'deve conter metrics');
    assert.ok(res.json.cache, 'deve conter cache');
    assert.ok(res.json.harvest, 'deve conter harvest');
    assert.ok(res.json.autofetch, 'deve conter autofetch');
  } finally {
    await server.close();
    config.jackett.testToken = savedToken;
  }
});

test('/dashboard-status.json?blocos=conta,gate devolve APENAS os blocos pedidos e ecoa blocos', async () => {
  const savedToken = config.jackett.testToken;
  config.jackett.testToken = 'test-token-status';
  const server = await createTestServer(createApp().app);
  try {
    const res = await server.request('GET', '/dashboard-status.json?blocos=conta,gate', {
      headers: { 'x-indexer-test-token': 'test-token-status' },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.blocos, ['conta', 'gate']);
    assert.ok(res.json.generatedAt);
    assert.ok(res.json.conta, 'deve conter bloco conta');
    assert.ok(res.json.gate, 'deve conter bloco gate');
    assert.equal(res.json.general, undefined, 'não deve computar general');
    assert.equal(res.json.metrics, undefined, 'não deve computar metrics');
    assert.equal(res.json.cache, undefined, 'não deve computar cache');

    // Validação da estrutura do bloco conta
    const conta = res.json.conta;
    assert.equal(typeof conta.cap, 'number');
    assert.equal(typeof conta.warnAt, 'number');
    assert.equal(typeof conta.total, 'number');
    assert.equal(typeof conta.usagePercent, 'number');

    // Validação da estrutura do bloco gate
    const gate = res.json.gate;
    assert.ok(gate.effective, 'gate deve ter effective');
    assert.ok(gate.envDefaults, 'gate deve ter envDefaults');
    assert.ok(Array.isArray(gate.diffs), 'gate deve ter diffs');
    assert.equal(typeof gate.autoFetchPauseAt, 'number');
  } finally {
    await server.close();
    config.jackett.testToken = savedToken;
  }
});

test('/dashboard-status.json com bloco desconhecido devolve 400 com lista de permitidos', async () => {
  const savedToken = config.jackett.testToken;
  config.jackett.testToken = 'test-token-status';
  const server = await createTestServer(createApp().app);
  try {
    const res = await server.request('GET', '/dashboard-status.json?blocos=conta,invalido_xyz', {
      headers: { 'x-indexer-test-token': 'test-token-status' },
    });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /bloco desconhecido/);
    assert.ok(Array.isArray(res.json.allowed));
    assert.ok(res.json.allowed.includes('conta'));
  } finally {
    await server.close();
    config.jackett.testToken = savedToken;
  }
});

test('/dashboard-status.json entrega os campos que o /painel consome (shapes reais)', async () => {
  const savedToken = config.jackett.testToken;
  config.jackett.testToken = 'test-token-status';
  const server = await createTestServer(createApp().app);
  try {
    const res = await server.request('GET', '/dashboard-status.json?blocos=magnetdb,cache,autofetch', {
      headers: { 'x-indexer-test-token': 'test-token-status' },
    });
    assert.equal(res.status, 200);
    const body = res.json;

    // magnetdb.status() → o que ViewMagnets consome.
    for (const key of ['enabled', 'sizeAlive', 'sizeBad', 'sizeLie', 'l1Entries', 'l1Max']) {
      assert.ok(key in body.magnetdb, 'magnetdb.' + key);
    }
    // cache.snapshot()/l2Stats() → o que ViewCache consome.
    for (const key of ['entries', 'maxEntries']) assert.ok(key in body.cache, 'cache.' + key);
    assert.ok('fileSizeBytes' in body.cache.l2, 'cache.l2.fileSizeBytes');
    // autofetch.snapshot() → config.effective.autoFetchMax (não af.effective).
    assert.equal(typeof body.autofetch.config.effective.autoFetchMax, 'number');

    // Os modelos puros do cliente consomem ESSES objetos do servidor sem tradução.
    assert.equal(magnetdbSummary(body.magnetdb).l1Entries, body.magnetdb.l1Entries);
    assert.equal(cacheSummary(body.cache).l1Max, body.cache.maxEntries);
    assert.equal(cacheSummary(body.cache).l2Bytes, body.cache.l2.fileSizeBytes);
    assert.equal(autoFetchTeto(body.autofetch), body.autofetch.config.effective.autoFetchMax);
  } finally {
    await server.close();
    config.jackett.testToken = savedToken;
  }
});

test('contaBlock não deriva "download preso" do oldestAt global do acervo', () => {
  // oldestAt é o magnet mais antigo da CONTA (prontos incluídos): 5 dias de
  // idade com 5 ativos NÃO prova download travado. O bloco não pode afirmar.
  const out = contaBlock(
    { ok: true, magnets: 900, ready: 895, active: 5, error: 0, oldestAt: Date.now() - 5 * 86_400_000 },
    { cap: 1000, warnAt: 800, service: 'alldebrid', label: 'AllDebrid' },
  );

  assert.equal(out.total, 900);
  assert.equal(out.downloading, 5);
  assert.equal(out.usagePercent, 90);
  assert.ok(out.oldestAt, 'a idade medida continua exposta como contexto');
  assert.equal('stuckCount' in out, false, 'sem inferência de preso a partir da idade global');
  assert.equal('oldestAgeMs' in out, false, 'sem métrica derivada que só servia à inferência falsa');
});

test('computeStatusPayload lê metrics.snapshot uma única vez por request', async () => {
  let snapshotCalls = 0;
  const snapshot = { uptimeS: 1, counters: {}, gauges: {}, timers: {} };
  const services: any = {
    metrics: {
      snapshot: () => {
        snapshotCalls += 1;
        return snapshot;
      },
    },
    cache: { snapshot: () => ({}), l2Stats: () => ({ sizeBytes: 0, entries: 0 }) },
    config: { cache: { persist: false } },
  };

  const result = await computeStatusPayload(
    { services, lastResolverProbes: new Map() },
    'searchFirst,metrics,cache',
  );

  assert.equal(result.ok, true);
  assert.equal(snapshotCalls, 1, 'searchFirst + metrics + cache dividem a mesma foto');
});

test('accountTimeout limpa o timer quando a operação vence', async () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const timerId = { __fakeTimer: true };
  const cleared: any[] = [];
  (globalThis as any).setTimeout = () => timerId;
  (globalThis as any).clearTimeout = (id: any) => {
    cleared.push(id);
  };

  try {
    const services: any = {
      config: { debrid: { dashboardAccountTimeoutMs: 5000 } },
      debrid: { current: () => null },
    };
    const out = await accountTimeout(services, Promise.resolve({ ok: true }));
    assert.deepEqual(out, { ok: true });
    assert.equal(cleared.length, 1, 'o timer do timeout precisa ser cancelado');
    assert.equal(cleared[0], timerId);
  } finally {
    (globalThis as any).setTimeout = realSetTimeout;
    (globalThis as any).clearTimeout = realClearTimeout;
  }
});

test('accountTimeout ainda devolve payload de timeout quando a operação não responde', async () => {
  const services: any = {
    config: { debrid: { dashboardAccountTimeoutMs: 20 } },
    debrid: { current: () => ({ id: 'alldebrid', label: 'AllDebrid' }) },
  };
  // O timer do accountTimeout é unref'd de propósito (não segura o processo em
  // produção): aqui um keep-alive REF'd mantém o event loop vivo até o disparo.
  let keepAliveId: any;
  const keepAlive = new Promise((resolve) => {
    keepAliveId = setTimeout(resolve, 200);
  });
  try {
    const out: any = await Promise.race([accountTimeout(services, new Promise(() => {})), keepAlive]);
    assert.equal(out?.ok, false);
    assert.equal(out?.reason, 'timeout');
    assert.equal(out?.service, 'alldebrid');
  } finally {
    clearTimeout(keepAliveId);
  }
});
