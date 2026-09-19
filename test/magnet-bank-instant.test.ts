// Resposta instantânea pelo banco de magnets vivo — janela adaptativa e seleção.
//
// Cobre: a matemática da janela (estável → 7d; novidade recente → 1h; lançamento
// recente → teto 2h; sem coleta viva → inelegível); as travas de cobertura
// (episódio exige release nomeada; `preferDubbed` sem dublado não responde);
// exclusão de hash do índice; fail-open; o selo 📦/~N e a remoção de
// `_fromFallback` no protocolo; e a troca do 📦 pelo vivo no tail.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import config from '../src/config.js';
import * as bank from '../src/utils/magnet-bank.js';
import * as metrics from '../src/utils/metrics.js';
import * as harvestQueue from '../src/providers/harvest-queue.js';
import * as releaseIndex from '../src/utils/release-index.js';
import debrid from '../src/debrid/index.js';
import { patch } from './helpers/stub.js';
import { collectInstantItems, instantWindow, isRecentRelease, dropInstantFallbacks } from '../src/providers/magnet-bank-instant.js';
import { attemptIndexFastPath } from '../src/providers/search-index-path.js';
import { prepareCandidateStreams } from '../src/providers/stream-builder-pipeline.js';
import { toStremioStream } from '../src/utils/search-names.js';
import { applyNoticeOrigin } from '../src/providers/stream-builder.js';
import type { WorkRow } from '../src/utils/magnet-bank.js';

const DAY = 86400000;
const FRESH_DIR = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mb-inst-'));
const hex = (c: string) => c.repeat(40);
const magnet = (h: string) => `magnet:?xt=urn:btih:${h}`;
const movieCtx = (imdb: string) => ({ imdbId: imdb, season: null, episode: null });
const NAME = 'Test Title';

const tempDirs: string[] = [];
const saved = {
  releaseIndex: config.releaseIndex.enabled,
  instantEnabled: config.magnetBank.instantEnabled,
  fallbackMaxPerIndexer: config.magnetBank.fallbackMaxPerIndexer,
  fallbackGlobalMax: config.magnetBank.fallbackGlobalMax,
  ptSweepGlobal: config.jackett.ptSweepGlobal,
};

/** Captura a release e marca passed_filter=1 na obra (busca viva). */
function seed(hash: string, indexer: string, ctx: any, opts: { title?: string; seeders?: number; isBr?: boolean } = {}) {
  const title = opts.title ?? 'Filme Teste 2024 1080p Dublado';
  bank.captureItems([{ title, infoHash: hash, magnet: magnet(hash), seeders: opts.seeders ?? 5, isBr: opts.isBr ?? true }], indexer, ctx);
  bank.markFilterResult([hash], [hash], ctx);
  bank.flushNow();
}

const work = (over: Partial<WorkRow>): WorkRow => ({
  hash: hex('a'), imdb: 'tt1', season: -1, episode: -1,
  firstSeen: 0, lastSeen: 0, passedFilter: 0, ...over,
});

beforeEach(() => {
  bank.resetForTests();
  const dir = FRESH_DIR();
  tempDirs.push(dir);
  bank.open(dir);
  harvestQueue.clearQueue();
  metrics.reset();
  config.magnetBank.enabled = true;
  config.magnetBank.instantEnabled = true;
  config.magnetBank.fallbackMaxPerIndexer = 40;
  config.magnetBank.fallbackGlobalMax = 40;
  config.releaseIndex.enabled = true;
  config.jackett.ptSweepGlobal = false;
});

after(() => {
  bank.resetForTests();
  harvestQueue.clearQueue();
  config.releaseIndex.enabled = saved.releaseIndex;
  config.magnetBank.instantEnabled = saved.instantEnabled;
  config.magnetBank.fallbackMaxPerIndexer = saved.fallbackMaxPerIndexer;
  config.magnetBank.fallbackGlobalMax = saved.fallbackGlobalMax;
  config.jackett.ptSweepGlobal = saved.ptSweepGlobal;
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('janela: estável confia até o teto de 7d; novidade recente cai no piso de 1h', () => {
  const now = 1_700_000_000_000;
  const stable = instantWindow([
    work({ firstSeen: now - 60 * DAY, lastSeen: now - 1 * DAY, passedFilter: 1 }),
  ], null, now);
  assert.equal(stable.stability, 59 * DAY);
  assert.equal(stable.windowMs, config.magnetBank.instantMaxMs);

  const hot = instantWindow([
    work({ firstSeen: now - 10 * 60 * 1000, lastSeen: now, passedFilter: 1 }),
  ], null, now);
  assert.equal(hot.windowMs, config.magnetBank.instantMinMs, 'metade da estabilidade respeita o piso');
});

test('janela: sem coleta viva é inelegível; lançamento recente sofre teto de 2h', () => {
  const now = 1_700_000_000_000;
  const never = instantWindow([work({ firstSeen: now, lastSeen: now, passedFilter: 0 })], null, now);
  assert.equal(never.lastCollection, 0);

  const stableWorks = [work({ firstSeen: now - 60 * DAY, lastSeen: now - 1 * DAY, passedFilter: 1 })];
  const fresh = instantWindow(stableWorks, { released: new Date(now - 5 * DAY).toISOString() }, now);
  assert.equal(fresh.fresh, true);
  assert.equal(fresh.windowMs, config.magnetBank.instantFreshMaxMs);
  const noDate = instantWindow(stableWorks, { year: new Date(now).getUTCFullYear() }, now);
  assert.equal(noDate.fresh, true, 'ano de catálogo corrente é o sinal grosseiro quando falta a data');
  assert.equal(noDate.windowMs, config.magnetBank.instantFreshMaxMs);
  assert.equal(isRecentRelease({ year: 1984 }, now), false);
});

test('seleção: filme coberto devolve item do banco com selo 📦/~N e sem vazar a marca', () => {
  const h = hex('a');
  seed(h, 'idx-br', movieCtx('tt200'), { seeders: 7 });
  const res = collectInstantItems({ type: 'movie', imdbId: 'tt200', season: null, episode: null, preferDubbed: false });
  assert.equal(res.eligible, true);
  assert.equal(res.items.length, 1);
  const item: any = res.items[0];
  assert.equal(item.infoHash, h);
  assert.equal(item.fromFallback, true, 'selo/exclusões dependem de fromFallback');
  assert.equal(item.seeders, 7, 'número real preservado (o ~ é só exibição)');

  const stream: any = toStremioStream(item);
  assert.match(stream.name, /📦/);
  assert.match(stream.name, /👤 ~7/);
  assert.equal(stream._fromFallback, true);
  const delivered = applyNoticeOrigin([stream]);
  assert.equal('_fromFallback' in delivered[0], false, 'marca interna não vai ao protocolo');
});

test('seleção: hash já no índice é excluído do 📦', () => {
  const h = hex('b');
  seed(h, 'idx-br', movieCtx('tt201'));
  const res = collectInstantItems({
    type: 'movie', imdbId: 'tt201', season: null, episode: null, preferDubbed: false,
    indexReleases: [{ hash: h, title: 'Filme Teste 2024 1080p Dublado', isBr: true, dubbed: true, seeders: 5 }],
  });
  assert.equal(res.eligible, false);
  assert.equal(res.reason, 'no-live-collection');
  assert.equal(res.items.length, 0);
});

test('passed_filter=1 é elegibilidade: release não confirmada não vira 📦', () => {
  const imdb = 'tt209';
  const unverified = hex('f');
  // Captura SEM marcar o filtro: obra existe, mas passed_filter=0.
  bank.captureItems([{ title: 'Filme Teste 2024 1080p Dublado', infoHash: unverified, magnet: magnet(unverified), seeders: 5, isBr: true }], 'idx-br', movieCtx(imdb));
  bank.flushNow();
  const only = collectInstantItems({ type: 'movie', imdbId: imdb, season: null, episode: null, preferDubbed: false });
  assert.equal(only.eligible, false, 'sem passed_filter=1 não há foto confiável');
  assert.equal(only.reason, 'no-live-collection');
  assert.equal(only.items.length, 0);

  const verified = hex('e');
  seed(verified, 'idx-br', movieCtx(imdb));
  const mixed = collectInstantItems({ type: 'movie', imdbId: imdb, season: null, episode: null, preferDubbed: false });
  assert.equal(mixed.eligible, true);
  assert.deepEqual(mixed.items.map((i) => i.infoHash), [verified], 'só o passed_filter=1 entra na reserva');
});

test('cobertura: episódio exige release que NOMEIE o episódio (pack sozinho não cobre)', () => {
  const imdb = 'tt202';
  const pack = hex('1');
  const items = [{ title: 'Serie Teste 1ª Temporada Completa 1080p Dublado', infoHash: pack, magnet: magnet(pack), seeders: 5, isBr: true }];
  const ctx = { imdbId: imdb, season: 1, episode: 1, resetPassedFilter: true };
  bank.captureItems(items, 'idx-br', ctx);
  prepareCandidateStreams(items as any, { meta: { name: 'Serie Teste' }, imdbId: imdb, season: 1, episode: 1 } as any);
  bank.flushNow();
  const res = collectInstantItems({ type: 'series', imdbId: imdb, season: 1, episode: 5, preferDubbed: false });
  assert.equal(res.eligible, false);
  assert.equal(res.reason, 'not-covered');

  const ep = hex('2');
  const epItem = { title: 'Serie Teste S01E05 1080p Dublado', infoHash: ep, magnet: magnet(ep), seeders: 5, isBr: true };
  const epCtx = { imdbId: imdb, season: 1, episode: 5, resetPassedFilter: true };
  bank.captureItems([epItem], 'idx-br', epCtx);
  prepareCandidateStreams([epItem] as any, { meta: { name: 'Serie Teste' }, imdbId: imdb, season: 1, episode: 5 } as any);
  bank.flushNow();
  const ok = collectInstantItems({ type: 'series', imdbId: imdb, season: 1, episode: 5, preferDubbed: false });
  assert.equal(ok.eligible, true);
  assert.ok(ok.items.some((i) => i.infoHash === ep));
});

test('preferDubbed sem pool dublado responde do acervo e só conta a métrica', () => {
  const imdb = 'tt203';
  const h = hex('c');
  // Fonte global sem marca de dublado: cobre o pool geral (swarm), não o dublado.
  // (BR sem marca conta como dublado pelo heurístico dos sites BR — por isso o
  // caso de recusa usa release global.)
  seed(h, 'idx-global', movieCtx(imdb), { title: 'Filme Teste 2024 1080p', isBr: false, seeders: 9 });
  const off = collectInstantItems({ type: 'movie', imdbId: imdb, season: null, episode: null, preferDubbed: false });
  assert.equal(off.eligible, true);
  // A coleta viva recente já procurou e não achou dublado: esperar o BR ao vivo
  // de novo custava ~5-7s por abertura (Angel Heart, 2026-09-18). O tail busca.
  const before = metrics.snapshot().counters['search.bank.instant.noDubbed'] ?? 0;
  const on = collectInstantItems({ type: 'movie', imdbId: imdb, season: null, episode: null, preferDubbed: true });
  assert.equal(on.eligible, true);
  assert.equal(metrics.snapshot().counters['search.bank.instant.noDubbed'], before + 1);
});

test('janela: obra sem coleta viva é inelegível; coleta antiga fica stale', () => {
  const imdb = 'tt204';
  seed(hex('d'), 'idx-br', movieCtx(imdb));
  const stale = collectInstantItems({
    type: 'movie', imdbId: imdb, season: null, episode: null, preferDubbed: false,
    now: Date.now() + 8 * 86400000, // além do piso default (7d)
  });
  assert.equal(stale.eligible, false);
  assert.equal(stale.reason, 'stale');

  const never = collectInstantItems({ type: 'movie', imdbId: 'tt205', season: null, episode: null, preferDubbed: false });
  assert.equal(never.eligible, false);
  assert.equal(never.reason, 'no-live-collection');
});

test('fail-open: banco desligado e erro do banco devolvem inelegível, nunca lançam', () => {
  config.magnetBank.enabled = false;
  const disabled = collectInstantItems({ type: 'movie', imdbId: 'tt206', season: null, episode: null, preferDubbed: false });
  assert.equal(disabled.eligible, false);
  assert.equal(disabled.reason, 'disabled');

  config.magnetBank.enabled = true;
  const original = config.magnetBank;
  Object.defineProperty(config, 'magnetBank', { configurable: true, get() { throw new Error('boom'); } });
  try {
    const errored = collectInstantItems({ type: 'movie', imdbId: 'tt207', season: null, episode: null, preferDubbed: false });
    assert.equal(errored.eligible, false);
    assert.equal(errored.reason, 'error');
    assert.equal(errored.items.length, 0);
  } finally {
    Object.defineProperty(config, 'magnetBank', { configurable: true, writable: true, enumerable: true, value: original });
  }
});

test('tail: a ponte 📦 inteira sai antes do rebuild; item vivo é preservado', () => {
  const items: any[] = [
    { title: 'Banco A', infoHash: hex('a'), fromFallback: true },
    { title: 'Banco B', infoHash: hex('b'), fromFallback: true },
    { title: 'Vivo C', infoHash: hex('c') },
  ];
  assert.equal(dropInstantFallbacks(items), 2);
  assert.deepEqual(items.map((i) => i.infoHash), [hex('c')]);
});

test('fast path: banco elegível devolve instant=true e não espera a coleta prioritária', async () => {
  const imdb = 'tt208';
  const h = hex('e');
  seed(h, 'idx-br', movieCtx(imdb));
  const matchContext = { names: ['Filme Teste'], year: 2024, isSeries: false, season: null, episode: null };
  // Sem rede: o inventário da conta é a única chamada de rede no caminho.
  const restoreInventory = patch(debrid as any, 'inventory', async () => []);
  try {
    const out = await attemptIndexFastPath({
      query: 'Filme Teste 2024', type: 'movie', id: imdb, imdbId: imdb, season: null, episode: null,
      ptQuery: null, matchContext, sweepQuery: null, deadlineAt: Date.now() + 8000, isDemo: false,
    } as any);
    assert.equal(out.instant, true);
    assert.equal(out.servedFromIndex, true);
    assert.equal(out.raw?.instant, true);
    assert.equal(out.raw?.partial, true, 'resposta instantânea é parcial até o tail promover');
    assert.ok(out.raw?.items.some((i: any) => i.infoHash === h && i.fromFallback), 'item do banco presente na resposta');
  } finally {
    restoreInventory();
  }
});

test('fresh release: data real encurta a janela mesmo fora do ano corrente', () => {
  const now = Date.parse('2026-01-10T00:00:00Z');
  assert.equal(isRecentRelease({ released: '2025-12-20T00:00:00.000Z' }, now), true);
  assert.equal(isRecentRelease({ firstAired: '2026-01-05T00:00:00.000Z' }, now), true);
  assert.equal(isRecentRelease({ released: '2019-01-01T00:00:00.000Z', year: 2019 }, now), false);
  const win = instantWindow(
    [work({ firstSeen: now - 60 * DAY, lastSeen: now - 1 * DAY, passedFilter: 1 })],
    { released: '2025-12-20T00:00:00.000Z' }, now,
  );
  assert.equal(win.fresh, true);
  assert.equal(win.windowMs, config.magnetBank.instantFreshMaxMs);
});

test('teto: com preferDubbed o dublado do acervo ocupa a vaga antes do global mais semeado', () => {
  const imdb = 'tt210';
  config.magnetBank.fallbackGlobalMax = 1;
  config.magnetBank.fallbackMaxPerIndexer = 1;
  // Ordenar só por seeders dava o único slot ao global e cortava o dublado.
  seed(hex('a'), 'idx-global', movieCtx(imdb), { title: `${NAME} 2024 1080p`, isBr: false, seeders: 9 });
  seed(hex('b'), 'idx-br', movieCtx(imdb), { title: `${NAME} 2024 1080p Dublado`, isBr: true, seeders: 4 });
  const dubbed = collectInstantItems({ type: 'movie', imdbId: imdb, season: null, episode: null, preferDubbed: true });
  assert.equal(dubbed.eligible, true);
  assert.deepEqual(dubbed.items.map((i) => i.infoHash), [hex('b')], 'o dublado leva a vaga');
  const any = collectInstantItems({ type: 'movie', imdbId: imdb, season: null, episode: null, preferDubbed: false });
  assert.equal(any.eligible, true);
  assert.deepEqual(any.items.map((i) => i.infoHash), [hex('a')], 'sem preferência, seeders decidem');
});

test('banco fechado: leitura instantânea NÃO abre data/magnets.db', () => {
  bank.resetForTests();
  assert.equal(bank.isOpen(), false);
  const res = collectInstantItems({ type: 'movie', imdbId: 'tt211', season: null, episode: null, preferDubbed: false });
  assert.equal(res.eligible, false);
  assert.equal(res.reason, 'no-live-collection');
  assert.equal(bank.isOpen(), false, 'a leitura quiet não pode criar o engine/arquivo');
});

test('follow-up: banco serve sem idx coberto enfileira miss e não polui search.idx', async () => {
  const imdb = 'tt212';
  config.releaseIndex.enabled = true;
  seed(hex('a'), 'idx-br', movieCtx(imdb), { title: `${NAME} 2024 1080p Dublado` });
  const matchContext = { names: [NAME], year: 2024, isSeries: false, season: null, episode: null };
  const restoreInventory = patch(debrid as any, 'inventory', async () => []);
  try {
    const out = await attemptIndexFastPath({
      query: `${NAME} 2024`, type: 'movie', id: imdb, imdbId: imdb, season: null, episode: null,
      ptQuery: null, matchContext, sweepQuery: null, deadlineAt: Date.now() + 8000, isDemo: false,
    } as any);
    assert.equal(out.instant, true);
    // Sem release no índice, o colhedor tem que continuar alimentando a obra.
    const queued = harvestQueue.findQueued({ imdbId: imdb, season: null, episode: null });
    assert.equal(queued?.reason, 'miss', 'banco servindo não cancela a colheita do índice');
    const counters = metrics.snapshot().counters;
    assert.equal(counters['search.idx.miss'] ?? 0, 0, 'funil search.idx não conta no caminho do banco');
    assert.equal(counters['search.idx.served'] ?? 0, 0);
    assert.ok((counters['search.bank.instant'] ?? 0) > 0, 'métrica própria do banco registra a via');
  } finally {
    restoreInventory();
  }
});

test('packOnly: cobertura do banco não conta no funil search.idx', () => {
  const imdb = 'tt213';
  const pack = hex('3');
  // Banco com SÓ um pack (não nomeia o E05): a cobertura recusa, mas o motivo
  // não pode virar `search.idx.packOnly` — o funil é do ÍNDICE, não do acervo.
  const ctx = { imdbId: imdb, season: 1, episode: null };
  bank.captureItems([
    { title: 'Serie Teste 1ª Temporada Completa 1080p Dublado', infoHash: pack, magnet: magnet(pack), seeders: 5, isBr: true },
  ], 'idx-br', ctx);
  bank.markFilterResult([pack], [pack], ctx);
  bank.flushNow();
  const res = collectInstantItems({ type: 'series', imdbId: imdb, season: 1, episode: 5, preferDubbed: false });
  assert.equal(res.eligible, false);
  assert.equal(res.reason, 'not-covered');
  assert.equal(metrics.snapshot().counters['search.idx.packOnly'] ?? 0, 0, 'packOnly não incrementa no caminho do banco');
});

test('packOnly: fast-path do banco com idx só de pack também fica limpo', async () => {
  const imdb = 'tt214';
  const bankHash = hex('5');
  // Banco cobre o EPISÓDIO; o índice só tem o pack. A checagem de cobertura do
  // idx (que roda no caminho do banco) não pode marcar `packOnly`.
  const epCtx = { imdbId: imdb, season: 1, episode: 5 };
  bank.captureItems([
    { title: 'Serie Teste S01E05 1080p Dublado', infoHash: bankHash, magnet: magnet(bankHash), seeders: 5, isBr: true },
  ], 'idx-br', epCtx);
  bank.markFilterResult([bankHash], [bankHash], epCtx);
  bank.flushNow();
  const packRelease = { hash: hex('9'), title: 'Serie Teste 1ª Temporada Completa 1080p Dublado', source: 'jackett', isBr: true, dubbed: true, seeders: 5 };
  // O índice REAL recebe o pack pela chave da TEMPORADA; o lookup do episódio o
  // enxerga (é o caso que `idxPoolCovered` reprova como pack-only).
  releaseIndex.record(imdb, { season: 1, episode: 5 }, [packRelease]);
  const restoreInventory = patch(debrid as any, 'inventory', async () => []);
  try {
    const out = await attemptIndexFastPath({
      query: 'Serie Teste S01E05', type: 'series', id: `${imdb}:1:5`, imdbId: imdb, season: 1, episode: 5,
      ptQuery: null, matchContext: { names: ['Serie Teste'], year: 2024, isSeries: true, season: 1, episode: 5 },
      sweepQuery: null, deadlineAt: Date.now() + 8000, isDemo: false,
    } as any);
    assert.equal(out.instant, true);
    assert.equal(metrics.snapshot().counters['search.idx.packOnly'] ?? 0, 0, 'packOnly não incrementa no fast-path');
  } finally {
    restoreInventory();
  }
});
