/**
 * Feed de holds do gateway in-process: `POST /internal/debrid/holds`
 * (`DEBRID_AL_HOLDS=on`).
 *
 * O que se prova aqui é a PONTE que faltava para o seam do `adom-search`: o
 * hold volátil do autofetch + o `adprot` durável saem por hash do lote,
 * `evaluated` cobre o lote (prova que o Rust confere), o inventário quente vira
 * `knownBefore`, e o que não dá para provar sai `holdsComplete:false`
 * (fail-closed) — nunca um "completo" por omissão. A chave vem do `encoded`,
 * nunca do `.env` do operador.
 *
 * O caminho Node default e o corpo do sidecar (`/debrid/check`) NÃO mudam: o
 * último teste confere que `account`/`evaluated` são exclusivos deste feed.
 * Sem rede real: `/magnet/status` é dublê de `fetch`.
 */
import './setup-env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import express from 'express';
import { createTestServer, encodeConfig } from './e2e/e2e-harness.js';
import config from '../src/config.js';
import { buildServices } from '../src/routes/services.js';
import { registerInternalDebridHolds } from '../src/routes/internal-debrid-holds.js';
import { registerInternalDebridMarked } from '../src/routes/internal-debrid-marked.js';
import { accountScope } from '../src/utils/request-key.js';
import { prefix } from '../src/utils/cache-keys.js';
import { kvForget, kvPeek } from '../src/utils/native-kv.js';
import { id as alldebridId } from '../src/debrid/alldebrid-api.js';
import { hold, release, protectBr, unprotect } from '../src/debrid/protected.js';
import { warmInventory } from '../src/debrid/alldebrid-inventory.js';
import { alldebridCleanupFacts } from '../src/debrid/alldebrid-cleanup-facts.js';

const TOKEN = 'tok-internal-debrid-holds';
const KEY = 'chave-do-usuario-holds';
const encoded = encodeConfig({ dk: KEY });
const newHash = () => randomBytes(20).toString('hex');

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Dublê SÓ do `/magnet/status` (inventário); qualquer outra URL é erro. */
function statusStub(magnets: Array<{ hash: string }> = []) {
  const calls: string[] = [];
  const impl = (async (input: unknown) => {
    const url = String(input);
    if (!url.includes('/magnet/status')) throw new Error(`fetch inesperado no teste: ${url}`);
    calls.push(url);
    return jsonResponse({ status: 'success', data: { magnets } });
  }) as typeof fetch;
  return { impl, calls };
}

let server: any;
const saved: Record<string, any> = {};
/** Chave do contexto: trocada entre casos ('' = instalação sem debrid). */
let apiKeyOf = () => KEY;

const post = (body: unknown, headers: Record<string, string> = {}) =>
  server.request('POST', '/internal/debrid/holds', {
    headers: { 'X-Indexer-Test-Token': TOKEN, ...headers },
    body,
  });

before(async () => {
  saved.testToken = config.jackett.testToken;
  config.jackett.testToken = TOKEN;

  const app = express();
  // Só de teste: personifica um cliente NÃO loopback (mesmo molde das rotas
  // internas de busca).
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
  // Sem override de `factsFor`: os testes de contrato usam o levantamento REAL
  // (protected/inventory) com o `/magnet/status` dublado.
  registerInternalDebridHolds(app as unknown as express.Router, services, {
    apiKeyOf: () => apiKeyOf(),
  });
  registerInternalDebridMarked(app as unknown as express.Router, services);
  server = await createTestServer(app);
});

after(async () => {
  await server.close();
  config.jackett.testToken = saved.testToken;
});

// ═══════════════════════════════════════════════════════════════════════════════
// Guarda e validação de entrada
// ═══════════════════════════════════════════════════════════════════════════════

test('fora do loopback com token certo → 403; sem token → 401', async () => {
  const body = { encoded, service: 'alldebrid', hashes: [newHash()] };
  const out = await post(body, { 'x-test-remote-addr': '203.0.113.9' });
  assert.equal(out.status, 403);
  const noToken = await server.request('POST', '/internal/debrid/holds', { body });
  assert.equal(noToken.status, 401);
});

test('entrada inválida → 400 (encoded, serviço, hashes e teto)', async () => {
  const hash = newHash();
  assert.equal((await post({ service: 'alldebrid', hashes: [hash] })).status, 400);
  assert.equal((await post({ encoded, service: 'torbox', hashes: [hash] })).status, 400);
  assert.equal((await post({ encoded, service: 'alldebrid', hashes: hash })).status, 400);
  assert.equal((await post({
    encoded, service: 'alldebrid',
    hashes: Array.from({ length: 501 }, () => newHash()),
  })).status, 400);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Contrato do feed
// ═══════════════════════════════════════════════════════════════════════════════

test('hold volátil + adprot saem por hash do lote; evaluated cobre o lote', async () => {
  const account = accountScope(KEY);
  const volatileHash = newHash();
  const durableHash = newHash();
  const plainHash = newHash();
  const realFetch = globalThis.fetch;
  const status = statusStub([]);
  globalThis.fetch = status.impl;
  const savedProtect = config.debrid.autoFetchProtectBr;
  const savedDrop = { ready: config.debrid.dropReady, uncached: config.debrid.dropUncached };
  try {
    config.debrid.autoFetchProtectBr = true;
    config.debrid.dropReady = false;
    config.debrid.dropUncached = true;
    hold(volatileHash, 600, account);
    protectBr(alldebridId, account, durableHash);

    const out = await post({
      encoded,
      service: 'alldebrid',
      hashes: [volatileHash.toUpperCase(), durableHash, plainHash],
    });
    assert.equal(out.status, 200);
    assert.equal(out.json.ok, true);
    assert.equal(out.json.service, 'alldebrid');
    // Identidade: sha256 da chave (o Rust confere antes de aceitar).
    assert.equal(out.json.account, account, 'account = accountScope(apiKey)');
    // O hash do lote chega em caixa alta; a auditoria normaliza.
    assert.deepEqual(
      new Set(out.json.heldHashes),
      new Set([volatileHash, durableHash]),
      'hold volátil e adprot entram; hash sem proteção não',
    );
    assert.equal(out.json.heldHashes.length, 2, 'sem duplicata');
    assert.deepEqual(
      new Set(out.json.evaluated),
      new Set([volatileHash, durableHash, plainHash]),
      'avaliados = todos os hashes válidos do lote',
    );
    assert.equal(out.json.holdsComplete, true, 'todos os hashes do lote foram avaliados');
    // Flags do config viajam mesmo sem drop: quem ignora é o Rust.
    assert.equal(out.json.dropReady, false);
    assert.equal(out.json.dropUncached, true);
    // Inventário frio nesta rodada: fail-safe do lado do Rust, não invenção.
    assert.equal(out.json.inventoryLoaded, false);
    assert.deepEqual(out.json.knownBefore, []);
    await warmInventory(KEY);
    assert.equal(status.calls.length, 1, 'a rota só pede o inventário que o caminho Node já pediria');
  } finally {
    release(volatileHash, account);
    unprotect(alldebridId, account, durableHash);
    config.debrid.autoFetchProtectBr = savedProtect;
    config.debrid.dropReady = savedDrop.ready;
    config.debrid.dropUncached = savedDrop.uncached;
    globalThis.fetch = realFetch;
  }
});

test('lote não comprovável vira holdsComplete:false sem perder o que foi provado', async () => {
  const account = accountScope(KEY);
  const protectedHash = newHash();
  const realFetch = globalThis.fetch;
  const status = statusStub([]);
  globalThis.fetch = status.impl;
  try {
    hold(protectedHash, 600, account);
    // Lote vazio não prova nada.
    assert.equal(alldebridCleanupFacts(KEY, []).holdsComplete, false);
    // Hash ilegível no lote: não dá para provar cobertura do lote inteiro.
    const out = await post({
      encoded, service: 'alldebrid',
      hashes: ['', protectedHash, '   '],
    });
    assert.equal(out.status, 200);
    assert.equal(out.json.holdsComplete, false, 'cobertura parcial nunca vira prova');
    assert.deepEqual(out.json.heldHashes, [protectedHash], 'o que deu para provar continua listado');
    assert.deepEqual(out.json.evaluated, [protectedHash]);
  } finally {
    release(protectedHash, account);
    globalThis.fetch = realFetch;
  }
});

test('inventário quente vira knownBefore; frio nunca é inventado', async () => {
  // Conta própria: o snapshot de `knownBefore` é por conta e sobrevive entre
  // casos (os outros já aqueceram a chave dele).
  const key = 'chave-inventario-holds';
  apiKeyOf = () => key;
  const knownHash = newHash();
  const realFetch = globalThis.fetch;
  const status = statusStub([{ hash: knownHash }]);
  globalThis.fetch = status.impl;
  try {
    const cold = await post({ encoded, service: 'alldebrid', hashes: [newHash()] });
    assert.equal(cold.json.inventoryLoaded, false, 'snapshot ainda não chegou não pode ser inventado');
    assert.deepEqual(cold.json.knownBefore, []);

    await warmInventory(key);
    assert.equal(status.calls.length, 1);
    const warm = await post({ encoded, service: 'alldebrid', hashes: [newHash()] });
    assert.equal(warm.json.inventoryLoaded, true);
    assert.deepEqual(warm.json.knownBefore, [knownHash], 'snapshot vigente vira o knownBefore do feed');
    assert.equal(status.calls.length, 1, 'snapshot vigente não refaz a leitura');
  } finally {
    apiKeyOf = () => KEY;
    globalThis.fetch = realFetch;
  }
});

test('encoded sem chave de debrid → fatos fail-closed (ninguém prova nada)', async () => {
  apiKeyOf = () => '';
  try {
    const out = await post({ encoded: encodeConfig({}), service: 'alldebrid', hashes: [newHash()] });
    assert.equal(out.status, 200);
    assert.equal(out.json.ok, true);
    assert.equal(out.json.account, '');
    assert.equal(out.json.holdsComplete, false);
    assert.deepEqual(out.json.evaluated, []);
    assert.deepEqual(out.json.heldHashes, []);
    assert.equal(out.json.inventoryLoaded, false);
  } finally {
    apiKeyOf = () => KEY;
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Posse da checagem NATIVA (`POST /internal/debrid/marked`)
//
// O Rust sobe (`/magnet/upload`) pela conta; aqui se prova que a devolução grava
// a MESMA chave do caminho TS — `adsub` para o que subiu. Não há mais canal de
// remoção: a limpeza nativa é higiene da checagem e nunca grava `adrm`.
// ═══════════════════════════════════════════════════════════════════════════════

const adsubKey = (account: string, hash: string) => `${prefix('adsub')}${account}:${hash}`;
const adrmKey = (account: string, hash: string) => `${prefix('adrm')}${account}:${hash}`;
const postMarked = (body: unknown, headers: Record<string, string> = {}) =>
  server.request('POST', '/internal/debrid/marked', {
    headers: { 'X-Indexer-Test-Token': TOKEN, ...headers },
    body,
  });

/** Mesmo pin do `alldebrid-reupload.test.ts`: o verde não depende do `.env`. */
function withReuploadBlock(fn: () => Promise<void>): Promise<void> {
  const saved = { block: config.debrid.reuploadBlock, ttl: config.debrid.alldebridReuploadBlockTtlMs };
  config.debrid.reuploadBlock = true;
  config.debrid.alldebridReuploadBlockTtlMs = 3 * 24 * 3600 * 1000;
  return fn().finally(() => {
    config.debrid.reuploadBlock = saved.block;
    config.debrid.alldebridReuploadBlockTtlMs = saved.ttl;
  });
}

test('marked: fora do loopback com token certo → 403; sem token → 401', async () => {
  const body = { service: 'alldebrid', apiKey: KEY, submitted: [newHash()] };
  const out = await postMarked(body, { 'x-test-remote-addr': '203.0.113.9' });
  assert.equal(out.status, 403);
  const noToken = await server.request('POST', '/internal/debrid/marked', { body });
  assert.equal(noToken.status, 401);
});

test('marked: corpo inválido → 400 (serviço, chave, hash, lista e teto)', async () => {
  const hash = newHash();
  const ok = { service: 'alldebrid', apiKey: KEY, submitted: [hash] };
  assert.equal((await postMarked({})).status, 400);
  assert.equal((await postMarked({ ...ok, service: 'torbox' })).status, 400);
  assert.equal((await postMarked({ ...ok, apiKey: '' })).status, 400);
  assert.equal((await postMarked({ ...ok, submitted: [hash.slice(0, 39)] })).status, 400);
  assert.equal((await postMarked({ ...ok, submitted: hash })).status, 400);
  // Lista vazia não é "nada a fazer": é corpo inválido.
  assert.equal((await postMarked({ ...ok, submitted: [] })).status, 400);
  assert.equal((await postMarked({
    ...ok,
    submitted: Array.from({ length: 501 }, newHash),
  })).status, 400);
});

test('marked: submitted grava adsub; `removed` de binário antigo é ignorado (nunca vira adrm)', async () => {
  const account = accountScope(KEY);
  const subiu = newHash();
  const saiu = newHash();
  await withReuploadBlock(async () => {
    try {
      const out = await postMarked({
        service: 'alldebrid',
        apiKey: KEY,
        submitted: [subiu],
        // Corpo do contrato antigo: a higiene da checagem vinha como remoção e
        // bloqueava o hash por 3 dias — o Chupim parava de baixar o dublado.
        removed: [{ hash: saiu, name: 'Lanternas S01E08 WEB-DL 1080p x264 DUAL 5.1' }],
      });
      assert.equal(out.status, 202);
      assert.deepEqual(out.json, { ok: true, service: 'alldebrid', submitted: 1 });
      assert.notEqual(kvPeek(adsubKey(account, subiu)), null, 'posse gravada em adsub:v1');
      assert.equal(kvPeek(adrmKey(account, saiu)), null, 'higiene da checagem não bloqueia re-upload');
      assert.equal(kvPeek(adrmKey(account, subiu)), null, 'quem subiu não vira bloqueado');
    } finally {
      for (const hash of [subiu, saiu]) {
        kvForget(adsubKey(account, hash));
        kvForget(adrmKey(account, hash));
      }
    }
  });
});

test('corpo do sidecar (/debrid/check) segue sem account/evaluated', async () => {
  const account = accountScope(KEY);
  const hash = newHash();
  const realFetch = globalThis.fetch;
  const status = statusStub([]);
  globalThis.fetch = status.impl;
  try {
    hold(hash, 600, account);
    const facts = alldebridCleanupFacts(KEY, [hash]);
    assert.deepEqual(facts.heldHashes, [hash]);
    assert.equal(facts.holdsComplete, true);
    assert.equal('account' in facts, false, 'account é exclusivo do feed in-process');
    assert.equal('evaluated' in facts, false, 'evaluated é exclusivo do feed in-process');
  } finally {
    release(hash, account);
    globalThis.fetch = realFetch;
  }
});
