// Integração do TAIL da resposta instantânea do banco de magnets.
//
// Separado de `magnet-bank-instant.test.ts` (catraca de 400 linhas): aqui roda o
// `findStreams` REAL com a coleta viva dublada, cobrindo o que o teste de helper
// não alcança — a reserva 📦 sobrevivendo ao tail e ao refresh de debrid (sem
// regravar lista vazia nem promover TTL longo indevido), a troca pelo vivo
// quando há novidade, e a promoção do cache.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import config from '../src/config.js';
import * as bank from '../src/utils/magnet-bank.js';
import * as cache from '../src/utils/cache.js';
import * as metrics from '../src/utils/metrics.js';
import * as runtime from '../src/runtime.js';
import jackett from '../src/providers/jackett.js';
import debrid from '../src/debrid/index.js';
import { findStreams } from '../src/providers/index.js';
import { streamsCacheKey } from '../src/utils/request-key.js';
import { patch, testOpts } from './helpers/stub.js';
import { withMockFetch } from './e2e/e2e-harness.js';

const FRESH_DIR = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mb-inst-tail-'));
const hex = (c: string) => c.repeat(40);
const magnet = (h: string) => `magnet:?xt=urn:btih:${h}`;
const movieCtx = (imdb: string) => ({ imdbId: imdb, season: null, episode: null });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const NAME = 'Test Title';
const integOpts = (over: any = {}) => testOpts({
  providers: ['jackett'], jackettIndexers: ['idx-fail'], preferDubbed: false,
  debridService: '', debridApiKey: '', dubbedOnly: false, ...over,
});
const integKey = (imdb: string, opts: any) => streamsCacheKey('movie', imdb, { ...opts, resolveUncached: config.debrid.resolveUncached });

const tempDirs: string[] = [];
const saved = { releaseIndex: config.releaseIndex.enabled, ptSweepGlobal: config.jackett.ptSweepGlobal };

/** Captura a release e marca passed_filter=1 na obra (busca viva). */
function seed(hash: string, indexer: string, ctx: any, opts: { title?: string; seeders?: number } = {}) {
  const title = opts.title ?? `${NAME} 2024 1080p Dublado`;
  bank.captureItems([{ title, infoHash: hash, magnet: magnet(hash), seeders: opts.seeders ?? 5, isBr: true }], indexer, ctx);
  bank.markFilterResult([hash], [hash], ctx);
  bank.flushNow();
}

beforeEach(() => {
  bank.resetForTests();
  const dir = FRESH_DIR();
  tempDirs.push(dir);
  bank.open(dir);
  cache.clear();
  config.magnetBank.enabled = true;
  config.magnetBank.instantEnabled = true;
  // O índice não participa: a cobertura vem do banco e o foco é o tail.
  config.releaseIndex.enabled = false;
  config.jackett.ptSweepGlobal = false;
});

after(() => {
  bank.resetForTests();
  config.releaseIndex.enabled = saved.releaseIndex;
  config.jackett.ptSweepGlobal = saved.ptSweepGlobal;
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('tail integração: reserva 📦 preservada quando o vivo falha (sem regravar vazio)', async () => {
  const imdb = 'tt1254207';
  seed(hex('a'), 'idx-fail', movieCtx(imdb), { title: `${NAME} 2024 1080p Dublado`, seeders: 6 });
  const opts = integOpts();
  let jackettCalls = 0;
  const restoreInv = patch(debrid as any, 'inventory', async () => []);
  const restoreJackett = patch(jackett as any, 'search', async (_q: string, _t: string, _ix: any, options: any) => {
    jackettCalls += 1;
    options?.onQueryResult?.({ indexer: 'idx-fail', responded: false, reason: 'error' });
    return [];
  });
  try {
    await withMockFetch([], async () => {
      const res = await runtime.run({ opts, encoded: 'inst-tail-keep' }, () => findStreams({ type: 'movie', id: imdb }));
      assert.ok(res.streams.some((s: any) => /📦/.test(s.name || '')), 'primeira resposta traz o 📦');
      await sleep(600);
      assert.ok(jackettCalls > 0, 'o tail rodou a coleta viva');
      const entry: any = cache.get(integKey(imdb, opts));
      assert.equal(entry?.fallback, true, 'reserva 📦 preservada após o tail');
      assert.equal(entry?.partial, true, 'não promove a completa sem o vivo');
      assert.ok(entry.streams.some((s: any) => s._fromFallback), '📦 não sumiu da lista servida');
      const remaining = cache.peekRemaining(integKey(imdb, opts)) || 0;
      assert.ok(remaining > 0 && remaining <= config.fallbackStreamsTtl, `TTL curto (${remaining}s)`);
    });
  } finally {
    restoreJackett(); restoreInv();
  }
});

test('tail integração: novidade viva troca o 📦 e promove TTL longo', async () => {
  const imdb = 'tt1254207';
  seed(hex('b'), 'idx-fail', movieCtx(imdb), { title: `${NAME} 2024 1080p Dublado`, seeders: 6 });
  const liveHash = hex('e');
  const opts = integOpts();
  const restoreInv = patch(debrid as any, 'inventory', async () => []);
  const restoreJackett = patch(jackett as any, 'search', async (_q: string, _t: string, _ix: any, options: any) => {
    options?.onQueryResult?.({ indexer: 'idx-fail', responded: true });
    return [{ title: `${NAME} 2024 720p`, infoHash: liveHash, seeders: 9 }];
  });
  try {
    await withMockFetch([], async () => {
      await runtime.run({ opts, encoded: 'inst-tail-promote' }, () => findStreams({ type: 'movie', id: imdb }));
      await sleep(600);
      const entry: any = cache.get(integKey(imdb, opts));
      assert.equal(entry?.partial, false);
      assert.ok(!entry?.fallback, 'reserva sai quando o vivo responde');
      assert.ok(entry.streams.some((s: any) => s.infoHash === liveHash), 'release viva promovida');
      assert.ok((cache.peekRemaining(integKey(imdb, opts)) || 0) > 120, 'TTL longo na promoção');
    });
  } finally {
    restoreJackett(); restoreInv();
  }
});

test('tail com varredura pt-BR ativa: não repete a inline, mantém o 📦 e não mede search.late', async () => {
  const imdb = 'tt1254207';
  seed(hex('a'), 'idx-fail', movieCtx(imdb), { title: `${NAME} 2024 1080p Dublado`, seeders: 6 });
  const opts = integOpts();
  const allQueries: string[] = [];
  const snapBefore = metrics.snapshot() as any;
  const lateBefore = snapBefore.timers['search.late']?.count ?? 0;
  const runBefore = snapBefore.counters['search.pt-sweep.run'] ?? 0;
  const restoreInv = patch(debrid as any, 'inventory', async () => []);
  // Título pt diferente do original → ptQuery + sweepQuery ativos. O TMDB é
  // alimentado pela PRÓPRIA chave de cache (`getTitles` devolve o hit) — sem
  // rede e sem stub de módulo (namespace ESM é read-only).
  const restoreTmdbKey = patch(config.tmdb as any, 'apiKey', 'test-key');
  cache.set(`tmdb:${imdb}`, { en: NAME, pt: 'Titulo Teste', original: NAME, year: 2024 }, 300);
  const restoreJackett = patch(jackett as any, 'search', async (q: string, _t: string, ix: any, options: any) => {
    allQueries.push(q);
    const ids: string[] = Array.isArray(ix) ? ix : ['idx-fail'];
    for (const id of ids) options?.onQueryResult?.({ indexer: id, responded: false, reason: 'error' });
    return [];
  });
  const savedSweep = config.jackett.ptSweepGlobal;
  config.jackett.ptSweepGlobal = true;
  try {
    await withMockFetch([], async () => {
      const res = await runtime.run({ opts, encoded: 'inst-sweep' }, () => findStreams({ type: 'movie', id: imdb }));
      assert.ok(res.streams.some((s: any) => /📦/.test(s.name || '')), 'primeira resposta traz o 📦');
      await sleep(900);
      // A coleta `all` do tail roda a varredura INLINE; a cauda serial a vê no
      // `raw.sweepInline` (setado em runtime) e não repete. A varredura é a
      // consulta que NÃO é a principal ("Test Title 2024").
      const sweepQueries = allQueries.filter((q) => q !== `${NAME} 2024`);
      assert.equal(sweepQueries.length, 1, 'varredura pt-BR rodou uma única vez');
      const snapAfter = metrics.snapshot() as any;
      assert.equal((snapAfter.counters['search.pt-sweep.run'] ?? 0) - runBefore, 0, 'cauda não agenda varredura duplicada');
      assert.equal((snapAfter.timers['search.late']?.count ?? 0) - lateBefore, 0, 'instantâneo não gera amostra ~0ms de search.late');
      const entry: any = cache.get(integKey(imdb, opts));
      assert.equal(entry?.fallback, true, 'reserva 📦 preservada após a varredura');
      assert.equal(entry?.partial, true, 'varredura não promove a completa sozinha');
      assert.ok(entry.streams.some((s: any) => s._fromFallback), '📦 não sumiu da lista');
      const remaining = cache.peekRemaining(integKey(imdb, opts)) || 0;
      assert.ok(remaining > 0 && remaining <= config.fallbackStreamsTtl, `TTL curto (${remaining}s)`);
    });
  } finally {
    config.jackett.ptSweepGlobal = savedSweep;
    restoreJackett(); restoreTmdbKey(); restoreInv();
    cache.forget(`tmdb:${imdb}`);
  }
});

test('refresh de debrid: reserva 📦 sobrevive com indexer ainda falho', async () => {
  const imdb = 'tt1254207';
  seed(hex('c'), 'idx-a', movieCtx(imdb), { title: `${NAME} 2024 1080p Dublado`, seeders: 6 });
  const liveHash = hex('d');
  const opts = integOpts({
    jackettIndexers: ['idx-a', 'idx-b'],
    debridService: 'premiumize', debridApiKey: 'k', autoFetchBr: false,
  });
  const restoreInv = patch(debrid as any, 'inventory', async () => []);
  // `known:false` degrada a checagem → `needsFullRefresh` liga o passe tardio
  // de debrid, que antes regravava a lista sem a reserva (usava `raw.live`=null).
  const restoreCheck = patch(debrid as any, 'checkCached', async () => ({ cached: new Set<string>(), known: false }));
  const restoreJackett = patch(jackett as any, 'search', async (_q: string, _t: string, ix: any, options: any) => {
    const ids: string[] = Array.isArray(ix) ? ix : ['idx-a'];
    for (const id of ids) options?.onQueryResult?.({ indexer: id, responded: id !== 'idx-a' });
    return ids.includes('idx-b') ? [{ title: `${NAME} 2024 720p`, infoHash: liveHash, seeders: 9 }] : [];
  });
  try {
    await withMockFetch([], async () => {
      await runtime.run({ opts, encoded: 'inst-refresh' }, () => findStreams({ type: 'movie', id: imdb }));
      await sleep(900);
      const entry: any = cache.get(integKey(imdb, opts));
      assert.equal(entry?.partial, true, 'refresh não promove a reserva a completa');
      assert.equal(entry?.fallback, true, 'reserva 📦 sobrevive ao refresh');
      assert.ok(entry.streams.some((s: any) => s._fromFallback), 'item do banco reinjetado no refresh');
    });
  } finally {
    restoreJackett(); restoreCheck(); restoreInv();
  }
});
