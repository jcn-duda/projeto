// Testes da rota interna da reserva 📦 (POST /internal/search/fallback).
//
// A rota é o I/O fino do banco: lê `worksForObraMany` + `sourcesForMany` e
// devolve as linhas + a config efetiva. A seleção/cortes ficam no núcleo Rust
// (`adom_core::fallback_bank`), cobertos por `fallback_bank_tests.rs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
process.env.CACHE_PERSIST = 'false';
import express from 'express';
import { createTestApp, createTestServer, encodeConfig } from './e2e/e2e-harness.js';
import config from '../src/config.js';
import { buildServices } from '../src/routes/services.js';
import { registerInternalSearchFallback } from '../src/routes/internal-search-fallback.js';
import type { InternalSearchFallbackCollaborators } from '../src/routes/internal-search-fallback.js';

const TOKEN = 'tok-internal-fallback';
const HASH = 'a'.repeat(40);
const FALLBACK_HASH = 'b'.repeat(40);
const encoded = encodeConfig({});
const calls: Array<{ indexers?: readonly string[] }> = [];

const overrides: Partial<InternalSearchFallbackCollaborators> = {
  worksForObraMany: (imdb: string, targets, _limit, _maxTotal, indexers) => {
    calls.push({ indexers });
    return targets.map((target) => {
      const season = target.season ?? -1;
      const episode = target.episode ?? -1;
      return {
        work: {
          hash: FALLBACK_HASH,
          imdb,
          season,
          episode,
          firstSeen: 1700000000000,
          lastSeen: 1700000001000,
          passedFilter: 1,
        },
        magnet: {
          hash: FALLBACK_HASH,
          uri: `magnet:?xt=urn:btih:${FALLBACK_HASH}&dn=Filme.Teste.2024.DUBLADO`,
          title: 'Filme Teste 2024 1080p DUBLADO',
          size: 2048,
          isBr: 1,
          dubbed: 1,
          quality: '1080p',
          seedersMax: 9,
          seedersLast: 7,
          firstSeen: 1700000000000,
          lastSeen: 1700000003000,
          lied: 0,
        },
      };
    });
  },
  sourcesForMany: (hashes) => new Map(hashes.map((hash) => [hash, [
    { hash, indexer: 'fake', tracker: 'FakeTracker', firstSeen: 1700000000000, lastSeen: 1700000002000, seedersLast: 3 },
  ]])),
};

let server: any;
const saved: Record<string, any> = {};

before(async () => {
  saved.testToken = config.jackett.testToken;
  saved.magnetBank = {
    enabled: config.magnetBank.enabled,
    fallbackEnabled: config.magnetBank.fallbackEnabled,
    fallbackMaxPerIndexer: config.magnetBank.fallbackMaxPerIndexer,
    fallbackGlobalMax: config.magnetBank.fallbackGlobalMax,
  };
  saved.ptBrIndexers = config.jackett.ptBrIndexers;
  saved.indexOnlyIndexers = config.jackett.indexOnlyIndexers;
  config.jackett.testToken = TOKEN;
  config.jackett.ptBrIndexers = ['fake'];
  config.jackett.indexOnlyIndexers = ['idxonly'];

  const app = express();
  const services = buildServices();
  registerInternalSearchFallback(app as unknown as express.Router, services, overrides);
  server = await createTestServer(app);
});

after(async () => {
  await server.close();
  config.jackett.testToken = saved.testToken;
  config.jackett.ptBrIndexers = saved.ptBrIndexers;
  config.jackett.indexOnlyIndexers = saved.indexOnlyIndexers;
  config.magnetBank.enabled = saved.magnetBank.enabled;
  config.magnetBank.fallbackEnabled = saved.magnetBank.fallbackEnabled;
  config.magnetBank.fallbackMaxPerIndexer = saved.magnetBank.fallbackMaxPerIndexer;
  config.magnetBank.fallbackGlobalMax = saved.magnetBank.fallbackGlobalMax;
});

test('devolve obras/fontes e a config efetiva', async () => {
  calls.length = 0;
  const res = await server.request('POST', '/internal/search/fallback', {
    headers: { 'X-Indexer-Test-Token': TOKEN },
    body: {
      encoded,
      type: 'movie',
      imdb: 'tt0000001',
      failed: ['FAKE'],
      suspect: ['SUS'],
      all_failed: false,
      live_hashes: [HASH.toUpperCase()],
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.enabled, true);
  assert.equal(res.json.fallback_enabled, true);
  assert.equal(res.json.per_indexer_max, 40);
  assert.equal(res.json.global_max, 40);
  assert.deepEqual(res.json.br_indexers, ['fake']);
  assert.deepEqual(res.json.index_only_indexers, ['idxonly']);
  assert.equal(res.json.works.length, 1);
  assert.equal(res.json.works[0].hash, FALLBACK_HASH);
  assert.equal(res.json.works[0].passed_filter, 1);
  assert.equal(res.json.works[0].magnet.is_br, true);
  assert.equal(res.json.works[0].magnet.dubbed, true);
  assert.equal(res.json.works[0].magnet.lied, false);
  assert.equal(res.json.works[0].magnet.seeders_last, 7);
  assert.equal(res.json.works[0].magnet.last_seen, 1700000003000);
  assert.equal(res.json.sources[FALLBACK_HASH][0].indexer, 'fake');
  assert.equal(res.json.sources[FALLBACK_HASH][0].allowed, true);
  // Só obras com fonte nos indexers falhos/suspeitos entram na janela.
  assert.deepEqual([...(calls[0].indexers ?? [])].sort(), ['fake', 'sus']);
});

test('allowed:false vem do ji da config do PEDIDO no runtime', async () => {
  // A rota roda dentro de `runtime.run`; o veredito de `allowedSourceIndexer`
  // precisa usar o `ji` do segmento, não o default do operador.
  const res = await server.request('POST', '/internal/search/fallback', {
    headers: { 'X-Indexer-Test-Token': TOKEN },
    body: {
      encoded: encodeConfig({ p: ['jackett'], ji: ['kickasstorrents-to'] }),
      type: 'movie',
      imdb: 'tt0000001',
      failed: ['fake'],
      suspect: [],
      all_failed: false,
      live_hashes: [],
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.sources[FALLBACK_HASH][0].indexer, 'fake');
  assert.equal(
    res.json.sources[FALLBACK_HASH][0].allowed,
    false,
    'fake não está no ji do pedido',
  );
});

test('all_failed abre qualquer fonte do banco', async () => {
  calls.length = 0;
  const res = await server.request('POST', '/internal/search/fallback', {
    headers: { 'X-Indexer-Test-Token': TOKEN },
    body: {
      encoded,
      type: 'movie',
      imdb: 'tt0000001',
      failed: [],
      suspect: [],
      all_failed: true,
      live_hashes: [],
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.works.length, 1);
  assert.equal(calls[0].indexers, undefined, 'sem filtro de indexer no /all');
});

test('sem falha/suspeita não lê o banco', async () => {
  calls.length = 0;
  const res = await server.request('POST', '/internal/search/fallback', {
    headers: { 'X-Indexer-Test-Token': TOKEN },
    body: {
      encoded,
      type: 'movie',
      imdb: 'tt0000001',
      failed: [],
      suspect: [],
      all_failed: false,
      live_hashes: [],
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.works.length, 0);
  assert.equal(calls.length, 0);
});

test('kill-switch devolve config e não lê o banco', async () => {
  const previous = config.magnetBank.enabled;
  config.magnetBank.enabled = false;
  calls.length = 0;
  try {
    const res = await server.request('POST', '/internal/search/fallback', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: {
        encoded,
        type: 'movie',
        imdb: 'tt0000001',
        failed: ['fake'],
        all_failed: false,
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.enabled, false);
    assert.equal(res.json.works.length, 0);
    assert.equal(calls.length, 0);
  } finally {
    config.magnetBank.enabled = previous;
  }
});

test('entradas inválidas → 400', async () => {
  const cases = [
    { body: { encoded, type: 'channel', imdb: 'tt0000001' } },
    { body: { encoded, type: 'movie', imdb: '123' } },
    { body: { encoded, type: 'movie', imdb: 'tt0000001', failed: 'fake' } },
    { body: { encoded, type: 'movie', imdb: 'tt0000001', all_failed: 'yes' } },
    { body: { encoded: 'não-é-base64url!!', type: 'movie', imdb: 'tt0000001' } },
  ];
  for (const item of cases) {
    const res = await server.request('POST', '/internal/search/fallback', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: item.body,
    });
    assert.equal(res.status, 400, JSON.stringify(item.body));
    assert.equal(res.json.ok, false);
  }
});

test('app real: /internal/search/fallback vem antes do overlay /:userConfig', async () => {
  const appServer = await createTestServer(createTestApp());
  try {
    const res = await appServer.request('POST', '/internal/search/fallback', { body: {} });
    assert.equal(res.status, 401);
    assert.equal(res.json.ok, false);
  } finally {
    await appServer.close();
  }
});
