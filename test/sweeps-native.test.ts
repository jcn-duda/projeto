// Ponte Node → varreduras NATIVAS da AllDebrid (`/sweeps` na API administrativa
// do gateway, 8711).
//
// O AGENDADOR é do Rust: due, anti-reentrada, plano e aplicação vivem no
// `adom-server` e são testados lá (`cargo test -p adom-server`). O que o Node
// precisa garantir é o CONTRATO da ponte:
//   - `GET /sweeps` normaliza o snapshot e o espelho é síncrono para o painel;
//   - o `POST /sweeps/run` valida o tipo ANTES da rede e copia os nomes que o
//     toast do painel lê (`varridos`/`falhas`) além dos canônicos;
//   - 409 é RESPOSTA (busy/desligado), não falha; 503 e erro de rede põem a
//     ponte em backoff; prazo vencido NÃO põe — a varredura segue no gateway.
// Nada de rede real: o `fetch` é dublado em todos os testes.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import config from '../src/config.js';
import {
  flushPendingSweeps,
  normalizeSweepKind,
  refreshSweepsStatus,
  resetSweepsBridgeForTests,
  runNativeSweep,
  startSweepsPolling,
  stopSweepsPolling,
  sweepsStatusSnapshot,
} from '../src/utils/sweeps-native.js';
import { stubFetch, type FetchResponse } from './helpers/stub.js';

const BASE = 'http://127.0.0.1:8771';
const saved = {
  url: config.streamStore.url,
  token: config.streamStore.token,
  timeoutMs: config.streamStore.timeoutMs,
  backoffMs: config.streamStore.backoffMs,
  sweepTimeoutMs: config.streamStore.sweepTimeoutMs,
};

beforeEach(() => {
  resetSweepsBridgeForTests();
  config.streamStore.url = BASE;
  config.streamStore.token = 'tok-teste';
  config.streamStore.timeoutMs = 200;
  config.streamStore.sweepTimeoutMs = 200;
  // Backoff alto o bastante para o teste não depender de relógio: uma vez
  // bloqueada, a ponte fica bloqueada até o `reset` do afterEach.
  config.streamStore.backoffMs = 60_000;
});

afterEach(() => {
  resetSweepsBridgeForTests();
  config.streamStore.url = saved.url;
  config.streamStore.token = saved.token;
  config.streamStore.timeoutMs = saved.timeoutMs;
  config.streamStore.backoffMs = saved.backoffMs;
  config.streamStore.sweepTimeoutMs = saved.sweepTimeoutMs;
});

function json(body: unknown, status = 200): FetchResponse {
  return { ok: status < 400, status, json: async () => body };
}

/** Corpo completo do `GET /sweeps` (contrato §3.1 do plano). */
function statusBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    enabled: true,
    scheduled: true,
    mode: 'read_only',
    intervalMs: 21_600_000,
    running: false,
    startedAt: 1_793_220_000_000,
    lastTickAt: 1_793_223_600_000,
    nextDueAt: 1_793_245_200_000,
    lastByKind: { sweepDead: 1_793_223_600_000 },
    disabledReason: null,
    counters: {
      runs: 3,
      manualRuns: 1,
      reentered: 0,
      notDue: 12,
      missing: 0,
      planned: 7,
      swept: 0,
      failed: 0,
      blocked: 3,
      calls: 0,
      byKind: {
        sweepDead: { runs: 2, planned: 4, swept: 0, failed: 0, blocked: 2, calls: 0 },
        sweepUndubbed: { runs: 1, planned: 3, swept: 2, failed: 1, blocked: 1, calls: 9 },
      },
      reasons: { cleanup_off: 3, not_due: 12, nothing_missing: 1, preexisting: 1 },
    },
    last: {
      at: 1_793_223_600_000,
      manual: true,
      outcomes: [{ kind: 'sweep_dead', applied: false, planned: 4, swept: 0, failed: 0, blocked: 2, calls: 0, stopped: null, reasons: {} }],
      missing: ['revalidate'],
    },
    ...over,
  };
}

test('normalizeSweepKind aceita as grafias do vocabulário e recusa lixo', () => {
  assert.equal(normalizeSweepKind('sweepDead'), 'sweepDead');
  assert.equal(normalizeSweepKind('sweep_dead'), 'sweepDead');
  assert.equal(normalizeSweepKind('sweep-undubbed'), 'sweepUndubbed');
  assert.equal(normalizeSweepKind('SWEEPDEAD'), 'sweepDead');
  assert.equal(normalizeSweepKind('reconcile'), 'reconcile');
  assert.equal(normalizeSweepKind('apagar-tudo'), null);
  assert.equal(normalizeSweepKind(null), null);
});

test('status: GET /sweeps normaliza o contrato e preenche byKind inteiro', async () => {
  const stub = stubFetch(() => json(statusBody()));
  try {
    const snap = await refreshSweepsStatus();
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].url, `${BASE}/sweeps`);
    assert.equal((stub.calls[0].options as any)?.method, 'GET');
    assert.equal((stub.calls[0].options as any)?.headers['x-indexer-test-token'], 'tok-teste');

    assert.equal(snap?.ok, true);
    assert.equal(snap?.enabled, true);
    assert.equal(snap?.scheduled, true);
    assert.equal(snap?.mode, 'read_only');
    assert.equal(snap?.intervalMs, 21_600_000);
    assert.equal(snap?.running, false);
    assert.equal(snap?.startedAt, 1_793_220_000_000);
    assert.equal(snap?.lastTickAt, 1_793_223_600_000);
    assert.equal(snap?.nextDueAt, 1_793_245_200_000);
    assert.equal(snap?.disabledReason, null);
    assert.match(String(snap?.pulledAt), /^\d{4}-\d{2}-\d{2}T/);

    // Contadores presentes como vieram; ausentes viram 0 (é contador de processo).
    assert.equal(snap?.counters.runs, 3);
    assert.equal(snap?.counters.manualRuns, 1);
    assert.equal(snap?.counters.blocked, 3);
    assert.equal(snap?.counters.reasons.not_due, 12);
    // `byKind` sai COMPLETO, com zeros no tipo que o gateway não mandou.
    assert.deepEqual(Object.keys(snap?.counters.byKind ?? {}).sort(), ['reconcile', 'revalidate', 'sweepDead', 'sweepUndubbed']);
    assert.equal(snap?.counters.byKind.sweepUndubbed.swept, 2);
    assert.equal(snap?.counters.byKind.reconcile.runs, 0);
    // Atalho `sweptUndubbed` derivado do byKind quando o gateway não o manda.
    assert.equal(snap?.counters.sweptUndubbed, 2);

    // `last` normalizado: kind canônico e `missing` filtrado.
    assert.equal(snap?.last?.manual, true);
    assert.equal(snap?.last?.at, 1_793_223_600_000);
    assert.equal(snap?.last?.outcomes[0].kind, 'sweepDead');
    assert.equal(snap?.last?.outcomes[0].applied, false);
    assert.deepEqual(snap?.last?.missing, ['revalidate']);

    // O espelho é o MESMO objeto: o bloco do painel lê sem rede.
    assert.equal(sweepsStatusSnapshot(), snap);
  } finally {
    stub.restore();
  }
});

test('status: recusa do gateway mantém o snapshot anterior (nunca zera o painel)', async () => {
  const bom = stubFetch(() => json(statusBody()));
  try {
    await refreshSweepsStatus();
  } finally {
    bom.restore();
  }
  const ruim = stubFetch(() => json({ ok: false, error: 'sem conta' }, 503));
  try {
    const depois = await refreshSweepsStatus();
    assert.equal(depois?.counters.runs, 3, 'a foto boa anterior continua valendo');
    assert.equal(depois?.mode, 'read_only');
  } finally {
    ruim.restore();
  }
  // Uma falha só não pausa a ponte (o `ruim` acima foi a 1ª); a 2ª pausa.
  const outra = stubFetch(() => json({ ok: false }, 503));
  try {
    await refreshSweepsStatus();
    assert.equal(sweepsStatusSnapshot()?.counters.runs, 3, 'nada novo medido, foto anterior de pé');
    const bloqueado = await refreshSweepsStatus();
    assert.equal(bloqueado?.counters.runs, 3);
    assert.equal(outra.calls.length, 1, 'com a ponte em espera o GET nem sai');
  } finally {
    outra.restore();
  }
});

test('run 200: copia varridos/falhas e os nomes canônicos', async () => {
  const stub = stubFetch(() => json({
    ok: true, kind: 'sweepDead', ran: true, mode: 'apply', applied: true,
    planned: 5, swept: 4, varridos: 4, falhas: 1, failed: 1, blocked: 0, calls: 12,
    stopped: null, reasons: { expirado: 4 }, at: 1_793_300_000_000,
  }));
  try {
    const run = await runNativeSweep('sweepDead');
    const body = JSON.parse(String((stub.calls[0].options as any)?.body));
    assert.deepEqual(body, { kind: 'sweepDead', confirm: true });
    assert.equal((stub.calls[0].options as any)?.method, 'POST');
    assert.equal(stub.calls[0].url, `${BASE}/sweeps/run`);

    assert.equal(run.ok, true);
    assert.equal(run.ran, true);
    assert.equal(run.kind, 'sweepDead');
    assert.equal(run.mode, 'apply');
    assert.equal(run.applied, true);
    assert.equal(run.planned, 5);
    assert.equal(run.swept, 4);
    assert.equal(run.varridos, 4);
    assert.equal(run.falhas, 1);
    assert.equal(run.failed, 1);
    assert.equal(run.calls, 12);
    assert.equal(run.reasons.expirado, 4);
    assert.equal(run.at, 1_793_300_000_000);
  } finally {
    stub.restore();
  }
});

test('run 200 sem os nomes do painel: deriva varridos/falhas dos canônicos', async () => {
  const stub = stubFetch(() => json({ ok: true, kind: 'sweepUndubbed', ran: true, applied: true, planned: 2, swept: 2, failed: 0 }));
  try {
    const run = await runNativeSweep('sweepUndubbed');
    assert.equal(run.varridos, 2);
    assert.equal(run.falhas, 0);
  } finally {
    stub.restore();
  }
});

test('run 409 reentered: busy, sem backoff (é resposta, não falha)', async () => {
  let n = 0;
  const stub = stubFetch(() => {
    n += 1;
    return n === 1
      ? json({ ok: false, reason: 'reentered', error: 'varredura em andamento' }, 409)
      : json({ ok: true, kind: 'sweepDead', ran: true, applied: true, planned: 1, swept: 1, failed: 0 });
  });
  try {
    const busy = await runNativeSweep('sweepDead');
    assert.equal(busy.ok, false);
    assert.equal(busy.busy, true);
    assert.equal(busy.reason, 'reentered');
    assert.equal(busy.pending, undefined, 'busy não é pending');
    // Sem backoff: o pedido seguinte chega no gateway.
    const depois = await runNativeSweep('sweepDead');
    assert.equal(depois.ok, true);
    assert.equal(stub.calls.length, 2);
  } finally {
    stub.restore();
  }
});

test('run 409 desligado no gateway: ok:false com o motivo do corpo e sem backoff', async () => {
  for (const reason of ['cleanup_off', 'interval_zero', 'confirmation_required']) {
    resetSweepsBridgeForTests();
    const stub = stubFetch(() => json({ ok: false, reason, error: `recusa: ${reason}` }, 409));
    try {
      const run = await runNativeSweep('sweepDead');
      assert.equal(run.ok, false, reason);
      assert.equal(run.reason, reason);
      assert.equal(run.error, `recusa: ${reason}`);
      assert.equal(run.varridos, null, 'recusa não vira zero removido');
    } finally {
      stub.restore();
    }
  }
});

test('run inválido não sai para a rede', async () => {
  const stub = stubFetch(() => json({ ok: true }));
  try {
    const run = await runNativeSweep('apagar-tudo');
    assert.equal(run.ok, false);
    assert.equal(run.reason, 'invalid_kind');
    assert.equal(stub.calls.length, 0, 'tipo desconhecido é barrado localmente');
  } finally {
    stub.restore();
  }
});

test('run 503 e erro de rede: ok:false e dois seguidos põem a ponte em espera', async () => {
  const indisponivel = stubFetch(() => json({ ok: false, reason: 'no_operator_account', error: 'sem conta' }, 503));
  try {
    const primeira = await runNativeSweep('sweepDead');
    assert.equal(primeira.ok, false);
    assert.equal(primeira.reason, 'no_operator_account');
    const segunda = await runNativeSweep('sweepDead');
    assert.equal(segunda.ok, false);
    assert.equal(indisponivel.calls.length, 2);
    // Terceira: bloqueada ANTES da rede.
    const terceira = await runNativeSweep('sweepDead');
    assert.equal(terceira.reason, 'bridge-backoff');
    assert.equal(indisponivel.calls.length, 2, 'backoff evita martelar o gateway');
  } finally {
    indisponivel.restore();
  }
});

test('run com prazo vencido: ok:true + timedOut, continua no gateway e NÃO pausa a ponte', async () => {
  let n = 0;
  const relogio = stubFetch(() => {
    n += 1;
    if (n === 1) {
      const err = new Error('prazo da ponte venceu');
      err.name = 'TimeoutError';
      throw err;
    }
    return json({ ok: true, kind: 'sweepDead', ran: true, applied: true, planned: 1, swept: 1, failed: 0 });
  });
  try {
    const lento = await runNativeSweep('sweepDead');
    assert.equal(lento.ok, true, 'prazo vencido não é recusa da varredura');
    assert.equal(lento.ran, true);
    assert.equal(lento.timedOut, true);
    assert.equal(lento.pending, true);
    assert.equal(lento.varridos, null, 'nada medido ainda');
    // Sem backoff: o próximo pedido sai normalmente.
    const seguinte = await runNativeSweep('sweepDead');
    assert.equal(seguinte.ok, true);
    assert.equal(relogio.calls.length, 2);
  } finally {
    relogio.restore();
  }
});

test('polling: arma uma vez, busca na hora e para no stop', async () => {
  const stub = stubFetch(() => json(statusBody()));
  try {
    startSweepsPolling(60_000);
    startSweepsPolling(60_000); // idempotente
    await flushPendingSweeps();
    assert.equal(stub.calls.length, 1, 'refresh imediato, um só timer');
    assert.equal(sweepsStatusSnapshot()?.counters.runs, 3);
    stopSweepsPolling();
    stopSweepsPolling(); // idempotente
    assert.equal(stub.calls.length, 1, 'parar não dispara refresh');
  } finally {
    stub.restore();
  }
});

// --- segunda credencial: token de diagnóstico não apaga magnet -------------

test('run sem o token destrutivo: nenhum fetch, nenhum backoff', async () => {
  // `config.streamStore.token` é `STREAM_STORE_ADMIN_TOKEN || DEBRID_INTERNAL_TOKEN`:
  // vazio = o gateway não tem credencial para apagar magnet. O token de
  // diagnóstico abaixo NÃO serve para o POST (só para o `GET /sweeps`).
  const savedJackett = config.jackett.testToken;
  config.streamStore.token = '';
  config.jackett.testToken = 'tok-diagnostico';
  const stub = stubFetch(() => json({ ok: true }));
  try {
    const run = await runNativeSweep('sweepDead');
    assert.equal(run.ok, false);
    assert.equal(run.reason, 'missing_admin_token');
    assert.match(String(run.error), /STREAM_STORE_ADMIN_TOKEN/);
    assert.equal(run.varridos, null, 'recusa não vira zero removido');
    assert.equal(stub.calls.length, 0, 'config ausente não vai à rede');
    // Nada de backoff: o próximo pedido também explica a credencial, sem fetch.
    const outra = await runNativeSweep('sweepDead');
    assert.equal(outra.reason, 'missing_admin_token');
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
    config.jackett.testToken = savedJackett;
  }
});

test('status: sem token próprio o GET cai no token de DIAGNÓSTICO', async () => {
  const savedJackett = config.jackett.testToken;
  config.streamStore.token = '';
  config.jackett.testToken = 'tok-diagnostico';
  const stub = stubFetch(() => json(statusBody()));
  try {
    const snap = await refreshSweepsStatus();
    assert.equal(stub.calls.length, 1);
    assert.equal((stub.calls[0].options as any)?.headers['x-indexer-test-token'], 'tok-diagnostico');
    assert.equal(snap?.ok, true);
  } finally {
    stub.restore();
    config.jackett.testToken = savedJackett;
  }
});
