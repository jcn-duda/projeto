// Ponte Node → CATÁLOGO da conta no gateway (`/account-catalog/*`, API admin 8711).
//
// O catálogo (varredura, dedup, auditoria, limpeza) é do Rust. O que o Node
// garante aqui é o CONTRATO da ponte:
//   - cada ação vai à rota, método e corpo certos, com o token certo: as que
//     apagam magnet (`dedup-apply`, `manual-delete`, `cleanup-apply`) usam SÓ o
//     destrutivo e sempre mandam `confirm:true`; as demais aceitam o diagnóstico;
//   - a ponte NUNCA lança: rede, 404/5xx e JSON ausente viram
//     `native-unavailable`; 4xx devolve o motivo que o gateway deu no corpo.
// Nada de rede real: o `fetch` é dublado em todos os testes.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import config from '../src/config.js';
import * as bridge from '../src/debrid/account-catalog-native.js';
import { stubFetch, type FetchResponse, type FetchStub } from './helpers/stub.js';

const BASE = 'http://127.0.0.1:8772';
const ADMIN = 'tok-admin';
const DIAG = 'tok-diag';

const saved = {
  url: config.streamStore.url,
  token: config.streamStore.token,
  testToken: config.jackett.testToken,
};

beforeEach(() => {
  config.streamStore.url = BASE;
  config.streamStore.token = ADMIN;
  config.jackett.testToken = DIAG;
});

afterEach(() => {
  config.streamStore.url = saved.url;
  config.streamStore.token = saved.token;
  config.jackett.testToken = saved.testToken;
});

function json(body: unknown, status = 200): FetchResponse {
  return { ok: status < 400, status, json: async () => body };
}

function headerOf(stub: FetchStub, index = 0, name = 'x-indexer-test-token'): string | undefined {
  const headers = stub.calls[index]?.options?.headers as Record<string, string> | undefined;
  return headers?.[name];
}

function bodyOf(stub: FetchStub, index = 0): unknown {
  const raw = stub.calls[index]?.options?.body;
  return raw === undefined ? undefined : JSON.parse(String(raw));
}

test('status: GET na rota, token de diagnóstico quando não há token próprio', async () => {
  config.streamStore.token = '';
  const stub = stubFetch(() => json({ ok: true, rows: 3 }));
  try {
    const r = await bridge.catalogStatusEnv();
    assert.deepEqual(r, { ok: true, rows: 3 });
    assert.equal(stub.calls[0].url, `${BASE}/account-catalog/status`);
    assert.equal(stub.calls[0].options?.method, 'GET');
    assert.equal(headerOf(stub), DIAG);
    assert.ok(stub.calls[0].options?.signal, 'o prazo do status vai no AbortSignal');
  } finally {
    stub.restore();
  }
});

test('leitura usa o token próprio quando existe (ele vence o de diagnóstico)', async () => {
  const stub = stubFetch(() => json({ ok: true, plan: {} }));
  try {
    await bridge.dedupPreviewEnv();
    assert.equal(stub.calls[0].url, `${BASE}/account-catalog/dedup-preview`);
    assert.equal(stub.calls[0].options?.method, 'GET');
    assert.equal(headerOf(stub), ADMIN);
  } finally {
    stub.restore();
  }
});

test('scan: POST com corpo {} e a resposta do gateway volta como está', async () => {
  const stub = stubFetch(() => json({ ok: true, report: { scanned: 7 } }));
  try {
    const r = await bridge.catalogScanEnv();
    assert.deepEqual(r, { ok: true, report: { scanned: 7 } });
    assert.equal(stub.calls[0].url, `${BASE}/account-catalog/scan`);
    assert.equal(stub.calls[0].options?.method, 'POST');
    assert.deepEqual(bodyOf(stub), {});
  } finally {
    stub.restore();
  }
});

test('dedup-apply: destrutiva, manda max e confirm:true com o token próprio', async () => {
  const stub = stubFetch(() => json({ ok: true, deleted: 2, falhas: [] }));
  try {
    const r = await bridge.dedupApplyEnv(5);
    assert.deepEqual(r, { ok: true, deleted: 2, falhas: [] });
    assert.equal(stub.calls[0].url, `${BASE}/account-catalog/dedup-apply`);
    assert.equal(stub.calls[0].options?.method, 'POST');
    assert.equal(headerOf(stub), ADMIN);
    assert.deepEqual(bodyOf(stub), { max: 5, confirm: true });
  } finally {
    stub.restore();
  }
});

test('dedup-apply sem max: o corpo não leva a chave max', async () => {
  const stub = stubFetch(() => json({ ok: true, deleted: 0, falhas: [] }));
  try {
    await bridge.dedupApplyEnv();
    assert.deepEqual(bodyOf(stub), { confirm: true });
  } finally {
    stub.restore();
  }
});

test('destrutiva sem token próprio: nem vai à rede e devolve catalog_requires_admin_token', async () => {
  config.streamStore.token = '';
  const stub = stubFetch(() => json({ ok: true }));
  try {
    for (const run of [
      () => bridge.dedupApplyEnv(1),
      () => bridge.manualDeleteEnv({ serviceIds: ['1'] }),
      () => bridge.cleanupApplyEnv(1),
    ]) {
      const r = await run();
      assert.deepEqual(r, { ok: false, reason: 'catalog_requires_admin_token' });
    }
    assert.equal(stub.calls.length, 0, 'token de diagnóstico não apaga magnet: sem rede');
  } finally {
    stub.restore();
  }
});

test('manual-delete: POST com os ids e confirm:true, token destrutivo', async () => {
  const stub = stubFetch(() => json({ ok: true, total: 2, deleted: 2, falhas: 0 }));
  try {
    const r = await bridge.manualDeleteEnv({ serviceIds: ['11', 22] });
    assert.equal(r.ok, true);
    assert.equal(stub.calls[0].url, `${BASE}/account-catalog/manual-delete`);
    assert.equal(headerOf(stub), ADMIN);
    assert.deepEqual(bodyOf(stub), { serviceIds: ['11', 22], confirm: true });
  } finally {
    stub.restore();
  }
});

test('cleanup-apply: manda max, includeKnown e confirm:true', async () => {
  const stub = stubFetch(() => json({ ok: true, total: 1, deleted: 1, falhas: 0 }));
  try {
    await bridge.cleanupApplyEnv(3, { includeKnown: true });
    assert.equal(stub.calls[0].url, `${BASE}/account-catalog/cleanup-apply`);
    assert.equal(headerOf(stub), ADMIN);
    assert.deepEqual(bodyOf(stub), { max: 3, includeKnown: true, confirm: true });
  } finally {
    stub.restore();
  }
});

test('cleanup-preview: POST read-only com o token de diagnóstico quando não há o próprio', async () => {
  config.streamStore.token = '';
  const stub = stubFetch(() => json({ ok: true, targets: [] }));
  try {
    await bridge.cleanupPreviewEnv({ includeKnown: false });
    assert.equal(stub.calls[0].url, `${BASE}/account-catalog/cleanup-preview`);
    assert.equal(stub.calls[0].options?.method, 'POST');
    assert.equal(headerOf(stub), DIAG);
    assert.deepEqual(bodyOf(stub), { includeKnown: false });
  } finally {
    stub.restore();
  }
});

test('list: GET com bucket e limit na query; parâmetro ausente não entra na URL', async () => {
  const stub = stubFetch(() => json({ ok: true, rows: [] }));
  try {
    await bridge.catalogListEnv({ bucket: 'foreign', limit: 10 });
    assert.equal(stub.calls[0].url, `${BASE}/account-catalog/list?bucket=foreign&limit=10`);
    await bridge.catalogListEnv();
    assert.equal(stub.calls[1].url, `${BASE}/account-catalog/list`);
  } finally {
    stub.restore();
  }
});

test('audit e audit-requeue e versions: rotas e métodos certos', async () => {
  const stub = stubFetch(() => json({ ok: true }));
  try {
    await bridge.auditBackfillEnv({ max: 20, concurrency: 2 });
    await bridge.auditRequeueEnv({ max: 50 });
    await bridge.catalogVersionsEnv();
    assert.equal(stub.calls[0].url, `${BASE}/account-catalog/audit`);
    assert.deepEqual(bodyOf(stub, 0), { max: 20, concurrency: 2 });
    assert.equal(stub.calls[1].url, `${BASE}/account-catalog/audit-requeue`);
    assert.deepEqual(bodyOf(stub, 1), { max: 50 });
    assert.equal(stub.calls[2].url, `${BASE}/account-catalog/versions`);
    assert.equal(stub.calls[2].options?.method, 'GET');
  } finally {
    stub.restore();
  }
});

test('falha de rede: não lança e devolve native-unavailable', async () => {
  const stub = stubFetch(() => { throw new Error('connect ECONNREFUSED 127.0.0.1:8772'); });
  try {
    const r = await bridge.catalogStatusEnv();
    assert.deepEqual(r, { ok: false, reason: 'native-unavailable' });
    const d = await bridge.dedupApplyEnv(1);
    assert.deepEqual(d, { ok: false, reason: 'native-unavailable' });
  } finally {
    stub.restore();
  }
});

test('404, 5xx e corpo que não é objeto viram native-unavailable', async () => {
  const cases: FetchResponse[] = [json({ error: 'not_found' }, 404), json({ error: 'boom' }, 500), json(null, 200)];
  for (const response of cases) {
    const stub = stubFetch(() => response);
    try {
      const r = await bridge.catalogScanEnv();
      assert.deepEqual(r, { ok: false, reason: 'native-unavailable' });
    } finally {
      stub.restore();
    }
  }
});

test('4xx do gateway devolve o motivo do corpo (409, 403, 400)', async () => {
  const cases: Array<[FetchResponse, string]> = [
    [json({ ok: false, error: 'catalog_requires_admin_token' }, 409), 'catalog_requires_admin_token'],
    [json({ ok: false, error: 'catalog_token_insufficient' }, 403), 'catalog_token_insufficient'],
    [json({ ok: false, error: 'confirm_required' }, 400), 'confirm_required'],
  ];
  for (const [response, reason] of cases) {
    const stub = stubFetch(() => response);
    try {
      const r = await bridge.cleanupApplyEnv(1);
      assert.deepEqual(r, { ok: false, reason });
    } finally {
      stub.restore();
    }
  }
});

test('200 com ok:false do gateway passa como veio (diagnóstico do próprio gateway)', async () => {
  const stub = stubFetch(() => json({ ok: false, reason: 'inventario-frio' }));
  try {
    const r = await bridge.cleanupPreviewEnv();
    assert.deepEqual(r, { ok: false, reason: 'inventario-frio' });
  } finally {
    stub.restore();
  }
});
