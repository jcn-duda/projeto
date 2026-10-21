// Testes de POST /internal/debrid/check (reserva do orquestrador Rust), molde
// de `internal-search-routes.test.ts`.
//
// O harness fala SEMPRE por 127.0.0.1, então o caminho 403 (fora do loopback)
// usa o mesmo middleware SÓ DE TESTE que troca o `remoteAddress` via header.
// Adaptadores são STUBS injetados (mesmo padrão de colaboradores de
// internal-search): o teste prova o fio da rota, nunca rede de debrid real.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
process.env.CACHE_PERSIST = 'false';
import express from 'express';
import { createTestServer, encodeConfig } from './e2e/e2e-harness.js';
import config from '../src/config.js';
import { buildServices } from '../src/routes/services.js';
import { registerInternalDebridCheck } from '../src/routes/internal-debrid-check.js';
import type { InternalDebridCheckCollaborators } from '../src/routes/internal-debrid-check.js';
import type { DebridAdapter } from '../types/domain.js';

const TOKEN = 'tok-internal-debrid';
const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);
const encoded = encodeConfig({});

/** Adaptador stub com cacheCheck ligado e resposta em lote configurável. */
function stubAdapter(overrides: Partial<DebridAdapter> = {}): DebridAdapter {
  return {
    id: 'torbox', label: 'TorBox', short: 'TB', cacheCheck: true, keyUrl: 'https://torbox.app',
    checkCached: async (_apiKey: string, hashes: string[]) => new Set(hashes),
    resolveLink: async () => null,
    ...overrides,
  } as unknown as DebridAdapter;
}

let server: any;
const saved: Record<string, any> = {};
let collaborators: InternalDebridCheckCollaborators;

const post = (body: unknown, headers: Record<string, string> = {}) =>
  server.request('POST', '/internal/debrid/check', {
    headers: { 'X-Indexer-Test-Token': TOKEN, ...headers },
    body,
  });

before(async () => {
  saved.testToken = config.jackett.testToken;
  config.jackett.testToken = TOKEN;

  const app = express();
  // Só de teste: permite personificar um cliente NÃO loopback (ver
  // internal-search-routes.test.ts — o socket é restaurado no fim da resposta).
  app.use((req, res, next) => {
    const spoof = req.get('x-test-remote-addr');
    if (!spoof) return next();
    const original = req.socket.remoteAddress;
    Object.defineProperty(req.socket, 'remoteAddress', { value: spoof, configurable: true, writable: true });
    res.on('finish', () => {
      Object.defineProperty(req.socket, 'remoteAddress', { value: original, configurable: true, writable: true });
    });
    return next();
  });
  const services = buildServices();
  collaborators = {
    adapterFor: () => stubAdapter(),
    apiKeyOf: () => 'chave-de-teste',
    availabilityCheck: () => null,
  };
  registerInternalDebridCheck(app as unknown as express.Router, services, collaborators);
  server = await createTestServer(app);
});

after(async () => {
  await server.close();
  config.jackett.testToken = saved.testToken;
});

// ═══════════════════════════════════════════════════════════════════════════════
// Guarda (mesma das rotas /internal/search/*)
// ═══════════════════════════════════════════════════════════════════════════════

test('fora do loopback com token certo → 403', async () => {
  const res = await post(
    { encoded, service: 'torbox', hashes: [HASH_A], deadline_at: Date.now() + 5_000 },
    { 'x-test-remote-addr': '203.0.113.9' },
  );
  assert.equal(res.status, 403);
  assert.equal(res.json.ok, false);
});

test('sem token → 401', async () => {
  const res = await server.request('POST', '/internal/debrid/check', {
    body: { encoded, service: 'torbox', hashes: [HASH_A], deadline_at: Date.now() + 5_000 },
  });
  assert.equal(res.status, 401);
  assert.equal(res.json.ok, false);
});

test('token errado → 401', async () => {
  const res = await post(
    { encoded, service: 'torbox', hashes: [HASH_A], deadline_at: Date.now() + 5_000 },
    { 'X-Indexer-Test-Token': 'tok-errado' },
  );
  assert.equal(res.status, 401);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Validação de entrada
// ═══════════════════════════════════════════════════════════════════════════════

test('encoded ausente → 400', async () => {
  const res = await post({ service: 'torbox', hashes: [HASH_A], deadline_at: Date.now() + 5_000 });
  assert.equal(res.status, 400);
});

test('service desconhecido → 400', async () => {
  const res = await post({ encoded, service: 'easynews', hashes: [HASH_A], deadline_at: Date.now() + 5_000 });
  assert.equal(res.status, 400);
});

test('hashes fora de array → 400', async () => {
  const res = await post({ encoded, service: 'torbox', hashes: HASH_A, deadline_at: Date.now() + 5_000 });
  assert.equal(res.status, 400);
});

test('hashes acima do teto de 500 → 400', async () => {
  const res = await post({
    encoded, service: 'torbox',
    hashes: Array.from({ length: 501 }, (_, i) => (i % 40 === 0 ? 'a' : 'c').repeat(40)),
    deadline_at: Date.now() + 5_000,
  });
  assert.equal(res.status, 400);
  assert.match(String(res.json.error), /teto de 500/);
});

test('deadline_at ausente ou já vencido → 400', async () => {
  assert.equal((await post({ encoded, service: 'torbox', hashes: [HASH_A] })).status, 400);
  assert.equal((await post({ encoded, service: 'torbox', hashes: [HASH_A], deadline_at: Date.now() - 1 })).status, 400);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Lote, falha isolada, configured:false, prazo
// ═══════════════════════════════════════════════════════════════════════════════

test('lote ok: cached/known por hash, parcial falso, chave e hashes em LOTE no adaptador', async () => {
  const seen: Array<{ apiKey: string; hashes: string[] }> = [];
  collaborators.adapterFor = () => stubAdapter({
    checkCached: async (apiKey: string, hashes: string[]) => {
      seen.push({ apiKey, hashes: [...hashes] });
      return new Set([HASH_A]);
    },
  });
  const res = await post({
    encoded, service: 'torbox', hashes: [HASH_A.toUpperCase(), HASH_B], deadline_at: Date.now() + 5_000,
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.service, 'torbox');
  assert.equal(res.json.configured, true);
  assert.equal(res.json.partial, false);
  // UMA chamada em lote, com hashes normalizados (minúsculo, dedupe) e a chave
  // do contexto do `encoded` (stub), não do `.env`.
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { apiKey: 'chave-de-teste', hashes: [HASH_A, HASH_B] });
  // Confirmado → cached+known; perguntado sem confirmação → known HONESTO
  // (não "não está em cache").
  assert.deepEqual(res.json.results[HASH_A], { cached: true, known: true });
  assert.deepEqual(res.json.results[HASH_B], { cached: false, known: true });
});

test('checagem da busca (davail) responde no lugar do adaptador cru, unusable vira estado da conta', async () => {
  let rawCalls = 0;
  const asked: Array<{ service: string; hashes: string[] }> = [];
  collaborators.adapterFor = () => stubAdapter({ checkCached: async () => { rawCalls += 1; return new Set(); } });
  collaborators.availabilityCheck = (service, hashes) => {
    asked.push({ service, hashes: [...hashes] });
    return Promise.resolve({ cached: new Set([HASH_A]), known: true });
  };
  try {
    const res = await post({ encoded, service: 'alldebrid', hashes: [HASH_A, HASH_B], deadline_at: Date.now() + 5_000 });
    assert.equal(res.status, 200);
    assert.equal(rawCalls, 0, 'o upload cru da AllDebrid não roda quando a checagem da busca responde');
    assert.deepEqual(asked, [{ service: 'alldebrid', hashes: [HASH_A, HASH_B] }]);
    assert.deepEqual(res.json.results[HASH_A], { cached: true, known: true });
    assert.deepEqual(res.json.results[HASH_B], { cached: false, known: true });

    collaborators.availabilityCheck = () => Promise.resolve({
      cached: new Set<string>(), known: false, unusable: { reason: 'auth', message: 'chave recusada' },
    });
    const bad = await post({ encoded, service: 'alldebrid', hashes: [HASH_A], deadline_at: Date.now() + 5_000 });
    assert.equal(bad.json.unusable, 'auth');
    assert.equal(bad.json.results[HASH_A].unusable, 'auth');
  } finally {
    collaborators.availabilityCheck = () => null;
  }
});

test('adaptador rejeita o lote → 200 com known:false + error isolado por hash', async () => {
  collaborators.adapterFor = () => stubAdapter({ checkCached: async () => { throw new Error('rede caiu'); } });
  const res = await post({ encoded, service: 'torbox', hashes: [HASH_A, HASH_B], deadline_at: Date.now() + 5_000 });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.partial, false);
  assert.deepEqual(res.json.results[HASH_A], { cached: false, known: false, error: 'falha' });
  assert.deepEqual(res.json.results[HASH_B], { cached: false, known: false, error: 'falha' });
});

test('erro de auth do adaptador → unusable por hash', async () => {
  collaborators.adapterFor = () => stubAdapter({
    checkCached: async () => { throw new Error('401 Unauthorized: bad token'); },
  });
  const res = await post({ encoded, service: 'torbox', hashes: [HASH_A], deadline_at: Date.now() + 5_000 });
  assert.equal(res.status, 200);
  assert.equal(res.json.unusable, 'auth');
  assert.equal(res.json.results[HASH_A].known, false);
  assert.equal(res.json.results[HASH_A].unusable, 'auth');
});

test('encoded sem chave de debrid → 200 configured:false com results vazio', async () => {
  collaborators.apiKeyOf = () => '';
  const res = await post({ encoded, service: 'torbox', hashes: [HASH_A], deadline_at: Date.now() + 5_000 });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.configured, false);
  assert.deepEqual(res.json.results, {});
  assert.equal(res.json.partial, false);
  collaborators.apiKeyOf = () => 'chave-de-teste';
});

test('adaptador sem cacheCheck → known:false honesto, sem perguntar', async () => {
  let called = 0;
  collaborators.adapterFor = () => stubAdapter({
    cacheCheck: false,
    checkCached: async () => { called += 1; return new Set<string>(); },
  });
  const res = await post({ encoded, service: 'debridlink', hashes: [HASH_A], deadline_at: Date.now() + 5_000 });
  assert.equal(res.status, 200);
  assert.equal(res.json.configured, true);
  assert.equal(res.json.cache_check, false);
  assert.equal(called, 0);
  assert.deepEqual(res.json.results[HASH_A], { cached: false, known: false });
});

test('prazo estourado → 200 partial:true com timeout por hash (nunca "não tem")', async () => {
  collaborators.adapterFor = () => stubAdapter({ checkCached: () => new Promise<Set<string>>(() => {}) });
  const res = await post({ encoded, service: 'torbox', hashes: [HASH_A], deadline_at: Date.now() + 60 });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.partial, true);
  assert.deepEqual(res.json.results[HASH_A], { cached: false, known: false, timeout: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// F4.6 — a rota deixa de ser a respondedora quando a checagem nativa está ligada
// ═══════════════════════════════════════════════════════════════════════════════

/** Roda com `DEBRID_AL_RUST` no modo pedido e restaura o ambiente no finally. */
async function withAlRust(mode: string, fn: () => Promise<void>) {
  const savedMode = process.env.DEBRID_AL_RUST;
  process.env.DEBRID_AL_RUST = mode;
  try {
    await fn();
  } finally {
    if (savedMode === undefined) delete process.env.DEBRID_AL_RUST;
    else process.env.DEBRID_AL_RUST = savedMode;
  }
}

test('DEBRID_AL_RUST=on → 410 (aposentada) sem tocar no adaptador', async () => {
  let called = 0;
  collaborators.adapterFor = () => stubAdapter({ checkCached: async () => { called += 1; return new Set(); } });
  await withAlRust('on', async () => {
    const res = await post({ encoded, service: 'alldebrid', hashes: [HASH_A], deadline_at: Date.now() + 5_000 });
    assert.equal(res.status, 410);
    assert.equal(res.json.ok, false);
    assert.equal(res.json.retired, true);
    assert.match(String(res.json.error), /DEBRID_AL_RUST=off/);
    assert.equal(called, 0, 'rota aposentada não faz upload nem checagem');
  });
});

test('DEBRID_AL_RUST=off → rollback de uma linha: a rota volta a checar', async () => {
  collaborators.adapterFor = () => stubAdapter({ checkCached: async (_apiKey, hashes) => new Set(hashes) });
  await withAlRust('off', async () => {
    const res = await post({ encoded, service: 'torbox', hashes: [HASH_A], deadline_at: Date.now() + 5_000 });
    assert.equal(res.status, 200);
    assert.equal(res.json.results[HASH_A].cached, true);
  });
});
