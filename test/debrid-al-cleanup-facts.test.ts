/**
 * Fatos da limpeza AllDebrid enviados ao check NATIVO (sidecar 8710).
 *
 * O que se prova aqui é a PONTE: com `DEBRID_AL_CLEANUP=on` o hold volátil do
 * autofetch e o `adprot` durável saem no corpo, o inventário sai quando existe,
 * e `holdsComplete` fecha (fail-closed) quando o lote não pode ser comprovado.
 * Com a flag OFF nada é enviado (o caminho sem limpeza fica idêntico). O
 * caminho da checagem nativa é exercitado no Rust (`debrid_seam`), não aqui.
 *
 * Sem rede real: `/magnet/status` e `/debrid/check` são dublês de `fetch`.
 */
import './setup-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import config from '../src/config.js';
import type { DebridAdapter } from '../types/domain.js';
import { accountScope } from '../src/utils/request-key.js';
import * as alldebrid from '../src/debrid/alldebrid.js';
import { id as alldebridId } from '../src/debrid/alldebrid-api.js';
import { hold, release, protectBr, unprotect } from '../src/debrid/protected.js';
import { warmInventory } from '../src/debrid/alldebrid-inventory.js';
import { alldebridCleanupFacts } from '../src/debrid/alldebrid-cleanup-facts.js';
import { wrap } from '../src/debrid/rust-remote.js';

const newHash = () => randomBytes(20).toString('hex');

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * Dublê do `/magnet/status` (inventário). Qualquer outra URL é ERRO: o teste
 * existe para provar que a ponte não abre rede além da que já existe.
 */
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

test('hold volátil + adprot entram em heldHashes; holdsComplete fecha o lote', async () => {
  const apiKey = 'chave-fatos-holds-completos';
  const account = accountScope(apiKey);
  const volatileHash = newHash();
  const durableHash = newHash();
  const plainHash = newHash();
  const savedProtect = config.debrid.autoFetchProtectBr;
  const savedDrop = { ready: config.debrid.dropReady, uncached: config.debrid.dropUncached };
  const realFetch = globalThis.fetch;
  const status = statusStub([]);
  globalThis.fetch = status.impl;
  try {
    config.debrid.autoFetchProtectBr = true;
    config.debrid.dropReady = false;
    config.debrid.dropUncached = true;
    hold(volatileHash, 600, account);
    protectBr(alldebridId, account, durableHash);
    // Casing diferente do hold: o hash do lote chega como a busca o monta.
    const facts = alldebridCleanupFacts(apiKey, [volatileHash.toUpperCase(), durableHash, plainHash]);
    assert.equal(facts.holdsComplete, true, 'todos os hashes do lote foram avaliados nas duas camadas');
    assert.deepEqual(
      new Set(facts.heldHashes),
      new Set([volatileHash, durableHash]),
      'hold volátil e adprot entram; hash sem proteção não',
    );
    assert.equal(facts.heldHashes.length, 2, 'sem duplicata');
    // Flags do config viajam mesmo com o lote protegido: quem ignora é o Rust.
    assert.equal(facts.dropReady, false);
    assert.equal(facts.dropUncached, true);
    // Inventário frio nesta rodada: fail-safe do lado do Rust, não invenção.
    assert.equal(facts.inventoryLoaded, false);
    assert.deepEqual(facts.knownBefore, []);
    await warmInventory(apiKey);
    assert.equal(status.calls.length, 1, 'a ponte só pede o inventário que o caminho Node já pediria');
  } finally {
    release(volatileHash, account);
    unprotect(alldebridId, account, durableHash);
    config.debrid.autoFetchProtectBr = savedProtect;
    config.debrid.dropReady = savedDrop.ready;
    config.debrid.dropUncached = savedDrop.uncached;
    globalThis.fetch = realFetch;
  }
});

test('lote não comprovável vira holdsComplete:false (fail-closed), sem perder o que foi listado', async () => {
  const apiKey = 'chave-fatos-holds-incompletos';
  const account = accountScope(apiKey);
  const protectedHash = newHash();
  const realFetch = globalThis.fetch;
  const status = statusStub([]);
  globalThis.fetch = status.impl;
  try {
    // Chave vazia não identifica conta: não prova nada e nem consulta rede.
    const noKey = alldebridCleanupFacts('', [protectedHash]);
    assert.equal(noKey.holdsComplete, false);
    assert.deepEqual(noKey.heldHashes, []);
    assert.equal(noKey.inventoryLoaded, false);
    assert.equal(status.calls.length, 0, 'chave vazia não dispara inventário');

    hold(protectedHash, 600, account);
    // Entrada ilegível no lote: não dá para provar cobertura do lote inteiro.
    const mixed = alldebridCleanupFacts(apiKey, ['', protectedHash, 42 as unknown as string]);
    assert.equal(mixed.holdsComplete, false, 'cobertura parcial nunca vira prova');
    assert.deepEqual(mixed.heldHashes, [protectedHash], 'o que deu para provar continua listado');
    await warmInventory(apiKey);
  } finally {
    release(protectedHash, account);
    globalThis.fetch = realFetch;
  }
});

test('inventário: frio manda inventoryLoaded:false; quente manda o knownBefore do Node', async () => {
  const apiKey = 'chave-fatos-inventario';
  const knownHash = newHash();
  const realFetch = globalThis.fetch;
  const status = statusStub([{ hash: knownHash }]);
  globalThis.fetch = status.impl;
  try {
    const cold = alldebridCleanupFacts(apiKey, [newHash()]);
    assert.equal(cold.inventoryLoaded, false, 'snapshot ainda não chegou e não pode ser inventado');
    assert.deepEqual(cold.knownBefore, []);
    await warmInventory(apiKey);
    assert.equal(status.calls.length, 1);

    const warm = alldebridCleanupFacts(apiKey, [newHash()]);
    assert.equal(warm.inventoryLoaded, true);
    assert.deepEqual(warm.knownBefore, [knownHash], 'snapshot vigente vira o `knownBefore` do corpo');
    assert.equal(status.calls.length, 1, 'snapshot vigente não refaz a leitura');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('wrap só envia os fatos com a limpeza ligada e preserva os campos do contrato', async () => {
  const apiKey = 'chave-fatos-wrap';
  const account = accountScope(apiKey);
  const infoHash = newHash();
  const bodies: Array<Record<string, unknown>> = [];
  const realFetch = globalThis.fetch;
  let statusCalls = 0;
  const impl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/magnet/status')) {
      statusCalls += 1;
      return jsonResponse({ status: 'success', data: { magnets: [] } });
    }
    if (!url.endsWith('/debrid/check')) throw new Error(`fetch inesperado no teste: ${url}`);
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return jsonResponse({ cached: [infoHash], complete: true });
  }) as typeof fetch;
  globalThis.fetch = impl;
  const savedCleanup = config.debridRust.alCleanup;
  try {
    const adapter = { ...alldebrid } as unknown as DebridAdapter;

    // Flag OFF (default): caminho nativo de paridade idêntico ao anterior —
    // nenhum campo de limpeza e NENHUMA leitura extra de inventário.
    config.debridRust.alCleanup = false;
    const off = wrap(adapter, { token: 'tok', fetchImpl: impl });
    await off.checkCached(apiKey, [infoHash], { timeoutMs: 5000 });
    const offBody = bodies[0]!;
    assert.equal(offBody.service, 'alldebrid');
    assert.deepEqual(offBody.hashes, [infoHash]);
    for (const key of ['heldHashes', 'holdsComplete', 'knownBefore', 'inventoryLoaded', 'dropReady', 'dropUncached']) {
      assert.equal(key in offBody, false, `${key} não pode viajar com a limpeza OFF`);
    }
    assert.equal(statusCalls, 0, 'limpeza OFF não pode adicionar leitura de /magnet/status');

    // Flag ON: fatos completos + contrato anterior intacto.
    config.debridRust.alCleanup = true;
    hold(infoHash, 600, account);
    const wrapped = wrap(adapter, { token: 'tok', fetchImpl: impl });
    const result = await wrapped.checkCached(apiKey, [infoHash], {
      timeoutMs: 5000,
      fileHashes: [infoHash],
      fileWaitTimeoutMs: 4000,
    });
    assert.equal(result instanceof Set ? result.has(infoHash) : result.cached.has(infoHash), true);
    assert.equal(result instanceof Set ? true : result.complete, true);

    assert.equal(bodies.length, 2);
    const body = bodies[1]!;
    // Contrato anterior: o sidecar continua lendo os mesmos campos.
    assert.equal(body.service, 'alldebrid');
    assert.equal(body.apiKey, apiKey);
    assert.deepEqual(body.hashes, [infoHash]);
    assert.equal(body.timeoutMs, 5000);
    assert.deepEqual(body.fileHashes, [infoHash]);
    assert.equal(body.fileWaitTimeoutMs, 4000);
    // Ponte nova: hold do processo + inventário + drops do config.
    assert.deepEqual(body.heldHashes, [infoHash]);
    assert.equal(body.holdsComplete, true);
    assert.equal(typeof body.dropReady, 'boolean');
    assert.equal(typeof body.dropUncached, 'boolean');
    assert.equal(typeof body.inventoryLoaded, 'boolean');
    assert.ok(Array.isArray(body.knownBefore));
    await warmInventory(apiKey);
    assert.equal(statusCalls, 1, 'a ponte pede o inventário uma vez (snapshot frio)');

    // Serviço que não é a AllDebrid não recebe os fatos.
    const torbox = {
      id: 'torbox', label: 'TorBox', short: 'TB', cacheCheck: true, keyUrl: 'https://torbox.app',
      checkCached: async () => new Set<string>(),
      resolveLink: async () => null,
    } as DebridAdapter;
    const other = wrap(torbox, { token: 'tok', fetchImpl: impl });
    await other.checkCached('chave', [newHash()]);
    const otherBody = bodies[2]!;
    assert.equal(otherBody.service, 'torbox');
    assert.equal('heldHashes' in otherBody, false);
    assert.equal('holdsComplete' in otherBody, false);
    assert.equal('knownBefore' in otherBody, false);
  } finally {
    release(infoHash, account);
    config.debridRust.alCleanup = savedCleanup;
    globalThis.fetch = realFetch;
  }
});
