// Testes do reenfileiramento de recuperação (scripts/crawl-recovery-requeue).
// SEMPRE banco temporário em tmp: NUNCA data/crawl.db, NUNCA data/cache.db
// (o módulo do plano não importa config nem store — o CLI só é executado por
// subprocesso apontando --crawl para o banco da fixture).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { probePort } from '../scripts/crawl-requeue-probe.js';
import {
  CANDIDATE_SQL, MICO_OWN_PACE_ERROR, REQUEUE_UPDATE_SQL, VICTIM_SQL,
  completionMs, planRequeue, rowFromSqlite,
} from '../scripts/crawl-requeue-plan.js';
import type { RequeueRow } from '../scripts/crawl-requeue-plan.js';

const require = createRequire(import.meta.url);
let hasSqlite = true;
try { await import('node:sqlite'); } catch { hasSqlite = false; }
const sqliteSkip = !hasSqlite && 'node:sqlite indisponível — precisa de Node 22+';

const CLI = 'dist/scripts/crawl-recovery-requeue.js';
const HOUR = 3_600_000;

function tempDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'crawl-requeue-')); }

function fixtureDb(file: string): { inside: number; outside: number } {
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
  `);
  const inside = Date.now() - HOUR;
  const outside = inside - 47 * HOUR;
  const insert = db.prepare(`INSERT INTO crawl_url
    (site,url,url_key,status,tries,next_at,checked_at,releases,error,progress,added_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  // nerdfilmes: vítimas (janela, fallback added_at) e não-vítimas.
  insert.run('nerdfilmes', 'https://nf.test/filme/a', '/filme/a', 'done', 1, 0, inside, 0, '', '', 0);
  insert.run('nerdfilmes', 'https://nf.test/filme/fallback', '/filme/fallback', 'done', 0, 0, 0, 0, '', '', inside);
  insert.run('nerdfilmes', 'https://nf.test/filme/velha', '/filme/velha', 'done', 2, 0, outside, 0, '', '', outside);
  insert.run('nerdfilmes', 'https://nf.test/filme/comrel', '/filme/comrel', 'done', 1, 0, inside, 5, '', '', 0);
  insert.run('nerdfilmes', 'https://nf.test/filme/pend', '/filme/pend', 'pending', 0, 0, 0, 0, '', '', 0);
  // mico: vítima (texto exato), fora da janela, erro outro, erro loose.
  insert.run('mico', 'https://mico.test/obra/a', '/obra/a', 'error', 3, 0, inside, 0, MICO_OWN_PACE_ERROR, '{"fatia":1}', 0);
  insert.run('mico', 'https://mico.test/obra/velha', '/obra/velha', 'error', 3, 0, outside, 0, MICO_OWN_PACE_ERROR, '', 0);
  insert.run('mico', 'https://mico.test/obra/outro', '/obra/outro', 'error', 1, 500, inside, 0, 'timeout de rede', '', 0);
  insert.run('mico', 'https://mico.test/obra/loose', '/obra/loose', 'error', 1, 0, inside, 0, 'mico: ritmo próprio (v2 do motor)', '', 0);
  // Controles fora do escopo.
  insert.run('vacatorrent', 'https://vaca.test/obra/x', '/obra/x', 'done', 1, 0, inside, 0, '', '', 0);
  insert.run('mico', 'https://mico.test/obra/done', '/obra/done', 'done', 1, 0, inside, 0, '', '', 0);
  db.close();
  return { inside, outside };
}

interface LoadedDb { db: any; close: () => void; candidates: () => RequeueRow[]; sqlKeys: (where: string, ...params: unknown[]) => Set<string>; raw: (key: string) => Record<string, unknown> | undefined }

function openFixture(file: string): LoadedDb {
  const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (path: string) => any };
  const db = new DatabaseSync(file);
  return {
    db,
    close: () => db.close(),
    candidates: () => (db.prepare(CANDIDATE_SQL).all('nerdfilmes', 'mico') as Array<Record<string, unknown>>).map(rowFromSqlite),
    sqlKeys: (where: string, ...params: unknown[]) => new Set(
      (db.prepare(`SELECT site, url_key FROM crawl_url WHERE ${where}`).all(...params) as Array<Record<string, unknown>>)
        .map((r) => `${r.site}\0${r.url_key}`),
    ),
    raw: (key: string) => (db.prepare('SELECT * FROM crawl_url WHERE site = ? AND url_key = ?')
      .get(...key.split('\0')) as Record<string, unknown> | undefined),
  };
}

function digest(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function runCli(extra: string[]): string {
  return execFileSync(process.execPath, [CLI, ...extra], { encoding: 'utf8' });
}

function runCliFails(extra: string[]): string {
  try {
    execFileSync(process.execPath, [CLI, ...extra], { encoding: 'utf8' });
  } catch (err) {
    const e = err as { stderr?: Buffer | string };
    return String(e.stderr ?? e);
  }
  assert.fail('o CLI deveria ter recusado (exit != 0)');
}

const NOW = Date.now();
const OPTS = { sinceMs: NOW - 24 * HOUR, micoError: MICO_OWN_PACE_ERROR };

test('sonda distingue porta fechada de erro de acesso e prazo esgotado', async () => {
  const simulate = (event: 'connect' | 'error' | 'timeout', code?: string) => {
    const socket = new EventEmitter() as net.Socket;
    let destroyed = false;
    socket.destroy = () => { destroyed = true; return socket; };
    const result = probePort(7000, () => socket);
    const error = Object.assign(new Error(code), { code });
    socket.emit(event, error);
    assert.equal(destroyed, true);
    return result;
  };
  assert.equal(await simulate('connect'), true);
  assert.equal(await simulate('error', 'ECONNREFUSED'), false);
  await assert.rejects(simulate('error', 'EACCES'), /EACCES/);
  await assert.rejects(simulate('timeout'), /tempo esgotado/);
});

test('seleção pura: vítimas por critério, janela, fallback added_at e relato loose', () => {
  const rows: RequeueRow[] = [
    { site: 'nerdfilmes', url: 'u', urlKey: '/a', status: 'done', tries: 1, nextAt: 0, checkedAt: NOW - HOUR, addedAt: 0, releases: 0, error: '', progress: '' },
    { site: 'nerdfilmes', url: 'u', urlKey: '/b', status: 'done', tries: 0, nextAt: 0, checkedAt: 0, addedAt: NOW - HOUR, releases: 0, error: '', progress: '' },
    { site: 'nerdfilmes', url: 'u', urlKey: '/fora', status: 'done', tries: 1, nextAt: 0, checkedAt: NOW - 48 * HOUR, addedAt: 0, releases: 0, error: '', progress: '' },
    { site: 'nerdfilmes', url: 'u', urlKey: '/rel', status: 'done', tries: 1, nextAt: 0, checkedAt: NOW - HOUR, addedAt: 0, releases: 5, error: '', progress: '' },
    { site: 'mico', url: 'u', urlKey: '/m', status: 'error', tries: 3, nextAt: 0, checkedAt: NOW - HOUR, addedAt: 0, releases: 0, error: MICO_OWN_PACE_ERROR, progress: 'x' },
    { site: 'mico', url: 'u', urlKey: '/loose', status: 'error', tries: 1, nextAt: 0, checkedAt: NOW - HOUR, addedAt: 0, releases: 0, error: 'mico: ritmo próprio (v2)', progress: '' },
    { site: 'mico', url: 'u', urlKey: '/outro', status: 'error', tries: 1, nextAt: 500, checkedAt: NOW - HOUR, addedAt: 0, releases: 0, error: 'timeout', progress: '' },
    { site: 'mico', url: 'u', urlKey: '/velho', status: 'error', tries: 3, nextAt: 0, checkedAt: NOW - 48 * HOUR, addedAt: 0, releases: 0, error: MICO_OWN_PACE_ERROR, progress: '' },
  ];
  const plan = planRequeue(rows, OPTS);
  assert.deepEqual(plan.nerdfilmes.map((v) => v.urlKey), ['/a', '/b']);
  assert.deepEqual(plan.mico.map((v) => v.urlKey), ['/m']);
  assert.deepEqual(plan.micoLooseOnly.map((v) => v.urlKey), ['/loose']);
  assert.deepEqual(plan.outsideWindow, { nerdfilmes: 1, mico: 1, micoLooseOnly: 0 });
  const nf = plan.nerdfilmes[0];
  assert.equal(nf?.guardStatus, 'done');
  const mico = plan.mico[0];
  assert.equal(mico?.guardStatus, 'error');
  assert.equal(mico?.criterion, 'mico');
  // Override do texto do mico: o loose passa a ser vítima exata do novo texto.
  const override = planRequeue(rows, { sinceMs: OPTS.sinceMs, micoError: 'mico: ritmo próprio (v2)' });
  assert.deepEqual(override.mico.map((v) => v.urlKey), ['/loose']);
  assert.deepEqual(override.micoLooseOnly.map((v) => v.urlKey), ['/m']);
  // Janela desligada: as fora-da-janela viram vítimas.
  const semJanela = planRequeue(rows, { sinceMs: 0, micoError: MICO_OWN_PACE_ERROR });
  assert.equal(semJanela.nerdfilmes.length, 3);
  assert.equal(semJanela.mico.length, 2);
  // completionMs espelha COALESCE(NULLIF(checked_at,0), added_at).
  assert.equal(completionMs(rows[1] as RequeueRow), NOW - HOUR);
});

test('paridade: VICTIM_SQL sobre o banco devolve as MESMAS vítimas da seleção pura', { skip: sqliteSkip }, () => {
  const dir = tempDir();
  const file = path.join(dir, 'crawl.db');
  fixtureDb(file);
  const fx = openFixture(file);
  try {
    const plan = planRequeue(fx.candidates(), OPTS);
    const jsNf = new Set(plan.nerdfilmes.map((v) => `${v.site}\0${v.urlKey}`));
    const jsMico = new Set(plan.mico.map((v) => `${v.site}\0${v.urlKey}`));
    const jsLoose = new Set(plan.micoLooseOnly.map((v) => `${v.site}\0${v.urlKey}`));
    const since = OPTS.sinceMs;
    assert.deepEqual(fx.sqlKeys(VICTIM_SQL.nerdfilmes, since), jsNf);
    assert.deepEqual(fx.sqlKeys(VICTIM_SQL.mico, OPTS.micoError, since), jsMico);
    assert.deepEqual(fx.sqlKeys(VICTIM_SQL.micoLoose, OPTS.micoError, since), jsLoose);
  } finally { fx.close(); }
});

test('UPDATE de requeue: zera status/tries/next_at/error/progress e PRESERVA releases/checked_at/added_at; guarda prote linha mudada', { skip: sqliteSkip }, () => {
  const dir = tempDir();
  const file = path.join(dir, 'crawl.db');
  const { inside } = fixtureDb(file);
  const fx = openFixture(file);
  try {
    const plan = planRequeue(fx.candidates(), OPTS);
    const update = fx.db.prepare(REQUEUE_UPDATE_SQL);
    let executed = 0;
    for (const v of [...plan.nerdfilmes, ...plan.mico]) {
      executed += Number((update.run(v.site, v.urlKey, v.guardStatus) as { changes?: number }).changes) || 0;
    }
    assert.equal(executed, 3);
    const key = (v: { site: string; urlKey: string }): string => `${v.site}\0${v.urlKey}`;
    const insideNf = fx.raw(key({ site: 'nerdfilmes', urlKey: '/filme/a' })) as Record<string, unknown>;
    assert.equal(String(insideNf.status), 'pending');
    assert.equal(Number(insideNf.tries), 0);
    assert.equal(Number(insideNf.next_at), 0);
    assert.equal(String(insideNf.error), '');
    assert.equal(String(insideNf.progress), '');
    assert.equal(Number(insideNf.releases), 0);
    assert.equal(Number(insideNf.checked_at), inside);
    const fallbackNf = fx.raw(key({ site: 'nerdfilmes', urlKey: '/filme/fallback' })) as Record<string, unknown>;
    assert.equal(String(fallbackNf.status), 'pending');
    assert.equal(Number(fallbackNf.added_at), inside);
    const mico = fx.raw(key({ site: 'mico', urlKey: '/obra/a' })) as Record<string, unknown>;
    assert.equal(String(mico.status), 'pending');
    assert.equal(Number(mico.tries), 0);
    assert.equal(String(mico.progress), '');
    assert.equal(String(mico.error), '');
    // Fora da janela e não-vítimas intocados.
    const velha = fx.raw(key({ site: 'nerdfilmes', urlKey: '/filme/velha' })) as Record<string, unknown>;
    assert.equal(String(velha.status), 'done');
    assert.equal(Number(velha.tries), 2);
    const comrel = fx.raw(key({ site: 'nerdfilmes', urlKey: '/filme/comrel' })) as Record<string, unknown>;
    assert.equal(String(comrel.status), 'done');
    assert.equal(Number(comrel.releases), 5);
    const loose = fx.raw(key({ site: 'mico', urlKey: '/obra/loose' })) as Record<string, unknown>;
    assert.equal(String(loose.status), 'error');
    // GUARDA: linha que virou inflight entre seleção e update não é tocada.
    fx.db.prepare("UPDATE crawl_url SET status = 'inflight' WHERE site = 'nerdfilmes' AND url_key = '/filme/a'").run();
    const guarded = update.run('nerdfilmes', '/filme/a', 'done') as { changes?: number };
    assert.equal(Number(guarded.changes), 0);
    assert.equal(String((fx.raw(key({ site: 'nerdfilmes', urlKey: '/filme/a' })) as Record<string, unknown>).status), 'inflight');
  } finally { fx.close(); }
});

test('CLI dry-run: relatório completo, banco byte-idêntico e db vazio é no-op', { skip: sqliteSkip }, () => {
  const dir = tempDir();
  const file = path.join(dir, 'crawl.db');
  fixtureDb(file);
  const before = digest(file);
  const out = runCli([`--crawl=${file}`, `--lock=${path.join(dir, 'l.lock')}`]);
  assert.match(out, /nerdfilmes \(done \+ releases=0\): 2 vítima\(s\)/);
  assert.match(out, /FORA da janela: 1/);
  assert.match(out, /mico \(error = texto exato\): 1 vítima\(s\)/);
  assert.match(out, /RELATO: 1 erro\(s\) de "ritmo próprio"/);
  assert.match(out, /total planejado: 3 linha\(s\)/);
  assert.match(out, /DRY-RUN \(nada gravado/);
  assert.match(out, /AMOSTRA nerdfilmes \/filme\/a/);
  assert.equal(digest(file), before, 'dry-run não pode alterar o arquivo do banco');
  // --since-hours=0 alarga a janela: todas as 5 viram vítimas no relatório.
  const wide = runCli([`--crawl=${file}`, '--since-hours=0', `--lock=${path.join(dir, 'l2.lock')}`]);
  assert.match(wide, /total planejado: 5 linha\(s\)/);
  // Banco vazio/ausente: no-op limpo (exit 0).
  const empty = path.join(dir, 'vazio.db');
  fs.writeFileSync(empty, '');
  assert.match(runCli([`--crawl=${empty}`, `--lock=${path.join(dir, 'l3.lock')}`]), /NADA a fazer/);
  assert.match(runCli([`--crawl=${path.join(dir, 'ausente.db')}`, `--lock=${path.join(dir, 'l4.lock')}`]), /NADA a fazer/);
});

test('CLI --apply: grava só as vítimas na janela, com backup/lock/sondas desligadas', { skip: sqliteSkip }, () => {
  const dir = tempDir();
  const file = path.join(dir, 'crawl.db');
  fixtureDb(file);
  const backup = path.join(dir, 'backup');
  fs.mkdirSync(backup);
  fs.copyFileSync(file, path.join(backup, 'crawl.db'));
  const out = runCli([
    '--apply', `--crawl=${file}`, `--backup=${backup}`,
    '--port=0', '--sidecar-port=0', `--lock=${path.join(dir, 'a.lock')}`,
  ]);
  assert.match(out, /3 linha\(s\) reenfileirada\(s\)/);
  assert.match(out, /APLICADO/);
  const fx = openFixture(file);
  try {
    const rows = new Set((fx.db.prepare('SELECT site, url_key, status FROM crawl_url').all() as Array<Record<string, unknown>>)
      .map((r) => `${r.site}\0${r.url_key}\0${r.status}`));
    assert.ok(rows.has('nerdfilmes\0/filme/a\0pending'));
    assert.ok(rows.has('nerdfilmes\0/filme/fallback\0pending'));
    assert.ok(rows.has('mico\0/obra/a\0pending'));
    assert.ok(rows.has('nerdfilmes\0/filme/velha\0done'), 'fora da janela intocada');
    assert.ok(rows.has('mico\0/obra/velha\0error'), 'fora da janela intocada');
    assert.ok(rows.has('mico\0/obra/loose\0error'), 'loose não é vítima');
  } finally { fx.close(); }
});

test('CLI --apply recusa: sem backup, com addon/sidecar vivo e com lock alheio', { skip: sqliteSkip }, async () => {
  const dir = tempDir();
  const file = path.join(dir, 'crawl.db');
  fixtureDb(file);
  const backup = path.join(dir, 'backup');
  fs.mkdirSync(backup);
  fs.copyFileSync(file, path.join(backup, 'crawl.db'));
  // 1. Sem --backup.
  assert.match(runCliFails(['--apply', `--crawl=${file}`, '--port=0', '--sidecar-port=0', `--lock=${path.join(dir, 'r1.lock')}`]), /exige --backup/);
  assert.match(runCliFails(['--apply', `--crawl=${file}`, '--port=abc']), /--port deve ser uma porta válida/);
  assert.match(runCliFails(['--apply', `--crawl=${file}`, '--port=0', '--sidecar-port=65536']), /--sidecar-port deve ser uma porta válida/);
  // 2. Addon respondendo na porta sonda.
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  try {
    assert.match(runCliFails(['--apply', `--crawl=${file}`, `--backup=${backup}`, `--port=${port}`, '--sidecar-port=0', `--lock=${path.join(dir, 'r2.lock')}`]), /addon vivo no volume/);
  } finally { server.close(); }
  // 3. Sidecar respondendo (dono do banco com CRAWL_ENGINE=rust).
  const sidecar = net.createServer();
  await new Promise<void>((resolve) => sidecar.listen(0, '127.0.0.1', resolve));
  const sidecarPort = (sidecar.address() as net.AddressInfo).port;
  try {
    assert.match(runCliFails(['--apply', `--crawl=${file}`, `--backup=${backup}`, '--port=0', `--sidecar-port=${sidecarPort}`, `--lock=${path.join(dir, 'r3.lock')}`]), /sidecar Rust/);
  } finally { sidecar.close(); }
  // 4. Lock alheio presente.
  const lock = path.join(dir, 'alheio.lock');
  fs.writeFileSync(lock, 'outro');
  assert.match(runCliFails(['--apply', `--crawl=${file}`, `--backup=${backup}`, '--port=0', '--sidecar-port=0', `--lock=${lock}`]), /lock/);
});
