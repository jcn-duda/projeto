// Reparo v2 (bug 2026-09-27): locações FORA da raiz (TWD em S1/S5 em vez de
// S4, dn "4ordf"), fusão na PK destino, exclusão de contaminação de
// identidade (One Piece live action sob o anime tt0388629 — nunca remanejar),
// saneamento do título com E01 fictício (só com prova no dn), limpeza de TODAS
// as chaves idx da obra afetada, lock exclusivo liberado em finally e
// IDEMPOTÊNCIA da segunda passada. Bancos sintéticos; NADA de rede.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);

// `node:sqlite` só existe no Node 22+. Todo cenário aqui nasce de um banco
// sintético aberto pelo `seed()`, então sem o módulo a suíte é pulada — falhar
// no Node 20 (que o CI cobre) seria ruído, não regressão.
let _hasSqlite = true;
try { await import('node:sqlite'); } catch { _hasSqlite = false; }
const skipSemSqlite = !_hasSqlite && 'node:sqlite indisponível — precisa de Node 22+';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'repair-v2-'));
const hashOf = (s: string) => s.padEnd(40, '0');
const magnetUri = (hash: string, dn: string) =>
  `magnet:?xt=urn:btih:${hash}${dn ? `&dn=${encodeURIComponent(dn)}` : ''}`;

interface RowSpec {
  hash: string; imdb: string; season: number; episode: number;
  dn: string; title: string; firstSeen: number; lastSeen: number; passedFilter: number;
}

function seed(d: string, rows: RowSpec[], idxKeys: string[]) {
  const { DatabaseSync } = _require('node:sqlite');
  const magnets = new DatabaseSync(path.join(d, 'magnets.db'));
  magnets.exec(`
    CREATE TABLE magnet (hash TEXT PRIMARY KEY, uri TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0, is_br INTEGER NOT NULL DEFAULT 0, dubbed INTEGER NOT NULL DEFAULT 0, quality TEXT NOT NULL DEFAULT '', seeders_max INTEGER NOT NULL DEFAULT 0, seeders_last INTEGER NOT NULL DEFAULT 0, first_seen INTEGER NOT NULL DEFAULT 0, last_seen INTEGER NOT NULL DEFAULT 0, lied INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE magnet_work (hash TEXT NOT NULL, imdb TEXT NOT NULL, season INTEGER NOT NULL DEFAULT -1, episode INTEGER NOT NULL DEFAULT -1, first_seen INTEGER NOT NULL DEFAULT 0, last_seen INTEGER NOT NULL DEFAULT 0, passed_filter INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (hash, imdb, season, episode));
  `);
  const magnet = magnets.prepare('INSERT INTO magnet (hash, uri, title) VALUES (?, ?, ?)');
  const work = magnets.prepare('INSERT INTO magnet_work (hash, imdb, season, episode, first_seen, last_seen, passed_filter) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const seen = new Set<string>();
  for (const r of rows) {
    if (!seen.has(r.hash)) { magnet.run(r.hash, magnetUri(r.hash, r.dn), r.title); seen.add(r.hash); }
    work.run(r.hash, r.imdb, r.season, r.episode, r.firstSeen, r.lastSeen, r.passedFilter);
  }
  magnets.close();

  const cache = new DatabaseSync(path.join(d, 'cache.db'));
  cache.exec('CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT, expires_at INTEGER)');
  const insKey = cache.prepare('INSERT INTO cache (key, value) VALUES (?, ?)');
  for (const key of idxKeys) insKey.run(key, 'x');
  cache.close();

  const crawl = new DatabaseSync(path.join(d, 'crawl.db'));
  crawl.exec(`CREATE TABLE crawl_url (site TEXT NOT NULL, url TEXT NOT NULL, lastmod TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'movie', status TEXT NOT NULL DEFAULT 'pending', imdb TEXT, tries INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, checked_at INTEGER NOT NULL DEFAULT 0, releases INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', progress TEXT NOT NULL DEFAULT '', added_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (site, url))`);
  const insUrl = crawl.prepare("INSERT INTO crawl_url (site, url, kind, imdb, status) VALUES ('vacatorrent', ?, 'tv_show', ?, 'done')");
  const imdbs = new Set(rows.map((r) => r.imdb));
  let i = 0;
  for (const imdb of imdbs) insUrl.run(`https://x/s${i += 1}`, imdb);
  crawl.close();
}

function makeBackup(d: string, name = 'backup'): string {
  const backup = path.join(d, name);
  fs.mkdirSync(backup, { recursive: true });
  for (const base of ['magnets.db', 'cache.db', 'crawl.db']) {
    fs.writeFileSync(path.join(backup, `${base}.bak`), fs.readFileSync(path.join(d, base)));
  }
  return backup;
}

function runScript(d: string, extra: string[] = []): { status: number; out: string } {
  try {
    const out = execFileSync(process.execPath, ['dist/scripts/crawl-repair-series-locations.js',
      `--magnets=${path.join(d, 'magnets.db')}`, `--cache=${path.join(d, 'cache.db')}`, `--crawl=${path.join(d, 'crawl.db')}`, ...extra],
      { encoding: 'utf8' });
    return { status: 0, out };
  } catch (err: any) {
    return { status: err.status ?? 1, out: String(err.stdout || '') + String(err.stderr || '') };
  }
}
const runApply = (d: string, extra: string[] = [], backupName = 'backup') =>
  runScript(d, ['--apply', '--port=0', `--backup=${makeBackup(d, backupName)}`, ...extra]);

/** Linhas de medida real (produção, 2026-09-27). */
const TWD = 'tt1520211';
const ST = 'tt4574334';
const OP = 'tt0388629';
const ROWS: RowSpec[] = [
  // TWD: pack da 4ª (dn com entidade destruída) gravado em S1 E em S5.
  { hash: hashOf('t1'), imdb: TWD, season: 1, episode: -1, dn: 'The.Walking.Dead.4ordf.Temporada.Completa.1080p', title: 'The Walking Dead 4ordf Temporada Completa', firstSeen: 100, lastSeen: 110, passedFilter: 1 },
  { hash: hashOf('t2'), imdb: TWD, season: 1, episode: -1, dn: 'The.Walking.Dead.4&ordf;.Temporada.Completa.720p', title: 'The Walking Dead 4ª Temporada', firstSeen: 100, lastSeen: 120, passedFilter: 0 },
  { hash: hashOf('t2'), imdb: TWD, season: 5, episode: -1, dn: 'The.Walking.Dead.4&ordf;.Temporada.Completa.720p', title: 'The Walking Dead 4ª Temporada', firstSeen: 200, lastSeen: 220, passedFilter: 1 },
  // Stranger Things: pack S01 na raiz com E01 fictício no título.
  { hash: hashOf('st'), imdb: ST, season: -1, episode: -1, dn: 'Stranger.Things.1TemporadaCompleta.1080p', title: 'Stranger Things (2025) E01', firstSeen: 50, lastSeen: 60, passedFilter: 1 },
  // One Piece: pack legítimo do anime (fica) + live action 2023 (contaminação).
  { hash: hashOf('op1'), imdb: OP, season: -1, episode: -1, dn: 'One.Piece.S01-S15.Completa.1999-2023.1080p', title: 'One Piece 1ª a 15ª Temporadas Completa (1999-2023)', firstSeen: 10, lastSeen: 15, passedFilter: 1 },
  { hash: hashOf('op2'), imdb: OP, season: 1, episode: -1, dn: 'One.Piece.Live.Action.2023.S01.1080p.DUAL', title: 'One Piece Live Action (2023) Temporada 1', firstSeen: 20, lastSeen: 25, passedFilter: 1 },
  // Título com entidade DESTRUÍDA e SEM dn: o planner decodifica o TÍTULO
  // ("4ordf" = "4ª") e move o pack para a temporada declarada.
  { hash: hashOf('t3'), imdb: TWD, season: 1, episode: -1, dn: '', title: 'The Walking Dead 4ordf Temporada', firstSeen: 130, lastSeen: 140, passedFilter: 1 },
];
const IDX_KEYS = [
  `idx:v13:${TWD}`, `idx:v13:${TWD}:S4`, `idx:v13:${TWD}:S4E5`,
  `idx:v13:${ST}`, `idx:v13:${OP}:S1`, 'idx:v13:tt9999999',
  // Listas prontas por instalação (formato real `streams:v20:series:<imdb>:…`):
  `streams:v20:series:${TWD}:4:5:${JSON.stringify({})}:account:deadbeef`,
  `streams:v20:series:${ST}:1:1:${JSON.stringify({})}:account:deadbeef`,
  'streams:v20:series:tt9999999:1:1:x:account:deadbeef',
];

function workRows(d: string, imdb: string): Array<Record<string, unknown>> {
  const { DatabaseSync } = _require('node:sqlite');
  const db = new DatabaseSync(path.join(d, 'magnets.db'), { readOnly: true });
  const out = db.prepare('SELECT * FROM magnet_work WHERE imdb = ? ORDER BY hash, season, episode').all(imdb) as Array<Record<string, unknown>>;
  db.close();
  return out;
}

describe('crawl-repair v2: fora da raiz, identidade, saneamento e lock', { concurrency: false, skip: skipSemSqlite }, () => {
  test('dry-run: planeja mover S1/S5→S4, saneia E01 e RELATA a suspeita sem ano — nada grava', () => {
    const d = dir();
    seed(d, ROWS, IDX_KEYS);
    const { out } = runScript(d);
    assert.match(out, /mover t10000000000… tt1520211 1:-1 -> 4:-1 \[dn=.*4ordf/);
    assert.match(out, /mover t20000000000… tt1520211 1:-1 -> 4:-1/);
    assert.match(out, /mover t20000000000… tt1520211 5:-1 -> 4:-1/);
    assert.match(out, /mover t30000000000… tt1520211 1:-1 -> 4:-1 \[title=/, 'título com entidade destruída e sem dn é decodificado');
    assert.match(out, /sanear título.*Stranger Things \(2025\) E01/);
    assert.match(out, /SUSPEITA sem ano de estreia.*op2/, 'live action sem --premiere só é relatado');
    // Plano de cache/fila REPORTADO no dry-run (paridade com o apply).
    assert.match(out, /idx do escopo \(planejado\): idx:v13:tt1520211/);
    assert.match(out, /idx do escopo \(planejado\): idx:v13:tt1520211:S4E5/, 'formato real do idx por episódio');
    assert.match(out, /streams do escopo \(planejado\): 1 chave\(s\) series:tt1520211/);
    assert.match(out, /fila \(planejado\): vacatorrent .* -> pending/);
    assert.match(out, /DRY-RUN/);
    const after = workRows(d, TWD);
    assert.equal(after.filter((r) => Number(r.season) === 4).length, 0, 'dry-run não gravou');
  });

  test('--apply: move para S4, FUNDE a PK destino, saneia título e EXCLUI contaminação com --premiere', () => {
    const { DatabaseSync } = _require('node:sqlite');
    const d = dir();
    seed(d, ROWS, IDX_KEYS);
    const { out } = runApply(d, [`--premiere=${OP}:1999`]);
    assert.match(out, /APLICADO/);
    const db = new DatabaseSync(path.join(d, 'magnets.db'), { readOnly: true });
    // TWD: UMA linha por hash em S4 (a de S5 foi FUNDIDA na PK destino;
    // t3 — título com entidade destruída e sem dn — também foi).
    const twd = db.prepare('SELECT * FROM magnet_work WHERE imdb = ? ORDER BY hash, season').all(TWD) as Array<Record<string, unknown>>;
    assert.deepEqual(twd.map((r) => `${String(r.hash).slice(0, 2)}${r.season}:${r.episode}`), ['t14:-1', 't24:-1', 't34:-1'], 't1, t2 e t3 em S4:-1; S1/S5 sumiram');
    const t2 = twd.find((r) => String(r.hash).startsWith('t2'))!;
    assert.equal(Number(t2.first_seen), 100, 'fusão preserva o first_seen mais antigo');
    assert.equal(Number(t2.passed_filter), 1, 'fusão faz OR do passed_filter');
    // Stranger Things: movido para S1:-1 e título SANEADO (prova no dn).
    const st = db.prepare('SELECT * FROM magnet_work WHERE imdb = ?').get(ST) as Record<string, unknown>;
    assert.equal(Number(st.season), 1);
    const stTitle = (db.prepare('SELECT title FROM magnet WHERE hash = ?').get(hashOf('st')) as Record<string, unknown>).title;
    assert.equal(stTitle, 'Stranger Things (2025)', 'E01 fictício removido do título');
    // One Piece: anime pack FICA; live action 2023 é EXCLUÍDO (não remanejado).
    const op = workRows(d, OP).map((r) => String(r.hash).slice(0, 3)).sort();
    assert.deepEqual(op, ['op1'], 'só o pack legítimo do anime permanece');
    db.close();

    // idx + streams: TODAS as chaves das obras afetadas saem (inclusive o
    // formato real `:S4E5` e as listas `streams:v20:series:<imdb>:…`);
    // obra não afetada fica.
    const cache = new DatabaseSync(path.join(d, 'cache.db'), { readOnly: true });
    const keys = (cache.prepare('SELECT key FROM cache').all() as Array<Record<string, unknown>>).map((r) => String(r.key));
    assert.deepEqual(keys, ['idx:v13:tt9999999', 'streams:v20:series:tt9999999:1:1:x:account:deadbeef']);
    cache.close();

    // Fila: séries afetadas voltam a pending.
    const crawl = new DatabaseSync(path.join(d, 'crawl.db'), { readOnly: true });
    const pendings = (crawl.prepare("SELECT COUNT(*) n FROM crawl_url WHERE status = 'pending'").get() as Record<string, unknown>).n;
    assert.equal(Number(pendings), 3, 'TWD, ST e One Piece reenfileirados');
    crawl.close();
  });

  test('IDEMPOTÊNCIA: segunda passada não planeja nada e os bancos não mudam', () => {
    const { createHash } = _require('node:crypto');
    const d = dir();
    seed(d, ROWS, IDX_KEYS);
    runApply(d, [`--premiere=${OP}:1999`]);
    const snap = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const before = ['magnets.db', 'cache.db', 'crawl.db'].map((f) => snap(path.join(d, f)));
    const second = runApply(d, [`--premiere=${OP}:1999`]);
    assert.match(second.out, /0 linha\(s\) a mover \(0 hash×obra distintos\), 0 por identidade, 0 título\(s\) \(0 distintos, 0 hashes\)/);
    const after = ['magnets.db', 'cache.db', 'crawl.db'].map((f) => snap(path.join(d, f)));
    assert.deepEqual(after, before, 'segunda passada é no-op');
  });

  test('LOCK: --apply cria lock exclusivo e LIBERA no finally mesmo falhando no meio', async () => {
    const d = dir();
    seed(d, ROWS, IDX_KEYS);
    const lock = path.join(d, 'meu.lock');
    // Lock alheio presente → recusa ANTES de qualquer mutação.
    fs.writeFileSync(lock, 'x');
    const blocked = runApply(d, ['--port=0', `--lock=${lock}`, `--premiere=${OP}:1999`]);
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.out, /lock/);
    fs.rmSync(lock);

    // Lock próprio nasce e é liberado MESMO com falha no meio (cache.db vira
    // diretório: o passo 2 explode depois da transação de magnets).
    const backup = makeBackup(d, 'pre-lock');
    const cachePath = path.join(d, 'cache.db');
    fs.rmSync(cachePath);
    fs.mkdirSync(cachePath);
    const failing = runScript(d, ['--apply', '--port=0', `--backup=${backup}`, `--lock=${lock}`, `--premiere=${OP}:1999`]);
    assert.notEqual(failing.status, 0, 'falha no meio da execução');
    assert.equal(fs.existsSync(lock), false, 'finally liberou o lock');
  });
});

// Bloqueador do repair v2 (2026-09-27): 19 linhas de EPISÓDIO ÚNICO sem dn, já
// corretas, viravam pack (S,E → S,-1) porque o planejador reusava a régua de
// CAPTURA (`declaredSeriesLocation` em modo batch, episode=null). A régua do
// reparo é a de `releaseWorkTargets`/`routeWorkLocation`: episódio único fica
// {S,E}; faixa multi-episódio é pack {S,-1}; recrawl tem PARIDADE entre
// dry-run e apply.
const BOYS = 'tt1190634';
describe('crawl-repair v2: episódio único sem dn não vira pack', { concurrency: false, skip: skipSemSqlite }, () => {
  const BOYS_ROWS: RowSpec[] = [
    // Já correta: título declara S05E01 único, sem dn — DEVE ficar em 5:1.
    { hash: hashOf('b1'), imdb: BOYS, season: 5, episode: 1, dn: '', title: 'The Boys S05E01 1080p DUAL 5.1', firstSeen: 300, lastSeen: 310, passedFilter: 1 },
    // Faixa multi-episódio no título, sem dn: é PACK da temporada — move.
    { hash: hashOf('b2'), imdb: BOYS, season: 5, episode: 1, dn: '', title: 'The Boys S05E01-E04 1080p DUAL', firstSeen: 320, lastSeen: 330, passedFilter: 0 },
  ];

  test('dry-run: S05E01 sem dn fica (nenhum move); faixa E01-E04 vira pack 5:-1', () => {
    const d = dir();
    seed(d, BOYS_ROWS, [`idx:v13:${BOYS}`]);
    const { out } = runScript(d);
    assert.doesNotMatch(out, /mover b10000000000/, 'episódio único já correto não é movido');
    assert.match(out, /mover b20000000000… tt1190634 5:1 -> 5:-1 \[title=/, 'faixa multi-episódio é pack');
    assert.match(out, /1 na locação correta/);
  });

  test('--apply: 5:1 preservado byte a byte; faixa movida para 5:-1', () => {
    const { DatabaseSync } = _require('node:sqlite');
    const d = dir();
    seed(d, BOYS_ROWS, [`idx:v13:${BOYS}`]);
    const { out } = runApply(d);
    assert.match(out, /APLICADO/);
    const db = new DatabaseSync(path.join(d, 'magnets.db'), { readOnly: true });
    const rows = db.prepare('SELECT * FROM magnet_work WHERE imdb = ? ORDER BY hash').all(BOYS) as Array<Record<string, unknown>>;
    assert.deepEqual(
      rows.map((r) => `${String(r.hash)[0]}${r.season}:${r.episode}:${r.passed_filter}:${r.first_seen}`),
      ['b5:1:1:300', 'b5:-1:0:320'],
      'episódio único preserva {S,E}; pack vai a 5:-1 com o histórico da linha',
    );
    db.close();
  });

  test('PARIDADE de recrawl: apply grava exatamente o plano do dry-run', () => {
    const d1 = dir();
    seed(d1, BOYS_ROWS, [`idx:v13:${BOYS}`]);
    const dry = runScript(d1);
    const d2 = dir();
    seed(d2, BOYS_ROWS, [`idx:v13:${BOYS}`]);
    const applied = runApply(d2);
    const summary = (out: string) => /resumo: (\d+) linha\(s\) a mover \((\d+) hash×obra distintos\), (\d+) por identidade, (\d+) título\(s\)/.exec(out)?.slice(1).join(',');
    assert.equal(summary(applied.out), summary(dry.out), 'apply grava exatamente o que o dry-run planejou');
    // O relatório PLANEJADO (cache e fila) é idêntico nos dois modos.
    const planned = (out: string) => out.split('\n').filter((l) => l.includes('(planejado)')).sort();
    assert.deepEqual(planned(applied.out), planned(dry.out), 'mesmo plano de cache/fila reportado');
    // A fila planejada ficou pending após o apply.
    const { DatabaseSync } = _require('node:sqlite');
    const c = new DatabaseSync(path.join(d2, 'crawl.db'), { readOnly: true });
    const statuses = (c.prepare('SELECT DISTINCT status FROM crawl_url').all() as Array<Record<string, unknown>>).map((r) => String(r.status));
    c.close();
    assert.deepEqual(statuses, ['pending'], 'fila do escopo reenfileirada');
  });

  test('series_truncated volta à fila MESMO sem actions; dry-run só planeja', () => {
    const { DatabaseSync } = _require('node:sqlite');
    const mk = () => {
      const d = dir();
      seed(d, [], ['idx:v13:tt0000001']);
      const db = new DatabaseSync(path.join(d, 'crawl.db'));
      db.prepare(`INSERT INTO crawl_url (site, url, kind, imdb, status, error) VALUES ('vacatorrent', 'https://x/grande', 'tv_show', NULL, 'error', 'series_truncated:9/18')`).run();
      db.close();
      return d;
    };
    const d1 = mk();
    const dry = runScript(d1);
    assert.match(dry.out, /fila \(planejado\): vacatorrent https:\/\/x\/grande/);
    const c1 = new DatabaseSync(path.join(d1, 'crawl.db'), { readOnly: true });
    assert.equal(String((c1.prepare('SELECT status FROM crawl_url').get() as Record<string, unknown>).status), 'error', 'dry-run não gravou');
    c1.close();
    const d2 = mk();
    runApply(d2);
    const c2 = new DatabaseSync(path.join(d2, 'crawl.db'), { readOnly: true });
    assert.equal(String((c2.prepare('SELECT status FROM crawl_url').get() as Record<string, unknown>).status), 'pending', 'apply reenfileira sem actions');
    c2.close();
  });
});

// Bloqueadores do dry-run REAL (2026-09-28, pós-0b4094c): ruído de cena
// (DS4K/BS8/Chris44/1280x720/2x2) virava multi-temporada → raiz FALSA;
// E1176 truncava em E117; saneador destruía ranges e "saneava" só espaços.
describe('crawl-repair v2: ruído de cena, E de 4 dígitos e saneador', { concurrency: false, skip: skipSemSqlite }, () => {
  const NOISE_ROWS: RowSpec[] = [
    // Ruído que NÃO é temporada: raiz FALSA proibida — pack fica em S1.
    { hash: hashOf('n1'), imdb: OP, season: 1, episode: 1, dn: 'One Piece (2023) Season 1 S01 (1080p DS4K NF WEB-DL x265 Vyndros)', title: 'One Piece (2023)', firstSeen: 400, lastSeen: 401, passedFilter: 1 },
    { hash: hashOf('n2'), imdb: OP, season: 1, episode: 1, dn: '[NanakoRaws] One Piece S01E986 (BS8 TV 1080p HEVC AAC)', title: 'One Piece', firstSeen: 402, lastSeen: 403, passedFilter: 1 },
    { hash: hashOf('n3'), imdb: OP, season: 1, episode: 1, dn: 'One Piece S01 MULTI WebDl1080p x264 - Chris44', title: 'One Piece', firstSeen: 404, lastSeen: 405, passedFilter: 1 },
    { hash: hashOf('n4'), imdb: OP, season: 1, episode: 2, dn: 'Sensationalists S01E02 Is It Art (1280x720p HD, 50fps)', title: 'Sensationalists', firstSeen: 406, lastSeen: 407, passedFilter: 0 },
    { hash: hashOf('n5'), imdb: OP, season: 7, episode: 1, dn: 'Futurama S7E1-26 of 26 [2012, HDRip] 2x2', title: 'Futurama', firstSeen: 408, lastSeen: 409, passedFilter: 1 },
    // E de 4 dígitos: {1,1176}, não {1,117}.
    { hash: hashOf('n6'), imdb: OP, season: 1, episode: 117, dn: 'One Piece S01E1176', title: 'One Piece', firstSeen: 410, lastSeen: 411, passedFilter: 1 },
    // Raiz legítima PRESERVADA: faixa explícita e multi-temporada marcada.
    { hash: hashOf('n7'), imdb: OP, season: -1, episode: -1, dn: 'The Sopranos (1999) S01-6 S01-S06 (1080p BluRay)', title: 'The Sopranos', firstSeen: 412, lastSeen: 413, passedFilter: 1 },
    { hash: hashOf('n8'), imdb: OP, season: -1, episode: -1, dn: 'Reacher S01.S02 Complete', title: 'Reacher', firstSeen: 414, lastSeen: 415, passedFilter: 1 },
    // Saneador: ranges/listas NÃO são tocados; só-espAços não é saneamento.
    { hash: hashOf('s1'), imdb: OP, season: 4, episode: 1, dn: 'The Boys S04 1080p AMZN WEB-DL', title: '黑袍纠察队.The.Boys S04E01-E08', firstSeen: 420, lastSeen: 421, passedFilter: 1 },
    // Range COLADO sem espaço ("S04E01-08", dn real dos packs G66/MIRCrew).
    { hash: hashOf('s5'), imdb: OP, season: 4, episode: 1, dn: 'The.Boys.S04.1080p.AMZN.WEB-DL.DDP5.1', title: 'The.Boys.S04E01-08.1080p.AMZN.WEB-DL.ITA.ENG.DDP5.1.H.264-G66', firstSeen: 428, lastSeen: 429, passedFilter: 1 },
    { hash: hashOf('s2'), imdb: OP, season: 1, episode: 3, dn: 'The Last of Us S01 1080p WEB H264 Dual', title: 'The.Last.of.Us.S01E03.e04.e05.1080p.WEB.H264 Dual', firstSeen: 422, lastSeen: 423, passedFilter: 1 },
    { hash: hashOf('s3'), imdb: OP, season: 1, episode: -1, dn: 'One Piece S01 Arc Baratie MULTi 1080p HEVC', title: 'One Piece - S01 - Arc Baratie  - MULTi - 1080p - HEVC', firstSeen: 424, lastSeen: 425, passedFilter: 1 },
    // Saneamento LEGÍTIMO: exatamente um marcador, E01 fictício do dn pack.
    { hash: hashOf('s4'), imdb: OP, season: -1, episode: 1, dn: 'Stranger Things 1TemporadaCompleta 1080p', title: 'Stranger Things (2025) E01 [1080p DUAL]', firstSeen: 426, lastSeen: 427, passedFilter: 1 },
    // Marcador COLADO (SxxEyy): NUNCA saneado — todas as variantes de
    // stored (5/2/-1) e dn (pack/episódio/ausente) resultam em null.
    { hash: hashOf('w1'), imdb: OP, season: 2, episode: 5, dn: 'One Piece S02 1080p', title: 'One Piece S02E05 1080p', firstSeen: 430, lastSeen: 431, passedFilter: 1 },
    { hash: hashOf('w2'), imdb: OP, season: 2, episode: 2, dn: 'One Piece S02 1080p', title: 'One Piece S02E05 1080p', firstSeen: 432, lastSeen: 433, passedFilter: 1 },
    { hash: hashOf('w3'), imdb: OP, season: 2, episode: -1, dn: 'One Piece S02 1080p', title: 'One Piece S02E05 1080p', firstSeen: 434, lastSeen: 435, passedFilter: 1 },
    { hash: hashOf('w4'), imdb: OP, season: 2, episode: 5, dn: 'One Piece S02E05 1080p CR WEB-DL', title: 'One Piece S02E05 1080p', firstSeen: 436, lastSeen: 437, passedFilter: 1 },
    // E solto LEGÍTIMO em 2 hashes com a MESMA saída: métrica conta
    // títulos distintos pelo `from` e hashes distintos separadamente.
    { hash: hashOf('w5'), imdb: OP, season: -1, episode: 1, dn: 'Stranger Things 1TemporadaCompleta 720p', title: 'Stranger Things (2025) E01 [720p]', firstSeen: 438, lastSeen: 439, passedFilter: 1 },
    { hash: hashOf('w6'), imdb: OP, season: -1, episode: 1, dn: 'Stranger Things 3TemporadaCompleta 720p', title: 'Stranger Things (2025) E01 [720p]', firstSeen: 440, lastSeen: 441, passedFilter: 1 },
  ];

  test('dry-run: ruído não cria raiz; 4 dígitos intacto; raiz legítima fica', () => {
    const d = dir();
    seed(d, NOISE_ROWS, [`idx:v13:${OP}`]);
    const { out } = runScript(d);
    // Raiz FALSA proibida: pack/episódio com ruído fica na temporada real.
    assert.match(out, /mover n10000000000… \S+ 1:1 -> 1:-1 /, 'DS4K não é multi-temporada: pack vai a 1:-1');
    assert.match(out, /mover n20000000000… \S+ 1:1 -> 1:986 /, 'BS8 não é temporada: E986 real');
    assert.match(out, /mover n30000000000… \S+ 1:1 -> 1:-1 /, 'Chris44 não é temporada: pack');
    assert.doesNotMatch(out, /mover n40000000000/, '1280x720 não é temporada: S01E02 fica');
    assert.match(out, /mover n50000000000… \S+ 7:1 -> 7:-1 /, '2x2 não é temporada: pack de S7');
    assert.match(out, /mover n60000000000… \S+ 1:117 -> 1:1176 /, 'E1176 não trunca em 117');
    // Raiz legítima: faixa explícita e multi-temporada marcada FICAM.
    assert.doesNotMatch(out, /mover n70000000000/, 'S01-6 S01-S06 é faixa explícita: raiz fica');
    assert.doesNotMatch(out, /mover n80000000000/, 'S01.S02 Complete é multi marcada: raiz fica');
    assert.doesNotMatch(out, /-> -1:-1 /, 'nenhum move para a raiz neste cenário');
    // Saneador.
    assert.doesNotMatch(out, /sanear título.*s10000000000/, 'range E01-E08 não é tocado');
    assert.doesNotMatch(out, /sanear título.*s20000000000/, 'lista e04.e05 não é tocada');
    assert.doesNotMatch(out, /sanear título.*s30000000000/, 'título sem marcador não é "saneado"');
    assert.doesNotMatch(out, /sanear título.*s50000000000/, 'range colado S04E01-08 não é tocado');
    assert.match(out, /sanear título \(E fictício com prova no dn\) s40000000000… "Stranger Things \(2025\) E01 \[1080p DUAL\]" -> "Stranger Things \(2025\) \[1080p DUAL\]"/);

    // Marcador colado (SxxEyy) NUNCA é saneado — só episódio SOLTO, qualquer
    // stored (5/2/-1) e qualquer dn (pack, episódio, ausente): todos null.
    assert.doesNotMatch(out, /sanear título.*w10000000000/, 'S02E05 colado não é saneado (stored 5)');
    assert.doesNotMatch(out, /sanear título.*w20000000000/, 'S02E05 colado não é saneado (stored 2)');
    assert.doesNotMatch(out, /sanear título.*w30000000000/, 'S02E05 colado não é saneado (stored -1)');
    assert.doesNotMatch(out, /sanear título.*w40000000000/, 'S02E05 colado não é saneado (dn episódio)');
    // s4 + w5 + w6: 3 ações; `from` distintos = 2 ([1080p DUAL] vs [720p]);
    // hashes distintos = 3 — a métrica separa TÍTULO (from) de HASH.
    assert.match(out, /, 3 título\(s\) \(2 distintos, 3 hashes\), /, 'métrica de saneamento separa título (from) e hash');
  });

  test('--apply: movimentos do cenário de ruído gravados e saneamento único', () => {
    const { DatabaseSync } = _require('node:sqlite');
    const d = dir();
    seed(d, NOISE_ROWS, [`idx:v13:${OP}`]);
    const { out } = runApply(d);
    assert.match(out, /APLICADO/);
    const db = new DatabaseSync(path.join(d, 'magnets.db'), { readOnly: true });
    const rows = db.prepare('SELECT * FROM magnet_work WHERE imdb = ? ORDER BY hash, season, episode').all(OP) as Array<Record<string, unknown>>;
    const lugar = (h: string) => rows.filter((r) => String(r.hash).startsWith(h)).map((r) => `${r.season}:${r.episode}`).join(',');
    assert.equal(lugar('n1'), '1:-1');
    assert.equal(lugar('n2'), '1:986');
    assert.equal(lugar('n6'), '1:1176');
    assert.equal(lugar('n7'), '-1:-1');
    assert.equal(lugar('n8'), '-1:-1');
    const stTitle = (db.prepare('SELECT title FROM magnet WHERE hash = ?').get(hashOf('s4')) as Record<string, unknown>).title;
    assert.equal(stTitle, 'Stranger Things (2025) [1080p DUAL]');
    const boysTitle = (db.prepare('SELECT title FROM magnet WHERE hash = ?').get(hashOf('s1')) as Record<string, unknown>).title;
    assert.equal(boysTitle, '黑袍纠察队.The.Boys S04E01-E08', 'range intacto no banco');
    db.close();
  });
});
