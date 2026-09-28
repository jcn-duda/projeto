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
import { errorBackoffMs, CRAWL_GIVE_UP_MS, parseProgress } from '../src/utils/crawl-store-rules.js';
import type { CrawlUrlRow } from '../src/providers/crawl-types.js';

// `node:sqlite` só existe no Node 22+; no 20 (que o CI também roda) o store cai
// na engine de memória por desenho — tipo da engine, persistência entre
// aberturas e rollback da transação são contratos do arquivo SQLite.
let hasNodeSqlite = true;
try {
  await import('node:sqlite');
} catch {
  hasNodeSqlite = false;
}
const skipSemSqlite = !hasNodeSqlite && 'node:sqlite indisponível — precisa de Node 22+';

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

test('upsert idempotente: nova URL nasce pending; repetida igual não mexe', { skip: skipSemSqlite }, () => {
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

test('requeueSimulated (SQL) zera a contagem seca de releases; done ao vivo preserva a dele', { skip: skipSemSqlite }, () => {
  assert.equal(store.engine().kind, 'sql');
  store.engine().upsertUrls('vacatorrent', [
    { url: '/sim', lastmod: 'x', kind: 'tv_show' },
    { url: '/drypart', lastmod: 'x', kind: 'tv_show' },
    { url: '/done', lastmod: 'x', kind: 'tv_show' },
  ], 1000);
  store.engine().markResult('vacatorrent', '/sim', { status: 'simulated', imdb: 'tt1', releases: 3 }, 2000);
  store.engine().markResult('vacatorrent', '/drypart', {
    status: 'partial', releases: 4, progress: '{"v":1,"doneCards":["/c1"],"totalCards":2,"dry":1}',
  }, 2100);
  store.engine().markResult('vacatorrent', '/done', { status: 'done', imdb: 'tt2', releases: 9 }, 2200);
  assert.equal(store.engine().requeueSimulated('vacatorrent'), 2);
  assert.equal(store.engine().getUrl('vacatorrent', '/sim')?.releases, 0, 'descoberta seca zerada no SQL');
  assert.equal(store.engine().getUrl('vacatorrent', '/drypart')?.releases, 0, 'idem no partial seco');
  assert.equal(store.engine().getUrl('vacatorrent', '/drypart')?.status, 'pending');
  assert.equal(store.engine().getUrl('vacatorrent', '/done')?.releases, 9, 'contagem de gravação real preservada');
  assert.equal(store.engine().sumReleases('vacatorrent'), 9, 'painel não soma seco+vivo');
});

test('SQLite persiste entre aberturas: retomada lê a fila gravada', { skip: skipSemSqlite }, () => {
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

test('upsert é atômico: erro ORIGINAL sobe e a leva NÃO fica pela metade', { skip: skipSemSqlite }, () => {
  // Entrada-bomba: o acesso a `url` explode no meio do lote (depois do BEGIN),
  // provando que o rollback roda e que o erro da linha — não um erro de
  // transação mascarado — é o que chega ao chamador.
  const bomb: any = {};
  Object.defineProperty(bomb, 'url', { get() { throw new Error('boom'); } });
  assert.throws(
    () => store.engine().upsertUrls('vacatorrent', [movie('/ok'), bomb], 1000),
    /boom/,
    'o erro original da entrada sobe, não um erro de BEGIN/ROLLBACK',
  );
  assert.equal(store.engine().getUrl('vacatorrent', '/ok'), null, 'a leva inteira voltou (sem half-write)');
  assert.equal(store.engine().counters('vacatorrent').total, 0);
  // E o store segue utilizável (nenhuma transação pendurada).
  assert.deepEqual(store.engine().upsertUrls('vacatorrent', [movie('/a')], 2000), { added: 1, refreshed: 0, unchanged: 0 });
});

test('hasDue é EXATO: só o que o takeNext serviria agora', () => {
  const eng = store.engine();
  assert.equal(eng.hasDue('vacatorrent', 1000), false, 'site sem nada não é debido');
  eng.upsertUrls('vacatorrent', [movie('/a'), movie('/b')], 1000);
  assert.equal(eng.hasDue('vacatorrent', 1000), true, 'pending é devido na hora');
  // Linha em BACKOFF existe e conta nos contadores, mas não está vencida: é o
  // caso em que a aproximação por status mandava o motor escolher "item" e o
  // passo virar no-op. Aqui a resposta é a verdade.
  eng.markResult('vacatorrent', '/a', { status: 'error', error: 'timeout' }, 2000, { retryBaseMs: 60000 });
  const backoff = eng.getUrl('vacatorrent', '/a') as CrawlUrlRow;
  assert.equal(eng.counters('vacatorrent').byStatus.error, 1, 'o contador vê a linha');
  assert.equal(eng.hasDue('vacatorrent', 3000), true, 'mas /b segue vencido');
  eng.markResult('vacatorrent', '/b', { status: 'done', imdb: 'tt1' }, 3000);
  assert.equal(eng.hasDue('vacatorrent', 3000), false, 'ninguém vencido: a linha em backoff NÃO é devida');
  assert.equal(eng.hasDue('vacatorrent', backoff.nextAt), true, 'vencido o backoff, é devida de novo');
});

test('hasDue: inflight não conta (já foi tomado) e site é isolado', () => {
  const eng = store.engine();
  eng.upsertUrls('vacatorrent', [movie('/a'), movie('/b')], 1000);
  eng.upsertUrls('nerdfilmes', [movie('/c')], 1000);
  assert.equal(eng.takeNext('vacatorrent', 2000)?.url, '/a');
  assert.equal(eng.hasDue('vacatorrent', 2000), true, '/b continua na fila');
  assert.equal(eng.hasDue('nerdfilmes', 2000), true, 'site alheio não é a fila deste');
  eng.markResult('vacatorrent', '/b', { status: 'done', imdb: 'tt2' }, 2000);
  assert.equal(eng.hasDue('vacatorrent', 2000), false, '/a está inflight: reivindicado, não devido');
  assert.equal(eng.requeueInflight('vacatorrent', 0, 2000), 1, 'a órfã é do requeueInflight, não do hasDue');
  assert.equal(eng.hasDue('vacatorrent', 2000), true, 'devolvida à fila, é devida');
  eng.markResult('vacatorrent', '/a', { status: 'simulated' }, 2100);
  eng.markResult('nerdfilmes', '/c', { status: 'no-work' }, 2100);
  assert.equal(eng.hasDue('vacatorrent', 2200), false, 'simulated não é elegível');
  assert.equal(eng.hasDue('nerdfilmes', 2200), false, 'no-work é terminal');
});

test('hasDue concorda com o takeNext página a página (paridade de elegibilidade)', () => {
  const eng = store.engine();
  eng.upsertUrls('vacatorrent', [movie('/a'), movie('/b'), movie('/c'), movie('/d')], 1000);
  eng.markResult('vacatorrent', '/b', { status: 'error', error: '403' }, 2000, { retryBaseMs: 60000 });
  eng.markResult('vacatorrent', '/c', { status: 'partial', releases: 2, progress: '{"v":1,"totalCards":9}' }, 2000, { retryBaseMs: 60000 });
  eng.markResult('vacatorrent', '/d', { status: 'done', imdb: 'tt4' }, 2000);
  // Drenar enquanto `hasDue` diz que há: a contagem tem que bater com as linhas
  // vencidas (a, b e c) e parar exatamente quando a fila acaba.
  let drenadas = 0;
  while (eng.hasDue('vacatorrent', 10 ** 12)) {
    assert.ok(eng.takeNext('vacatorrent', 10 ** 12), 'hasDue verdadeiro implica takeNext com linha');
    drenadas += 1;
    assert.ok(drenadas <= 4, 'não entra em laço infinito');
  }
  assert.equal(drenadas, 3, 'a, b e c: pending + error vencido + partial no retry');
  assert.equal(eng.hasDue('vacatorrent', 10 ** 12), false, 'só o `done` ficou, e terminal não é elegível');
});

test('hasDue na engine de memória: mesma resposta do SQL', () => {
  store.resetForTests();
  store.open(undefined, { forceMemory: true });
  const eng = store.engine();
  assert.equal(eng.kind, 'memory');
  assert.equal(eng.hasDue('vacatorrent', 1000), false);
  eng.upsertUrls('vacatorrent', [movie('/a'), movie('/b')], 1000);
  assert.equal(eng.hasDue('vacatorrent', 1000), true);
  eng.markResult('vacatorrent', '/a', { status: 'error', error: 'timeout' }, 2000, { retryBaseMs: 60000 });
  eng.markResult('vacatorrent', '/b', { status: 'done', imdb: 'tt1' }, 2000);
  assert.equal(eng.hasDue('vacatorrent', 2000), false, 'backoff e terminal não são devidos');
  const backoff = eng.getUrl('vacatorrent', '/a') as CrawlUrlRow;
  assert.equal(eng.hasDue('vacatorrent', backoff.nextAt), true);
  eng.takeNext('vacatorrent', backoff.nextAt);
  assert.equal(eng.hasDue('vacatorrent', backoff.nextAt), false, 'reivindicado sai da elegibilidade');
});

test('clearRows limpa TAMBÉM o crawl_state (paridade com a memória)', () => {
  store.engine().setState('vacatorrent', 'cursor', '2026-09-01');
  assert.equal(store.engine().getState('vacatorrent', 'cursor'), '2026-09-01');
  store.engine().clearRows();
  assert.equal(store.engine().getState('vacatorrent', 'cursor'), null, 'cursor não sobrevive ao clear');
  // "Zerar site" limpa o estado daquele site — e só dele.
  store.engine().setState('vacatorrent', 'cursor', '2026-09-02');
  store.engine().setState('nerdfilmes', 'cursor', '2026-09-03');
  store.engine().clearSite('vacatorrent');
  assert.equal(store.engine().getState('vacatorrent', 'cursor'), null, 'cursor do site zerado sai');
  assert.equal(store.engine().getState('nerdfilmes', 'cursor'), '2026-09-03', 'outro site intacto');
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
    byStatus: { pending: 0, inflight: 0, done: 1, 'no-torrent': 0, 'no-work': 0, error: 1, simulated: 0, partial: 0 },
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

test('partial: due/claim com progresso; codec roundtrip na coluna (SQL)', { skip: skipSemSqlite }, () => {
  assert.equal(store.engine().kind, 'sql');
  store.engine().upsertUrls('vacatorrent', [movie('/s1', '2026-01-01')], 1000);
  store.engine().markResult('vacatorrent', '/s1', {
    status: 'partial', imdb: 'tt1', releases: 3,
    error: 'series_truncated: teto de série atingido (cards 10/24, botões 0/40)',
    progress: '{"card":{"skip":2,"url":"/c"},"doneCards":["/a","/b"],"totalCards":24,"v":1}',
  }, 2000);
  const row = store.engine().getUrl('vacatorrent', '/s1') as CrawlUrlRow;
  assert.equal(row.status, 'partial');
  assert.equal(row.releases, 3);
  assert.deepEqual(parseProgress(row.progress)?.doneCards, ['/a', '/b'], 'roundtrip preserva a forma canônica');
  assert.equal(parseProgress(row.progress)?.card?.skip, 2);
  // nextAt = now + base (60s): devido depois da base, antes do backoff longo.
  const claimed = store.engine().takeNext('vacatorrent', 2000 + 60_000) as CrawlUrlRow;
  assert.equal(claimed.url, '/s1', 'partial é devido pelo next_at curto');
  assert.equal(claimed.status, 'inflight');
});

test('migração: banco no formato anterior (sem progress) ganha a coluna preservando linhas', { skip: skipSemSqlite }, async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const d = freshDir();
  const db = new DatabaseSync(path.join(d, 'crawl.db'));
  db.exec(`
    CREATE TABLE crawl_url (
      site TEXT NOT NULL, url TEXT NOT NULL, lastmod TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'movie', status TEXT NOT NULL DEFAULT 'pending',
      imdb TEXT, tries INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
      checked_at INTEGER NOT NULL DEFAULT 0, releases INTEGER NOT NULL DEFAULT 0,
      error TEXT NOT NULL DEFAULT '', added_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (site, url)
    );
    INSERT INTO crawl_url (site, url, status, releases) VALUES ('vacatorrent', '/antiga', 'done', 5);
  `);
  db.close();
  store.resetForTests();
  store.open(path.join(d, 'crawl.db'));
  const row = store.engine().getUrl('vacatorrent', '/antiga') as CrawlUrlRow;
  assert.ok(row, 'linha do formato anterior preservada');
  assert.equal(row.status, 'done');
  assert.equal(row.releases, 5);
  assert.equal(row.progress, '', 'coluna nova nasce vazia');
});

test('arquivo corrompido na abertura fecha o handle e cai na memória (o arquivo fica livre)', { skip: skipSemSqlite }, async () => {
  const d = freshDir();
  const dbPath = path.join(d, 'crawl.db');
  // Arquivo que não é banco: a falha vem DEPOIS do handle aberto (o PRAGMA
  // lê o cabeçalho), que é exatamente o caminho em que a queda para memória
  // deixaria um handle vivo. No Windows esse handle trava o `crawl.db` e o
  // reparo do arquivo fica impossível.
  fs.writeFileSync(dbPath, 'isto nao e um banco sqlite');
  store.resetForTests();
  store.open(dbPath);
  assert.ok(store.engine(), 'a engine de memória cobre o store mesmo com o arquivo ruim');
  store.close();
  fs.rmSync(dbPath, { force: false });
  assert.ok(!fs.existsSync(dbPath), 'arquivo removível depois da queda');
});
