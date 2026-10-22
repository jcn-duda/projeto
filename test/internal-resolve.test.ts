// Testes das rotas internas do `/resolve` nativo do gateway:
// POST /internal/resolve/facts e POST /internal/resolve/effects.
// Molde de `internal-search-effects.test.ts`: app mínimo, guarda real e o
// `magnetdb` em memória (CACHE_PERSIST=false) como prova do efeito gravado.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
process.env.CACHE_PERSIST = 'false';
import express from 'express';
import { createTestServer, encodeConfig } from './e2e/e2e-harness.js';
import config from '../src/config.js';
import { buildServices } from '../src/routes/services.js';
import { registerInternalResolve } from '../src/routes/internal-resolve.js';
import * as magnetdb from '../src/utils/magnetdb.js';

const TOKEN = 'tok-internal-resolve';
const KEY = 'chave-de-teste-resolve';
const alldebrid = encodeConfig({ ds: 'alldebrid', dk: KEY });
const torbox = encodeConfig({ ds: 'torbox', dk: KEY });
const HASH = 'b'.repeat(40);

let server: any;
const saved: Record<string, any> = {};

before(async () => {
  saved.testToken = config.jackett.testToken;
  config.jackett.testToken = TOKEN;
  const app = express();
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
  registerInternalResolve(app as unknown as express.Router, buildServices());
  server = await createTestServer(app);
});

after(async () => {
  await server.close();
  config.jackett.testToken = saved.testToken;
});

const auth = { 'X-Indexer-Test-Token': TOKEN };
const post = (path: string, body: unknown, headers: Record<string, string> = auth) =>
  server.request('POST', path, { headers, body });

test('resolve interno: fora do loopback → 403; token errado → 401', async () => {
  const fora = await post('/internal/resolve/effects', {}, { ...auth, 'x-test-remote-addr': '203.0.113.9' });
  assert.equal(fora.status, 403);
  const semToken = await post('/internal/resolve/facts', {}, { 'X-Indexer-Test-Token': 'errado' });
  assert.equal(semToken.status, 401);
});

test('facts: AllDebrid sem hold devolve held:false; serviço divergente → 400', async () => {
  const ok = await post('/internal/resolve/facts', { encoded: alldebrid, service: 'alldebrid', hash: HASH });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.held, false);
  assert.equal(typeof ok.json.dropUncached, 'boolean');
  // Runtime da TorBox pedindo fato da AllDebrid: nada a responder.
  const torto = await post('/internal/resolve/facts', { encoded: torbox, service: 'alldebrid', hash: HASH });
  assert.equal(torto.status, 400);
  const outro = await post('/internal/resolve/facts', { encoded: torbox, service: 'torbox', hash: HASH });
  assert.equal(outro.status, 400, 'fatos só para alldebrid');
});

test('effects: play ok marca o magnet vivo na conta do encoded', async () => {
  const hash = 'c'.repeat(40);
  const res = await post('/internal/resolve/effects', {
    encoded: torbox, service: 'torbox', hash, outcome: 'ok', alive: true,
  });
  assert.equal(res.status, 200);
  assert.equal(magnetdb.peekAlive('torbox', KEY, hash), true);
});

test('effects: sem vídeo marca bad; dublagem falsa marca lie', async () => {
  const bad = 'd'.repeat(40);
  const lie = 'e'.repeat(40);
  const semVideo = await post('/internal/resolve/effects', {
    encoded: torbox, service: 'torbox', hash: bad, outcome: 'error',
    effect: { mark: 'bad', unprotect: false, invalidate: 'none', index: null, noteBlocked: false },
  });
  assert.equal(semVideo.status, 200);
  assert.equal(magnetdb.peekBad('torbox', KEY, bad), true);
  const mentira = await post('/internal/resolve/effects', {
    encoded: torbox, service: 'torbox', hash: lie, outcome: 'error',
    effect: { mark: 'lie', unprotect: true, invalidate: 'none', index: null, noteBlocked: false },
  });
  assert.equal(mentira.status, 200);
  assert.equal(magnetdb.peekLie('torbox', KEY, lie), true);
});

test('effects: corpo inválido ou serviço divergente não grava nada', async () => {
  const hash = 'f'.repeat(40);
  const semEfeito = await post('/internal/resolve/effects', { encoded: torbox, service: 'torbox', hash, outcome: 'error' });
  assert.equal(semEfeito.status, 400);
  const marcaDesconhecida = await post('/internal/resolve/effects', {
    encoded: torbox, service: 'torbox', hash, outcome: 'error',
    effect: { mark: 'veneno', invalidate: 'none', index: null },
  });
  assert.equal(marcaDesconhecida.status, 400);
  const divergente = await post('/internal/resolve/effects', {
    encoded: torbox, service: 'alldebrid', hash, outcome: 'error',
    effect: { mark: 'bad', invalidate: 'none', index: null, noteBlocked: false },
  });
  assert.equal(divergente.status, 400);
  assert.equal(magnetdb.peekBad('torbox', KEY, hash), false);
  assert.equal(magnetdb.peekBad('alldebrid', KEY, hash), false);
  const hashRuim = await post('/internal/resolve/effects', { encoded: torbox, service: 'torbox', hash: 'xyz', outcome: 'ok' });
  assert.equal(hashRuim.status, 400);
});
