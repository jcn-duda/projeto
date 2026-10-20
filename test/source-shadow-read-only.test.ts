// C0a — sombra de fonte, lado Node: a coleta `read_only` é REFERÊNCIA, não
// produção. Aqui se prova, por fonte:
//   1. BLUDV não lê nem grava o cache bruto `raw:v1`;
//   2. Mico não pinta card, não abre/reseta breaker e não captura no banco;
//   3. Torrentio não abre/reseta o breaker local;
//   4. a elegibilidade da rota espelha o `wants` POR FONTE (BLUDV/Mico não são
//      tokens de `providers`);
//   5. o caminho NORMAL (readOnly=false) continua consultando exatamente as
//      mesmas fontes de antes para a matriz providers×fonte.
// Sem rede real: `fetch` é dublê e os providers de request são controlados por
// config/stub.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import express from 'express';
import { createTestServer, encodeConfig } from './e2e/e2e-harness.js';
import config from '../src/config.js';
import * as cache from '../src/utils/cache.js';
import * as bank from '../src/utils/magnet-bank.js';
import { worksForObraMany } from '../src/utils/magnet-bank-query.js';
import * as indexerStatus from '../src/providers/indexer-status.js';
import { prefix } from '../src/utils/cache-keys.js';
import * as runtime from '../src/runtime.js';
import { collectRaw } from '../src/providers/collect-orchestrator.js';
import bludv from '../src/providers/bludv.js';
import * as mico from '../src/providers/mico.js';
import * as torrentio from '../src/providers/torrentio.js';
import jackett from '../src/providers/jackett.js';
import prowlarr from '../src/providers/prowlarr.js';
import { buildServices } from '../src/routes/services.js';
import { registerInternalSearch } from '../src/routes/internal-search.js';
import type { InternalSearchCollaborators } from '../src/routes/internal-search.js';
import { patch, stubFetch, testOpts } from './helpers/stub.js';

const IMDB = 'tt0100001';
const HASH = 'a'.repeat(40);
const TOKEN = 'tok-source-shadow';
const MATCH = { names: ['Filme'], year: 2024, isSeries: false, season: null, episode: null };

function emptyCollection() {
  return {
    items: [], partial: false, completion: Promise.resolve(), sweepInline: false, live: null,
  };
}

/** Coleta a matriz de fontes acionadas por `collectRaw` (caminho normal). */
async function collectedSources(providers: string[], skip: string[] = []) {
  const calls = new Set<string>();
  const patches = [
    patch(jackett, 'search', (async () => { calls.add('jackett'); return []; }) as typeof jackett.search),
    patch(prowlarr, 'search', (async () => { calls.add('prowlarr'); return []; }) as typeof prowlarr.search),
  ];
  const net = stubFetch((url) => {
    if (url.startsWith(config.torrentio.url)) {
      calls.add('torrentio');
      return { ok: true, status: 200, json: async () => ({ streams: [] }) };
    }
    if (url.startsWith(config.mico.url)) {
      calls.add('mico');
      return { ok: true, status: 200, json: async () => ({ streams: [] }) };
    }
    if (url.startsWith(config.bludv.baseUrl)) {
      calls.add('bludv');
      return { ok: true, status: 200, text: async () => '' };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
  try {
    const batch = await runtime.run({
      opts: testOpts({ providers, jackettIndexers: [] }),
      encoded: 'src-shadow',
    }, () => collectRaw(
      'Filme 2024', 'movie', IMDB, 'Filme', MATCH,
      null, null, Date.now() + 2000, 'all',
      null, null, null, null, new Set(skip),
    ));
    return { sources: [...calls].sort(), items: batch.items.length };
  } finally {
    net.restore();
    for (const undo of patches) undo();
  }
}

let server: any;
const saved: Record<string, any> = {};

before(async () => {
  saved.testToken = config.jackett.testToken;
  config.jackett.testToken = TOKEN;
  const app = express();
  const services = buildServices();
  const stub: Partial<InternalSearchCollaborators> = {
    collectRaw: (async () => emptyCollection()) as any,
  };
  registerInternalSearch(app as unknown as express.Router, services, stub);
  server = await createTestServer(app);
});

after(async () => {
  await server.close();
  config.jackett.testToken = saved.testToken;
});

async function eligibleOf(opts: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const res = await server.request('POST', '/internal/search/collect', {
    headers: { 'X-Indexer-Test-Token': TOKEN },
    body: {
      encoded: encodeConfig(opts),
      query: 'Filme 2024',
      type: 'movie',
      imdb: IMDB,
      deadline_at: Date.now() + 5000,
      read_only: true,
      ...extra,
    },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.json.eligible;
}

// ── BLUDV — cache bruto ──

test('bludv read-only: não lê nem grava raw:v1', async () => {
  const savedEnabled = config.bludv.enabled;
  const savedBase = config.bludv.baseUrl;
  config.bludv.enabled = true;
  config.bludv.baseUrl = 'http://bludv.local';
  cache.clear();
  const key = `${prefix('raw')}bludv:${runtime.defaults().dubbedOnly ? 'd' : 't'}:Filme 2024`;
  const net = stubFetch(() => ({ ok: true, status: 200, text: async () => '' }));
  try {
    // Sentinela no cache: a referência não pode servi-la nem apagá-la.
    cache.set(key, { items: [{ title: 'SENTINELA' }] }, 60);
    const items = await bludv.search('Filme 2024', { readOnly: true });
    assert.equal(net.calls.length, 1, 'read-only consulta a rede (não usa cache)');
    assert.deepEqual(items, [], 'resultado é o da rede, não o do cache');
    assert.deepEqual(cache.get(key), { items: [{ title: 'SENTINELA' }] }, 'cache bruto não foi reescrito');

    // Caminho normal: sem sentinela, grava; com sentinela, serve do cache.
    cache.clear();
    await bludv.search('Filme 2024');
    assert.ok(cache.get(key), 'caminho normal grava raw:v1');
    cache.set(key, { items: [{ title: 'SENTINELA' }] }, 60);
    const before = net.calls.length;
    const cached = await bludv.search('Filme 2024');
    assert.equal(net.calls.length, before, 'caminho normal lê raw:v1');
    assert.equal(cached[0]?.title, 'SENTINELA');
  } finally {
    net.restore();
    cache.clear();
    config.bludv.enabled = savedEnabled;
    config.bludv.baseUrl = savedBase;
  }
});

// ── Mico — card, breaker e banco de magnets ──

function micoOk(title = 'Filme 2024 DUBLADO') {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      streams: [{
        infoHash: HASH,
        title,
        sources: ['tracker:udp://tracker.example:80'],
      }],
    }),
  };
}

test('mico read-only: sem card, breaker e banco; normal mantém tudo', async () => {
  const savedMico = { enabled: config.mico.enabled, failures: config.mico.breakerFailures, cooldown: config.mico.breakerCooldown };
  config.mico.enabled = true;
  config.mico.breakerFailures = 1;
  config.mico.breakerCooldown = 60_000;
  mico._resetBreaker();
  indexerStatus.clear();
  cache.clear();
  bank.resetForTests();
  bank.open(undefined, { forceMemory: true });

  const net = stubFetch(() => micoOk());
  try {
    const out = await mico.search({ type: 'movie', imdbId: IMDB }, { readOnly: true });
    assert.equal(out.length, 1, 'referência devolve o lote');
    assert.equal(net.calls.length, 1);
    assert.equal(indexerStatus.get(mico.MICO_ID), null, 'read-only não pinta card');
    bank.flushBarrier();
    assert.equal(
      worksForObraMany(IMDB, [{ season: null, episode: null }], 10).length,
      0,
      'read-only não captura no banco',
    );

    // Caminho normal no mesmo estado: pinta card e captura no banco.
    await mico.search({ type: 'movie', imdbId: IMDB }, { recordStatus: true });
    assert.ok(indexerStatus.get(mico.MICO_ID), 'caminho normal pinta card');
    bank.flushBarrier();
    assert.ok(
      worksForObraMany(IMDB, [{ season: null, episode: null }], 10).length > 0,
      'caminho normal captura no banco',
    );
  } finally {
    net.restore();
    bank.resetForTests();
    indexerStatus.clear();
    cache.clear();
    config.mico.enabled = savedMico.enabled;
    config.mico.breakerFailures = savedMico.failures;
    config.mico.breakerCooldown = savedMico.cooldown;
    mico._resetBreaker();
  }
});

test('mico read-only: ignora o breaker aberto e não o reseta', async () => {
  const saved = { failures: config.mico.breakerFailures, cooldown: config.mico.breakerCooldown };
  config.mico.breakerFailures = 1;
  config.mico.breakerCooldown = 60_000;
  mico._resetBreaker();
  // Abre o circuito pelo caminho normal (uma falha de rede basta).
  const fail = stubFetch(() => { throw new Error('rede caiu'); });
  try {
    await mico.search({ type: 'movie', imdbId: IMDB }, { recordStatus: false });
  } finally {
    fail.restore();
  }
  const blocked = stubFetch(() => micoOk());
  try {
    // Normal: circuito aberto → nem consulta.
    await mico.search({ type: 'movie', imdbId: IMDB }, { recordStatus: false });
    assert.equal(blocked.calls.length, 0, 'normal respeita o breaker aberto');
    // Referência: consulta mesmo aberto e NÃO reseta o circuito.
    const out = await mico.search({ type: 'movie', imdbId: IMDB }, { readOnly: true });
    assert.equal(blocked.calls.length, 1, 'read-only ignora o breaker');
    assert.equal(out.length, 1, 'read-only devolve a referência');
    await mico.search({ type: 'movie', imdbId: IMDB }, { recordStatus: false });
    assert.equal(blocked.calls.length, 1, 'read-only não reseta o breaker');
  } finally {
    blocked.restore();
    config.mico.breakerFailures = saved.failures;
    config.mico.breakerCooldown = saved.cooldown;
    mico._resetBreaker();
  }
});

// ── Torrentio — breaker local ──

function torrentioOk() {
  return {
    ok: true,
    status: 200,
    json: async () => ({ streams: [{ infoHash: HASH, title: 'Filme 2024 1080p', fileIdx: 0 }] }),
  };
}

test('torrentio read-only: ignora o breaker e não o abre/reseta', async () => {
  const saved = { failures: config.torrentio.breakerFailures, cooldown: config.torrentio.breakerCooldown };
  config.torrentio.enabled = true;
  config.torrentio.breakerFailures = 1;
  config.torrentio.breakerCooldown = 60_000;
  torrentio._resetBreaker();
  const fail = stubFetch(() => { throw new Error('rede caiu'); });
  try {
    await torrentio.search({ type: 'movie', imdbId: IMDB });
  } finally {
    fail.restore();
  }
  const net = stubFetch(() => torrentioOk());
  try {
    await torrentio.search({ type: 'movie', imdbId: IMDB });
    assert.equal(net.calls.length, 0, 'normal respeita o breaker aberto');
    const out = await torrentio.search({ type: 'movie', imdbId: IMDB }, { readOnly: true });
    assert.equal(net.calls.length, 1, 'read-only ignora o breaker');
    assert.equal(out.length, 1);
    await torrentio.search({ type: 'movie', imdbId: IMDB });
    assert.equal(net.calls.length, 1, 'read-only não reseta o breaker');
  } finally {
    net.restore();
    config.torrentio.breakerFailures = saved.failures;
    config.torrentio.breakerCooldown = saved.cooldown;
    torrentio._resetBreaker();
  }
});

// ── Elegibilidade da rota — por FONTE, não por token de `providers` ──

test('elegibilidade: BLUDV/Mico não são tokens de providers', async () => {
  const savedBludv = config.bludv.enabled;
  const savedMico = { enabled: config.mico.enabled, default: config.mico.default };
  const savedTorrentio = config.torrentio.enabled;
  config.bludv.enabled = true;
  config.mico.enabled = true;
  config.mico.default = true;
  config.torrentio.enabled = true;
  try {
    // BLUDV independe do PROVIDER (só o kill-switch).
    assert.equal(await eligibleOf({ p: ['prowlarr'] }, { shadow_source: 'bludv' }), true);
    // Mico exige `jackettMode`: provider só prowlarr não consulta o card.
    assert.equal(await eligibleOf({ p: ['prowlarr'] }, { shadow_source: 'mico' }), false);
    // Com Jackett/both, o card depende do `ji` (ou do default do operador).
    assert.equal(
      await eligibleOf({ p: ['both'], ji: ['mico'] }, { shadow_source: 'mico', indexers: ['mico'] }),
      true,
    );
    assert.equal(
      await eligibleOf({ p: ['both'], ji: ['yts'] }, { shadow_source: 'mico', indexers: ['yts'] }),
      false,
    );
    assert.equal(await eligibleOf({ p: ['both'] }, { shadow_source: 'mico' }), true);
    config.mico.default = false;
    assert.equal(await eligibleOf({ p: ['both'] }, { shadow_source: 'mico' }), false);
    // `skip_sources` desabilita a fonte.
    assert.equal(
      await eligibleOf({ p: ['prowlarr'] }, {
        shadow_source: 'bludv',
        skip_sources: ['bludv'],
      }),
      false,
    );
    // Torrentio continua sendo token de `providers` e respeita o kill-switch.
    assert.equal(await eligibleOf({ p: ['jackett'] }, { shadow_source: 'torrentio' }), false);
    assert.equal(await eligibleOf({ p: ['both'] }, { shadow_source: 'torrentio' }), true);
    config.torrentio.enabled = false;
    assert.equal(await eligibleOf({ p: ['both'] }, { shadow_source: 'torrentio' }), false);
  } finally {
    config.bludv.enabled = savedBludv;
    config.mico.enabled = savedMico.enabled;
    config.mico.default = savedMico.default;
    config.torrentio.enabled = savedTorrentio;
  }
});

// ── Caminho NORMAL inalterado — matriz providers×fonte ──

test('caminho normal: matriz providers×fonte idêntica à produção', async () => {
  const saved = {
    provider: config.provider,
    jackett: { url: config.jackett.url, apiKey: config.jackett.apiKey, indexers: config.jackett.indexers },
    prowlarr: { url: config.prowlarr.url, apiKey: config.prowlarr.apiKey },
    torrentio: { url: config.torrentio.url, enabled: config.torrentio.enabled },
    mico: { url: config.mico.url, enabled: config.mico.enabled, default: config.mico.default },
    bludv: { enabled: config.bludv.enabled, baseUrl: config.bludv.baseUrl },
  };
  config.provider = 'jackett';
  config.jackett.url = 'http://jackett.local';
  config.jackett.apiKey = 'fake';
  config.jackett.indexers = [];
  config.prowlarr.url = 'http://prowlarr.local';
  config.prowlarr.apiKey = 'fake';
  config.torrentio.url = 'http://torrentio.local';
  config.torrentio.enabled = true;
  config.mico.url = 'http://mico.local';
  config.mico.enabled = true;
  config.mico.default = true;
  config.bludv.enabled = true;
  config.bludv.baseUrl = 'http://bludv.local';
  cache.clear();
  try {
    const cases: [string[], string[]][] = [
      [['jackett'], ['bludv', 'jackett', 'mico']],
      [['prowlarr'], ['bludv', 'prowlarr']],
      [['both'], ['bludv', 'jackett', 'mico', 'prowlarr', 'torrentio']],
      [['jackett', 'torrentio'], ['bludv', 'jackett', 'mico', 'torrentio']],
      [['foo'], ['bludv', 'jackett']],
    ];
    for (const [providers, expected] of cases) {
      // Cada caso é uma busca independente: sem limpar, o `raw:v1` vazio do
      // BLUDV do caso anterior serviria o seguinte sem rede.
      cache.clear();
      const got = await collectedSources(providers);
      assert.deepEqual(
        got.sources,
        [...expected].sort(),
        `fontes consultadas com providers=${JSON.stringify(providers)}`,
      );
    }
    // `demo` continua isolado: responde do próprio lote, sem tocar fonte.
    const demo = await collectedSources(['demo']);
    assert.deepEqual(demo.sources, [], 'demo não consulta fonte real');
    // `skip_sources` continua desligando a fonte mesmo na seleção efetiva.
    cache.clear();
    const skipped = await collectedSources(['both'], ['bludv', 'jackett', 'mico']);
    assert.deepEqual(skipped.sources, ['prowlarr', 'torrentio']);
  } finally {
    config.provider = saved.provider;
    Object.assign(config.jackett, saved.jackett);
    Object.assign(config.prowlarr, saved.prowlarr);
    Object.assign(config.torrentio, saved.torrentio);
    Object.assign(config.mico, saved.mico);
    Object.assign(config.bludv, saved.bludv);
    cache.clear();
  }
});
