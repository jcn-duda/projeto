// Testes das rotas internas em lote do orquestrador Rust:
// POST /internal/search/index-write e POST /internal/search/effects.
// Molde de `internal-search-collect.test.ts`: app mínimo com colaboradores
// trocados por stubs determinísticos (o teste prova o FIO da rota, não o
// Jackett/debrid). O caminho 403 usa o middleware de personificação de
// `remoteAddress`, que não existe em produção — a guarda real lê o socket.
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
    record: [], mark: [], autofetch: [], warmer: [], audit: [], probe: [], harvest: [], seasonKey: [],
  };
  const deps: Partial<InternalSearchEffectsCollaborators> = {
    record: (imdb: string, location: any, items: any[], opts: any = {}) => {
      seen.record.push({ imdb, location, items, opts });
      return items.length; // conta "gravada" = tamanho do lote
    },
    markBankFilterOutcome: (entered: any, survivors: any, ctx: any) => {
      seen.mark.push({ entered, survivors, ctx });
      return true;
    },
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
// Guarda (loopback + token) — as duas rotas
// ═══════════════════════════════════════════════════════════════════════════════

test('index-write e effects: fora do loopback → 403', async () => {
  const opts = { headers: { 'X-Indexer-Test-Token': TOKEN, 'x-test-remote-addr': '203.0.113.9' } };
  assert.equal((await server.request('POST', '/internal/search/index-write', { ...opts, body: { encoded, releases: [] } })).status, 403);
  assert.equal((await server.request('POST', '/internal/search/effects', { ...opts, body: { encoded, effects: [] } })).status, 403);
});

test('index-write e effects: 401 sem token e com token errado', async () => {
  const bodies = [
    ['/internal/search/index-write', { encoded, releases: [] }],
    ['/internal/search/effects', { encoded, effects: [] }],
  ] as const;
  for (const [path, body] of bodies) {
    const sem = await server.request('POST', path, { body });
    assert.equal(sem.status, 401, path);
    const errado = await server.request('POST', path, {
      headers: { 'X-Indexer-Test-Token': 'token-errado' }, body,
    });
    assert.equal(errado.status, 401, path);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// index-write
// ═══════════════════════════════════════════════════════════════════════════════

test('index-write: 400 sem encoded e com releases ruim', async () => {
  const semEncoded = await server.request('POST', '/internal/search/index-write', {
    headers: { 'X-Indexer-Test-Token': TOKEN },
    body: { releases: [] },
  });
  assert.equal(semEncoded.status, 400);
  for (const releases of ['não-array', [{ imdb: 'tt1' }], [{ imdb: 'tt0000001', items: 'não-array' }]]) {
    const res = await server.request('POST', '/internal/search/index-write', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { encoded, releases },
    });
    assert.equal(res.status, 400, JSON.stringify(releases));
  }
});

test('index-write: grava o lote e responde contagens', async () => {
  const { deps, seen } = stubEffects();
  const app2 = express();
  registerInternalSearch(app2 as unknown as express.Router, buildServices(), {}, deps);
  const server2 = await createTestServer(app2);
  try {
    const items = [itemOf(HASH_A)];
    const res = await server2.request('POST', '/internal/search/index-write', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: {
        encoded,
        releases: [
          { imdb: 'tt0000001', items },
          { imdb: 'tt0000002', season: 2, episode: 3, items, entered: [items[0]], survivors: [] },
        ],
      },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true, recorded: 2, entries: 2, bank_marked: 2, failed: 0 });
    // record recebeu a obra e a localização (S2E3 na segunda entrada).
    assert.equal(seen.record[0].imdb, 'tt0000001');
    assert.equal(seen.record[1].location.season, 2);
    assert.equal(seen.record[1].location.episode, 3);
    assert.equal(seen.record[1].items[0].infoHash, HASH_A);
    // markBankFilterOutcome usa entered/survivors quando vêm; senão o próprio items.
    assert.deepEqual(seen.mark[0].entered, items);
    assert.deepEqual(seen.mark[0].survivors, items);
    assert.deepEqual(seen.mark[1].survivors, []);
    assert.deepEqual(seen.mark[1].ctx, { imdbId: 'tt0000002', season: 2, episode: 3 });
    // Idempotente: repetir o mesmo lote devolve o MESMO contrato (o stub do
    // record é puro; a rota não acumula estado próprio entre chamadas).
    const deNovo = await server2.request('POST', '/internal/search/index-write', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { encoded, releases: [{ imdb: 'tt0000001', items }] },
    });
    assert.equal(deNovo.status, 200);
    assert.deepEqual(deNovo.json, { ok: true, recorded: 1, entries: 1, bank_marked: 1, failed: 0 });
  } finally {
    await server2.close();
  }
});

test('index-write: entrada que lança vira failed na contagem, lote segue', async () => {
  const { deps } = stubEffects();
  const original = deps.record!;
  deps.record = (imdb: any, location: any, items: any[], opts: any) => {
    if (imdb === 'tt9999999') throw new Error('boom');
    return original(imdb, location, items, opts);
  };
  const app2 = express();
  registerInternalSearch(app2 as unknown as express.Router, buildServices(), {}, deps);
  const server2 = await createTestServer(app2);
  try {
    const res = await server2.request('POST', '/internal/search/index-write', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: {
        encoded,
        releases: [
          { imdb: 'tt9999999', items: [itemOf(HASH_A)] },
          { imdb: 'tt0000001', items: [itemOf(HASH_A)] },
        ],
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.failed, 1);
    assert.equal(res.json.recorded, 1);
    assert.equal(res.json.entries, 2);
  } finally {
    await server2.close();
  }
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
  // não perde a obra — ela vai ao colhedor com motivo br-gap, como o
  // `enqueueIndexFollowUp` faz no processo Node.
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
