// Testes das rotas internas de busca (POST /internal/search/meta e
// POST /internal/search/state), molde de `internal-crawl-routes.test.ts`.
//
// O harness fala SEMPRE por 127.0.0.1, então o caminho 403 (fora do loopback)
// não seria exercitado de outro jeito: o mini-app abaixo monta um middleware
// SÓ DE TESTE que troca o `remoteAddress` do socket via header. Esse override
// não existe em produção — a guarda lê o socket real.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
process.env.CACHE_PERSIST = 'false';
import express from 'express';
import { createTestApp, createTestServer, encodeConfig } from './e2e/e2e-harness.js';
import config from '../src/config.js';
import { buildServices } from '../src/routes/services.js';
import {
  registerInternalSearch,
  isLoopbackAddress,
} from '../src/routes/internal-search.js';
import type { InternalSearchCollaborators } from '../src/routes/internal-search.js';

const TOKEN = 'tok-internal-search';
const HASH = 'a'.repeat(40);

const overrides: Partial<InternalSearchCollaborators> = {
  // Stubs determinísticos: o teste prova o FIO da rota, não Cinemeta/TMDB.
  getMeta: async (type: string, imdbId: string) => ({ name: `Meta ${imdbId}`, year: '2024', type }),
  getTitles: async () => ({ pt: 'Título em Português', original: 'Original Title', en: 'Original Title', year: 2024 }),
  worksForObraMany: (imdb: string, targets) => targets.map((target) => {
    const season = target.season ?? -1;
    const episode = target.episode ?? -1;
    return {
      work: { hash: HASH, imdb, season, episode, firstSeen: 1700000000000, lastSeen: 1700000001000, passedFilter: 1 },
      magnet: {
        hash: HASH, uri: `magnet:?xt=urn:btih:${HASH}`, title: 'Filme Teste 2024 1080p DUBLADO',
        size: 1024, isBr: 1, dubbed: 1, quality: '1080p',
        seedersMax: 7, seedersLast: 7, firstSeen: 1700000000000, lastSeen: 1700000001000, lied: 0,
      },
    };
  }),
  sourcesForMany: (hashes) => new Map(hashes.map((hash) => [hash, [
    { hash, indexer: 'fake', tracker: 'FakeTracker', firstSeen: 1700000000000, lastSeen: 1700000001000, seedersLast: 3 },
  ]])),
  firstSeenMany: (hashes) => new Map(hashes.map((hash) => [hash, 1700000000000])),
};

let server: any;
const saved: Record<string, any> = {};
const encoded = encodeConfig({});

before(async () => {
  saved.testToken = config.jackett.testToken;
  config.jackett.testToken = TOKEN;

  const app = express();
  // Só de teste: permite personificar um cliente NÃO loopback. Nunca produção.
  // O `remoteAddress` é restaurado no fim da resposta porque o agente HTTP do
  // Node reaproveita o socket (keep-alive): sem restaurar, a requisição
  // seguinte herdaria o IP falsificado e a guarda recusaria tudo.
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
  registerInternalSearch(app as unknown as express.Router, services, overrides);
  server = await createTestServer(app);
});

after(async () => {
  await server.close();
  config.jackett.testToken = saved.testToken;
});

// ═══════════════════════════════════════════════════════════════════════════════
// Guarda
// ═══════════════════════════════════════════════════════════════════════════════

test('isLoopbackAddress: aceita 127.0.0.1/::1/::ffff:127.0.0.1 e recusa o resto', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('10.0.0.5'), false);
  assert.equal(isLoopbackAddress('::ffff:10.0.0.5'), false);
  assert.equal(isLoopbackAddress(undefined), false);
});

test('POST /internal/search/meta: fora do loopback com token certo → 403', async () => {
  const res = await server.request('POST', '/internal/search/meta', {
    headers: { 'X-Indexer-Test-Token': TOKEN, 'x-test-remote-addr': '203.0.113.9' },
    body: { encoded, type: 'movie', id: 'tt0000001' },
  });
  assert.equal(res.status, 403);
  assert.equal(res.json.ok, false);
});

test('POST /internal/search/state: fora do loopback → 403', async () => {
  const res = await server.request('POST', '/internal/search/state', {
    headers: { 'X-Indexer-Test-Token': TOKEN, 'x-test-remote-addr': '::ffff:10.0.0.5' },
    body: { encoded, obra_keys: ['tt0000001'], hashes: [] },
  });
  assert.equal(res.status, 403);
  assert.equal(res.json.ok, false);
});

test('POST /internal/search/meta: sem token → 401', async () => {
  const res = await server.request('POST', '/internal/search/meta', {
    body: { encoded, type: 'movie', id: 'tt0000001' },
  });
  assert.equal(res.status, 401);
  assert.equal(res.json.ok, false);
});

test('POST /internal/search/meta: token errado → 401', async () => {
  const res = await server.request('POST', '/internal/search/meta', {
    headers: { 'X-Indexer-Test-Token': 'tok-errado' },
    body: { encoded, type: 'movie', id: 'tt0000001' },
  });
  assert.equal(res.status, 401);
});

test('POST /internal/search/meta: operador sem token configurado → 503', async () => {
  const prev = config.jackett.testToken;
  config.jackett.testToken = '';
  try {
    const res = await server.request('POST', '/internal/search/meta', {
      body: { encoded, type: 'movie', id: 'tt0000001' },
    });
    assert.equal(res.status, 503);
    assert.equal(res.json.ok, false);
  } finally {
    config.jackett.testToken = prev;
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /internal/search/meta
// ═══════════════════════════════════════════════════════════════════════════════

test('POST /internal/search/meta: token certo + encoded válido → 200 com meta/titles', async () => {
  const res = await server.request('POST', '/internal/search/meta', {
    headers: { 'X-Indexer-Test-Token': TOKEN },
    body: { encoded, type: 'movie', id: 'tt0000001' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.type, 'movie');
  assert.equal(res.json.imdb_id, 'tt0000001');
  assert.equal(res.json.season, null);
  assert.equal(res.json.meta.name, 'Meta tt0000001');
  assert.equal(res.json.titles.pt, 'Título em Português');
  // Opcionais são OPT-IN: sem o flag, nem aparecem (o Rust não paga TMDB extra).
  assert.equal('multiWork' in res.json, false);
  assert.equal('homeReleaseAt' in res.json, false);
});

test('POST /internal/search/meta: série com S/E separa o id', async () => {
  const res = await server.request('POST', '/internal/search/meta', {
    headers: { 'X-Indexer-Test-Token': TOKEN },
    body: { encoded, type: 'series', id: 'tt0000002:3:7' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.imdb_id, 'tt0000002');
  assert.equal(res.json.season, 3);
  assert.equal(res.json.episode, 7);
});

test('POST /internal/search/meta: encoded inválido → 400', async () => {
  const res = await server.request('POST', '/internal/search/meta', {
    headers: { 'X-Indexer-Test-Token': TOKEN },
    body: { encoded: 'não-é-base64url!!', type: 'movie', id: 'tt0000001' },
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.ok, false);
});

test('POST /internal/search/meta: type fora de movie|series → 400', async () => {
  const res = await server.request('POST', '/internal/search/meta', {
    headers: { 'X-Indexer-Test-Token': TOKEN },
    body: { encoded, type: 'channel', id: 'tt0000001' },
  });
  assert.equal(res.status, 400);
});

test('POST /internal/search/meta: id sem tt → 400', async () => {
  const res = await server.request('POST', '/internal/search/meta', {
    headers: { 'X-Indexer-Test-Token': TOKEN },
    body: { encoded, type: 'movie', id: '12345' },
  });
  assert.equal(res.status, 400);
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /internal/search/state
// ═══════════════════════════════════════════════════════════════════════════════

test('POST /internal/search/state: token certo + encoded válido → 200 em lote', async () => {
  const res = await server.request('POST', '/internal/search/state', {
    headers: { 'X-Indexer-Test-Token': TOKEN },
    body: { encoded, obra_keys: ['tt0000001', 'tt0000001:1:2'], hashes: [HASH, HASH.toUpperCase()] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  // A chave de resposta é EXATAMENTE a pedida (filme e episódio não colidem).
  assert.deepEqual(Object.keys(res.json.obras).sort(), ['tt0000001', 'tt0000001:1:2']);
  assert.equal(res.json.obras.tt0000001.length, 1);
  assert.equal(res.json.obras['tt0000001:1:2'][0].work.season, 1);
  assert.equal(res.json.obras['tt0000001:1:2'][0].work.episode, 2);
  // hashes são normalizados (minúsculo) e deduplicados.
  assert.deepEqual(Object.keys(res.json.sources), [HASH]);
  assert.equal(res.json.sources[HASH][0].indexer, 'fake');
  assert.equal(res.json.firstSeen[HASH], 1700000000000);
});

test('POST /internal/search/state: obra_key inválida → 400', async () => {
  const res = await server.request('POST', '/internal/search/state', {
    headers: { 'X-Indexer-Test-Token': TOKEN },
    body: { encoded, obra_keys: ['filme-sem-imdb'], hashes: [] },
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.ok, false);
});

test('POST /internal/search/state: obra_keys fora do formato de array → 400', async () => {
  const res = await server.request('POST', '/internal/search/state', {
    headers: { 'X-Indexer-Test-Token': TOKEN },
    body: { encoded, obra_keys: 'tt0000001', hashes: [] },
  });
  assert.equal(res.status, 400);
});

test('POST /internal/search/state: encoded inválido → 400', async () => {
  const res = await server.request('POST', '/internal/search/state', {
    headers: { 'X-Indexer-Test-Token': TOKEN },
    body: { obra_keys: ['tt0000001'], hashes: [] },
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.ok, false);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Montagem real (register.ts): a rota interna vem ANTES de /:userConfig
// ═══════════════════════════════════════════════════════════════════════════════

test('app real: /internal/search/meta é a rota interna (não o overlay /:userConfig)', async () => {
  const appServer = await createTestServer(createTestApp());
  try {
    // Sem token: se o overlay /:userConfig tivesse capturado "/internal", a
    // resposta seria 404 "configuração inválida" (decode de "internal" falha).
    const res = await appServer.request('POST', '/internal/search/meta', { body: {} });
    assert.equal(res.status, 401);
    assert.equal(res.json.ok, false);
  } finally {
    await appServer.close();
  }
});
