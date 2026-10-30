// Ponte Node → colhedor NATIVO (`/harvest/*` do `adom-server`).
//
// O worker, a fila, a prioridade e o dedupe vivem no Rust (`cargo test -p
// adom-harvest`/`-p adom-server`). O que o Node ainda precisa garantir é o
// CONTRATO da ponte do painel: o GET do status normaliza o snapshot, e duas
// falhas sequenciais põem a ponte em backoff — sem martelar um gateway doente.
// O `harvester_enqueue` da busca não passa por aqui: o gateway o consome no
// próprio processo (`harvest_effect.rs`). Nada de rede real: o `fetch` é
// dublado em todos os testes.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import config from '../src/config.js';
import {
  clearNativeHarvest,
  drainNativeHarvest,
  harvestNativeOnline,
  harvestStatusSnapshot,
  pauseNativeHarvest,
  refreshHarvestStatus,
  resetHarvestBridgeForTests,
} from '../src/utils/harvest-native.js';
import { stubFetch, type FetchResponse } from './helpers/stub.js';

const BASE = 'http://127.0.0.1:8777';
const saved = {
  url: config.streamStore.url,
  token: config.streamStore.token,
  timeoutMs: config.streamStore.timeoutMs,
  backoffMs: config.streamStore.backoffMs,
};

beforeEach(() => {
  resetHarvestBridgeForTests();
  config.streamStore.url = BASE;
  config.streamStore.token = 'tok-teste';
  config.streamStore.timeoutMs = 200;
  // Backoff alto o bastante para o teste não depender de relógio: uma vez
  // bloqueada, a ponte fica bloqueada até o `reset` do `finally`.
  config.streamStore.backoffMs = 60_000;
});

afterEach(() => {
  resetHarvestBridgeForTests();
  config.streamStore.url = saved.url;
  config.streamStore.token = saved.token;
  config.streamStore.timeoutMs = saved.timeoutMs;
  config.streamStore.backoffMs = saved.backoffMs;
});

function json(body: unknown): FetchResponse {
  return { ok: true, status: 200, json: async () => body };
}

test('status: normaliza o contrato do gateway e marca a ponte online', async () => {
  const stub = stubFetch(() => json({
    ok: true,
    enabled: true,
    paused: false,
    intervalMs: 60_000,
    maxPerHour: 12,
    queriesThisHour: 3,
    depth: 2,
    inflight: true,
    preview: [{ imdbId: 'tt0107953', type: 'movie', reason: 'miss', fullIntent: { reason: 'miss' } }],
    last: [{ imdbId: 'tt0107953', type: 'movie', reason: 'miss', ok: true, queries: 1, at: 123 }],
    counters: { drained: 5, failed: 1 },
    store: 'data/streams.db',
  }));
  try {
    const snap = await refreshHarvestStatus();
    assert.equal(snap?.ok, true);
    assert.equal(snap?.enabled, true);
    assert.equal(snap?.paused, false);
    assert.equal(snap?.intervalMs, 60_000);
    assert.equal(snap?.maxPerHour, 12);
    assert.equal(snap?.queriesThisHour, 3);
    assert.equal(snap?.depth, 2);
    assert.equal(snap?.inflight, true);
    assert.equal(snap?.preview.length, 1);
    assert.equal('fullIntent' in (snap?.preview[0] ?? {}), false, 'formato público omite fullIntent');
    assert.equal(snap?.preview[0].imdbId, 'tt0107953');
    assert.equal(snap?.last[0].queries, 1);
    assert.deepEqual(snap?.counters, { drained: 5, failed: 1 });
    assert.equal(snap?.store, 'data/streams.db');
    assert.equal(harvestNativeOnline(), true);
    assert.equal(harvestStatusSnapshot()?.depth, 2, 'o snapshot sync é o mesmo do refresh');
    assert.equal(stub.calls[0].url, `${BASE}/harvest`, 'GET no contrato do gateway');
    const headers = stub.calls[0].options?.headers as Record<string, string>;
    assert.equal(headers['x-indexer-test-token'], 'tok-teste');
  } finally {
    stub.restore();
  }
});

test('status: corpo torto não inventa número nem derruba a ponte', async () => {
  const stub = stubFetch(() => json({ ok: true }));
  try {
    const snap = await refreshHarvestStatus();
    assert.equal(snap?.ok, true);
    assert.equal(snap?.enabled, false, 'ausência de enabled vira false, não true');
    assert.equal(snap?.queriesThisHour, 0);
    assert.deepEqual(snap?.counters, { drained: 0, failed: 0 });
    assert.equal(harvestNativeOnline(), false, 'enabled=false não é um gateway operante');
  } finally {
    stub.restore();
  }
});

test('backoff: duas falhas sequenciais bloqueiam a ponte e o próximo pedido nem sai', async () => {
  const failing = stubFetch(() => ({ ok: false, status: 500, json: async () => ({}) }));
  try {
    await refreshHarvestStatus();
    await refreshHarvestStatus();
    assert.equal(failing.calls.length, 2, 'as duas primeiras tentativas saíram');
    await refreshHarvestStatus();
    assert.equal(failing.calls.length, 2, 'em backoff a ponte recusa localmente e não faz fetch');
  } finally {
    failing.restore();
  }
});

test('backoff: reset devolve a ponte ao ar (sucesso zera as falhas)', async () => {
  const failing = stubFetch(() => ({ ok: false, status: 500, json: async () => ({}) }));
  try {
    await refreshHarvestStatus();
    await refreshHarvestStatus();
  } finally {
    failing.restore();
  }
  resetHarvestBridgeForTests();
  const ok = stubFetch(() => json({ ok: true, enabled: true }));
  try {
    const snap = await refreshHarvestStatus();
    assert.equal(snap?.enabled, true, 'depois do reset a ponte volta a falar com o gateway');
    assert.equal(ok.calls.length, 1, 'e o GET de status sai');
  } finally {
    ok.restore();
  }
});

test('pause/drain/clear: o painel lê o retorno do gateway, não um número inventado', async () => {
  const stub = stubFetch((rawUrl) => {
    if (rawUrl.endsWith('/harvest/pause')) return json({ paused: true });
    if (rawUrl.endsWith('/harvest/drain')) return json({ drained: 3 });
    if (rawUrl.endsWith('/harvest/clear')) return json({ cleared: 2 });
    return { ok: false, status: 404, json: async () => ({}) };
  });
  try {
    assert.equal(await pauseNativeHarvest(true), true);
    assert.deepEqual(await drainNativeHarvest(5), { drained: 3, timedOut: false });
    assert.equal(await clearNativeHarvest(), 2);
    assert.deepEqual(JSON.parse(String(stub.calls[1].options?.body)), { max: 5 });
  } finally {
    stub.restore();
  }
});

test('drain: prazo próprio, e vencê-lo não pausa a ponte (o gateway segue drenando)', async () => {
  // O gateway só responde depois de drenar; com o prazo de 2 s das outras rotas
  // o botão nunca respondia e o timeout pausava a ponte por 30 s.
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const stub = stubFetch((rawUrl) => {
    if (rawUrl.endsWith('/harvest/drain')) throw timeout;
    if (rawUrl.endsWith('/harvest')) return json({ ok: true, enabled: true });
    return { ok: false, status: 404, json: async () => ({}) };
  });
  try {
    assert.ok(config.streamStore.drainTimeoutMs > config.streamStore.timeoutMs, 'o drain tem prazo maior que as rotas curtas');
    assert.deepEqual(await drainNativeHarvest(1), { drained: 0, timedOut: true });
    assert.deepEqual(await drainNativeHarvest(1), { drained: 0, timedOut: true });
    assert.equal(
      (await refreshHarvestStatus())?.enabled,
      true,
      'dois drains longos seguidos não colocam a ponte em backoff',
    );
    assert.ok(stub.calls.some((call) => call.url.endsWith('/harvest')), 'e o GET de status sai');
  } finally {
    stub.restore();
  }
});
