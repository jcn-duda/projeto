// Fallback do banco de magnets vivo (Etapa 4) — integração de cache/late e do
// gatilho agregado. Cobre TTL do fallback respeitando CACHE_TTL, promoção
// tardia (com/sem novidade) e o ramo `/all` do collectRaw. Sem rede: jackett e
// metadados são dublês; config temporal fixada e restaurada.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
process.env.CACHE_PERSIST = 'false';

import config from '../src/config.js';
import jackett from '../src/providers/jackett.js';
import * as bank from '../src/utils/magnet-bank.js';
import * as cache from '../src/utils/cache.js';
import * as metrics from '../src/utils/metrics.js';
import * as runtime from '../src/runtime.js';
import { collectRaw } from '../src/providers/collect-orchestrator.js';
import { findStreams } from '../src/providers/index.js';
import { streamsCacheKey } from '../src/utils/request-key.js';
import { patch, testOpts } from './helpers/stub.js';
import { withMockFetch, fakeResponse } from './e2e/e2e-harness.js';

const hex = (c: string) => c.repeat(40);
const magnet = (h: string) => `magnet:?xt=urn:btih:${h}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const matchContext = (name: string) => ({ names: [name], year: 2024, isSeries: false, season: null, episode: null });
const tempDirs: string[] = [];
const orig = {
  debridReserve: config.debridReserve,
  cacheTtl: config.cacheTtl,
  fallbackTtl: config.fallbackStreamsTtl,
  replyDeadline: config.replyDeadline,
  jackettIndexers: config.jackett.indexers,
  jackettUrl: config.jackett.url,
  jackettApiKey: config.jackett.apiKey,
  ptSweepGlobal: config.jackett.ptSweepGlobal,
  releaseIndex: config.releaseIndex.enabled,
  // Esta suíte testa a reserva do banco da Etapa 4 e o passe tardio, não a via
  // instantânea: com `MAGNET_BANK_INSTANT` ligada a resposta sairia do acervo
  // antes da coleta e o cenário medido deixaria de ser o alvo.
  instantEnabled: config.magnetBank.instantEnabled,
};

function freshDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-fb-int-'));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  bank.resetForTests();
  bank.open(freshDir());
  cache.clear();
  metrics.reset();
  config.magnetBank.enabled = true;
  config.magnetBank.instantEnabled = false;
  config.magnetBank.fallbackEnabled = true;
  config.magnetBank.fallbackMaxPerIndexer = 40;
  config.magnetBank.fallbackGlobalMax = 40;
  config.releaseIndex.enabled = false;
  config.jackett.ptSweepGlobal = false;
  config.jackett.breakerEnabled = true;
  config.jackett.breakerFailures = 3;
  // Estabiliza o orçamento temporal: 1200 − 4500 => piso 500ms.
  config.debridReserve = 4500;
  config.replyDeadline = orig.replyDeadline;
  config.cacheTtl = orig.cacheTtl;
  config.fallbackStreamsTtl = orig.fallbackTtl;
});

after(() => {
  bank.resetForTests();
  config.debridReserve = orig.debridReserve;
  config.cacheTtl = orig.cacheTtl;
  config.fallbackStreamsTtl = orig.fallbackTtl;
  config.replyDeadline = orig.replyDeadline;
  config.jackett.indexers = orig.jackettIndexers;
  config.jackett.url = orig.jackettUrl;
  config.jackett.apiKey = orig.jackettApiKey;
  config.jackett.ptSweepGlobal = orig.ptSweepGlobal;
  config.releaseIndex.enabled = orig.releaseIndex;
  config.magnetBank.instantEnabled = orig.instantEnabled;
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function seedFallback(hash: string, indexer: string, name: string) {
  const ctx = { imdbId: 'tt1254207', season: null, episode: null };
  bank.captureItems([{ title: `${name} 2024 1080p Dublado`, infoHash: hash, magnet: magnet(hash), seeders: 5, isBr: true }], indexer, ctx);
  bank.markFilterResult([hash], [hash], ctx);
  bank.flushNow();
}

const NAME = 'Test Title';
const userOpts = () => testOpts({ providers: ['jackett'], jackettIndexers: ['idx-fail'], preferDubbed: false, debridService: '', debridApiKey: '' });
const cacheKeyFor = () => streamsCacheKey('movie', 'tt1254207', { ...userOpts(), resolveUncached: config.debrid.resolveUncached });

async function runWithJackett(impl: (options: any, call: number) => Promise<any[]>, fn: () => Promise<any>) {
  let call = 0;
  const restore = patch(jackett, 'search', async (_q: string, _t: string, _ix: any, options: any) => impl(options, call++));
  try {
    return await fn();
  } finally {
    restore();
  }
}

test('cache: lista com fallback grava fallback/partial e TTL curto', async () => {
  seedFallback(hex('a'), 'idx-fail', NAME);
  config.replyDeadline = 1200;
  await withMockFetch([], async () => {
    const res = await runWithJackett(
      async (options) => { options?.onQueryResult?.({ indexer: 'idx-fail', responded: false, reason: 'error' }); return []; },
      () => runtime.run({ opts: userOpts(), encoded: 'cfg-cache' }, () => findStreams({ type: 'movie', id: 'tt1254207' })),
    );
    assert.equal(res.partial, true, 'resposta marca partial para cacheMaxAge 0');
    assert.ok(res.streams.some((s: any) => /📦/.test(s.name || '')), 'o fallback entrou na lista');
    const entry: any = cache.get(cacheKeyFor());
    assert.equal(entry?.fallback, true);
    assert.equal(entry?.partial, true);
    const remaining = cache.peekRemaining(cacheKeyFor()) || 0;
    assert.ok(remaining > 100 && remaining <= 120, `TTL curto (${remaining}s)`);
  });
});

test('cache: CACHE_TTL=0 não grava a reserva', async () => {
  seedFallback(hex('b'), 'idx-fail', NAME);
  config.replyDeadline = 1200;
  config.cacheTtl = 0;
  await withMockFetch([], async () => {
    const res = await runWithJackett(
      async (options) => { options?.onQueryResult?.({ indexer: 'idx-fail', responded: false, reason: 'error' }); return []; },
      () => runtime.run({ opts: userOpts(), encoded: 'cfg-zero' }, () => findStreams({ type: 'movie', id: 'tt1254207' })),
    );
    assert.ok(res.streams.some((s: any) => /📦/.test(s.name || '')), 'a lista ainda é entregue');
    assert.ok(!cache.get(cacheKeyFor()), 'cache desligado não grava reserva');
  });
});

test('cache: CACHE_TTL menor que o fallback vence (min)', async () => {
  seedFallback(hex('c'), 'idx-fail', NAME);
  config.replyDeadline = 1200;
  config.cacheTtl = 60;
  await withMockFetch([], async () => {
    await runWithJackett(
      async (options) => { options?.onQueryResult?.({ indexer: 'idx-fail', responded: false, reason: 'error' }); return []; },
      () => runtime.run({ opts: userOpts(), encoded: 'cfg-min' }, () => findStreams({ type: 'movie', id: 'tt1254207' })),
    );
    const remaining = cache.peekRemaining(cacheKeyFor()) || 0;
    assert.ok(remaining > 40 && remaining <= 60, `TTL respeita CACHE_TTL (${remaining}s)`);
  });
});

test('cache: late com novidade remove o fallback e promove', async () => {
  seedFallback(hex('d'), 'idx-fail', NAME);
  config.replyDeadline = 1200;
  const liveHash = hex('e');
  await withMockFetch([], async () => {
    await runWithJackett(
      async (options) => {
        await sleep(800);
        options?.onQueryResult?.({ indexer: 'idx-fail', responded: true });
        return [{ title: `${NAME} 2024 720p`, infoHash: liveHash, magnet: magnet(liveHash), seeders: 9 }];
      },
      () => runtime.run({ opts: userOpts(), encoded: 'cfg-grew' }, () => findStreams({ type: 'movie', id: 'tt1254207' })),
    );
    await sleep(700);
    const entry: any = cache.get(cacheKeyFor());
    assert.equal(entry?.fallback ?? false, false, 'fallback sai quando o vivo volta');
    assert.equal(entry?.partial, false);
    assert.ok((cache.peekRemaining(cacheKeyFor()) || 0) > 120, 'TTL cheio na promoção');
    assert.ok(entry.streams.some((s: any) => s.infoHash === liveHash));
  });
});

test('cache: late sem novidade com falha viva mantém a reserva', async () => {
  seedFallback(hex('f'), 'idx-fail', NAME);
  config.replyDeadline = 1200;
  await withMockFetch([], async () => {
    await runWithJackett(
      async () => { await sleep(800); return []; }, // nunca responde: falha/pendência viva
      () => runtime.run({ opts: userOpts(), encoded: 'cfg-still' }, () => findStreams({ type: 'movie', id: 'tt1254207' })),
    );
    await sleep(700);
    const entry: any = cache.get(cacheKeyFor());
    assert.equal(entry?.fallback, true, 'falha viva mantém a reserva');
    assert.equal(entry?.partial, true);
  });
});

test('cache: late sem novidade com resposta válida invalida a reserva', async () => {
  seedFallback(hex('1'), 'idx-fail', NAME);
  config.replyDeadline = 1200;
  await withMockFetch([], async () => {
    await runWithJackett(
      async (options) => { await sleep(800); options?.onQueryResult?.({ indexer: 'idx-fail', responded: true }); return []; },
      () => runtime.run({ opts: userOpts(), encoded: 'cfg-inval' }, () => findStreams({ type: 'movie', id: 'tt1254207' })),
    );
    await sleep(700);
    assert.ok(!cache.get(cacheKeyFor()), 'reserva não fica 120s após resposta viva válida');
  });
});

test('/all: collectRaw com agregado em erro vira allFailed', async () => {
  const savedIndexers = config.jackett.indexers;
  const realFetch = globalThis.fetch;
  config.jackett.url = 'http://jackett.test';
  config.jackett.apiKey = 'k';
  config.jackett.indexers = [];
  globalThis.fetch = (async () => { throw new Error('rede'); }) as any;
  try {
    const optsAll = testOpts({ providers: ['jackett'], jackettIndexers: [], debridService: '', debridApiKey: '' });
    const raw = await runtime.run({ opts: optsAll, encoded: 'cfg-all' }, () => collectRaw(
      'Filme Teste 2024', 'movie', 'tt300', null, matchContext('Filme Teste') as any, null, null, null,
    )) as any;
    assert.equal(raw.live?.allState(), 'error');
    assert.equal(raw.live?.allFailed(), true);
  } finally {
    globalThis.fetch = realFetch;
    config.jackett.indexers = savedIndexers;
    config.jackett.url = orig.jackettUrl;
    config.jackett.apiKey = orig.jackettApiKey;
  }
});

test('/all: cross config não vazia + runtime vazio NÃO marca agregado', async () => {
  const savedIndexers = config.jackett.indexers;
  const realFetch = globalThis.fetch;
  config.jackett.url = 'http://jackett.test';
  config.jackett.apiKey = 'k';
  config.jackett.indexers = ['cfg-idx'];
  globalThis.fetch = (async () => fakeResponse({ Results: [] })) as any;
  try {
    const optsEmpty = testOpts({ providers: ['jackett'], jackettIndexers: [], debridService: '', debridApiKey: '' });
    const raw = await runtime.run({ opts: optsEmpty, encoded: 'cfg-cross' }, () => collectRaw(
      'Filme Teste 2024', 'movie', 'tt301', null, matchContext('Filme Teste') as any, null, null, null,
    )) as any;
    assert.equal(raw.live?.allState(), 'unknown', 'não deixou /all pending fantasma');
    assert.equal(raw.live?.allFailed(), false);
    assert.equal(raw.live?.hasAnyFailure(), false, 'indexer respondeu válido');
  } finally {
    globalThis.fetch = realFetch;
    config.jackett.indexers = savedIndexers;
    config.jackett.url = orig.jackettUrl;
    config.jackett.apiKey = orig.jackettApiKey;
  }
});
