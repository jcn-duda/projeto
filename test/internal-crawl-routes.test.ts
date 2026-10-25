// Testes da rota /internal/activity (a que sobrou do par do sidecar).
// O `/internal/crawl-result` saiu na T3-L3: a ingestão da página é nativa no
// sidecar, então não há mais POST do motor Rust para o Node.
// Como o maestro (register.ts) não é importado nos testes de rota, o mini-app
// Express é montado à mão e usa o createTestServer do harness.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
process.env.CACHE_PERSIST = 'false';
import express from 'express';
import { createTestServer } from './e2e/e2e-harness.js';
import config from '../src/config.js';
import { buildServices } from '../src/routes/services.js';
import { registerInternalActivity } from '../src/routes/internal-activity.js';

const TOKEN = 'tok-internal-crawl';

let server: any;
const saved: Record<string, any> = {};

before(async () => {
  saved.testToken = config.jackett.testToken;
  config.jackett.testToken = TOKEN;

  const app = express();
  const services = buildServices();
  registerInternalActivity(app as unknown as express.Router, services);

  server = await createTestServer(app);
});

after(async () => {
  await server.close();
  config.jackett.testToken = saved.testToken;
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /internal/activity
// ═══════════════════════════════════════════════════════════════════════════════

test('GET /internal/activity: sem token → 401', async () => {
  const res = await server.request('GET', '/internal/activity');
  assert.equal(res.status, 401);
  assert.equal(res.json.ok, false);
});

test('GET /internal/activity: token errado → 401', async () => {
  const res = await server.request('GET', '/internal/activity', {
    headers: { 'X-Indexer-Test-Token': 'tok-errado' },
  });
  assert.equal(res.status, 401);
});

test('GET /internal/activity: com token → 200 { recent: false }', async () => {
  const res = await server.request('GET', '/internal/activity', {
    headers: { 'X-Indexer-Test-Token': TOKEN },
  });
  assert.equal(res.status, 200);
  assert.equal(typeof res.json.recent, 'boolean');
  // Em teste, nenhum tráfego de usuário real aconteceu — recent deve ser false.
  assert.equal(res.json.recent, false);
});

test('GET /internal/activity: window_ms customizado → 200', async () => {
  const res = await server.request('GET', '/internal/activity?window_ms=5000', {
    headers: { 'X-Indexer-Test-Token': TOKEN },
  });
  assert.equal(res.status, 200);
  assert.equal(typeof res.json.recent, 'boolean');
});

test('GET /internal/activity: window_ms inválido → 400', async () => {
  const res = await server.request('GET', '/internal/activity?window_ms=-1', {
    headers: { 'X-Indexer-Test-Token': TOKEN },
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.ok, false);
});

test('GET /internal/activity: sem token configurado → 503', async () => {
  // Salva e limpa o token para testar o 503
  const prev = config.jackett.testToken;
  config.jackett.testToken = '';
  try {
    const res = await server.request('GET', '/internal/activity');
    assert.equal(res.status, 503);
    assert.equal(res.json.ok, false);
  } finally {
    config.jackett.testToken = prev;
  }
});
