// Estado da raspagem dos sites BR (Fase 0 — base sem rede): fila em SQLite
// próprio com fallback em memória. Cobre o upsert idempotente (nova / lastmod
// novo / igual), o próximo pendente com claim determinístico e vencimento, a
// marcação de resultado (terminais, erro com backoff e esgotamento), a
// retomada (requeue de inflight e de erros), contadores por status, rodadas
// do motor e a PARIDADE da engine de memória (mesmos verbos, mesmos
// resultados) e a persistência entre aberturas (retomada de verdade).
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import * as store from '../src/utils/crawl-store.js';
import { errorBackoffMs, CRAWL_GIVE_UP_MS } from '../src/utils/crawl-store-rules.js';
import type { CrawlUrlRow } from '../src/providers/crawl-types.js';

const tempDirs: string[] = [];
const freshDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'crawl-'));
  tempDirs.push(d);
  return d;
};
const movie = (url: string, lastmod = '2026-09-25') => ({ url, lastmod, kind: 'movie' as const });

beforeEach(() => {
  store.resetForTests();
  store.open(path.join(freshDir(), 'crawl.db'));
});

after(() => {
  store.resetForTests();
  for (const d of tempDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('upsert idempotente: nova URL nasce pending; repetida igual não mexe', () => {
  assert.equal(store.engine().kind, 'sql');
  assert.deepEqual(store.engine().upsertUrls('vacatorrent', [movie('/a'), movie('/b')], 1000), { added: 2, refreshed: 0, unchanged: 0 });
  assert.deepEqual(store.engine().upsertUrls('vacatorrent', [movie('/a'), movie('/b')], 2000), { added: 0, refreshed: 0, unchanged: 2 });
  store.engine().markResult('vacatorrent', '/a', { status: 'done', imdb: 'tt100', releases: 3 }, 3000);
  assert.deepEqual(store.engine().upsertUrls('vacatorrent', [movie('/a')], 4000), { added: 0, refreshed: 0, unchanged: 1 });
  assert.equal(store.engine().getUrl('vacatorrent', '/a')?.status, 'done', 'lastmod igual não reprocessa done');
});

test('lastmod novo reprocessa URL (zera tries/imdb/releases; preserva addedAt)', () => {
  store.engine().upsertUrls('vacatorrent', [movie('/a')], 1000);
  const addedAt = store.engine().getUrl('vacatorrent', '/a')?.addedAt;
  store.engine().markResult('vacatorrent', '/a', { status: 'done', imdb: 'tt100', releases: 2 }, 2000);
  assert.deepEqual(store.engine().upsertUrls('vacatorrent', [{ url: '/a', lastmod: '2026-09-26', kind: 'movie' }], 3000), { added: 0, refreshed: 1, unchanged: 0 });
  const row = store.engine().getUrl('vacatorrent', '/a') as CrawlUrlRow;
  assert.equal(row.status, 'pending');
  assert.equal(row.tries, 0);
  assert.equal(row.imdb, null, 'conteúdo mudou: obra antiga não sobrevive');
  assert.equal(row.releases, 0);
  assert.equal(row.lastmod, '2026-09-26');
  assert.equal(row.addedAt, addedAt);
});

test('takeNext: ordem determinística, claim vira inflight e some da fila', () => {
  store.engine().upsertUrls('vacatorrent', [movie('/c'), movie('/a'), movie('/b')], 1000);
  const first = store.engine().takeNext('vacatorrent', 2000) as CrawlUrlRow;
  assert.equal(first.url, '/a');
  assert.equal(first.status, 'inflight');
  assert.equal(store.engine().getUrl('vacatorrent', '/a')?.status, 'inflight');
  assert.equal(store.engine().takeNext('vacatorrent', 2000)?.url, '/b');
  assert.equal(store.engine().takeNext('vacatorrent', 2000)?.url, '/c');
  assert.equal(store.engine().takeNext('vacatorrent', 2000), null, 'sem pendente não inventa trabalho');
});

test('takeNext só serve o que está vencido; erro em backoff espera', () => {
  store.engine().upsertUrls('vacatorrent', [movie('/a'), movie('/b')], 1000);
  store.engine().markResult('vacatorrent', '/a', { status: 'error', error: 'timeout' }, 2000, { retryBaseMs: 60000 });
  const row = store.engine().getUrl('vacatorrent', '/a') as CrawlUrlRow;
  assert.equal(row.status, 'error');
  assert.equal(row.tries, 1);
  assert.ok(row.nextAt > 2000, 'backoff empurra a próxima tentativa');
  assert.equal(store.engine().takeNext('vacatorrent', row.nextAt - 1)?.url, '/b', 'em backoff não é servida');
  assert.equal(store.engine().takeNext('vacatorrent', row.nextAt)?.url, '/a', 'vencido o backoff, volta');
});

test('erro: tries crescem, backoff é exponencial com teto e maxTries põe pra dormir', () => {
  assert.ok(errorBackoffMs(60000, 2) > errorBackoffMs(60000, 1), 'exponencial');
  assert.ok(errorBackoffMs(60000, 40) <= 6 * 3600_000, 'backoff tem teto');
  store.engine().upsertUrls('vacatorrent', [movie('/a')], 1000);
  const opts = { retryBaseMs: 60000, maxTries: 3 };
  store.engine().markResult('vacatorrent', '/a', { status: 'error', error: 'e1' }, 2000, opts);
  store.engine().markResult('vacatorrent', '/a', { status: 'error', error: 'e2' }, 3000, opts);
  const tired = store.engine().getUrl('vacatorrent', '/a') as CrawlUrlRow;
  assert.equal(tired.tries, 2);
  assert.ok(tired.nextAt < 3000 + CRAWL_GIVE_UP_MS, 'antes do teto ainda usa backoff');
  store.engine().markResult('vacatorrent', '/a', { status: 'error', error: 'e3' }, 4000, opts);
  const dead = store.engine().getUrl('vacatorrent', '/a') as CrawlUrlRow;
  assert.equal(dead.tries, 3);
  assert.ok(dead.nextAt >= 4000 + CRAWL_GIVE_UP_MS, 'esgotado dorme um dia, não apagada');
  assert.equal(store.engine().requeueErrors('vacatorrent'), 1);
  const back = store.engine().getUrl('vacatorrent', '/a') as CrawlUrlRow;
  assert.equal(back.status, 'pending');
  assert.equal(back.tries, 0);
  assert.equal(back.nextAt, 0);
});

test('inflight velho volta a pending (crash recovery); recente não', () => {
  store.engine().upsertUrls('vacatorrent', [movie('/a'), movie('/b')], 1000);
  assert.equal(store.engine().takeNext('vacatorrent', 2000)?.url, '/a');
  assert.equal(store.engine().requeueInflight('vacatorrent', 60_000, 30_000), 0, 'inflight recente fica');
  assert.equal(store.engine().requeueInflight('vacatorrent', 60_000, 62_001), 1, 'inflight velho volta');
  const row = store.engine().getUrl('vacatorrent', '/a') as CrawlUrlRow;
  assert.equal(row.status, 'pending');
  assert.equal(store.engine().takeNext('vacatorrent', 62_002)?.url, '/a', 'reenfileirada é servida de novo');
});

test('contadores por status e isolamento por site', () => {
  store.engine().upsertUrls('vacatorrent', [movie('/a'), movie('/b'), movie('/c')], 1000);
  store.engine().upsertUrls('nerdfilmes', [movie('/a')], 1000);
  store.engine().markResult('vacatorrent', '/a', { status: 'done', imdb: 'tt1', releases: 2 }, 2000);
  store.engine().markResult('vacatorrent', '/b', { status: 'no-torrent' }, 2000);
  assert.equal(store.engine().takeNext('vacatorrent', 2000)?.url, '/c');
  const c = store.engine().counters('vacatorrent');
  assert.equal(c.total, 3);
  assert.equal(c.byStatus.done, 1);
  assert.equal(c.byStatus['no-torrent'], 1);
  assert.equal(c.byStatus.inflight, 1);
  assert.equal(c.byStatus.pending, 0);
  assert.equal(c.byStatus.error, 0);
  assert.equal(store.engine().counters('nerdfilmes').total, 1, 'site é isolado');
  assert.equal(store.engine().takeNext('nerdfilmes', 2000)?.url, '/a', 'fila do outro site intacta');
});

test('markResult de URL desconhecida é no-op (fila zerada no meio)', () => {
  store.engine().markResult('vacatorrent', '/fantasma', { status: 'done', imdb: 'tt1' }, 1000);
  assert.equal(store.engine().getUrl('vacatorrent', '/fantasma'), null);
  assert.equal(store.engine().counters('vacatorrent').total, 0);
});

test('rodada: start/finish/latest guarda fase, cursor e contadores', () => {
  store.engine().upsertUrls('vacatorrent', [movie('/a')], 1000);
  const id = store.engine().startRun('vacatorrent', 'initial', '', 2000);
  assert.equal(store.engine().latestRun('vacatorrent')?.id, id);
  assert.equal(store.engine().latestRun('vacatorrent')?.finishedAt, null, 'rodada aberta');
  store.engine().finishRun(id, 9000, { pages: 1, magnets: 4 });
  const done = store.engine().latestRun('vacatorrent');
  assert.equal(done?.finishedAt, 9000);
  assert.deepEqual(done?.counters, { pages: 1, magnets: 4 });
  const id2 = store.engine().startRun('vacatorrent', 'incremental', 'cursor-x', 10_000);
  const latest = store.engine().latestRun('vacatorrent');
  assert.equal(latest?.id, id2);
  assert.equal(latest?.phase, 'incremental');
  assert.equal(latest?.cursor, 'cursor-x');
  assert.equal(store.engine().latestRun('outro'), null);
});

test('SQLite persiste entre aberturas: retomada lê a fila gravada', () => {
  const dir = freshDir();
  store.resetForTests();
  store.open(path.join(dir, 'crawl.db'));
  store.engine().upsertUrls('vacatorrent', [movie('/a')], 1000);
  store.engine().markResult('vacatorrent', '/a', { status: 'done', imdb: 'tt7', releases: 5 }, 2000);
  store.close(); // fecha SEM limpar (resetForTests zebra por desenho — isolamento)
  store.open(path.join(dir, 'crawl.db'));
  const row = store.engine().getUrl('vacatorrent', '/a') as CrawlUrlRow;
  assert.equal(row.status, 'done', 'estado sobrevive ao restart do container');
  assert.equal(row.imdb, 'tt7');
  assert.equal(row.releases, 5);
  store.resetForTests(); // solta o arquivo do temp antes do cleanup
  store.open(path.join(freshDir(), 'crawl.db'));
});

test('engine de memória: mesmos verbos, mesmos resultados (paridade)', () => {
  store.resetForTests();
  store.open(undefined, { forceMemory: true });
  assert.equal(store.engine().kind, 'memory');
  assert.deepEqual(store.engine().upsertUrls('vacatorrent', [movie('/a'), movie('/b')], 1000), { added: 2, refreshed: 0, unchanged: 0 });
  assert.deepEqual(store.engine().upsertUrls('vacatorrent', [movie('/a')], 1500), { added: 0, refreshed: 0, unchanged: 1 });
  const first = store.engine().takeNext('vacatorrent', 2000) as CrawlUrlRow;
  assert.equal(first.url, '/a');
  assert.equal(first.status, 'inflight');
  store.engine().markResult('vacatorrent', '/a', { status: 'done', imdb: 'tt9', releases: 1 }, 2500);
  store.engine().markResult('vacatorrent', '/b', { status: 'error', error: '403' }, 2500, { retryBaseMs: 60000, maxTries: 1 });
  assert.deepEqual(store.engine().counters('vacatorrent'), {
    total: 2,
    byStatus: { pending: 0, inflight: 0, done: 1, 'no-torrent': 0, 'no-work': 0, error: 1 },
  });
  const b = store.engine().getUrl('vacatorrent', '/b') as CrawlUrlRow;
  assert.ok(b.nextAt >= 2500 + CRAWL_GIVE_UP_MS, 'maxTries esgota também na memória');
  assert.equal(store.engine().requeueErrors('vacatorrent'), 1);
  assert.equal(store.engine().requeueInflight('vacatorrent', 1000, 9999), 0);
  assert.equal(store.engine().takeNext('vacatorrent', 9999)?.url, '/b', 'erro reprocessado volta a servir');
  const id = store.engine().startRun('vacatorrent', 'initial', '', 3000);
  store.engine().finishRun(id, 4000, { pages: 2 });
  assert.equal(store.engine().latestRun('vacatorrent')?.counters.pages, 2);
  const cap = store.engine().memoryMax();
  assert.ok(typeof cap === 'number' && (cap as number) > 0, 'memória declara teto (nunca ilimitada)');
  assert.equal(store.engine().memoryEvictions(), 0);
});
