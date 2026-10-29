// Ponte Node → warmer NATIVO do Real-Debrid (`/rd-warm` na API administrativa
// do gateway, 8711).
//
// A fila, a sonda e o teto horário são do Rust (`cargo test -p adom-server`); o
// que o Node precisa garantir é o CONTRATO da ponte: o GET normaliza o snapshot
// para o painel, as ações mandam método/corpo/token certos, sem token
// destrutivo nada sai para a rede e, sem snapshot, a ponte devolve
// `native-unavailable` e `nativeWarmStatus()` devolve `null` (não há warmer
// local). Nada de rede real: o `fetch` é dublado em todos os testes.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import config from '../src/config.js';
import {
  drainNativeRdWarm,
  nativeWarmStatus,
  pauseNativeRdWarm,
  probeNativeRdWarm,
  rdWarmStatusSnapshot,
  refreshRdWarmStatus,
  resetRdWarmBridgeForTests,
  resumeNativeRdWarm,
} from '../src/utils/rd-warm-native.js';
import { stubFetch, type FetchResponse } from './helpers/stub.js';

const BASE = 'http://127.0.0.1:8774';
const saved = {
  url: config.streamStore.url,
  token: config.streamStore.token,
  timeoutMs: config.streamStore.timeoutMs,
  backoffMs: config.streamStore.backoffMs,
  rdWarmDrainTimeoutMs: config.streamStore.rdWarmDrainTimeoutMs,
  jackettToken: config.jackett.testToken,
};

beforeEach(() => {
  resetRdWarmBridgeForTests();
  config.streamStore.url = BASE;
  config.streamStore.token = 'tok-teste';
  config.streamStore.timeoutMs = 200;
  config.streamStore.rdWarmDrainTimeoutMs = 250;
  // Backoff alto o bastante para o teste não depender de relógio: uma vez
  // bloqueada, a ponte fica bloqueada até o `reset` do afterEach.
  config.streamStore.backoffMs = 60_000;
});

afterEach(() => {
  resetRdWarmBridgeForTests();
  config.streamStore.url = saved.url;
  config.streamStore.token = saved.token;
  config.streamStore.timeoutMs = saved.timeoutMs;
  config.streamStore.backoffMs = saved.backoffMs;
  config.streamStore.rdWarmDrainTimeoutMs = saved.rdWarmDrainTimeoutMs;
  config.jackett.testToken = saved.jackettToken;
});

function json(body: unknown, status = 200): FetchResponse {
  return { ok: status < 400, status, json: async () => body };
}

/** Corpo do `GET /rd-warm` (contrato da Fase 1 do porte). */
function statusBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    enabled: true,
    paused: false,
    queueDepth: 4,
    queueMax: 5000,
    batch: 10,
    maxPerHour: 300,
    queriesThisHour: 7,
    intervalMs: 30_000,
    idleWindowMs: 120_000,
    inFlight: false,
    lastTickAt: 1_793_220_000_000,
    accountSource: 'panel',
    counters: {
      enqueued: 11,
      skipped: 2,
      droppedFull: 1,
      droppedNoKey: 3,
      probes: 9,
      hits: 5,
      misses: 4,
      blocked: 1,
      stopped: 0,
    },
    ...over,
  };
}

test('status: GET /rd-warm normaliza o contrato e preenche o espelho sync', async () => {
  const stub = stubFetch(() => json(statusBody()));
  try {
    const snap = await refreshRdWarmStatus();
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].url, `${BASE}/rd-warm`);
    assert.equal(stub.calls[0].options?.method, 'GET');
    const headers = stub.calls[0].options?.headers as Record<string, string>;
    assert.equal(headers['x-indexer-test-token'], 'tok-teste');

    assert.equal(snap?.ok, true);
    assert.equal(snap?.enabled, true);
    assert.equal(snap?.paused, false);
    assert.equal(snap?.queueDepth, 4);
    assert.equal(snap?.queueMax, 5000);
    assert.equal(snap?.batch, 10);
    assert.equal(snap?.maxPerHour, 300);
    assert.equal(snap?.queriesThisHour, 7);
    assert.equal(snap?.intervalMs, 30_000);
    assert.equal(snap?.idleWindowMs, 120_000);
    assert.equal(snap?.inFlight, false);
    assert.equal(snap?.lastTickAt, 1_793_220_000_000);
    assert.equal(snap?.accountSource, 'panel');
    assert.deepEqual(snap?.counters, statusBody().counters);
    assert.match(String(snap?.pulledAt), /^\d{4}-\d{2}-\d{2}T/);

    // O espelho é o MESMO objeto: o bloco do painel lê sem rede.
    assert.equal(rdWarmStatusSnapshot(), snap);
  } finally {
    stub.restore();
  }
});

test('status: corpo torto não inventa número nem origem', async () => {
  const stub = stubFetch(() => json({ ok: true }));
  try {
    const snap = await refreshRdWarmStatus();
    assert.equal(snap?.enabled, false, 'ausência de enabled vira false, não true');
    assert.equal(snap?.queueDepth, 0);
    assert.equal(snap?.lastTickAt, null, 'sem tick medido, nada de "agora"');
    assert.equal(snap?.accountSource, 'none');
    assert.deepEqual(snap?.counters, {
      enqueued: 0, skipped: 0, droppedFull: 0, droppedNoKey: 0,
      probes: 0, hits: 0, misses: 0, blocked: 0, stopped: 0,
    });
  } finally {
    stub.restore();
  }
});

test('pause/resume/drain: método, corpo e token destrutivo', async () => {
  const stub = stubFetch((rawUrl) => {
    if (rawUrl.endsWith('/rd-warm')) return json(statusBody());
    if (rawUrl.endsWith('/rd-warm/pause')) return json({ ok: true, paused: true });
    if (rawUrl.endsWith('/rd-warm/resume')) return json({ ok: true, paused: false });
    if (rawUrl.endsWith('/rd-warm/drain')) return json({ ok: true, processed: 3, queueRemaining: 1 });
    return json({ ok: false }, 404);
  });
  try {
    await refreshRdWarmStatus();

    const pause = await pauseNativeRdWarm();
    assert.deepEqual(pause, { ok: true, paused: true });
    assert.equal(stub.calls[1].url, `${BASE}/rd-warm/pause`);
    assert.equal(stub.calls[1].options?.method, 'POST');
    assert.deepEqual(JSON.parse(String(stub.calls[1].options?.body)), {});
    assert.equal((stub.calls[1].options?.headers as Record<string, string>)['x-indexer-test-token'], 'tok-teste');

    const resume = await resumeNativeRdWarm();
    assert.deepEqual(resume, { ok: true, paused: false });
    assert.equal(stub.calls[2].url, `${BASE}/rd-warm/resume`);
    assert.deepEqual(JSON.parse(String(stub.calls[2].options?.body)), {});

    const drain = await drainNativeRdWarm(7);
    assert.deepEqual(drain, { ok: true, processed: 3, queueRemaining: 1 });
    assert.equal(stub.calls[3].url, `${BASE}/rd-warm/drain`);
    assert.deepEqual(JSON.parse(String(stub.calls[3].options?.body)), { confirm: true, max: 7 });
    assert.equal(rdWarmStatusSnapshot()?.queueDepth, 1, 'o drain atualiza a fila do espelho');
  } finally {
    stub.restore();
  }
});

test('sem token destrutivo: o GET cai no diagnóstico e as ações não vão à rede', async () => {
  // `config.streamStore.token` vazio = o gateway não tem credencial para mexer
  // na fila. O token de diagnóstico serve ao GET, nunca ao POST.
  config.streamStore.token = '';
  config.jackett.testToken = 'tok-diagnostico';
  const stub = stubFetch((rawUrl) => (
    rawUrl.endsWith('/rd-warm') ? json(statusBody()) : json({ ok: true, paused: true })
  ));
  try {
    await refreshRdWarmStatus();
    assert.equal((stub.calls[0].options?.headers as Record<string, string>)['x-indexer-test-token'], 'tok-diagnostico');

    for (const result of [await pauseNativeRdWarm(), await resumeNativeRdWarm(), await drainNativeRdWarm(5)]) {
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'missing_admin_token');
      assert.match(String(result.error), /STREAM_STORE_ADMIN_TOKEN/);
    }
    assert.equal(stub.calls.length, 1, 'config ausente não vai à rede nem entra em backoff');
  } finally {
    stub.restore();
  }
});

test('sem snapshot: native-unavailable sem tocar a rede (o painel reporta a falha)', async () => {
  const stub = stubFetch(() => json({ ok: true }));
  try {
    for (const result of [await pauseNativeRdWarm(), await resumeNativeRdWarm(), await drainNativeRdWarm()]) {
      assert.deepEqual(result, { ok: false, reason: 'native-unavailable', unavailable: true });
    }
    assert.equal(stub.calls.length, 0, 'sem snapshot a ponte nem tenta o gateway');
  } finally {
    stub.restore();
  }
});

test('status nativo mapeado para o formato de rd.warm no diagnóstico', async () => {
  const stub = stubFetch(() => json(statusBody()));
  try {
    await refreshRdWarmStatus();
    const out = nativeWarmStatus();
    assert.ok(out, 'com snapshot o diagnóstico publica o bloco');
    assert.equal(out.enabled, true);
    assert.equal(out.queueDepth, 4);
    assert.equal(out.lastTickAt, 1_793_220_000_000);
    assert.equal(out.paused, false);
    assert.equal(out.processedLastHour, 7, 'queriesThisHour vira processedLastHour');
    assert.equal(out.accountSource, 'panel');
    assert.equal(out.source, 'rust');
    assert.deepEqual(out.counters, statusBody().counters);
  } finally {
    stub.restore();
  }
});

test('sem snapshot, nativeWarmStatus devolve null', () => {
  assert.equal(nativeWarmStatus(), null, 'o dono é o gateway: nada de delegar ao warmer local');
});

test('probe: 200/ok:true (mesmo enabled:false) confirma o dono nativo; falha vira false', async () => {
  const ok = stubFetch(() => json(statusBody({ enabled: false })));
  try {
    assert.equal(await probeNativeRdWarm(), true, 'rota presente com warmer desligado ainda é dono nativo');
    assert.equal(rdWarmStatusSnapshot()?.enabled, false);
  } finally {
    ok.restore();
  }
  resetRdWarmBridgeForTests();
  const falha = stubFetch(() => ({ ok: false, status: 500, json: async () => ({}) }));
  try {
    assert.equal(await probeNativeRdWarm(), false, 'gateway antigo/sem a rota deixa a ponte sem snapshot');
  } finally {
    falha.restore();
  }
});

test('backoff: duas falhas seguidas bloqueiam o GET e a terceira nem sai', async () => {
  const stub = stubFetch(() => ({ ok: false, status: 500, json: async () => ({}) }));
  try {
    await refreshRdWarmStatus();
    await refreshRdWarmStatus();
    assert.equal(stub.calls.length, 2, 'as duas primeiras tentativas saíram');
    const terceira = await refreshRdWarmStatus();
    assert.equal(terceira, null);
    assert.equal(stub.calls.length, 2, 'em backoff a ponte não martela o gateway');
  } finally {
    stub.restore();
  }
});
