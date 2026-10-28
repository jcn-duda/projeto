// Ponte Node → worker NATIVO do Chupim (`/autofetch*` da admin do `adom-server`).
//
// O worker, a fila e a credencial vivem no Rust (`cargo test -p adom-server`);
// o que o Node precisa garantir é o CONTRATO da ponte: token SÓ no header, URL
// sem segredo, status normalizado, e `null`/`{ok:false}` — nunca exceção — no
// caminho do painel. Nada de rede real: o `fetch` é dublado em todos os testes.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import config from '../src/config.js';
import {
  autofetchEffectApplied,
  drainAutofetch,
  drainSuppressedAutofetch,
  fetchAutofetchStatus,
  pauseAutofetch,
  resetAutofetchBridgeForTests,
  setAutofetchConfig,
} from '../src/utils/autofetch-native.js';
import { stubFetch, type FetchResponse } from './helpers/stub.js';

const BASE = 'http://127.0.0.1:8778';
const TOKEN = 'tok-admin-chupim';
const saved = {
  url: config.streamStore.url,
  token: config.streamStore.token,
  timeoutMs: config.streamStore.timeoutMs,
  backoffMs: config.streamStore.backoffMs,
};

beforeEach(() => {
  resetAutofetchBridgeForTests();
  config.streamStore.url = BASE;
  config.streamStore.token = TOKEN;
  config.streamStore.timeoutMs = 200;
  // Backoff alto para o teste não depender de relógio: bloqueada, a ponte fica
  // bloqueada até o `restore` do finally.
  config.streamStore.backoffMs = 60_000;
});

afterEach(() => {
  resetAutofetchBridgeForTests();
  config.streamStore.url = saved.url;
  config.streamStore.token = saved.token;
  config.streamStore.timeoutMs = saved.timeoutMs;
  config.streamStore.backoffMs = saved.backoffMs;
});

function json(body: unknown): FetchResponse {
  return { ok: true, status: 200, json: async () => body };
}

function timeoutError(): Error {
  return Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
}

let stubCalls: Array<{ url: string; options?: any }> = [];

function withStub(handler: Parameters<typeof stubFetch>[0]) {
  const stub = stubFetch(handler);
  stubCalls = stub.calls;
  return stub;
}

function headersOf(index: number): Record<string, string> {
  return (stubCalls[index].options?.headers || {}) as Record<string, string>;
}

// (a) token só no header — URL limpa, sem segredo em lugar nenhum.
test('status: lê o contrato da admin e o token viaja SÓ no header', async () => {
  const stub = withStub(() => json({
    ok: true,
    status: {
      enabled: false, phase: 'prepared', paused: true,
      queueDepth: 3, lots: 2, inflight: false, intervalMs: 60_000,
    },
  }));
  try {
    const snap = await fetchAutofetchStatus();
    assert.deepEqual(snap, {
      enabled: false, phase: 'prepared', paused: true,
      queueDepth: 3, lots: 2, inflight: false, intervalMs: 60_000,
    });
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].url, `${BASE}/autofetch`, 'GET no contrato da admin');
    assert.equal(stub.calls[0].url.includes(TOKEN), false, 'a URL não carrega o token');
    assert.equal(stub.calls[0].url.includes('token='), false, 'nada de token na querystring');
    assert.equal(stub.calls[0].options?.method, 'GET');
    assert.equal(headersOf(0)['x-indexer-test-token'], TOKEN, 'token no header da admin');
  } finally {
    stub.restore();
  }
});

test('status: admin antiga (sem o objeto status) não vira estado inventado', async () => {
  const stub = withStub(() => json({ ok: true }));
  try {
    assert.equal(await fetchAutofetchStatus(), null, 'sem `status` a ponte não responde o bloco');
  } finally {
    stub.restore();
  }
});

// (b) 503 do worker e prazo vencido: fallback silencioso, sem lançar.
test('503 do worker: comandos viram {ok:false} e o status vira null, sem exceção', async () => {
  const stub = withStub(() => ({
    ok: false,
    status: 503,
    json: async () => ({ ok: false, error: 'autofetch_worker_unavailable' }),
  }));
  try {
    assert.equal(await fetchAutofetchStatus(), null);
    const pause = await pauseAutofetch(true);
    assert.deepEqual(pause, { ok: false, error: 'autofetch_worker_unavailable' });
    assert.equal(autofetchEffectApplied(pause), false, 'recusa não é efeito aplicado');
    assert.equal(autofetchEffectApplied(await drainAutofetch()), false);
  } finally {
    stub.restore();
  }
});

test('prazo vencido/rede fora: TODAS as chamadas devolvem null e nada lança', async () => {
  const stub = withStub(() => { throw timeoutError(); });
  try {
    assert.equal(await fetchAutofetchStatus(), null);
    assert.equal(await pauseAutofetch(true), null);
    assert.equal(await setAutofetchConfig({ paused: false }), null);
    assert.equal(await drainAutofetch(), null);
    assert.equal(await drainSuppressedAutofetch(), null);
    // Sem exceção em nenhuma das cinco; e o backoff (2 falhas) poupa a rede do
    // resto em vez de insistir a cada clique do painel.
    assert.equal(stub.calls.length, 2, 'duas tentativas e o resto fica em backoff');
  } finally {
    stub.restore();
  }
});

test('backoff: duas falhas seguidas sossegam a ponte e o pedido seguinte nem sai', async () => {
  const failing = withStub(() => ({ ok: false, status: 500, json: async () => ({}) }));
  try {
    await fetchAutofetchStatus();
    await fetchAutofetchStatus();
    assert.equal(failing.calls.length, 2, 'as duas primeiras tentativas saíram');
    assert.equal(await drainAutofetch(), null, 'em backoff a ponte devolve null sem fetch');
    assert.equal(failing.calls.length, 2, 'e não faz fetch durante o bloqueio');
  } finally {
    failing.restore();
  }
  resetAutofetchBridgeForTests();
  const ok = withStub(() => json({ ok: true, status: { enabled: false, phase: 'prepared' } }));
  try {
    assert.ok(await fetchAutofetchStatus(), 'depois do reset o status volta a sair');
    assert.equal(ok.calls.length, 1);
  } finally {
    ok.restore();
  }
});

// (c) proxy das ações: caminho, corpo e header de cada rota da admin.
test('comandos: cada ação bate na rota certa da admin, com o corpo do contrato', async () => {
  const stub = withStub((rawUrl) => {
    if (rawUrl.endsWith('/autofetch/pause')) {
      return json({ ok: true, status: { enabled: false, phase: 'prepared', paused: true, intervalMs: 1000 } });
    }
    if (rawUrl.endsWith('/autofetch/config')) {
      return json({ ok: true, status: { enabled: false, phase: 'prepared', paused: false, intervalMs: 5000 } });
    }
    if (rawUrl.endsWith('/autofetch/drain')) {
      return json({ ok: true, enabled: false, phase: 'prepared', operation: 'drain', effect: 'none', drained: 0 });
    }
    if (rawUrl.endsWith('/autofetch/suppressed-drain')) {
      return json({ ok: true, enabled: false, phase: 'prepared', operation: 'suppressed-drain', effect: 'none', drained: 0 });
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  try {
    const pause = await pauseAutofetch(true);
    assert.equal(pause?.ok, true);
    assert.equal(pause?.status?.paused, true, 'estado efetivo vem do gateway');
    assert.deepEqual(JSON.parse(String(stub.calls[0].options?.body)), { paused: true });

    const configOut = await setAutofetchConfig({ paused: false, intervalMs: 5000 });
    assert.equal(configOut?.status?.intervalMs, 5000);
    assert.deepEqual(JSON.parse(String(stub.calls[1].options?.body)), { paused: false, intervalMs: 5000 });

    const drain = await drainAutofetch();
    assert.deepEqual(
      { ok: drain?.ok, effect: drain?.effect, operation: drain?.operation, drained: drain?.drained },
      { ok: true, effect: 'none', operation: 'drain', drained: 0 },
    );
    assert.deepEqual(JSON.parse(String(stub.calls[2].options?.body)), {}, 'o dreno não manda credencial nem parâmetro');

    const suppressed = await drainSuppressedAutofetch();
    assert.equal(suppressed?.operation, 'suppressed-drain');

    assert.deepEqual(
      stub.calls.map((call) => call.url),
      [`${BASE}/autofetch/pause`, `${BASE}/autofetch/config`, `${BASE}/autofetch/drain`, `${BASE}/autofetch/suppressed-drain`],
    );
    for (const [index, call] of stub.calls.entries()) {
      assert.equal(call.options?.method, 'POST');
      assert.equal(headersOf(index)['x-indexer-test-token'], TOKEN, `token no header (${call.url})`);
      assert.equal(call.url.includes(TOKEN), false, `URL sem token (${call.url})`);
    }
  } finally {
    stub.restore();
  }
});

test('effect: só `effect` diferente de "none" libera o Node de fazer o trabalho', () => {
  assert.equal(autofetchEffectApplied({ ok: true, effect: 'none' }), false);
  assert.equal(autofetchEffectApplied({ ok: true }), true, 'worker vivo devolve drained sem effect');
  assert.equal(autofetchEffectApplied({ ok: false, effect: 'applied' }), false, 'recusa nunca conta');
  assert.equal(autofetchEffectApplied(null), false);
});
