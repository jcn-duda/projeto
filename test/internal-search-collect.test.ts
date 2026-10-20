// Testes da rota interna de coleta (POST /internal/search/collect) — o passo
// que o orquestrador Rust pede ao Node enquanto a rede não migrou. Molde de
// `internal-search-routes.test.ts`: app mínimo com os colaboradores trocados
// por stubs determinísticos (o teste prova o FIO da rota, não Jackett).
//
// O caminho 403 usa o middleware de personificação de `remoteAddress`, que não
// existe em produção — a guarda real lê o socket.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
process.env.CACHE_PERSIST = 'false';
import express from 'express';
import { createTestServer, encodeConfig } from './e2e/e2e-harness.js';
import config from '../src/config.js';
import { buildServices } from '../src/routes/services.js';
import { registerInternalSearch } from '../src/routes/internal-search.js';
import type { InternalSearchCollaborators } from '../src/routes/internal-search.js';
import { createLiveIndexerState } from '../src/providers/live-indexer-state.js';
import type { LiveIndexerState } from '../src/providers/live-indexer-state.js';

const TOKEN = 'tok-internal-collect';
const encoded = encodeConfig({});
// Sombra: `p` é a chave curta de `providers`; jackett precisa estar na
// seleção efetiva para a rota responder eligible:true.
const shadowEncoded = encodeConfig({ p: ['jackett'] });

function liveWith(fn: (live: LiveIndexerState) => void) {
  const live = createLiveIndexerState();
  fn(live);
  return live;
}

/** CollectRaw de mentira: devolve o que o teste mandar, sem rede. */
function stubCollect(overrides: Partial<InternalSearchCollaborators> = {}): Partial<InternalSearchCollaborators> {
  return {
    collectRaw: async () => ({
      items: [
        { title: 'Filme 2024 1080p DUBLADO', infoHash: 'a'.repeat(40), indexer: 'bludv', isBr: true },
        { title: 'Movie 2024 1080p', infoHash: 'b'.repeat(40), indexer: 'eztv' },
        // Sem `indexer` nem tracker: não pode ser descartado pela rota.
        { title: 'Órfão 2024', infoHash: 'c'.repeat(40) },
      ],
      partial: true,
      completion: Promise.resolve(),
      sweepInline: false,
      live: liveWith((live) => {
        live.noteStart(['bludv', 'eztv', 'thepiratebay']);
        live.noteResult({ indexer: 'bludv', responded: true, relevant: 1 });
        live.noteResult({ indexer: 'eztv', responded: true, relevant: 0 });
        live.noteResult({ indexer: 'thepiratebay', responded: false, reason: 'breaker' });
      }),
    }),
    breakerSnapshot: (indexer: string) => ({
      indexer, state: 'fechado' as const, tripped: false,
      enabled: true, failStreak: 0, failuresRequired: 3, cooldownMs: 0, cooldownRemainingMs: 0,
    }),
    ...overrides,
  };
}

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
  const services = buildServices();
  registerInternalSearch(app as unknown as express.Router, services, stubCollect());
  server = await createTestServer(app);
});

after(async () => {
  await server.close();
  config.jackett.testToken = saved.testToken;
});

function collectBody(extra: Record<string, unknown> = {}) {
  return {
    encoded,
    query: 'Filme 2024',
    type: 'movie',
    imdb: 'tt0000001',
    deadline_at: Date.now() + 5000,
    ...extra,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Guarda (loopback + token)
// ═══════════════════════════════════════════════════════════════════════════════

test('POST /internal/search/collect: fora do loopback → 403', async () => {
  const res = await server.request('POST', '/internal/search/collect', {
    headers: { 'X-Indexer-Test-Token': TOKEN, 'x-test-remote-addr': '203.0.113.9' },
    body: collectBody(),
  });
  assert.equal(res.status, 403);
});

test('POST /internal/search/collect: sem token → 401', async () => {
  const res = await server.request('POST', '/internal/search/collect', { body: collectBody() });
  assert.equal(res.status, 401);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Contrato
// ═══════════════════════════════════════════════════════════════════════════════

test('collect: 200 com itens por indexer, live e breaker', async () => {
  const res = await server.request('POST', '/internal/search/collect', {
    headers: { 'X-Indexer-Test-Token': TOKEN },
    body: collectBody(),
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  // Agrupamento por indexer, mesma unidade do cache raw:v1 (array de RawItem).
  assert.equal(res.json.by_indexer.bludv.length, 1);
  assert.equal(res.json.by_indexer.bludv[0].infoHash, 'a'.repeat(40));
  assert.equal(res.json.by_indexer.eztv.length, 1);
  // Item sem rótulo de fonte não é descartado.
  assert.equal(res.json.by_indexer['sem-indexer'].length, 1);
  // `items` é o lote cru completo (compatível com o que alimenta o raw:v1).
  assert.equal(res.json.items.length, 3);
  assert.equal(res.json.partial, true);
  // Estado vivo em snapshot (contrato de LiveIndexerState.snapshot):
  // bludv serviu, eztv vazio suspeito, tpb falho por breaker. `served` é o
  // desempate do replay congelado (desfaz o vazio suspeito na ordem certa).
  assert.deepEqual(res.json.live, {
    failed: ['thepiratebay'], pending: [], empty: ['eztv'], served: ['bludv'], all: 'unknown',
  });
  // Breaker cobre quem apareceu no lote E quem o estado vivo marcou.
  assert.deepEqual(Object.keys(res.json.breaker), ['bludv', 'eztv', 'sem-indexer', 'thepiratebay']);
});

test('collect: task_scope priority é repassado ao collectRaw', async () => {
  const seen: any[] = [];
  const app2 = express();
  const overrides = stubCollect({
    collectRaw: (async (...args: any[]) => {
      seen.push(args);
      return stubCollect().collectRaw!(
        'Filme 2024', 'movie', 'tt0000001', null,
        { names: ['Filme 2024'], year: null, isSeries: false, season: null, episode: null },
        null,
      );
    }) as any,
  });
  const services = buildServices();
  registerInternalSearch(app2 as unknown as express.Router, services, overrides);
  const server2 = await createTestServer(app2);
  try {
    const res = await server2.request('POST', '/internal/search/collect', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: collectBody({ task_scope: 'priority', pt_query: 'Filme', season: 2, episode: 3, type: 'series' }),
    });
    assert.equal(res.status, 200);
    const args = seen[0];
    // (query, type, imdb, ptQuery, matchContext, onLate=null, sweep, deadline,
    //  scope, observer=null, trace=null, original, multiwork, skip, readOnly)
    assert.equal(args[1], 'series');
    assert.equal(args[3], 'Filme');
    assert.equal(args[5], null);
    assert.equal(args[8], 'priority');
    assert.equal(args[9], null);
    assert.equal(args[10], null);
    assert.equal(args[14], false, 'caminho de resposta nunca é read-only');
    assert.equal(args[4].season, 2);
    assert.equal(args[4].episode, 3);
    assert.equal(args[4].isSeries, true);
  } finally {
    await server2.close();
  }
});

test('collect: read_only liga a referência sem efeitos e omite o breaker', async () => {
  const seen: any[] = [];
  const app2 = express();
  const overrides = stubCollect({
    collectRaw: (async (...args: any[]) => {
      seen.push(args);
      return stubCollect().collectRaw!(
        'Filme 2024', 'movie', 'tt0000001', null,
        { names: ['Filme 2024'], year: null, isSeries: false, season: null, episode: null },
        null,
      );
    }) as any,
  });
  const services = buildServices();
  registerInternalSearch(app2 as unknown as express.Router, services, overrides);
  const server2 = await createTestServer(app2);
  try {
    const res = await server2.request('POST', '/internal/search/collect', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: collectBody({
        encoded: shadowEncoded,
        read_only: true,
        shadow_source: 'jackett',
        indexers: ['process-idx'],
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(seen[0][14], true, 'read_only viaja ao collectRaw');
    assert.deepEqual(seen[0][15], ['process-idx'], 'override de indexers viaja');
    assert.equal(res.json.eligible, true, 'jackett está nos providers');
    assert.deepEqual(res.json.breaker, {}, 'sombra não lê/expõe breaker');
  } finally {
    await server2.close();
  }
});

test('collect: read_only com fonte fora dos providers → eligible:false sem coletar', async () => {
  const seen: any[] = [];
  const app2 = express();
  const overrides = stubCollect({
    collectRaw: (async (...args: any[]) => {
      seen.push(args);
      return stubCollect().collectRaw!(
        'Filme 2024', 'movie', 'tt0000001', null,
        { names: ['Filme 2024'], year: null, isSeries: false, season: null, episode: null },
        null,
      );
    }) as any,
  });
  const services = buildServices();
  registerInternalSearch(app2 as unknown as express.Router, services, overrides);
  const server2 = await createTestServer(app2);
  try {
    const res = await server2.request('POST', '/internal/search/collect', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: collectBody({
        encoded: encodeConfig({ p: ['prowlarr'] }),
        read_only: true,
        shadow_source: 'jackett',
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.eligible, false);
    assert.deepEqual(res.json.items, []);
    assert.equal(seen.length, 0, 'fonte ausente não coleta nada');
  } finally {
    await server2.close();
  }
});

test('collect: read_only com indexers inválido → 400', async () => {
  const res = await server.request('POST', '/internal/search/collect', {
    headers: { 'X-Indexer-Test-Token': TOKEN },
    body: collectBody({
      encoded: shadowEncoded,
      read_only: true,
      shadow_source: 'jackett',
      indexers: 'yts',
    }),
  });
  assert.equal(res.status, 400);
});

test('collect: read_only sem shadow_source → 400', async () => {
  const res = await server.request('POST', '/internal/search/collect', {
    headers: { 'X-Indexer-Test-Token': TOKEN },
    body: collectBody({ encoded: shadowEncoded, read_only: true }),
  });
  assert.equal(res.status, 400);
});

test('collect: read_only não booleano → 400', async () => {
  const res = await server.request('POST', '/internal/search/collect', {
    headers: { 'X-Indexer-Test-Token': TOKEN },
    body: collectBody({ read_only: 'sim' }),
  });
  assert.equal(res.status, 400);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Validação de entrada
// ═══════════════════════════════════════════════════════════════════════════════

test('collect: 400 sem query, type ruim, imdb ruim, task_scope ruim', async () => {
  const cases = [
    collectBody({ query: '  ' }),
    collectBody({ type: 'channel' }),
    collectBody({ imdb: '1234' }),
    collectBody({ task_scope: 'tudo' }),
    collectBody({ names: ['ok', 3] }),
  ];
  for (const body of cases) {
    const res = await server.request('POST', '/internal/search/collect', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body,
    });
    assert.equal(res.status, 400, `esperava 400 para ${JSON.stringify(body)}`);
  }
});

test('collect: 400 sem deadline_at e com deadline já vencido', async () => {
  const semPrazo = await server.request('POST', '/internal/search/collect', {
    headers: { 'X-Indexer-Test-Token': TOKEN },
    body: collectBody({ deadline_at: undefined }),
  });
  assert.equal(semPrazo.status, 400);
  const vencido = await server.request('POST', '/internal/search/collect', {
    headers: { 'X-Indexer-Test-Token': TOKEN },
    body: collectBody({ deadline_at: Date.now() - 10 }),
  });
  assert.equal(vencido.status, 400);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Prazo e falha
// ═══════════════════════════════════════════════════════════════════════════════

test('collect: promessa que nunca assenta dentro do prazo → 504, não erro', async () => {
  const app2 = express();
  const overrides = stubCollect({
    collectRaw: (() => new Promise(() => {})) as any,
  });
  registerInternalSearch(app2 as unknown as express.Router, buildServices(), overrides);
  const server2 = await createTestServer(app2);
  try {
    const res = await server2.request('POST', '/internal/search/collect', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: collectBody({ deadline_at: Date.now() + 60 }),
    });
    assert.equal(res.status, 504);
    assert.equal(res.json.ok, false);
  } finally {
    await server2.close();
  }
});

test('collect: erro do collectRaw → 500 curto, processo de pé', async () => {
  const app2 = express();
  const overrides = stubCollect({
    collectRaw: (async () => { throw new Error('boom'); }) as any,
  });
  registerInternalSearch(app2 as unknown as express.Router, buildServices(), overrides);
  const server2 = await createTestServer(app2);
  try {
    const res = await server2.request('POST', '/internal/search/collect', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: collectBody(),
    });
    assert.equal(res.status, 500);
    assert.equal(res.json.ok, false);
    // A rota continua viva depois da falha.
    const again = await server2.request('POST', '/internal/search/collect', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: collectBody({ deadline_at: Date.now() - 1 }),
    });
    assert.equal(again.status, 400);
  } finally {
    await server2.close();
  }
});

test('skip_sources aceita "account" (conta coletada em tarefa própria pelo Rust)', async () => {
  const { parseSkipSources } = await import('../src/routes/internal-search-skip.js');
  const skip = parseSkipSources(['jackett', 'account']);
  assert.ok(skip && skip.has('account'));
  assert.equal(parseSkipSources(['desconhecida']), null);
});
