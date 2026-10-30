/**
 * Contrato do feed de holds da AllDebrid, agora SEM rota Node.
 *
 * O `POST /internal/debrid/holds` saiu: o gateway calcula os mesmos fatos
 * (`al_cleanup_facts`). O que se prova aqui é a régua TS (oráculo em
 * `test/helpers/pipeline-oracle/alldebrid-holds-feed.ts`): o hold volátil do
 * autofetch + o `adprot` durável saem por hash do lote, `evaluated` cobre o
 * lote, o inventário quente vira `knownBefore`, e o que não dá para provar sai
 * `holdsComplete:false` (fail-closed). Também se prova que a rota não voltou
 * (404 no app real), para o gateway não ter um destino Node a chamar.
 *
 * O caminho do sidecar (`/debrid/check`) NÃO recebe `account`/`evaluated`.
 * Sem rede real: `/magnet/status` é dublê de `fetch`.
 */
import './setup-env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
// Persistência desligada ANTES do app real ser carregado (ver app-routes.test.ts).
process.env.CACHE_PERSIST = 'false';
import { createApp } from '../src/app.js';
import { createTestServer } from './e2e/e2e-harness.js';
import config from '../src/config.js';
import { accountScope } from '../src/utils/request-key.js';
import { id as alldebridId } from '../src/debrid/alldebrid-api.js';
import { hold, release, protectBr, unprotect } from '../src/debrid/protected.js';
import { warmInventory } from '../src/debrid/alldebrid-inventory.js';
import { alldebridCleanupFacts } from './helpers/pipeline-oracle/alldebrid-cleanup-facts.js';
import { alldebridHoldsFeedFacts } from './helpers/pipeline-oracle/alldebrid-holds-feed.js';

const TOKEN = 'tok-internal-debrid-holds';
const KEY = 'chave-do-usuario-holds';
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

before(async () => {
  saved.testToken = config.jackett.testToken;
  config.jackett.testToken = TOKEN;
  server = await createTestServer(createApp().app);
});

after(async () => {
  await server.close();
  config.jackett.testToken = saved.testToken;
});

// ═══════════════════════════════════════════════════════════════════════════════
// A rota saiu
// ═══════════════════════════════════════════════════════════════════════════════

test('POST /internal/debrid/holds saiu: 404 mesmo com o token certo, sem fato devolvido', async () => {
  const out = await server.request('POST', '/internal/debrid/holds', {
    headers: { 'X-Indexer-Test-Token': TOKEN },
    body: { encoded: 'x', service: 'alldebrid', hashes: [newHash()] },
  });
  assert.equal(out.status, 404);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Contrato do feed (régua TS no oráculo)
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

    // O hash do lote chega em caixa alta; a auditoria normaliza.
    const out = alldebridHoldsFeedFacts(KEY, [volatileHash.toUpperCase(), durableHash, plainHash]);
    // Identidade: sha256 da chave (o Rust confere antes de aceitar).
    assert.equal(out.account, account, 'account = accountScope(apiKey)');
    assert.deepEqual(
      new Set(out.heldHashes),
      new Set([volatileHash, durableHash]),
      'hold volátil e adprot entram; hash sem proteção não',
    );
    assert.equal(out.heldHashes.length, 2, 'sem duplicata');
    assert.deepEqual(
      new Set(out.evaluated),
      new Set([volatileHash, durableHash, plainHash]),
      'avaliados = todos os hashes válidos do lote',
    );
    assert.equal(out.holdsComplete, true, 'todos os hashes do lote foram avaliados');
    // Flags do config viajam mesmo sem drop: quem ignora é o Rust.
    assert.equal(out.dropReady, false);
    assert.equal(out.dropUncached, true);
    // Inventário frio nesta rodada: fail-safe do lado do Rust, não invenção.
    assert.equal(out.inventoryLoaded, false);
    assert.deepEqual(out.knownBefore, []);
    await warmInventory(KEY);
    assert.equal(status.calls.length, 1, 'o caminho TS pede só o inventário que já pediria');
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
    const out = alldebridHoldsFeedFacts(KEY, ['', protectedHash, '   ']);
    assert.equal(out.holdsComplete, false, 'cobertura parcial nunca vira prova');
    assert.deepEqual(out.heldHashes, [protectedHash], 'o que deu para provar continua listado');
    assert.deepEqual(out.evaluated, [protectedHash]);
  } finally {
    release(protectedHash, account);
    globalThis.fetch = realFetch;
  }
});

test('inventário quente vira knownBefore; frio nunca é inventado', async () => {
  // Conta própria: o snapshot de `knownBefore` é por conta.
  const key = 'chave-inventario-holds';
  const knownHash = newHash();
  const realFetch = globalThis.fetch;
  const status = statusStub([{ hash: knownHash }]);
  globalThis.fetch = status.impl;
  try {
    const cold = alldebridHoldsFeedFacts(key, [newHash()]);
    assert.equal(cold.inventoryLoaded, false, 'snapshot ainda não chegou não pode ser inventado');
    assert.deepEqual(cold.knownBefore, []);

    await warmInventory(key);
    assert.equal(status.calls.length, 1);
    const warm = alldebridHoldsFeedFacts(key, [newHash()]);
    assert.equal(warm.inventoryLoaded, true);
    assert.deepEqual(warm.knownBefore, [knownHash], 'snapshot vigente vira o knownBefore do feed');
    assert.equal(status.calls.length, 1, 'snapshot vigente não refaz a leitura');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('sem chave de debrid → fatos fail-closed (ninguém prova nada)', async () => {
  const out = alldebridHoldsFeedFacts('', [newHash()]);
  assert.equal(out.account, '');
  assert.equal(out.holdsComplete, false);
  assert.deepEqual(out.evaluated, []);
  assert.deepEqual(out.heldHashes, []);
  assert.equal(out.inventoryLoaded, false);
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
    assert.equal('account' in facts, false, 'account é exclusivo do feed do oráculo');
    assert.equal('evaluated' in facts, false, 'evaluated é exclusivo do feed do oráculo');
  } finally {
    release(hash, account);
    globalThis.fetch = realFetch;
  }
});
