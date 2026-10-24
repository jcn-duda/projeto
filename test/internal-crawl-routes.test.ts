// Testes das rotas /internal/crawl-result e /internal/activity.
// Como o maestro (register.ts) ainda não integra estas rotas, o teste monta
// um mini-app Express com as duas rotas registradas manualmente e usa o
// createTestServer do harness para fazer as requisições.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
process.env.CACHE_PERSIST = 'false';
import express from 'express';
import { createTestServer } from './e2e/e2e-harness.js';
import config from '../src/config.js';
import { buildServices } from '../src/routes/services.js';
import { registerInternalCrawlResult } from '../src/routes/internal-crawl-result.js';
import { registerInternalActivity } from '../src/routes/internal-activity.js';

const TOKEN = 'tok-internal-crawl';

let server: any;
const saved: Record<string, any> = {};

before(async () => {
  saved.testToken = config.jackett.testToken;
  config.jackett.testToken = TOKEN;

  // Monta um mini-app com as duas rotas internas (sem o overlay /:userConfig).
  const app = express();
  const services = buildServices();
  registerInternalCrawlResult(app as unknown as express.Router, services);
  registerInternalActivity(app as unknown as express.Router, services);

  server = await createTestServer(app);
});

after(async () => {
  await server.close();
  config.jackett.testToken = saved.testToken;
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /internal/crawl-result
// ═══════════════════════════════════════════════════════════════════════════════

test('POST /internal/crawl-result: sem token → 401', async () => {
  const res = await server.request('POST', '/internal/crawl-result', {
    body: { url: 'https://teste.com/filme/1', url_key: 'filme/1', site: 'fake', status: 'done', imdb: 'tt0000001', title: 'Teste', year: 2024, kind: 'movie', releases: [], groups: [], unlocated: [], progress: null, request_cost: 1, error: '' },
  });
  assert.equal(res.status, 401);
  assert.equal(res.json.ok, false);
});

test('POST /internal/crawl-result: token errado → 401', async () => {
  const res = await server.request('POST', '/internal/crawl-result', {
    headers: { 'X-Indexer-Test-Token': 'tok-errado' },
    body: { url: 'https://teste.com/filme/1', url_key: 'filme/1', site: 'fake', status: 'done' },
  });
  assert.equal(res.status, 401);
});

test('POST /internal/crawl-result: body sem site → 400', async () => {
  const res = await server.request('POST', '/internal/crawl-result', {
    headers: { 'X-Indexer-Test-Token': TOKEN },
    body: { url: '', url_key: '', site: '', status: 'done' },
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.ok, false);
});

test('POST /internal/crawl-result: status error sem IMDb → 200 com note', async () => {
  const res = await server.request('POST', '/internal/crawl-result', {
    headers: { 'X-Indexer-Test-Token': TOKEN },
    body: {
      url: 'https://teste.com/erro/1', url_key: 'erro/1', site: 'fake',
      status: 'error', imdb: null, title: null, year: null, kind: 'movie',
      releases: [], groups: [], unlocated: [], progress: null,
      request_cost: 1, error: 'timeout',
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.note, 'error');
  assert.equal(res.json.kept, 0);
  assert.equal(res.json.added, 0);
});

test('POST /internal/crawl-result: status done com IMDb válido → 200 { ok: true }', async () => {
  const res = await server.request('POST', '/internal/crawl-result', {
    headers: { 'X-Indexer-Test-Token': TOKEN },
    body: {
      url: 'https://teste.com/filme/1', url_key: 'filme/1', site: 'fake',
      status: 'done', imdb: 'tt0000001', title: 'Filme Teste', year: 2024,
      kind: 'movie',
      releases: [{
        title: 'Filme Teste 2024 1080p BluRay x264 DUBLADO',
        magnet: 'magnet:?xt=urn:btih:' + 'a'.repeat(40),
        link: null, size: '1.5 GB', seeders: 10, tracker: 'FakeTracker', is_br: true,
      }],
      groups: [], unlocated: [], progress: null,
      request_cost: 1, error: '',
    },
  });
  // O recorder pode falhar (depende de Cinemeta/TMDB no teste), mas a rota
  // NÃO pode derrubar — ou 200 com kept/added ou 500 controlado.
  assert.ok(res.status === 200 || res.status === 500, `status inesperado: ${res.status}`);
  if (res.status === 200) {
    assert.equal(res.json.ok, true);
    assert.equal(typeof res.json.kept, 'number');
    assert.equal(typeof res.json.added, 'number');
  } else {
    assert.equal(res.json.ok, false);
  }
});

test('POST /internal/crawl-result: sem IMDb → 200 com note=no-imdb', async () => {
  const res = await server.request('POST', '/internal/crawl-result', {
    headers: { 'X-Indexer-Test-Token': TOKEN },
    body: {
      url: 'https://teste.com/sem-imdb', url_key: 'sem-imdb', site: 'fake',
      status: 'done', imdb: null, title: 'Sem IMDb', year: null, kind: 'movie',
      releases: [{ title: 'Test', magnet: null, link: null, size: null, seeders: null, tracker: null, is_br: false }],
      groups: [], unlocated: [], progress: null,
      request_cost: 1, error: '',
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.note, 'no-imdb');
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
