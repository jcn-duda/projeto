// Remediação ONE-SHOT dos dados do Defeito A da Fase 7 (plano v2, seção 5):
// releases de série gravadas na RAIZ da obra (`magnet_work` com
// season=-1/episode=-1) quando o título/dn declara TEMPORADA — os 9 hashes de
// Stranger Things `E01..E08` medidos em produção, os batches raiz de
// Reacher/Dexter/The Last of Us etc.
//
// O que faz (nesta ordem — deploy do fix ANTES deste script; a mutação segue
// a MESMA ordem do reporte: magnets → cache → crawl):
//   1. magnets.db: varre `magnet_work` raiz agrupado por imdb; a régua de
//      locação é a MESMA do runtime (F4): `declaredSeriesLocation`
//      (`vaca-series-locate.ts`), onde o dn do magnet VENCE qualquer evidência
//      de página — título que diz S01 com dn de série inteira FICA na raiz,
//      exatamente como o motor gravaria hoje. Linha que declara temporada
//      única é MOVIDA para a chave certa (DELETE + INSERT dentro de UMA
//      transação com rollback; PK `(hash,imdb,season,episode)` preserva
//      first/last_seen/passed_filter). Raiz legítima FICA.
//   2. cache.db: apaga as chaves RAIZ `idx:v13:<imdb>` do escopo (transação
//      própria). O erro foi todo para a raiz; as chaves S/S:E não existiam.
//   3. crawl.db: URL do escopo daquele SITE (F5: só `vacatorrent` — a máquina
//      de fatias é do adaptador Vaca; erro `series_truncated` de outro site
//      não entra) volta a `pending` do zero (transação própria); o motor
//      reprocessa com o adaptador corrigido.
//
// Segurança (F6):
//   - `--dry-run` é o DEFAULT e só imprime o relatório; nada grava sem
//     `--apply`.
//   - `--apply` RECUSA addon vivo: porta TCP respondendo em
//     `127.0.0.1:<porta>` (default 7000; `--port=<n>`, `--port=0` desliga a
//     sonda) OU lock file existente (`--lock=<path>`, default
//     `data/crawl-repair.lock`).
//   - `--apply` EXIGE `--backup=<dir>` verificável: diretório existente com
//     uma cópia NÃO VAZIA de cada banco (`magnets.db*`, `cache.db*`,
//     `crawl.db*` — sufixo livre). Rollback = restaurar essas cópias.
//   - Conexões com `busy_timeout=5000`; cada banco muta dentro de transação
//     única com rollback.
//
// Uso:
//   node dist/scripts/crawl-repair-series-locations.js            # relatório
//   node dist/scripts/crawl-repair-series-locations.js --apply \
//     --backup=data/backup-2026-09-27                             # executa
//   Flags: --magnets=<path> --cache=<path> --crawl=<path> (default: data/*)
//   Runbook: docs/crawl-repair-series-locations.md
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const flag = (name: string): string | null => {
  const a = args.find((v) => v.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
};

const DATA = path.resolve('data');
const magnetsPath = flag('magnets') ?? path.join(DATA, 'magnets.db');
const cachePath = flag('cache') ?? path.join(DATA, 'cache.db');
const crawlPath = flag('crawl') ?? path.join(DATA, 'crawl.db');
/** F5: a máquina de fatias/fatiamento de série é do adaptador Vaca — o passe
 * de requeue da fila só alcança o site dele. */
const REPAIR_SITE = 'vacatorrent';

function fail(message: string): never {
  console.error(`[repair] RECUSADO: ${message}`);
  process.exit(1);
}

// --- F6: portas de segurança do --apply --------------------------------------

/** Porta TCP respondendo em loopback = addon (ou qualquer serviço) vivo no
 * mesmo volume dos bancos. `--port=0` desliga a sonda (uso em teste). */
function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port, timeout: 1500 });
    const done = (up: boolean) => { socket.destroy(); resolve(up); };
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}

/** Backup verificável: diretório existente com cópia não vazia de cada banco
 * (nome começa com o basename do banco; sufixo livre). */
function verifyBackup(dirPath: string): void {
  if (!dirPath) fail('--apply exige --backup=<dir> com cópia dos três bancos.');
  let stat: fs.Stats;
  try { stat = fs.statSync(dirPath); } catch { fail(`backup não encontrado: ${dirPath}`); }
  if (!stat.isDirectory()) fail(`backup não é diretório: ${dirPath}`);
  for (const db of [magnetsPath, cachePath, crawlPath]) {
    const base = path.basename(db);
    const hit = fs.readdirSync(dirPath).filter((f) => f === base || f.startsWith(`${base}.`))
      .map((f) => path.join(dirPath, f))
      .find((f) => { try { return fs.statSync(f).size > 0; } catch { return false; } });
    if (!hit) fail(`backup sem cópia não vazia de ${base} em ${dirPath}`);
  }
}

const { parseTitleSeasonEpisode } = await import('../src/utils/episode-matching.js');
const { declaredSeriesLocation } = await import('../src/providers/crawl-sites/vaca-series-locate.js');

function openDb(file: string): any {
  const { DatabaseSync } = _require('node:sqlite');
  if (!fs.existsSync(file)) {
    throw new Error(`banco não encontrado: ${file}`);
  }
  const db = new DatabaseSync(file);
  // F6: o addon parado pode ter deixado WAL quente / outro leitor (backup,
  // auditoria) — esperar é melhor que falhar a remediação no meio.
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

/** Transação única com rollback: ou o passo inteiro, ou nada. O erro ORIGINAL
 * é o que sobe (a falha do rollback não o mascara). */
function inTransaction(db: any, body: () => void): void {
  db.exec('BEGIN');
  let started = true;
  try {
    body();
    db.exec('COMMIT');
    started = false;
  } finally {
    if (started) { try { db.exec('ROLLBACK'); } catch { /* erro original sobe */ } }
  }
}

// --- 1. magnets.db: relatório ------------------------------------------------

const db = openDb(magnetsPath);
const rootRows = db.prepare(`
  SELECT w.hash, w.imdb, w.first_seen, w.last_seen, w.passed_filter,
         m.title, m.uri
  FROM magnet_work w JOIN magnet m ON m.hash = w.hash
  WHERE w.season = -1 AND w.episode = -1
  ORDER BY w.imdb, w.hash
`).all() as Array<Record<string, unknown>>;

/** Locação declarada (F4): MESMA função do runtime — o dn do magnet vence
 * qualquer evidência de página, e a raiz (legítima ou silenciosa) fica. */
function declared(title: string, dn: string): { season: number; episode: number } | null {
  const loc = declaredSeriesLocation({
    cardSeason: null, cardTitle: title, isBatch: true,
    realTitle: null, dn: dn || null, linkEpisode: null,
  });
  if (loc.season == null) return null; // raiz legítima ou pista nenhuma: fica
  return { season: loc.season, episode: loc.episode ?? -1 };
}

const moves: Array<{ imdb: string; hash: string; from: string; to: string; title: string; evidence: string }> = [];
const rootKept = new Map<string, number>();
for (const r of rootRows) {
  const imdb = String(r.imdb || '');
  const title = String(r.title || '');
  const uri = String(r.uri || '');
  const m = /[?&]dn=([^&]+)/.exec(uri);
  let dn = '';
  if (m) { try { dn = decodeURIComponent(m[1].replace(/\+/g, ' ')); } catch { dn = m[1]; } }
  const target = declared(title, dn);
  if (!target) {
    rootKept.set(imdb, (rootKept.get(imdb) || 0) + 1);
    continue;
  }
  moves.push({
    imdb, hash: String(r.hash || ''),
    from: '-1:-1', to: `${target.season}:${target.episode}`,
    title,
    evidence: dn ? `dn=${dn}` : `title=${title}`,
  });
}

console.log(`[repair] magnet_work raiz: ${rootRows.length} linha(s) em ${[...new Set([...rootKept.keys(), ...moves.map((mv) => mv.imdb)])].length} obra(s)`);
for (const [imdb, n] of [...rootKept].sort()) {
  console.log(`[repair]   raiz legítima preservada: ${imdb} (${n} linha(s))`);
}
for (const mv of moves) {
  console.log(`[repair]   mover ${mv.hash.slice(0, 12)}… ${mv.imdb} ${mv.from} -> ${mv.to} [${mv.evidence}]`);
}

// --- F6: gates do --apply (antes de qualquer mutação) ------------------------

if (apply) {
  const port = Number(flag('port') ?? process.env.ADDON_PORT ?? 7000);
  if (Number.isFinite(port) && port > 0 && await probePort(port)) {
    fail(`porta ${port} respondendo em 127.0.0.1 — addon (ou outro serviço) vivo no volume. Pare-o antes de --apply (ou aponte --port=<porta correta>; --port=0 desliga a sonda).`);
  }
  const lockPath = flag('lock') ?? path.join(DATA, 'crawl-repair.lock');
  if (fs.existsSync(lockPath)) {
    fail(`lock presente: ${lockPath} — outra execução/instância pode estar usando os bancos.`);
  }
  verifyBackup(flag('backup') ?? '');
}

// --- execução: magnets → cache → crawl (MESMA ordem do relatório) ------------

if (moves.length > 0 && apply) {
  const delW = db.prepare('DELETE FROM magnet_work WHERE hash = ? AND imdb = ? AND season = -1 AND episode = -1');
  const insW = db.prepare(`
    INSERT OR REPLACE INTO magnet_work (hash, imdb, season, episode, first_seen, last_seen, passed_filter)
    SELECT hash, imdb, ?, ?, first_seen, last_seen, passed_filter
      FROM magnet_work WHERE hash = ? AND imdb = ? AND season = -1 AND episode = -1
  `);
  inTransaction(db, () => {
    for (const mv of moves) {
      const [s, e] = mv.to.split(':').map((x) => Number(x));
      insW.run(s, e, mv.hash, mv.imdb);
      delW.run(mv.hash, mv.imdb);
    }
  });
}

// --- 2. cache.db (chaves idx raiz do escopo) ---------------------------------

const scopedImdbs = new Set(moves.map((mv) => mv.imdb));
const idxRoots = [...scopedImdbs].map((imdb) => `idx:v13:${imdb}`);
let cacheDeleted = 0;
if (fs.existsSync(cachePath)) {
  const cache = openDb(cachePath);
  const sel = cache.prepare('SELECT key FROM cache WHERE key = ?');
  const del = cache.prepare('DELETE FROM cache WHERE key = ?');
  const hits = idxRoots.filter((key) => sel.get(key));
  cacheDeleted = hits.length;
  for (const key of hits) console.log(`[repair]   idx raiz no escopo: ${key}`);
  if (apply && hits.length > 0) {
    inTransaction(cache, () => { for (const key of hits) del.run(key); });
    try { cache.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* best-effort */ }
  }
  cache.close();
} else {
  console.log(`[repair] cache.db ausente (${cachePath}): passo 2 ignorado`);
}

// --- 3. crawl.db (URLs do escopo DAQUELE SITE + series_truncated do site) ----

let crawlReset = 0;
if (fs.existsSync(crawlPath)) {
  const crawl = openDb(crawlPath);
  const urls = crawl.prepare(`
    SELECT site, url, imdb, status FROM crawl_url
    WHERE site = ?
      AND ((imdb IS NOT NULL AND imdb IN (${[...scopedImdbs].map(() => '?').join(', ') || "''"}))
        OR (status = 'error' AND error LIKE 'series_truncated:%'))
  `).all(REPAIR_SITE, ...[...scopedImdbs]) as Array<Record<string, unknown>>;
  const reset = crawl.prepare(`
    UPDATE crawl_url SET status = 'pending', tries = 0, next_at = 0, error = '', releases = 0, progress = ''
    WHERE site = ? AND url = ?
  `);
  for (const u of urls) {
    crawlReset += 1;
    console.log(`[repair]   fila: ${u.site} ${u.url} (status=${u.status}, imdb=${u.imdb ?? '—'}) -> pending`);
  }
  if (apply && urls.length > 0) {
    inTransaction(crawl, () => {
      for (const u of urls) reset.run(String(u.site), String(u.url));
    });
    try { crawl.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* best-effort */ }
  }
  crawl.close();
} else {
  console.log(`[repair] crawl.db ausente (${crawlPath}): passo 3 ignorado`);
}

try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* best-effort */ }
db.close();

console.log(`[repair] resumo: ${moves.length} linha(s) a mover, ${cacheDeleted} chave(s) idx raiz, ${crawlReset} URL(s) da fila — ${apply ? 'APLICADO' : 'DRY-RUN (nada gravado; use --apply)'}`);
if (!apply) process.exitCode = 0;
