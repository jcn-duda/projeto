// Smoke do script de remediação (Parte D + F4/F5/F6): bancos sintéticos,
// dry-run/apply, régua dn-vence (conflito completo×temporada), filtro de site
// e gates de segurança do --apply (backup verificável, addon vivo, lock).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);

function dir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'repair-')); }

function seed(d: string) {
  const { DatabaseSync } = _require('node:sqlite');
  const magnets = new DatabaseSync(path.join(d, 'magnets.db'));
  magnets.exec(`
    CREATE TABLE magnet (hash TEXT PRIMARY KEY, uri TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0, is_br INTEGER NOT NULL DEFAULT 0, dubbed INTEGER NOT NULL DEFAULT 0, quality TEXT NOT NULL DEFAULT '', seeders_max INTEGER NOT NULL DEFAULT 0, seeders_last INTEGER NOT NULL DEFAULT 0, first_seen INTEGER NOT NULL DEFAULT 0, last_seen INTEGER NOT NULL DEFAULT 0, lied INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE magnet_work (hash TEXT NOT NULL, imdb TEXT NOT NULL, season INTEGER NOT NULL DEFAULT -1, episode INTEGER NOT NULL DEFAULT -1, first_seen INTEGER NOT NULL DEFAULT 0, last_seen INTEGER NOT NULL DEFAULT 0, passed_filter INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (hash, imdb, season, episode));
  `);
  // aa: pack S01 na raiz com E01 fictício no título (dn declara 1 temporada) — move.
  // bb: série inteira (título e dn declaram complete) — fica.
  // cc: obra fora do escopo — fica.
  // dd (F4): título declara S02 mas o DN declara SÉRIE COMPLETA — dn vence, FICA.
  // ee (F4, inverso): título declara série completa mas o DN declara S03E01 — move p/ S03:E01.
  const hashOf = (s: string) => s.padEnd(40, '0');
  const magnet = magnets.prepare('INSERT INTO magnet (hash, uri, title) VALUES (?, ?, ?)');
  const work = magnets.prepare('INSERT INTO magnet_work (hash, imdb, season, episode, passed_filter) VALUES (?, ?, -1, -1, 1)');
  magnet.run(hashOf('aa'), `magnet:?xt=urn:btih:${hashOf('aa')}&dn=${encodeURIComponent('Stranger.Things.1TemporadaCompleta.1080p')}`, 'Stranger Things (2025) E01');
  work.run(hashOf('aa'), 'tt4574334');
  magnet.run(hashOf('bb'), `magnet:?xt=urn:btih:${hashOf('bb')}&dn=${encodeURIComponent('Stranger.Things.Todas.as.Temporadas')}`, 'Stranger Things Todas');
  work.run(hashOf('bb'), 'tt4574334');
  magnet.run(hashOf('cc'), 'magnet:?xt=urn:btih:' + hashOf('cc'), 'Fallout (2024)');
  work.run(hashOf('cc'), 'tt2442560');
  magnet.run(hashOf('dd'), `magnet:?xt=urn:btih:${hashOf('dd')}&dn=${encodeURIComponent('Reacher.S01.S02.Complete.Serie.1080p')}`, 'Reacher 2 Temporada Dual');
  work.run(hashOf('dd'), 'tt9475514');
  magnet.run(hashOf('ee'), `magnet:?xt=urn:btih:${hashOf('ee')}&dn=${encodeURIComponent('Dexter.New.Blood.S03E01.1080p')}`, 'Dexter Temporadas Completas');
  work.run(hashOf('ee'), 'tt5848272');
  magnets.close();

  const cache = new DatabaseSync(path.join(d, 'cache.db'));
  cache.exec('CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT, expires_at INTEGER)');
  const insKey = cache.prepare('INSERT INTO cache (key, value) VALUES (?, ?)');
  insKey.run('idx:v13:tt4574334', 'x');
  insKey.run('idx:v13:tt2442560', 'x');
  insKey.run('idx:v13:tt5848272', 'x');
  cache.close();

  const crawl = new DatabaseSync(path.join(d, 'crawl.db'));
  crawl.exec(`CREATE TABLE crawl_url (site TEXT NOT NULL, url TEXT NOT NULL, lastmod TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'movie', status TEXT NOT NULL DEFAULT 'pending', imdb TEXT, tries INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, checked_at INTEGER NOT NULL DEFAULT 0, releases INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', progress TEXT NOT NULL DEFAULT '', added_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (site, url))`);
  const insUrl = crawl.prepare("INSERT INTO crawl_url (site, url, imdb, status, error) VALUES (?, ?, ?, ?, ?)");
  insUrl.run('vacatorrent', 'https://x/st', 'tt4574334', 'done', '');
  insUrl.run('vacatorrent', 'https://x/op', null, 'error', 'series_truncated: teto de série atingido (cards 10/24, botões 0/40)');
  // F5: série truncada de OUTRO site não entra no passe (a máquina de fatias é do Vaca).
  insUrl.run('outro-site', 'https://y/op', null, 'error', 'series_truncated: teto de série atingido (cards 1/9, botões 0/4)');
  // F5: IMDb do escopo em OUTRO site não é tocado pelo requeue.
  insUrl.run('outro-site', 'https://y/st', 'tt4574334', 'done', '');
  crawl.close();
}

/** Backups verificáveis (F6): cópias não vazias dos três bancos. */
function makeBackup(d: string): string {
  const backup = path.join(d, 'backup');
  fs.mkdirSync(backup);
  for (const base of ['magnets.db', 'cache.db', 'crawl.db']) {
    fs.writeFileSync(path.join(backup, `${base}.bak`), fs.readFileSync(path.join(d, base)));
  }
  return backup;
}

function runScript(d: string, extra: string[] = []): string {
  return execFileSync(process.execPath, ['dist/scripts/crawl-repair-series-locations.js', ...extra,
    `--magnets=${path.join(d, 'magnets.db')}`, `--cache=${path.join(d, 'cache.db')}`, `--crawl=${path.join(d, 'crawl.db')}`],
    { encoding: 'utf8' });
}

/** --apply com os gates satisfeitos (porta desligada + backup). */
function runApply(d: string, extra: string[] = []): string {
  return runScript(d, ['--apply', '--port=0', `--backup=${makeBackup(d)}`, ...extra]);
}

/** --apply FALHANDO: recebe as flags completas (a sonda de porta é opt-in por
 * chamada — não há --port duplicado, o `flag()` do script pega o primeiro). */
function runApplyFailing(d: string, extra: string[] = []): { status: number; stderr: string } {
  try {
    execFileSync(process.execPath, ['dist/scripts/crawl-repair-series-locations.js', '--apply',
      `--magnets=${path.join(d, 'magnets.db')}`, `--cache=${path.join(d, 'cache.db')}`, `--crawl=${path.join(d, 'crawl.db')}`, ...extra],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, stderr: '' };
  } catch (err: any) {
    return { status: err.status ?? 1, stderr: String(err.stderr || '') };
  }
}

describe('crawl-repair-series-locations (smoke)', { concurrency: false }, () => {
  test('dry-run: relatório correto, NADA gravado', async () => {
    const { DatabaseSync } = _require('node:sqlite');
    const d = dir();
    seed(d);
    const report = runScript(d);
    assert.match(report, /aa.*tt4574334 -1:-1 -> 1:-1/);
    assert.match(report, /ee.*tt5848272 -1:-1 -> 3:1/, 'dn vence título completo: move para S03E01');
    assert.match(report, /DRY-RUN/);
    const after = new DatabaseSync(path.join(d, 'magnets.db'));
    const st = after.prepare("SELECT COUNT(*) n FROM magnet_work WHERE imdb='tt4574334' AND season=1").get() as any;
    assert.equal(st.n, 0, 'dry-run não gravou');
    after.close();
  });

  test('--apply move raiz→S, preserva legítimo e raiz por dn-vence; cache e fila no escopo do Vaca', async () => {
    const { DatabaseSync } = _require('node:sqlite');
    const d = dir();
    seed(d);
    runApply(d);
    const db = new DatabaseSync(path.join(d, 'magnets.db'));
    const moved = db.prepare("SELECT season, episode, passed_filter, first_seen FROM magnet_work WHERE imdb='tt4574334' AND hash LIKE 'aa%'").get() as any;
    assert.deepEqual({ season: moved.season, episode: moved.episode }, { season: 1, episode: -1 });
    assert.equal(moved.passed_filter, 1, 'dados da linha preservados');
    const root = db.prepare("SELECT COUNT(*) n FROM magnet_work WHERE imdb='tt4574334' AND season=-1 AND hash LIKE 'bb%'").get() as any;
    assert.equal(root.n, 1, 'série inteira fica na raiz');
    const fallout = db.prepare("SELECT COUNT(*) n FROM magnet_work WHERE imdb='tt2442560' AND season=-1").get() as any;
    assert.equal(fallout.n, 1, 'obra fora do escopo não é tocada');
    // F4: conflito completo×temporada — o DN é conteúdo e vence o título.
    const dd = db.prepare("SELECT season, episode FROM magnet_work WHERE imdb='tt9475514' AND hash LIKE 'dd%'").get() as any;
    assert.deepEqual({ season: dd.season, episode: dd.episode }, { season: -1, episode: -1 },
      'título diz 2ª temporada mas dn declara série completa: FICA na raiz (mesma régua do runtime)');
    const ee = db.prepare("SELECT season, episode FROM magnet_work WHERE imdb='tt5848272' AND hash LIKE 'ee%'").get() as any;
    assert.deepEqual({ season: ee.season, episode: ee.episode }, { season: 3, episode: 1 },
      'título diz séries completas mas dn declara S03E01: move para S03E01');
    db.close();

    const cache = new DatabaseSync(path.join(d, 'cache.db'));
    const gone = (cache.prepare("SELECT COUNT(*) n FROM cache WHERE key='idx:v13:tt4574334'").get() as any).n;
    assert.equal(gone, 0, 'idx raiz do escopo apagada');
    const kept = (cache.prepare("SELECT COUNT(*) n FROM cache WHERE key='idx:v13:tt2442560'").get() as any).n;
    assert.equal(kept, 1, 'idx fora do escopo preservada');
    const keptEe = (cache.prepare("SELECT COUNT(*) n FROM cache WHERE key='idx:v13:tt5848272'").get() as any).n;
    assert.equal(keptEe, 0, 'idx raiz de obra movida (ee) também sai do escopo: erro foi todo para a raiz');
    cache.close();

    const crawl = new DatabaseSync(path.join(d, 'crawl.db'));
    const stRow = (crawl.prepare("SELECT status, tries FROM crawl_url WHERE url='https://x/st'").get() as any);
    assert.equal(stRow.status, 'pending', 'URL do escopo reenfileirada');
    const opRow = (crawl.prepare("SELECT status, error FROM crawl_url WHERE url='https://x/op'").get() as any);
    assert.equal(opRow.status, 'pending', 'series_truncated do Vaca entra no passe');
    assert.equal(opRow.error, '');
    const otherTrunc = (crawl.prepare("SELECT status, error FROM crawl_url WHERE site='outro-site' AND url='https://y/op'").get() as any);
    assert.equal(otherTrunc.status, 'error', 'F5: series_truncated de outro site NÃO é tocada');
    assert.match(otherTrunc.error, /^series_truncated/);
    const otherImdb = (crawl.prepare("SELECT status FROM crawl_url WHERE site='outro-site' AND url='https://y/st'").get() as any);
    assert.equal(otherImdb.status, 'done', 'F5: IMDb do escopo em outro site NÃO é tocado');
    crawl.close();
  });

  test('F6: --apply sem --backup recusa; backup incompleto/vazio recusa; nada grava', async () => {
    const d = dir();
    seed(d);
    const noBackup = runApplyFailing(d, ['--port=0']);
    assert.notEqual(noBackup.status, 0, 'recusa sem --backup');
    assert.match(noBackup.stderr, /--backup/);

    const missing = runApplyFailing(d, ['--port=0', '--backup=' + path.join(d, 'inexistente')]);
    assert.notEqual(missing.status, 0, 'recusa backup inexistente');

    const empty = path.join(d, 'vazio');
    fs.mkdirSync(empty);
    fs.writeFileSync(path.join(empty, 'magnets.db.bak'), 'x');
    const partial = runApplyFailing(d, ['--port=0', '--backup=' + empty]);
    assert.notEqual(partial.status, 0, 'recusa backup sem os três bancos');

    const zero = path.join(d, 'zero');
    fs.mkdirSync(zero);
    for (const base of ['magnets.db', 'cache.db', 'crawl.db']) fs.writeFileSync(path.join(zero, `${base}.bak`), '');
    const emptyFiles = runApplyFailing(d, ['--port=0', '--backup=' + zero]);
    assert.notEqual(emptyFiles.status, 0, 'recusa backup com cópia vazia');

    const { DatabaseSync } = _require('node:sqlite');
    const db = new DatabaseSync(path.join(d, 'magnets.db'));
    const n = db.prepare("SELECT COUNT(*) n FROM magnet_work WHERE imdb='tt4574334' AND season=1").get() as any;
    assert.equal(n.n, 0, 'nenhuma recusa gravou');
    db.close();
  });

  test('F6: --apply com porta respondendo recusa; lock presente recusa', async () => {
    const d = dir();
    seed(d);
    const backup = makeBackup(d);
    // Servidor TCP "addon vivo" na porta efêmera.
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as net.AddressInfo;
    try {
      const live = runApplyFailing(d, [`--backup=${backup}`, `--port=${addr.port}`]);
      assert.notEqual(live.status, 0, 'recusa com addon vivo na porta');
      assert.match(live.stderr, /respondendo/);

      const lock = path.join(d, 'meu.lock');
      fs.writeFileSync(lock, 'x');
      const locked = runApplyFailing(d, [`--backup=${backup}`, '--port=0', `--lock=${lock}`]);
      assert.notEqual(locked.status, 0, 'recusa com lock presente');
      assert.match(locked.stderr, /lock/);
    } finally {
      server.close();
    }

    // Sem porta viva e sem lock, o mesmo apply passa (gates não são permanentes).
    const ok = runScript(d, ['--apply', '--port=0', `--backup=${backup}`, `--lock=${path.join(d, 'nao-existe.lock')}`]);
    assert.match(ok, /APLICADO/);
  });
});
