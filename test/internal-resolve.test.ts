// Testes das rotas internas do `/resolve` que SAÍRAM do Node:
// POST /internal/resolve/facts e POST /internal/resolve/effects. O gateway
// calcula o `held` do play (`resolve_bridge`) e grava os efeitos nos stores
// nativos, então as duas rotas têm que responder 404 no app real e não gravar
// nada. Se alguma voltar, este teste acusa (o magnet marcado apareceria no
// magnetdb, e o token certo não pode virar 401/403, que significaria rota viva).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
process.env.CACHE_PERSIST = 'false';
import { createApp } from '../src/app.js';
import { createTestServer, encodeConfig } from './e2e/e2e-harness.js';
import config from '../src/config.js';
import * as magnetdb from '../src/utils/magnetdb.js';
import * as magnetdbWrites from './helpers/pipeline-oracle/play/magnetdb-writes.js';

const TOKEN = 'tok-internal-resolve';
const KEY = 'chave-de-teste-resolve';
const torbox = encodeConfig({ ds: 'torbox', dk: KEY });
const HASH = 'b'.repeat(40);

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

const auth = { 'X-Indexer-Test-Token': TOKEN };
const post = (path: string, body: unknown, headers: Record<string, string> = auth) =>
  server.request('POST', path, { headers, body });

test('facts: a rota saiu (404) com o token certo; o held é do gateway', async () => {
  const out = await post('/internal/resolve/facts', { encoded: torbox, service: 'alldebrid', hash: HASH });
  assert.equal(out.status, 404);
  const semToken = await post('/internal/resolve/facts', {}, { 'X-Indexer-Test-Token': 'errado' });
  assert.equal(semToken.status, 404, 'sem rota não há guarda a checar: 404 em qualquer caso');
});

test('effects: a rota saiu (404) e não grava nada, nem com corpo válido', async () => {
  // Os efeitos do play são do gateway (stores nativos). Se a rota voltasse,
  // este teste acusa: o magnet marcado aqui apareceria no magnetdb.
  const hash = 'c'.repeat(40);
  const res = await post('/internal/resolve/effects', {
    encoded: torbox, service: 'torbox', hash, outcome: 'ok', alive: true,
  });
  assert.equal(res.status, 404);
  assert.equal(magnetdbWrites.peekAlive('torbox', KEY, hash), false);
  const semToken = await post('/internal/resolve/effects', {}, { 'X-Indexer-Test-Token': 'errado' });
  assert.equal(semToken.status, 404);
});
