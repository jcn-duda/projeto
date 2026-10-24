import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { parseRecoveryManifest, planRecovery } from '../scripts/crawl-recovery-preview-plan.js';
import type { RecoveryManifest, RecoveryRow } from '../scripts/crawl-recovery-preview-plan.js';

const require = createRequire(import.meta.url);
let hasSqlite = true;
try { await import('node:sqlite'); } catch { hasSqlite = false; }
const sqliteSkip = !hasSqlite && 'node:sqlite indisponível — precisa de Node 22+';

function tempDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'crawl-preview-')); }

function fixtureDb(file: string): void {
  const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (path: string) => any };
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE crawl_url (
      site TEXT NOT NULL, url TEXT NOT NULL, url_key TEXT NOT NULL DEFAULT '',
      lastmod TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'movie',
      status TEXT NOT NULL DEFAULT 'pending', imdb TEXT, tries INTEGER NOT NULL DEFAULT 0,
      next_at INTEGER NOT NULL DEFAULT 0, checked_at INTEGER NOT NULL DEFAULT 0,
      releases INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '',
      progress TEXT NOT NULL DEFAULT '', added_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (site, url_key)
    );
    CREATE TABLE crawl_state (site TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (site,key));
  `);
  const insert = db.prepare(`INSERT INTO crawl_url
    (site,url,url_key,lastmod,kind,status,imdb,tries,next_at,error)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  insert.run('hdrtorrents', 'https://hdr.test/filme/errado?auth=do-not-print', '/filme/errado',
    '2026-09-20T00:00:00Z', 'movie', 'done', 'tt1111111', 2, 999, 'old');
  insert.run('hdrtorrents', 'https://hdr.test/filme/widget', '/filme/widget',
    '2026-09-20T00:00:00Z', 'movie', 'done', 'tt9999999', 0, 0, '');
  insert.run('apachetorrent', 'https://apache.test/serie/kind', '/serie/kind',
    '2026-09-21T00:00:00Z', 'movie', 'done', 'tt2222222', 1, 200, '');
  insert.run('vacatorrent', 'https://vaca.test/obra/uma', '/obra/uma',
    '2026-09-10T00:00:00Z', 'tv_show', 'done', 'tt3333333', 1, 100, '');
  insert.run('vacatorrent', 'https://vaca.test/obra/duas', '/obra/duas',
    '2026-09-20T00:00:00Z', 'tv_show', 'pending', null, 0, 0, '');
  insert.run('vacatorrent', 'https://vaca.test/obra/ruim', '/obra/ruim',
    'ilegivel', 'tv_show', 'done', null, 0, 0, '');
  db.prepare('INSERT INTO crawl_state(site,key,value) VALUES (?,?,?)').run('vacatorrent', 'cursor:movie', 'https://secret.test/?token=nope');
  db.close();
}

function manifestFile(dir: string, value: unknown): string {
  const file = path.join(dir, 'evidence.json');
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

function baseManifest(entries: unknown[]): unknown {
  return { schema: 'crawl-recovery-evidence/v1', source: 'previous-check', entries };
}

function run(crawl: string, manifest: string, extra: string[] = []): string {
  return execFileSync(process.execPath, ['dist/scripts/crawl-recovery-preview.js', `--manifest=${manifest}`, `--crawl=${crawl}`, ...extra], { encoding: 'utf8' });
}

function digest(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('manifesto evidence/v1 valida tipos e rejeita campos, segredo e identidade duplicada', () => {
  const valid = parseRecoveryManifest(baseManifest([{
    type: 'identity', site: 'hdrtorrents', urlKey: 'https://hdr.test/filme/x?ref=1',
    expectedImdb: 'tt1234567', check: 'current-check', proof: 'canonical link checked',
  }]));
  assert.equal(valid.entries[0]?.type, 'identity');
  assert.throws(() => parseRecoveryManifest({ ...baseManifest([]) as object, schema: 'v2' }), /schema/);
  assert.throws(() => parseRecoveryManifest(baseManifest([{ type: 'identity', site: 'hdrtorrents', urlKey: '/x', expectedImdb: 'tt1', check: 'operator', proof: 'ok', extra: 1 }])), /desconhecido/);
  assert.throws(() => parseRecoveryManifest(baseManifest([{ type: 'identity', site: 'hdrtorrents', urlKey: '/x', expectedImdb: 'tt1', check: 'operator', proof: 'magnet:?xt=urn:btih:secret' }])), /secreto/);
  const duplicate = { type: 'identity', site: 'hdrtorrents', urlKey: '/x', expectedImdb: 'tt1', check: 'operator', proof: 'checked' };
  assert.throws(() => parseRecoveryManifest(baseManifest([duplicate, duplicate])), /duplicada/);
  assert.throws(() => parseRecoveryManifest(baseManifest([{ type: 'discovery-gap', site: 'vaca', urlKey: '/x', hint: { urlKeyPrefix: '/x' }, check: 'operator' }])), /OU/);
});

test('planner é puro: divergência explícita gera proposta e caso correto é no-op', () => {
  const row = (urlKey: string, imdb: string | null, status: string): RecoveryRow => ({
    site: 'hdrtorrents', url: `https://hdr.test${urlKey}`, urlKey, lastmod: '', kind: 'movie',
    status: status as RecoveryRow['status'], imdb, tries: 1, nextAt: 5, checkedAt: 0,
    releases: 0, error: '', progress: '', addedAt: 0,
  });
  const manifest = parseRecoveryManifest(baseManifest([
    { type: 'identity', site: 'hdrtorrents', urlKey: '/wrong', expectedImdb: 'tt222', check: 'current-check', proof: 'title/year confirmed' },
    { type: 'identity', site: 'hdrtorrents', urlKey: '/right', expectedImdb: 'tt333', check: 'previous-check', proof: 'canonical link' },
    { type: 'identity', site: 'hdrtorrents', urlKey: '/busy', expectedImdb: 'tt444', check: 'operator', proof: 'verified' },
    { type: 'identity', site: 'hdrtorrents', urlKey: '/queued', expectedImdb: 'tt555', check: 'operator', proof: 'verified' },
  ]));
  const inputRows = [row('/wrong', 'tt111', 'done'), row('/right', 'tt333', 'done'), row('/busy', null, 'inflight'), row('/queued', 'tt111', 'pending')];
  const plan = planRecovery(inputRows, manifest);
  assert.equal(plan.proposals.length, 1);
  assert.equal(plan.proposals[0]?.reason, 'identity-divergence');
  assert.deepEqual(plan.proposals[0]?.desired, { status: 'pending', nextAt: 0 });
  assert.deepEqual(plan.noops.map((item) => item.reason), ['already-correct', 'identity-divergence-already-queued']);
  assert.deepEqual(plan.reports.map((item) => item.reason), ['inflight-skip']);
  assert.deepEqual(planRecovery(inputRows, manifest), plan);
});

test('planner limita discovery-gap aos caminhos com prova; lastmod ilegível fica ambíguo', () => {
  const rows: RecoveryRow[] = [
    { site: 'vacatorrent', url: '', urlKey: '/obras/uma', lastmod: '2026-09-10T00:00:00Z', kind: 'movie', status: 'done', imdb: null, tries: 0, nextAt: 0, checkedAt: 0, releases: 0, error: '', progress: '', addedAt: 0 },
    { site: 'vacatorrent', url: '', urlKey: '/obras/duas', lastmod: 'ilegivel', kind: 'movie', status: 'done', imdb: null, tries: 0, nextAt: 0, checkedAt: 0, releases: 0, error: '', progress: '', addedAt: 0 },
  ];
  const manifest: RecoveryManifest = parseRecoveryManifest(baseManifest([
    { type: 'discovery-gap', site: 'vacatorrent', hint: { lastmodFrom: '2026-09-01T00:00:00Z', lastmodTo: '2026-09-30T00:00:00Z' }, check: 'previous-check' },
    { type: 'discovery-gap', site: 'vacatorrent', urlKey: '/missing', check: 'operator' },
  ]));
  const plan = planRecovery(rows, manifest);
  assert.equal(plan.proposals.length, 1);
  assert.equal(plan.proposals[0]?.urlKey, '/obras/uma');
  assert.equal(plan.reports[0]?.reason, 'gap-unverifiable-lastmod');
  assert.equal(plan.reports[1]?.reason, 'gap-unverifiable-offline');
});

test('CLI é read-only, só seleciona evidência do manifesto e não vaza URLs/segredos', { skip: sqliteSkip }, () => {
  const dir = tempDir();
  const db = path.join(dir, 'crawl.db');
  fixtureDb(db);
  const evidence = manifestFile(dir, baseManifest([
    { type: 'identity', site: 'hdrtorrents', urlKey: '/filme/errado', expectedImdb: 'tt8888888', check: 'current-check', proof: 'reidentified without widget' },
    { type: 'identity', site: 'apachetorrent', urlKey: '/serie/kind', expectedImdb: 'tt2222222', expectedKind: 'tv_show', check: 'operator', proof: 'type verified' },
    { type: 'discovery-gap', site: 'vacatorrent', hint: { urlKeyPrefix: '/obra/', lastmodFrom: '2026-09-01T00:00:00Z', lastmodTo: '2026-09-30T23:59:59Z' }, check: 'previous-check' },
    { type: 'identity', site: 'hdrtorrents', urlKey: '/absent', expectedImdb: 'tt0000000', check: 'operator', proof: 'checked' },
  ]));
  const before = digest(db);
  const output = run(db, evidence);
  assert.match(output, /PROPOSTA requeue-url hdrtorrents \/filme\/errado motivo=identity-divergence/);
  assert.match(output, /PROPOSTA requeue-url apachetorrent \/serie\/kind motivo=identity-divergence/);
  assert.match(output, /PROPOSTA requeue-url vacatorrent \/obra\/uma motivo=discovery-gap-reread/);
  assert.match(output, /NO-OP vacatorrent \/obra\/duas motivo=already-queued/);
  assert.match(output, /RELATO vacatorrent \/obra\/ruim motivo=gap-unverifiable-lastmod/);
  assert.match(output, /RELATO hdrtorrents \/absent motivo=row-not-found/);
  assert.doesNotMatch(output, /\/filme\/widget|auth=|token=nope|secret\.test/);
  assert.equal(digest(db), before, 'prévia não alterou o banco');
});

test('CLI valida manifesto antes de tentar abrir banco e não oferece apply', { skip: sqliteSkip }, () => {
  const dir = tempDir();
  const nonexistent = path.join(dir, 'absent.db');
  const bad = manifestFile(dir, { schema: 'wrong' });
  const invalid = spawnSync(process.execPath, ['dist/scripts/crawl-recovery-preview.js', `--manifest=${bad}`, `--crawl=${nonexistent}`], { encoding: 'utf8' });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /manifesto inválido/);
  assert.doesNotMatch(invalid.stderr, /banco não pôde ser lido/);
  const valid = manifestFile(dir, baseManifest([]));
  const apply = spawnSync(process.execPath, ['dist/scripts/crawl-recovery-preview.js', `--manifest=${valid}`, `--crawl=${nonexistent}`, '--apply'], { encoding: 'utf8' });
  assert.notEqual(apply.status, 0);
  assert.match(apply.stderr, /não tem --apply/);
});

test('CLI relata banco ausente ou vazio sem criar arquivos SQLite', { skip: sqliteSkip }, () => {
  const dir = tempDir();
  const evidence = manifestFile(dir, baseManifest([
    { type: 'identity', site: 'hdrtorrents', urlKey: '/missing', expectedImdb: 'tt123', check: 'operator', proof: 'verified' },
  ]));
  const absent = path.join(dir, 'absent.db');
  const absentOut = run(absent, evidence);
  assert.match(absentOut, /crawl\.db ausente\/vazio/);
  assert.match(absentOut, /row-not-found/);
  const empty = path.join(dir, 'empty.db');
  fs.writeFileSync(empty, '');
  const emptyOut = run(empty, evidence);
  assert.match(emptyOut, /crawl\.db ausente\/vazio/);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith('empty.db-')), []);
});

test('CLI verifica backup referenciado sem exigir ou gravar a cópia', { skip: sqliteSkip }, () => {
  const dir = tempDir();
  const db = path.join(dir, 'crawl.db');
  fixtureDb(db);
  const backup = path.join(dir, 'backup');
  fs.mkdirSync(backup);
  fs.writeFileSync(path.join(backup, 'crawl.db.before'), 'fixture backup');
  const valid = manifestFile(dir, { ...(baseManifest([]) as object), backup: { dir: backup } });
  assert.match(run(db, valid), /backup: cópia crawl\.db não vazia encontrada/);
  const missing = manifestFile(dir, { ...(baseManifest([]) as object), backup: { dir: path.join(dir, 'missing-backup') } });
  assert.match(run(db, missing), /backup: não verificado/);
  assert.equal(fs.readFileSync(path.join(backup, 'crawl.db.before'), 'utf8'), 'fixture backup');
});

test('CLI com WAL pré-existente preserva bytes de db e wal', { skip: sqliteSkip }, () => {
  const dir = tempDir();
  const dbPath = path.join(dir, 'base.db');
  const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (path: string) => any };
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec(`CREATE TABLE crawl_url (site TEXT, url TEXT, url_key TEXT, lastmod TEXT, kind TEXT, status TEXT, imdb TEXT, tries INTEGER, next_at INTEGER, checked_at INTEGER, releases INTEGER, error TEXT, progress TEXT, added_at INTEGER, PRIMARY KEY(site,url_key)); CREATE TABLE crawl_state(site TEXT,key TEXT,value TEXT,updated_at INTEGER,PRIMARY KEY(site,key))`);
  db.prepare('INSERT INTO crawl_url(site,url,url_key,lastmod,kind,status,imdb,tries,next_at,checked_at,releases,error,progress,added_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('hdrtorrents', 'https://hdr.test/x', '/x', '', 'movie', 'done', 'tt1', 0, 0, 0, 0, '', '', 0);
  const hot = path.join(dir, 'hot.db');
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(`${dbPath}${suffix}`)) fs.copyFileSync(`${dbPath}${suffix}`, `${hot}${suffix}`);
  }
  assert.ok(fs.existsSync(`${hot}-wal`), 'fixture precisa carregar WAL para verificar bytes');
  db.close();
  const evidence = manifestFile(dir, baseManifest([{ type: 'identity', site: 'hdrtorrents', urlKey: '/x', expectedImdb: 'tt2', check: 'operator', proof: 'checked' }]));
  const before = new Map(['', '-wal', '-shm']
    .filter((suffix) => fs.existsSync(`${hot}${suffix}`))
    .map((suffix) => [suffix, `${digest(`${hot}${suffix}`)}:${fs.statSync(`${hot}${suffix}`).size}`]));
  run(hot, evidence);
  for (const [suffix, snapshot] of before) {
    const [hash, size] = snapshot.split(':');
    if (suffix === '-shm') assert.equal(fs.statSync(`${hot}${suffix}`).size, Number(size), 'tamanho do shm preservado');
    else assert.equal(digest(`${hot}${suffix}`), hash, `${suffix || 'db'} byte-imutável`);
  }
});
