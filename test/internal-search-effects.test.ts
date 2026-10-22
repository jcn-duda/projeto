// Testes das rotas internas em lote do orquestrador Rust:
// POST /internal/search/effects.
// Molde de `internal-search-routes.test.ts`: app mínimo com colaboradores
// trocados por stubs determinísticos (o teste prova o FIO da rota, não o
// Jackett/debrid). O caminho 403 usa o middleware de personificação de
// `remoteAddress`, que não existe em produção — a guarda real lê o socket.
// A antiga rota `index-write` saiu no R4 (índice/banco são nativos); os testes
// dela foram removidos junto com os stubs `record`/`markBankFilterOutcome`.
// `magnet_capture` é o outro lado do fio da coleta NATIVA do tail: o lote que o
// Rust viu chega aqui e vira `captureItems` com `resetPassedFilter: false`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
process.env.CACHE_PERSIST = 'false';
import express from 'express';
import { createTestServer, encodeConfig } from './e2e/e2e-harness.js';
import config from '../src/config.js';
import { buildServices } from '../src/routes/services.js';
import { registerInternalSearch } from '../src/routes/internal-search.js';
import type { InternalSearchEffectsCollaborators } from '../src/routes/internal-search-effects.js';
import * as runtime from '../src/runtime.js';

const TOKEN = 'tok-internal-effects';
const encoded = encodeConfig({ ds: 'torbox' });

/** Stubs determinísticos que registram as chamadas recebidas. */
function stubEffects(): { deps: Partial<InternalSearchEffectsCollaborators>; seen: Record<string, any[]> } {
  const seen: Record<string, any[]> = {
    autofetch: [], warmer: [], audit: [], probe: [], harvest: [], seasonKey: [], capture: [],
  };
  const deps: Partial<InternalSearchEffectsCollaborators> = {
    enqueueAutofetch: (candidate: any, request: any) => {
      seen.autofetch.push({ candidate, request, opts: runtime.opts().debridService });
      return true;
    },
    queueRdWarmForRelevant: (relevant: any[]) => { seen.warmer.push(relevant); },
    queueDubAudit: (adapterId: string, apiKey: string, candidates: any[], searchKey: string | null) => {
      seen.audit.push({ adapterId, apiKey, candidates, searchKey });
    },
    requestBrProbe: (work: any) => { seen.probe.push(work); return { probe: true, pending: true, fallbackBrGap: false }; },
    harvestEnqueue: (entry: any) => {
      seen.harvest.push(entry);
      return { reason: 'enqueued', entry: { ...entry, enqueuedAt: Date.now() } } as any;
    },
    registerSeasonSearchKey: (adapterId: string, account: string, imdb: string, season: number, cacheKey: string) => {
      seen.seasonKey.push({ adapterId, account, imdb, season, cacheKey });
    },
    captureItems: (items: readonly any[], indexer: string, ctx: any) => {
      seen.capture.push({ items, indexer, ctx });
      return true;
    },
  };
  return { deps, seen };
}

const HASH_A = 'a'.repeat(40);
const itemOf = (hash: string) => ({ title: 'Filme 2024 1080p DUBLADO', infoHash: hash, indexer: 'bludv', isBr: true });

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
  registerInternalSearch(app as unknown as express.Router, services, {}, stubEffects().deps);
  server = await createTestServer(app);
});

after(async () => {
  await server.close();
  config.jackett.testToken = saved.testToken;
});

/** Drena os setImmediate dos efeitos (e o ALS restaurado dentro deles). */
async function flushTimers() {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
}

// ═══════════════════════════════════════════════════════════════════════════════
// Guarda (loopback + token)
// ═══════════════════════════════════════════════════════════════════════════════

test('effects: fora do loopback → 403', async () => {
  const opts = { headers: { 'X-Indexer-Test-Token': TOKEN, 'x-test-remote-addr': '203.0.113.9' } };
  assert.equal((await server.request('POST', '/internal/search/effects', { ...opts, body: { encoded, effects: [] } })).status, 403);
});

test('effects: 401 sem token e com token errado', async () => {
  const body = { encoded, effects: [] };
  const sem = await server.request('POST', '/internal/search/effects', { body });
  assert.equal(sem.status, 401);
  const errado = await server.request('POST', '/internal/search/effects', {
    headers: { 'X-Indexer-Test-Token': 'token-errado' }, body,
  });
  assert.equal(errado.status, 401);
});

// ═══════════════════════════════════════════════════════════════════════════════
// effects
// ═══════════════════════════════════════════════════════════════════════════════

test('effects: 202 imediato e dispara cada efeito com o contexto do usuário', async () => {
  const { deps, seen } = stubEffects();
  const app2 = express();
  registerInternalSearch(app2 as unknown as express.Router, buildServices(), {}, deps);
  const server2 = await createTestServer(app2);
  try {
    const res = await server2.request('POST', '/internal/search/effects', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: {
        encoded,
        effects: [
          { kind: 'autofetch', payload: { candidate: { stream: { infoHash: HASH_A } }, request: { cached: false, imdbId: 'tt0000001' } } },
          { kind: 'rd_warmer', payload: { releases: [itemOf(HASH_A)] } },
          { kind: 'dub_audit', payload: { adapter_id: 'rd', api_key: 'k', candidates: [{ hash: HASH_A }], search_key: 's1' } },
          { kind: 'br_probe', payload: { imdbId: 'tt0000001', type: 'movie', season: null, episode: null } },
          { kind: 'harvester_enqueue', payload: { imdbId: 'tt0000001', type: 'movie', season: null, episode: null, reason: 'miss' } },
          { kind: 'season_key', payload: { adapter_id: 'rd', account: 'acc', imdb: 'tt0000001', season: 2, cache_key: 'ck' } },
        ],
      },
    });
    // A resposta sai ANTES de qualquer efeito: 202 com as contagens.
    assert.equal(res.status, 202);
    assert.deepEqual(res.json, { ok: true, accepted: 6, rejected: 0 });
    await flushTimers();
    // Cada ponto de entrada real foi acionado uma vez.
    assert.equal(seen.autofetch.length, 1);
    assert.equal(seen.autofetch[0].candidate.stream.infoHash, HASH_A);
    assert.equal(seen.autofetch[0].opts, 'torbox', 'runtime.run restaurou a config do encoded');
    assert.deepEqual(seen.warmer, [[itemOf(HASH_A)]]);
    assert.deepEqual(seen.audit, [{ adapterId: 'rd', apiKey: 'k', candidates: [{ hash: HASH_A }], searchKey: 's1' }]);
    assert.equal(seen.probe[0].imdbId, 'tt0000001');
    assert.equal(seen.harvest[0].reason, 'miss');
    assert.deepEqual(seen.seasonKey, [{ adapterId: 'rd', account: 'acc', imdb: 'tt0000001', season: 2, cacheKey: 'ck' }]);
  } finally {
    await server2.close();
  }
});

test('effects: efeito desconhecido/malformado é rejeitado, o lote segue', async () => {
  const { deps, seen } = stubEffects();
  const app2 = express();
  registerInternalSearch(app2 as unknown as express.Router, buildServices(), {}, deps);
  const server2 = await createTestServer(app2);
  try {
    const res = await server2.request('POST', '/internal/search/effects', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: {
        encoded,
        effects: [
          { kind: 'efeito_inexistente', payload: {} },
          { kind: 'br_probe', payload: { imdbId: '1234', type: 'movie' } }, // imdb inválido
          { kind: 'rd_warmer' }, // sem payload
          { kind: 'rd_warmer', payload: { releases: [itemOf(HASH_A)] } },
        ],
      },
    });
    assert.equal(res.status, 202);
    assert.equal(res.json.accepted, 1);
    assert.equal(res.json.rejected, 3);
    await flushTimers();
    assert.equal(seen.warmer.length, 1);
  } finally {
    await server2.close();
  }
});

test('effects: br_probe inelegível manda a obra ao colhedor (br-gap)', async () => {
  // A sonda pode recusar por kill-switch/retry/estado: o follow-up do índice
  // não perde a obra — ela vai ao colhedor com motivo br-gap, como o follow-up
  // nativo do Rust preserva.
  const { deps, seen } = stubEffects();
  deps.requestBrProbe = (work: any) => {
    seen.probe.push(work);
    return { probe: false, pending: false, skipped: 'disabled', fallbackBrGap: true } as any;
  };
  const app2 = express();
  registerInternalSearch(app2 as unknown as express.Router, buildServices(), {}, deps);
  const server2 = await createTestServer(app2);
  try {
    const res = await server2.request('POST', '/internal/search/effects', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: {
        encoded,
        effects: [
          {
            kind: 'br_probe',
            payload: { imdbId: 'tt0000001', type: 'series', season: 2, episode: 5, mode: 'upgrade' },
          },
        ],
      },
    });
    assert.equal(res.status, 202);
    await flushTimers();
    assert.equal(seen.probe.length, 1);
    assert.equal(seen.harvest.length, 1, 'sonda inelegível vira colheita br-gap');
    assert.equal(seen.harvest[0].reason, 'br-gap');
    assert.equal(seen.harvest[0].season, 2);
    assert.equal(seen.harvest[0].episode, 5);
  } finally {
    await server2.close();
  }
});

test('effects: br_probe agendado NÃO duplica a colheita', async () => {
  const { deps, seen } = stubEffects();
  deps.requestBrProbe = (work: any) => {
    seen.probe.push(work);
    return { probe: true, pending: true, fallbackBrGap: false } as any;
  };
  const app2 = express();
  registerInternalSearch(app2 as unknown as express.Router, buildServices(), {}, deps);
  const server2 = await createTestServer(app2);
  try {
    const res = await server2.request('POST', '/internal/search/effects', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: {
        encoded,
        effects: [
          { kind: 'br_probe', payload: { imdbId: 'tt0000001', type: 'movie', season: null, episode: null } },
        ],
      },
    });
    assert.equal(res.status, 202);
    await flushTimers();
    assert.equal(seen.probe.length, 1);
    assert.equal(seen.harvest.length, 0, 'quem enfileira é o próprio requestBrProbe');
  } finally {
    await server2.close();
  }
});

/** Lote da coleta NATIVA (`magnet_capture`) com a forma que o Rust emite. */
function captureEffect(overrides: Record<string, unknown> = {}, items: any[] = [itemOf(HASH_A)]) {
  return {
    kind: 'magnet_capture',
    payload: {
      items, indexer: 'bludv', imdbId: 'tt0133093',
      season: null, episode: null, year: '1999', resetPassedFilter: false,
      ...overrides,
    },
  };
}

test('effects: magnet_capture alimenta o banco vivo com o grupo indexer||tracker', async () => {
  const { deps, seen } = stubEffects();
  const app2 = express();
  registerInternalSearch(app2 as unknown as express.Router, buildServices(), {}, deps);
  const server2 = await createTestServer(app2);
  try {
    const res = await server2.request('POST', '/internal/search/effects', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: {
        encoded,
        effects: [
          // Série: o Rust já resolve o grupo e manda em `indexer`.
          captureEffect({ season: 2, episode: 3 }),
          // Segunda camada: sem `indexer`, o `tracker` do BLUDV é o grupo.
          captureEffect({ indexer: '', tracker: 'BLUDV' }),
        ],
      },
    });
    assert.equal(res.status, 202);
    assert.deepEqual(res.json, { ok: true, accepted: 2, rejected: 0 });
    await flushTimers();
    assert.equal(seen.capture.length, 2);

    const serie = seen.capture[0];
    assert.deepEqual(serie.items, [itemOf(HASH_A)], 'o item cru da coleta nativa atravessa');
    assert.equal(serie.indexer, 'bludv');
    // A captura registra o que foi visto; nunca reabre o filtro da obra.
    assert.equal(serie.ctx.resetPassedFilter, false);
    assert.equal(serie.ctx.imdbId, 'tt0133093');
    assert.equal(serie.ctx.season, 2);
    assert.equal(serie.ctx.episode, 3);
    assert.equal(serie.ctx.year, '1999');

    const bludv = seen.capture[1];
    assert.equal(bludv.indexer, 'BLUDV', 'sem indexer, o tracker vira o grupo');
    assert.equal(bludv.ctx.season, null);
  } finally {
    await server2.close();
  }
});

test('effects: magnet_capture malformado é recusado sem derrubar a rota', async () => {
  const { deps, seen } = stubEffects();
  const app2 = express();
  registerInternalSearch(app2 as unknown as express.Router, buildServices(), {}, deps);
  const server2 = await createTestServer(app2);
  try {
    const res = await server2.request('POST', '/internal/search/effects', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: {
        encoded,
        effects: [
          // Reabrir o filtro nunca é trabalho da captura.
          captureEffect({ resetPassedFilter: true }),
          // Acima do recorte do Rust: recusado, nunca truncado em silêncio.
          captureEffect({}, Array.from({ length: 201 }, (_, i) => itemOf(String(i).padStart(40, 'b')))),
          captureEffect({}, []),
          captureEffect({ season: '2' }),
          captureEffect({ imdbId: 'nao-e-imdb' }),
          // O válido do MESMO lote continua passando.
          captureEffect(),
        ],
      },
    });
    assert.equal(res.status, 202);
    assert.equal(res.json.accepted, 1);
    assert.equal(res.json.rejected, 5);
    await flushTimers();
    assert.equal(seen.capture.length, 1, 'só o efeito válido chega ao banco');

    // A rota continua de pé depois do lote ruim.
    const deNovo = await server2.request('POST', '/internal/search/effects', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { encoded, effects: [{ kind: 'magnet_capture', payload: 'não-objeto' }] },
    });
    assert.equal(deNovo.status, 202);
    assert.equal(deNovo.json.rejected, 1);
  } finally {
    await server2.close();
  }
});

test('effects: falha de um efeito não afeta os outros (rota de pé)', async () => {
  const { deps, seen } = stubEffects();
  deps.queueRdWarmForRelevant = () => { throw new Error('boom'); };
  const app2 = express();
  registerInternalSearch(app2 as unknown as express.Router, buildServices(), {}, deps);
  const server2 = await createTestServer(app2);
  try {
    const res = await server2.request('POST', '/internal/search/effects', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: {
        encoded,
        effects: [
          { kind: 'rd_warmer', payload: { releases: [itemOf(HASH_A)] } },
          { kind: 'season_key', payload: { adapter_id: 'rd', account: 'acc', imdb: 'tt0000001', season: 1, cache_key: 'ck' } },
        ],
      },
    });
    assert.equal(res.status, 202);
    await flushTimers();
    // O vizinho do efeito que lançou rodou do mesmo jeito.
    assert.deepEqual(seen.seasonKey, [{ adapterId: 'rd', account: 'acc', imdb: 'tt0000001', season: 1, cacheKey: 'ck' }]);
    // E a rota continua viva.
    const deNovo = await server2.request('POST', '/internal/search/effects', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { encoded, effects: 'não-array' },
    });
    assert.equal(deNovo.status, 400);
  } finally {
    await server2.close();
  }
});
