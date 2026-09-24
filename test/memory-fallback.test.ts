// Fallback do banco de magnets vivo (Etapa 4) — unidade e seleção.
//
// Cobre o estado vivo de falha, a seleção por obra/indexer do banco (packs,
// caps, lied, live-dedupe), o corte por episódio no build, o selo honesto
// (📦/~) com remoção no protocolo e as travas de auto-perpetuação
// (banco/índice/Chupim). Sem rede: banco em memória e config restaurada.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import config from '../src/config.js';
import * as bank from '../src/utils/magnet-bank.js';
import * as cache from '../src/utils/cache.js';
import * as metrics from '../src/utils/metrics.js';
import * as releaseIndex from '../src/utils/release-index.js';
import debrid from '../src/debrid/index.js';
import * as held from '../src/debrid/protected.js';
import * as autofetch from '../src/providers/autofetch.js';
import * as runtime from '../src/runtime.js';
import { applyDebrid } from '../src/providers/index.js';
import { accountScope } from '../src/utils/request-key.js';
import { collectFallbackItems } from '../src/providers/magnet-bank-fallback.js';
import { createLiveIndexerState, ALL_QUERY_INDEXER } from '../src/providers/live-indexer-state.js';
import { prepareCandidateStreams } from '../src/providers/stream-builder-pipeline.js';
import { toStremioStream } from '../src/utils/search-names.js';
import { applyNoticeOrigin } from '../src/providers/stream-builder.js';
import type { Stream, DebridAdapter } from '../types/domain.js';

const FRESH_DIR = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mem-fb-'));
const hex = (c: string) => c.repeat(40);
const hnum = (n: number) => n.toString(16).padStart(40, '0');
const magnet = (h: string) => `magnet:?xt=urn:btih:${h}`;
const movieCtx = (imdb: string) => ({ imdbId: imdb, season: null, episode: null });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const trace = () => ({ stages: {} as Record<string, number>, items: [] as any[], accountItems: 0, startedAt: 0, finishedAt: null });

const tempDirs: string[] = [];
const savedConfig = {
  cacheTtl: config.cacheTtl,
  fallbackTtl: config.fallbackStreamsTtl,
  globalMax: config.magnetBank.fallbackGlobalMax,
};

/** Captura a release e (se pedido) marca passed_filter=1 na obra. */
function seed(hash: string, indexer: string, ctx: any, opts: { title?: string; seeders?: number; lied?: boolean; passed?: boolean } = {}) {
  const title = opts.title ?? 'Filme Teste 2024 1080p Dublado';
  bank.captureItems([{ title, infoHash: hash, magnet: magnet(hash), seeders: opts.seeders ?? 5, isBr: true, lied: opts.lied }], indexer, ctx);
  if (opts.passed !== false) bank.markFilterResult([hash], [hash], ctx);
  bank.flushNow();
}

beforeEach(() => {
  bank.resetForTests();
  const dir = FRESH_DIR();
  tempDirs.push(dir);
  bank.open(dir);
  cache.clear();
  metrics.reset();
  config.magnetBank.enabled = true;
  config.magnetBank.fallbackEnabled = true;
  config.magnetBank.fallbackMaxPerIndexer = 40;
  config.magnetBank.fallbackGlobalMax = 40;
  config.releaseIndex.enabled = true;
  config.releaseIndex.ttl = 86400;
  config.cacheTtl = savedConfig.cacheTtl;
  config.fallbackStreamsTtl = savedConfig.fallbackTtl;
});

after(() => {
  bank.resetForTests();
  config.magnetBank.fallbackGlobalMax = savedConfig.globalMax;
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('estado vivo: pendente conta como falho e resposta tardia remove', () => {
  const s = createLiveIndexerState();
  assert.equal(s.hasAnyFailure(), false);
  s.noteStart(['a', 'b']);
  assert.equal(s.hasAnyFailure(), true, 'pendente já justifica reserva (transitório)');
  assert.deepEqual([...s.failedIndexers()].sort(), ['a', 'b']);
  s.noteResult({ indexer: 'a', responded: true });
  assert.deepEqual([...s.failedIndexers()], ['b'], 'resposta válida remove o pendente');
  s.noteResult({ indexer: 'b', responded: false, reason: 'source' });
  assert.equal(s.failed.get('b'), 'source');
  s.noteResult({ indexer: 'b', responded: true });
  assert.equal(s.hasAnyFailure(), false, 'late live vence o fallback do mesmo indexer');
});

test('estado vivo: /all sintético — erro/pendente falha, válido não', () => {
  const s = createLiveIndexerState();
  s.noteAllStart();
  assert.equal(s.allFailed(), true, '/all pendente conta como falho');
  s.noteResult({ indexer: ALL_QUERY_INDEXER, responded: true });
  assert.equal(s.allFailed(), false);
  s.noteResult({ indexer: ALL_QUERY_INDEXER, responded: false, reason: 'error' });
  assert.equal(s.allFailed(), true, '/all em erro deriva candidatos do banco');
  assert.equal(s.hasAnyFailure(), true);
});

test('seleção: falha do indexer injeta só o acervo dele; vazio válido não', () => {
  const h = hex('a');
  seed(h, 'idx-fail', movieCtx('tt100'));
  const ok = collectFallbackItems({ type: 'movie', imdbId: 'tt100', season: null, episode: null, liveHashes: new Set(), failedIndexers: new Set(['idx-fail']), allFailed: false });
  assert.equal(ok.injected, 1);
  assert.equal(ok.items[0].fromFallback, true);
  assert.equal(ok.items[0].fallbackIndexer, 'idx-fail');
  assert.equal(ok.items[0].seeders, 5);
  seed(hex('b'), 'idx-ok', movieCtx('tt100'));
  const onlyFail = collectFallbackItems({ type: 'movie', imdbId: 'tt100', season: null, episode: null, liveHashes: new Set(), failedIndexers: new Set(['idx-fail']), allFailed: false });
  assert.equal(onlyFail.injected, 1, 'só o indexer FALHO');
  const none = collectFallbackItems({ type: 'movie', imdbId: 'tt100', season: null, episode: null, liveHashes: new Set(), failedIndexers: new Set(), allFailed: false });
  assert.equal(none.injected, 0, 'resposta válida => sem fallback');
});

test('seleção: hash vivo vence sempre, mesmo com seeders menores', () => {
  const h = hex('c');
  seed(h, 'idx-fail', movieCtx('tt101'), { seeders: 999 });
  const fb = collectFallbackItems({ type: 'movie', imdbId: 'tt101', season: null, episode: null, liveHashes: new Set([h]), failedIndexers: new Set(['idx-fail']), allFailed: false });
  assert.equal(fb.injected, 0, 'vivo vence independentemente de seeders');
  assert.equal(fb.cut['live-dedupe'], 1);
});

test('seleção: lied fora; passed_filter=0 é ELEGÍVEL (filtro atual decide)', () => {
  seed(hex('d'), 'idx-fail', movieCtx('tt102'), { lied: true });
  const past = hex('e');
  seed(past, 'idx-fail', movieCtx('tt102'), { passed: false, title: 'Filme Teste 2024 1080p' });
  const fb = collectFallbackItems({ type: 'movie', imdbId: 'tt102', season: null, episode: null, liveHashes: new Set(), failedIndexers: new Set(['idx-fail']), allFailed: false });
  assert.equal(fb.injected, 1, 'passed_filter é dado auxiliar, não autorização');
  assert.equal(fb.items[0].infoHash, past);
  assert.equal(fb.cut.lied, 1);
});

test('pack S01 capturado em E01 é recuperado em E05; série completa sempre', () => {
  const pack = hex('1');
  const full = hex('2');
  const items = [
    { title: 'Serie Teste 1ª Temporada Completa 1080p', infoHash: pack, magnet: magnet(pack), seeders: 3, isBr: true },
    { title: 'Serie Teste Todas as Temporadas 1080p', infoHash: full, magnet: magnet(full), seeders: 2, isBr: true },
  ];
  const ctx = { imdbId: 'tt700', season: 1, episode: 1, resetPassedFilter: true };
  bank.captureItems(items, 'idx-br', ctx);
  prepareCandidateStreams(items as any, { meta: { name: 'Serie Teste' }, imdbId: 'tt700', season: 1, episode: 1 } as any);
  bank.flushNow();
  const tuple = (w: any) => `${w.season}:${w.episode}`;
  assert.ok(bank.worksFor(pack).map(tuple).includes('1:-1'), 'pack gravou a temporada (1,-1)');
  assert.ok(bank.worksFor(pack).map(tuple).includes('1:1'), 'obra do pedido preservada');
  assert.ok(bank.worksFor(full).map(tuple).includes('-1:-1'), 'série completa gravou (-1,-1)');
  const fb = collectFallbackItems({ type: 'series', imdbId: 'tt700', season: 1, episode: 5, liveHashes: new Set(), failedIndexers: new Set(['idx-br']), allFailed: false });
  assert.deepEqual(fb.items.map((i) => i.infoHash).sort(), [pack, full].sort());
});

test('targets: mesmo hash com títulos distintos UNE as obras no filtro', () => {
  const h = hex('3');
  const items = [
    { title: 'Serie Teste 1ª Temporada Completa 1080p', infoHash: h, magnet: magnet(h), seeders: 5, isBr: true },
    { title: 'Serie Teste S01E03 1080p', infoHash: h, magnet: magnet(h), seeders: 5, isBr: true },
  ];
  const ctx = { imdbId: 'tt701', season: 1, episode: 3, resetPassedFilter: true };
  bank.captureItems(items, 'idx-x', ctx);
  prepareCandidateStreams(items as any, { meta: { name: 'Serie Teste' }, imdbId: 'tt701', season: 1, episode: 3 } as any);
  bank.flushNow();
  const rows = bank.worksFor(h);
  const packWork = rows.find((w) => w.season === 1 && w.episode === -1);
  assert.ok(packWork, 'obra de pack existe');
  assert.equal(packWork?.passedFilter, 1, 'filtro marca a obra unida do pack (não só a última)');
});

test('captura: release de OUTRA temporada vai para a obra dela, não para a do pedido', () => {
  // Indexer BR busca só o nome da série e devolve todas as temporadas. True
  // Detective S01E01 (2026-09-24): 217 de 419 works eram de outra temporada.
  const s04 = hex('4');
  const s01 = hex('5');
  const dnS04 = `${magnet(s04)}&dn=${encodeURIComponent('Serie.Teste.S04E05.1080p.WEB-DL.DUAL')}`;
  const items = [
    { title: 'Serie Teste - 4ª Temporada [1080p WEB-DL DUAL]', infoHash: s04, magnet: dnS04, seeders: 1, isBr: true },
    { title: 'Serie Teste S01E01 1080p Dual', infoHash: s01, magnet: magnet(s01), seeders: 1, isBr: true },
  ];
  const ctx = { imdbId: 'tt702', season: 1, episode: 1, resetPassedFilter: true };
  bank.captureItems(items, 'idx-br', ctx);
  prepareCandidateStreams(items as any, { meta: { name: 'Serie Teste' }, imdbId: 'tt702', season: 1, episode: 1 } as any);
  bank.flushNow();
  const tuple = (w: any) => `${w.season}:${w.episode}`;
  assert.deepEqual(bank.worksFor(s04).map(tuple), ['4:5'], 'S04E05 fica recuperável no próprio episódio');
  assert.deepEqual(bank.worksFor(s01).map(tuple), ['1:1']);
});

test('seleção: linha legada de outra temporada é cortada antes dos tetos', () => {
  // Linha gravada pela regra antiga: work 1:1 com magnet cujo dn é S04E05.
  const legacy = hex('6');
  const good = hex('7');
  seed(legacy, 'idx-fail', { imdbId: 'tt703', season: 1, episode: 1 }, { title: 'Serie Teste 1080p', seeders: 50 });
  const withDn = `${magnet(legacy)}&dn=${encodeURIComponent('Serie.Teste.S04E05.1080p')}`;
  bank.captureItems([{ title: 'Serie Teste 1080p', infoHash: legacy, magnet: withDn, seeders: 50, isBr: true }], 'idx-fail', { imdbId: 'tt703', season: 4, episode: 5 });
  bank.flushNow();
  seed(good, 'idx-fail', { imdbId: 'tt703', season: 1, episode: 1 }, { title: 'Serie Teste S01E01 1080p', seeders: 1 });
  config.magnetBank.fallbackMaxPerIndexer = 1;
  const fb = collectFallbackItems({ type: 'series', imdbId: 'tt703', season: 1, episode: 1, liveHashes: new Set(), failedIndexers: new Set(['idx-fail']), allFailed: false });
  assert.deepEqual(fb.items.map((i) => i.infoHash), [good], 'a vaga única fica com o episódio pedido');
  assert.equal(fb.cut['episode-mismatch'], 1);
});

test('build: episódio errado do fallback é cortado como qualquer item', () => {
  seed(hex('f'), 'idx-fail', movieCtx('tt103'), { title: 'Serie Teste S01E02 1080p' });
  const item = { title: 'Serie Teste S01E02 1080p', infoHash: hex('f'), magnet: magnet(hex('f')), seeders: 5, fromFallback: true, fallbackIndexer: 'idx-fail' };
  const out = prepareCandidateStreams([item] as any, { meta: { name: 'Serie Teste' }, imdbId: 'tt103', season: 1, episode: 5 } as any);
  assert.equal(out.streams.length, 0, 'episódio errado não passa o filtro de episódio');
});

test('seeders 0 continua sujeito ao MIN_SEEDERS (sem bypass)', () => {
  const h = hex('9');
  seed(h, 'idx-fail', movieCtx('tt801'), { seeders: 0, title: 'Filme Teste 2024 1080p' });
  const fb = collectFallbackItems({ type: 'movie', imdbId: 'tt801', season: null, episode: null, liveHashes: new Set(), failedIndexers: new Set(['idx-fail']), allFailed: false });
  assert.equal(fb.injected, 1, 'a reserva é montada com o número real');
  const out = prepareCandidateStreams([fb.items[0]] as any, { meta: { name: 'Filme Teste', year: 2024 }, imdbId: 'tt801' } as any);
  assert.equal(out.streams.length, 0, 'MIN_SEEDERS corta como qualquer item (sem bypass)');
});

test('caps: teto por indexer, teto global e default 40', () => {
  assert.equal(config.magnetBank.fallbackGlobalMax, 40, 'default conservador');
  config.magnetBank.fallbackMaxPerIndexer = 2;
  config.magnetBank.fallbackGlobalMax = 3;
  const a = [hex('1'), hex('2'), hex('3'), hex('4')];
  a.forEach((h, i) => seed(h, 'idx-a', movieCtx('tt104'), { seeders: 100 - i }));
  const fbA = collectFallbackItems({ type: 'movie', imdbId: 'tt104', season: null, episode: null, liveHashes: new Set(), failedIndexers: new Set(['idx-a']), allFailed: false });
  assert.equal(fbA.injected, 2, 'cap por indexer');
  const b = [hex('5'), hex('6'), hex('7')];
  b.forEach((h, i) => seed(h, 'idx-b', movieCtx('tt104'), { seeders: 50 - i }));
  const fbBoth = collectFallbackItems({ type: 'movie', imdbId: 'tt104', season: null, episode: null, liveHashes: new Set(), failedIndexers: new Set(['idx-a', 'idx-b']), allFailed: false });
  assert.equal(fbBoth.injected, 3, 'teto global somando indexers');
});

test('trace: amostra de cortes limitada a 20, stage e drop vivo preservados', () => {
  config.magnetBank.fallbackGlobalMax = 3;
  for (let i = 0; i < 30; i += 1) seed(hnum(i + 1), 'idx-fail', movieCtx('tt802'), { title: `Filme Teste 2024 1080p c${i}` });
  const liveHash = hnum(999);
  seed(liveHash, 'idx-fail', movieCtx('tt802'), { title: 'Filme Teste 2024 1080p VIVO' });
  const t = trace();
  const fb = collectFallbackItems({ type: 'movie', imdbId: 'tt802', season: null, episode: null, liveHashes: new Set([liveHash]), failedIndexers: new Set(['idx-fail']), allFailed: false, trace: t as any });
  assert.equal(fb.injected, 3);
  assert.equal(t.stages.fallback, 3, 'stage exato mesmo com amostra');
  assert.ok(t.items.length <= 20, `amostra limitada (${t.items.length})`);
  assert.ok(t.items.some((i: any) => /VIVO/.test(i.label)), 'drop vivo (live-dedupe) preservado');
});

test('allFailed (ramo /all em erro) deriva candidatos das sources do banco', () => {
  seed(hex('8'), 'all-tracker', movieCtx('tt105'));
  const fb = collectFallbackItems({ type: 'movie', imdbId: 'tt105', season: null, episode: null, liveHashes: new Set(), failedIndexers: new Set(), allFailed: true });
  assert.equal(fb.injected, 1, 'sem lista configurada, qualquer source do banco serve');
});

test('zero auto-perpetuação: banco e índice ignoram fromFallback', () => {
  const h = hex('a');
  bank.captureItems([{ title: 'Filme Teste 2024 1080p', infoHash: h, magnet: magnet(h), seeders: 5, fromFallback: true, fallbackIndexer: 'idx' }], 'idx', movieCtx('tt106'));
  bank.flushNow();
  assert.equal(bank.lookup(h), null, 'fallback não entra no banco');
  const item = { title: 'Filme Teste 2024 1080p', infoHash: h, magnet: magnet(h), seeders: 5, isBr: true, fromFallback: true, fallbackIndexer: 'idx' };
  prepareCandidateStreams([item] as any, { meta: { name: 'Filme Teste', year: 2024 }, imdbId: 'tt106' } as any);
  assert.equal(releaseIndex.lookup('tt106', { season: null, episode: null }).length, 0, 'fallback não alimenta o release-index');
});

test('selo honesto: 📦 e ~N no nome, _fromFallback removido no protocolo', () => {
  const h = hex('a');
  const stream = toStremioStream({ title: 'Filme Teste 2024 1080p Dublado', infoHash: h, magnet: magnet(h), seeders: 5, isBr: true, fromFallback: true, fallbackIndexer: 'idx' }) as any;
  assert.match(stream.name, /📦/);
  assert.match(stream.name, /👤 ~5/);
  assert.equal(stream._fromFallback, true);
  assert.equal(stream._seeders, 5, 'número real preservado para ranking/filtros');
  const zero = toStremioStream({ title: 'Filme Teste 2024 1080p', infoHash: hex('b'), magnet: magnet(hex('b')), seeders: 0, fromFallback: true }) as any;
  assert.match(zero.name, /👤 ~/);
  assert.doesNotMatch(zero.name, /~0/);
  const delivered = applyNoticeOrigin([stream]);
  assert.equal('_fromFallback' in delivered[0], false, 'marca interna não vai ao protocolo');
});

test('fallback passa o debrid como P2P, mas não vira candidato do Chupim', async () => {
  const h = hex('c');
  const adapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalCheck = debrid.checkCached;
  const originalEnqueue = adapter.enqueue;
  const enqueued: string[] = [];
  const searchKey = 'busca-fb-chupim';
  const account = accountScope('chave-fb');
  const stream = { infoHash: h, name: 'Filme Teste 1080p', _br: true, _dubbed: true, _quality: '1080p', _seeders: 5, _fromFallback: true } as unknown as Stream;
  try {
    adapter.enqueue = async (_apiKey, infoHash) => { enqueued.push(infoHash); return true; };
    debrid.checkCached = async () => ({ cached: new Set(), known: true });
    const userOpts = { ...runtime.defaults(), debridService: 'premiumize', debridApiKey: 'chave-fb', debridCachedOnly: false, autoFetchBr: true };
    const out = await runtime.run({ opts: userOpts, encoded: 'cfg-fb' }, () => applyDebrid([stream], { searchKey } as any)) as Stream[];
    await sleep(20);
    assert.equal(out.length, 1, 'fallback não é descartado pelo debrid');
    assert.deepEqual(enqueued, [], 'fallback nunca vira candidato do autofetch');
    assert.equal(held.isHeld(h, account), false);
  } finally {
    debrid.checkCached = originalCheck;
    adapter.enqueue = originalEnqueue;
    autofetch.releaseSearch(searchKey);
  }
});
