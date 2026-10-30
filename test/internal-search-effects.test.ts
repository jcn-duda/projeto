// Testes das rotas internas em lote do orquestrador Rust:
// POST /internal/search/effects.
// Molde de `internal-search-routes.test.ts`: app mínimo com colaboradores
// trocados por stubs determinísticos (o teste prova o FIO da rota, não o
// Jackett/debrid). O caminho 403 usa o middleware de personificação de
// `remoteAddress`, que não existe em produção — a guarda real lê o socket.
// A rota NÃO executa mais nenhum kind: todos são donos do gateway. O
// `harvester_enqueue` é consumido pelo colhedor nativo (commit 3ab92ad5) e o
// trabalho do Chupim/warmer RD pelo worker e sink nativos. Forma válida
// continua aceita, mas cada kind só conta em `nativeOnly`, e o aceite sai com
// UM `warn` por request (o `Deferred`/`Forward` do gateway desemboca nele; sem
// o aviso o trabalho sumiria mudo). A validação de forma segue valendo.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
process.env.CACHE_PERSIST = 'false';
import express from 'express';
import { createTestServer, encodeConfig } from './e2e/e2e-harness.js';
import config from '../src/config.js';
import { buildServices } from '../src/routes/services.js';
import { registerInternalSearch } from '../src/routes/internal-search.js';
import * as log from '../src/utils/logger.js';

const TOKEN = 'tok-internal-effects';
const encoded = encodeConfig({ ds: 'torbox' });

const HASH_A = 'a'.repeat(40);
const itemOf = (hash: string) => ({ title: 'Filme 2024 1080p DUBLADO', infoHash: hash, indexer: 'bludv', isBr: true });
const enqueue = (reason: string) => ({
  kind: 'harvester_enqueue',
  payload: { imdbId: 'tt0000001', type: 'movie', season: null, episode: null, reason },
});

let server: any;
const saved: Record<string, any> = {};

before(async () => {
  saved.testToken = config.jackett.testToken;
  config.jackett.testToken = TOKEN;
  // O aviso do aceite nativo sai por `log.warn`; o nível do ambiente poderia
  // ser `silent`/`error`, então o teste fixa o dele e devolve no `after`.
  saved.logLevel = log.level();
  log.setLevel('warn');
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
  registerInternalSearch(app as unknown as express.Router, buildServices(), {});
  server = await createTestServer(app);
});

after(async () => {
  await server.close();
  config.jackett.testToken = saved.testToken;
  log.setLevel(saved.logLevel);
});

/** Sobe um app com a rota e devolve o servidor de teste (fecha no `finally`). */
async function serverWithEffects() {
  const app2 = express();
  registerInternalSearch(app2 as unknown as express.Router, buildServices(), {});
  return createTestServer(app2);
}

/**
 * Captura o `console.warn` do trecho (é para onde o `log.warn` escreve) — o
 * aviso do aceite nativo tem de sair UMA vez e sem payload.
 */
async function captureWarns<T>(fn: () => Promise<T>): Promise<{ result: T; warns: string[] }> {
  const warns: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warns.push(args.map((a) => String(a)).join(' ')); };
  try {
    return { result: await fn(), warns };
  } finally {
    console.warn = original;
  }
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
// effects: aceite sem execução
// ═══════════════════════════════════════════════════════════════════════════════

test('effects: harvester_enqueue e rd_warmer são aceitos e contados em nativeOnly, sem executar', async () => {
  const server2 = await serverWithEffects();
  try {
    const { result: res, warns } = await captureWarns(() => server2.request('POST', '/internal/search/effects', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: {
        encoded,
        effects: [
          enqueue('miss'),
          { kind: 'rd_warmer', payload: { releases: [itemOf(HASH_A)] } },
        ],
      },
    }));
    // A resposta sai com as contagens; os dois são do gateway e só engordam
    // `nativeOnly`.
    assert.equal(res.status, 202);
    assert.deepEqual(res.json, { ok: true, accepted: 2, rejected: 0, nativeOnly: 2 });
    const avisos = warns.filter((linha) => linha.includes('[internal]'));
    assert.equal(avisos.length, 1, 'um único warn por request');
    assert.match(avisos[0], /nativeOnly=2/);
    assert.ok(avisos[0].includes('harvester_enqueue'), 'o warn cita harvester_enqueue');
    assert.ok(avisos[0].includes('rd_warmer'), 'o warn cita rd_warmer');
    assert.ok(!avisos[0].includes(HASH_A), 'o warn não carrega payload (hash)');
  } finally {
    await server2.close();
  }
});

test('effects: kinds do Chupim e o colhedor são aceitos e contados em nativeOnly, sem executar', async () => {
  const server2 = await serverWithEffects();
  try {
    const { result: res, warns } = await captureWarns(() => server2.request('POST', '/internal/search/effects', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: {
        encoded,
        effects: [
          { kind: 'autofetch', payload: { candidate: { stream: { infoHash: HASH_A } }, request: { cached: false, imdbId: 'tt0000001' } } },
          { kind: 'autofetch_batch', payload: { items: [itemOf(HASH_A)], cached: [], known: true, imdbId: 'tt0000001' } },
          { kind: 'br_probe', payload: { imdbId: 'tt0000001', type: 'movie', season: null, episode: null } },
          { kind: 'season_key', payload: { adapter_id: 'rd', account: 'acc', imdb: 'tt0000001', season: 2, cache_key: 'ck' } },
          { kind: 'rd_warmer', payload: { releases: [itemOf(HASH_A)] } },
          enqueue('gap'),
        ],
      },
    }));
    // O 202 não mente sobre o lote: os seis têm forma válida e TODOS viajam no
    // `nativeOnly` — o dono é o gateway.
    assert.equal(res.status, 202);
    assert.deepEqual(res.json, { ok: true, accepted: 6, rejected: 0, nativeOnly: 6 });
    // O aceite sem execução NÃO pode ser mudo: UM aviso por request, com a
    // contagem e os kinds — e sem uma gota do payload.
    const avisos = warns.filter((linha) => linha.includes('[internal]'));
    assert.equal(avisos.length, 1, 'um único warn por request');
    assert.match(avisos[0], /nativeOnly=6/);
    for (const kind of ['autofetch', 'autofetch_batch', 'br_probe', 'season_key', 'rd_warmer', 'harvester_enqueue']) {
      assert.ok(avisos[0].includes(kind), `o warn cita o kind ${kind}`);
    }
    assert.ok(!avisos[0].includes(HASH_A), 'o warn não carrega payload (hash)');
    assert.ok(!avisos[0].includes('Filme 2024'), 'o warn não carrega payload (título)');
    assert.ok(!avisos[0].includes('acc'), 'o warn não carrega a conta/credencial');
  } finally {
    await server2.close();
  }
});

test('effects: lote sem kind nativo (só desconhecido) não avisa', async () => {
  const server2 = await serverWithEffects();
  try {
    const { result: res, warns } = await captureWarns(() => server2.request('POST', '/internal/search/effects', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { encoded, effects: [{ kind: 'efeito_inexistente', payload: {} }] },
    }));
    assert.equal(res.status, 202);
    assert.deepEqual(res.json, { ok: true, accepted: 0, rejected: 1, nativeOnly: 0 });
    assert.deepEqual(warns.filter((linha) => linha.includes('[internal]')), []);
  } finally {
    await server2.close();
  }
});

test('effects: efeito desconhecido/malformado é rejeitado, o lote segue', async () => {
  const server2 = await serverWithEffects();
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
    assert.equal(res.json.nativeOnly, 1, 'o rd_warmer válido é contado, não executado');
  } finally {
    await server2.close();
  }
});

test('effects: payload malformado do Chupim e do colhedor é rejeitado na forma', async () => {
  const server2 = await serverWithEffects();
  try {
    const res = await server2.request('POST', '/internal/search/effects', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: {
        encoded,
        effects: [
          { kind: 'br_probe', payload: { imdbId: 'tt0000001', type: 'series', season: 2, episode: 5, mode: 'upgrade' } },
          { kind: 'autofetch_batch', payload: { items: [], cached: [], known: 'true' } },
          // `tt1` NÃO serve de inválido: `IMDB_RE` é /^tt\d+$/ e o aceitaria.
          { kind: 'season_key', payload: { adapter_id: 'rd', account: 'acc', imdb: 'tt-sem-numero', season: 2, cache_key: 'ck' } },
          // Colhedor sem imdbId válido e sem motivo: recusado na forma.
          { kind: 'harvester_enqueue', payload: { imdbId: '1234', type: 'movie', reason: 'miss' } },
          { kind: 'harvester_enqueue', payload: { imdbId: 'tt0000001', type: 'movie' } },
        ],
      },
    });
    assert.equal(res.status, 202);
    assert.deepEqual(res.json, { ok: true, accepted: 1, rejected: 4, nativeOnly: 1 });
  } finally {
    await server2.close();
  }
});

test('effects: kinds com dono nativo (magnet_capture, dub_audit) são rejeitados', async () => {
  const server2 = await serverWithEffects();
  try {
    // Os dois kinds saíram da rota: a captura do acervo passou para o processo
    // Rust no fim da busca (T2-L1) e o interrogatório de áudio para o gateway
    // (T3-L7a). Um lote com eles é recusado sem derrubar os demais efeitos; o
    // `rd_warmer` tem forma válida e é contado em `nativeOnly`.
    const res = await server2.request('POST', '/internal/search/effects', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: {
        encoded,
        effects: [
          {
            kind: 'magnet_capture',
            payload: { items: [itemOf(HASH_A)], indexer: 'bludv', resetPassedFilter: false },
          },
          {
            kind: 'dub_audit',
            payload: { adapter_id: 'rd', api_key: 'k', candidates: [{ hash: HASH_A }] },
          },
          { kind: 'rd_warmer', payload: { releases: [itemOf(HASH_A)] } },
        ],
      },
    });
    assert.equal(res.status, 202);
    assert.deepEqual(res.json, { ok: true, accepted: 1, rejected: 2, nativeOnly: 1 });
  } finally {
    await server2.close();
  }
});

test('effects: teto de lote e corpo sem array são recusados, a rota segue viva', async () => {
  const server2 = await serverWithEffects();
  try {
    const deNovo = await server2.request('POST', '/internal/search/effects', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { encoded, effects: 'não-array' },
    });
    assert.equal(deNovo.status, 400);
    const acima = await server2.request('POST', '/internal/search/effects', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { encoded, effects: Array.from({ length: 101 }, () => enqueue('miss')) },
    });
    assert.equal(acima.status, 400);
    // Lote válido depois dos recusados: a rota responde normalmente.
    const ok = await server2.request('POST', '/internal/search/effects', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: { encoded, effects: [enqueue('gap')] },
    });
    assert.equal(ok.status, 202);
    assert.equal(ok.json.nativeOnly, 1);
  } finally {
    await server2.close();
  }
});
