// Bloco `debrid` do /dashboard-status.json: a foto das varreduras NATIVAS da
// AllDebrid entra como `debrid.sweeps`.
//
// Duas regras que estes testes travam:
//   1. o bloco é SÍNCRONO na parte nativa — ele lê o espelho da ponte e nunca
//      fala com o gateway (quem fala é o poll de fundo ou o refresh da ação);
//   2. sem foto, `sweeps` é `null` e o painel diz "status nativo indisponível".
//      Zero inventado num contador de varredura vira "0 removidos" na cara do
//      operador — mentira operacional.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import config from '../src/config.js';
import { createApp } from '../src/app.js';
import type { AppServices } from '../src/routes/types.js';
import { debridBlock } from '../src/routes/dashboard-debrid-block.js';
import { refreshSweepsStatus, resetSweepsBridgeForTests, sweepsStatusSnapshot } from '../src/utils/sweeps-native.js';
import { createTestServer, fakeResponse, withMockFetch } from './e2e/e2e-harness.js';
import { stubFetch, type FetchResponse } from './helpers/stub.js';

const BASE = 'http://127.0.0.1:8771';
const TOKEN = 'tok-painel-sweeps';
let server: any;
const saved: Record<string, any> = {};

before(async () => {
  saved.token = config.jackett.testToken;
  saved.storeUrl = config.streamStore.url;
  saved.storeToken = config.streamStore.token;
  saved.storeTimeoutMs = config.streamStore.timeoutMs;
  config.jackett.testToken = TOKEN;
  config.streamStore.url = BASE;
  config.streamStore.token = 'tok-teste';
  config.streamStore.timeoutMs = 200;
  server = await createTestServer(createApp().app);
});

after(async () => {
  await server.close();
  config.jackett.testToken = saved.token;
  config.streamStore.url = saved.storeUrl;
  config.streamStore.token = saved.storeToken;
  config.streamStore.timeoutMs = saved.storeTimeoutMs;
});

beforeEach(() => {
  resetSweepsBridgeForTests();
});

function json(body: unknown, status = 200): FetchResponse {
  return { ok: status < 400, status, json: async () => body };
}

function statusBody(): Record<string, unknown> {
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
    disabledReason: null,
    counters: {
      runs: 3, manualRuns: 1, reentered: 0, notDue: 12, missing: 0,
      planned: 7, swept: 0, failed: 0, blocked: 3, calls: 0,
      byKind: { sweepUndubbed: { swept: 2 } },
      reasons: { not_due: 12 },
    },
    last: { at: 1_793_223_600_000, manual: true, outcomes: [], missing: [] },
  };
}

/** `services` mínimo do bloco: só o trio que `debridBlock` consome. */
function fakeServices() {
  return {
    debrid: {
      current: () => ({ id: 'alldebrid', label: 'AllDebrid' }),
      dashboardAccounts: async () => ({ alldebrid: { ok: true } }),
      SERVICES: [{ id: 'alldebrid' }],
    },
  } as unknown as AppServices;
}

test('bloco debrid: sem foto, `sweeps` é null e o contrato antigo continua inteiro', async () => {
  const block = await debridBlock(fakeServices(), { ok: true, total: 933 });
  assert.equal(block.sweeps, null, 'sem foto o painel diz indisponível');
  assert.equal(block.active, 'alldebrid');
  assert.deepEqual(block.account, { ok: true, total: 933 });
  assert.deepEqual(block.accounts, { alldebrid: { ok: true } });
  assert.deepEqual(block.services, [{ id: 'alldebrid' }]);
});

test('bloco debrid: `sweeps` é a foto SÍNCRONA da ponte, não uma consulta nova', async () => {
  const stub = stubFetch(() => json(statusBody()));
  try {
    await refreshSweepsStatus();
  } finally {
    stub.restore();
  }
  const antes = stub.calls.length;
  const block = await debridBlock(fakeServices(), { ok: true });
  assert.equal(block.sweeps, sweepsStatusSnapshot(), 'mesmo objeto do espelho');
  assert.equal((block.sweeps as any).mode, 'read_only');
  assert.equal((block.sweeps as any).counters.planned, 7);
  assert.equal(stub.calls.length, antes, 'o bloco não chama o gateway');
});

test('painel: /dashboard-status.json?blocos=debrid publica debrid.sweeps', async () => {
  await withMockFetch([{ match: /\/sweeps$/, handler: () => fakeResponse(statusBody()) }], async () => {
    const semFoto = await server.request('GET', '/dashboard-status.json?blocos=debrid', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
    });
    assert.equal(semFoto.status, 200);
    assert.ok('sweeps' in semFoto.json.debrid, 'a chave existe sempre');
    assert.equal(semFoto.json.debrid.sweeps, null, 'sem foto: null, nunca zeros');

    // O poll de fundo tira a foto; o bloco seguinte a exibe.
    await refreshSweepsStatus();
    const comFoto = await server.request('GET', '/dashboard-status.json?blocos=debrid', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
    });
    assert.equal(comFoto.status, 200);
    const debrid = comFoto.json.debrid;
    // Contrato anterior preservado (o painel inteiro depende destas chaves).
    for (const key of ['active', 'account', 'accounts', 'services']) {
      assert.ok(key in debrid, `debrid.${key} preservado`);
    }
    assert.equal(debrid.sweeps.mode, 'read_only');
    assert.equal(debrid.sweeps.scheduled, true);
    assert.equal(debrid.sweeps.running, false);
    assert.equal(debrid.sweeps.intervalMs, 21_600_000);
    assert.equal(debrid.sweeps.counters.planned, 7);
    assert.equal(debrid.sweeps.counters.sweptUndubbed, 2, 'atalho derivado do byKind');
    assert.equal(debrid.sweeps.last.manual, true);
    assert.match(String(debrid.sweeps.pulledAt), /^\d{4}-\d{2}-\d{2}T/);
  });
});
