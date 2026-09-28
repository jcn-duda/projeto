// Remediação ONE-SHOT dos dados do Defeito A da Fase 7 (plano v2, seção 5):
// releases de série gravadas na locação ERRADA — raiz quando o título/dn
// declara TEMPORADA, e TEMPORADA errada quando o card impôs a dele (TWD:
// packs da 4ª gravados em S1/S5, medido em produção 2026-09-27).
//
// ESCOPO (bug 2026-09-27): SOMENTE IMDb comprovadamente SÉRIE — linha
// `kind='tv_show'` no `crawl.db`, aberto ANTES de qualquer
// relatório/movimento/cache delete/requeue. Linha de FILME é intocada e IMDb
// sem linha no crawl NÃO é tocado: sem prova de série, sem movimento. Vale
// para TODAS as locações (raiz, S, S:E) — não só a raiz.
//
// O que faz (nesta ordem; a mutação segue a MESMA ordem do relatório:
// magnets → cache → crawl). O PLANO é puro (`crawl-repair-plan.ts`):
//   1. magnets.db: para cada linha do escopo compara a evidência declarada
//      (dn vence título; MESMA `declaredSeriesLocation` do runtime) com a
//      locação armazenada — divergente é MOVIDO (ou FUNDIDO na PK destino,
//      preservando first/last_seen e passed_filter) e contaminação de
//      identidade ("Live Action" de outra adaptação, com o ano de estreia
//      fornecido) é EXCLUÍDA — nunca remanejada para outro IMDb. Título com
//      `E01` FICTÍCIO (dn prova pack sem episódio único) é SANEADO.
//   2. cache.db: apaga TODAS as chaves das obras afetadas — idx real
//      `idx:v13:<imdb>`, `idx:v13:<imdb>:S4`, `idx:v13:<imdb>:S4E5` (chave
//      raiz exata + prefixo `:%`) e as listas prontas por instalação
//      `streams:%:series:<imdb>:%`; o índice/busca regravam do acervo vivo.
//   3. crawl.db: URL do escopo daquele SITE (só `vacatorrent`) volta a
//      `pending` — INDEPENDENTE de haver moves (series_truncated precisa
//      voltar à fila mesmo com plano vazio); o motor reprocessa corrigido.
//
// Segurança:
//   - `--dry-run` é o DEFAULT, read-only de verdade (conexão readOnly, sem
//     checkpoint; db/wal byte-idênticos — o -shm transitório é livro de
//     concorrência) e REPORTA o plano completo: moves, chaves idx/streams
//     e fila planejados — o apply grava exatamente esse relatório.
//   - `--apply` RECUSA addon vivo (porta TCP em `127.0.0.1:<porta>`, default
//     7000; `--port=0` desliga) e EXIGE `--backup=<dir>` verificável. Cria
//     LOCK EXCLUSIVO (`--lock=<path>`, default `data/crawl-repair.lock`):
//     presença alheia recusa; o lock nasce com `wx` e só o lock CRIADO por
//     este processo é liberado em `finally` (lockOwned).
//   - Conexões com `busy_timeout=5000`; cada banco muta em transação única
//     com rollback.
//   - Offline por desenho: o ano de estreia vem de `--premiere=tt…:AAAA`
//     (repetível). Sem o ano, suspeita de contaminação só é RELATADA.
//
// Uso:
//   node dist/scripts/crawl-repair-series-locations.js            # relatório
//   node dist/scripts/crawl-repair-series-locations.js --apply \
//     --backup=data/backup-2026-09-27 \
//     --premiere=tt0388629:1999                                   # executa
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

/** Anos de estreia informados por flag (offline; repetível). */
const premieres = new Map<string, number>();
for (const a of args.filter((v) => v.startsWith('--premiere='))) {
  const m = /^((?:tt\d+):(19|20)\d{2})$/.exec(a.slice('--premiere='.length));
  if (!m) {
    console.error(`[repair] RECUSADO: --premiere inválida ("${a}") — use --premiere=tt1234567:1999.`);
    process.exit(1);
  }
  // Grupo 1 = "tt…:AAAA" inteiro (m[2]/m[3] são metades do ano).
  const [imdb, year] = m[1].split(':');
  premieres.set(imdb, Number(year));
}

function fail(message: string): never {
  console.error(`[repair] RECUSADO: ${message}`);
  process.exit(1);
}

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

const { planRepairs, dnOf } = await import('./crawl-repair-plan.js');
type RepairRow = import('./crawl-repair-plan.js').RepairRow;
type RepairAction = import('./crawl-repair-plan.js').RepairAction;

function openDb(file: string, readOnly = false): any {
  const { DatabaseSync } = _require('node:sqlite');
  if (!fs.existsSync(file)) {
    throw new Error(`banco não encontrado: ${file}`);
  }
  if (readOnly) {
    // Dry-run read-only DE VERDADE: a conexão recusa escrita por construção,
    // não faz checkpoint no close e não muda db/wal (byte-idênticos). O
    // SQLite pode criar/tocar o -shm TRANSITÓRIO ao abrir um banco em WAL —
    // é livro de concorrência, não dado; db e wal permanecem intactos.
    try {
      const ro = new DatabaseSync(file, { readOnly: true });
      ro.exec('PRAGMA busy_timeout = 5000');
      return ro;
    } catch {
      // segue para a abertura comum
    }
  }
  const db = new DatabaseSync(file);
  // F6: o addon parado pode ter deixado WAL quente / outro leitor — esperar é
  // melhor que falhar a remediação no meio.
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

// --- escopo: SOMENTE IMDb comprovadamente SÉRIE no crawl.db (bug 2026-09-27) --

let seriesImdbs = new Set<string>();
let crawlDb: any = null;
const readOnly = !apply;
if (!fs.existsSync(crawlPath)) {
  console.log(`[repair] crawl.db ausente (${crawlPath}): escopo vazio — nenhuma obra é comprovadamente série; NADA a fazer.`);
  process.exit(0);
}
if (fs.statSync(crawlPath).size === 0) {
  console.log(`[repair] crawl.db vazio (0 bytes) em ${crawlPath}: escopo vazio — nenhuma obra é comprovadamente série; NADA a fazer.`);
  process.exit(0);
}
crawlDb = openDb(crawlPath, readOnly);
{
  const rows = crawlDb.prepare(`
    SELECT DISTINCT imdb FROM crawl_url
    WHERE imdb IS NOT NULL AND imdb != '' AND kind = 'tv_show'
  `).all() as Array<Record<string, unknown>>;
  seriesImdbs = new Set(rows.map((r) => String(r.imdb)));
  console.log(`[repair] escopo: ${seriesImdbs.size} IMDb comprovadamente série (kind='tv_show') no crawl.db`);
}

// --- 1. magnets.db: relatório (TODAS as locações, não só a raiz) --------------

const db = openDb(magnetsPath, readOnly);
const placeholders = [...seriesImdbs].map(() => '?').join(', ') || "''";
const allRows = db.prepare(`
  SELECT w.hash, w.imdb, w.season, w.episode, w.first_seen, w.last_seen,
         w.passed_filter, m.title, m.uri
  FROM magnet_work w JOIN magnet m ON m.hash = w.hash
  WHERE w.imdb IN (${placeholders})
  ORDER BY w.imdb, w.hash, w.season, w.episode
`).all(...[...seriesImdbs]) as Array<Record<string, unknown>>;
const repairRows: RepairRow[] = allRows.map((r) => ({
  hash: String(r.hash || ''), imdb: String(r.imdb || ''),
  season: Number(r.season ?? -1), episode: Number(r.episode ?? -1),
  firstSeen: Number(r.first_seen ?? 0), lastSeen: Number(r.last_seen ?? 0),
  passedFilter: Number(r.passed_filter ?? 0),
  title: String(r.title || ''), uri: String(r.uri || ''),
}));
const { actions, kept } = planRepairs(repairRows, { premieres });
const excluded = (db.prepare(`
  SELECT COUNT(*) n FROM magnet_work w JOIN magnet m ON m.hash = w.hash
  WHERE w.imdb NOT IN (${placeholders})
`).get(...[...seriesImdbs]) as Record<string, unknown>).n;
console.log(`[repair] fora do escopo (filme ou sem linha tv_show no crawl): ${excluded} linha(s) — preservadas`);
console.log(`[repair] magnet_work do escopo: ${repairRows.length} linha(s) em ${new Set(repairRows.map((r) => r.imdb)).size} obra(s); ${kept} na locação correta`);
for (const a of actions) {
  const r = (a as Extract<RepairAction, { row: unknown }>).row;
  if (a.kind === 'move') {
    console.log(`[repair]   mover ${r.hash.slice(0, 12)}… ${r.imdb} ${r.season}:${r.episode} -> ${a.to.season}:${a.to.episode} [${dnOf(r.uri) ? `dn=${dnOf(r.uri)}` : `title=${r.title}`}]`);
  } else if (a.kind === 'delete-identity') {
    console.log(`[repair]   excluir (identidade live action) ${r.hash.slice(0, 12)}… ${r.imdb} ${r.season}:${r.episode}`);
  } else if (a.kind === 'suspect-identity') {
    console.log(`[repair]   SUSPEITA sem ano de estreia (passe --premiere=${r.imdb}:AAAA): ${r.hash.slice(0, 12)}… ${r.imdb} ${r.season}:${r.episode}`);
  } else {
    console.log(`[repair]   sanear título (E fictício com prova no dn) ${r.hash.slice(0, 12)}… "${r.title}" -> "${a.to}"`);
  }
}

// --- alvo e relatório PLANEJADO (idêntico em dry-run e --apply) --------------

const affected = new Set<string>(
  actions
    .filter((a) => a.kind !== 'suspect-identity')
    .map((a) => (a as Extract<RepairAction, { row: unknown }>).row.imdb),
);

// Chaves idx reais: `idx:v13:<imdb>`, `:S4`, `:S4E5` (o episódio cola na
// temporada, sem segundo ":" — o prefixo `:%` cobre ambos).
const plannedIdx: string[] = [];
// Listas por instalação: `streams:%:series:<imdb>:%` (qualquer config/conta).
const plannedStreams = new Map<string, number>();
const plannedFila: Array<Record<string, unknown>> = [];
if (affected.size > 0 && fs.existsSync(cachePath)) {
  try {
    const cache = openDb(cachePath, true);
    for (const imdb of affected) {
      for (const row of cache.prepare('SELECT key FROM cache WHERE key = ? OR key LIKE ?')
        .all(`idx:v13:${imdb}`, `idx:v13:${imdb}:%`) as Array<Record<string, unknown>>) {
        plannedIdx.push(String(row.key));
      }
      const n = (cache.prepare('SELECT COUNT(*) n FROM cache WHERE key LIKE ?')
        .get(`streams:%:series:${imdb}:%`) as Record<string, unknown>).n;
      plannedStreams.set(imdb, Number(n));
    }
    cache.close();
  } catch (err) {
    // Falha no relatório segue até o fim no dry-run (fail-safe, não silêncio).
    console.log(`[repair] cache ilegível para relatório planejado: ${(err as Error).message}`);
  }
}
{
  const inClause = [...affected].map(() => '?').join(', ') || "''";
  plannedFila.push(...(crawlDb.prepare(`
    SELECT site, url, imdb, status, tries, next_at, error, releases, progress FROM crawl_url
    WHERE site = ?
      AND kind = 'tv_show'
      AND ((imdb IS NOT NULL AND imdb IN (${inClause}))
        OR (status = 'error' AND error LIKE 'series_truncated:%'))
  `).all(REPAIR_SITE, ...[...affected]) as Array<Record<string, unknown>>));
}
for (const key of plannedIdx) console.log(`[repair]   idx do escopo (planejado): ${key}`);
for (const [imdb, n] of plannedStreams) {
  if (n > 0) console.log(`[repair]   streams do escopo (planejado): ${n} chave(s) series:${imdb}`);
}
for (const u of plannedFila) {
  console.log(`[repair]   fila (planejado): ${u.site} ${u.url} (status=${u.status}, imdb=${u.imdb ?? '—'}) -> pending`);
}

// --- F6: gates do --apply (antes de qualquer mutação) ------------------------

const lockPath = flag('lock') ?? path.join(DATA, 'crawl-repair.lock');
if (apply) {
  const port = Number(flag('port') ?? process.env.ADDON_PORT ?? 7000);
  if (Number.isFinite(port) && port > 0 && await probePort(port)) {
    fail(`porta ${port} respondendo em 127.0.0.1 — addon (ou outro serviço) vivo no volume. Pare-o antes de --apply (ou aponte --port=<porta correta>; --port=0 desliga a sonda).`);
  }
  if (fs.existsSync(lockPath)) {
    fail(`lock presente: ${lockPath} — outra execução/instância pode estar usando os bancos.`);
  }
  verifyBackup(flag('backup') ?? '');
}

// --- execução: magnets → cache → crawl (MESMA ordem do relatório) ------------

let lockCreated = false;
try {
  if (apply) {
    // LOCK EXCLUSIVO (wx falha em corrida); no finally só o lock CRIADO por
    // este processo é removido (lockOwned).
    fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
    lockCreated = true;
    if (actions.length > 0) {
    const moves = actions.filter((a): a is Extract<RepairAction, { kind: 'move' }> => a.kind === 'move');
    const deletes = actions.filter((a): a is Extract<RepairAction, { kind: 'delete-identity' }> => a.kind === 'delete-identity');
    const sanitizes = actions.filter((a): a is Extract<RepairAction, { kind: 'sanitize-title' }> => a.kind === 'sanitize-title');
    const selTarget = db.prepare('SELECT first_seen, last_seen, passed_filter FROM magnet_work WHERE hash = ? AND imdb = ? AND season = ? AND episode = ?');
    const insCopy = db.prepare(`
      INSERT INTO magnet_work (hash, imdb, season, episode, first_seen, last_seen, passed_filter)
      SELECT hash, imdb, ?, ?, first_seen, last_seen, passed_filter
        FROM magnet_work WHERE hash = ? AND imdb = ? AND season = ? AND episode = ?
    `);
    const delRow = db.prepare('DELETE FROM magnet_work WHERE hash = ? AND imdb = ? AND season = ? AND episode = ?');
    const mergeRow = db.prepare(`
      UPDATE magnet_work SET first_seen = MIN(first_seen, ?), last_seen = MAX(last_seen, ?),
        passed_filter = MAX(passed_filter, ?)
      WHERE hash = ? AND imdb = ? AND season = ? AND episode = ?
    `);
    const updTitle = db.prepare('UPDATE magnet SET title = ? WHERE hash = ? AND title = ?');
    inTransaction(db, () => {
      for (const mv of moves) {
        const exists = selTarget.get(mv.row.hash, mv.row.imdb, mv.to.season, mv.to.episode);
        if (exists) {
          // FUSÃO: PK destino já tem a mesma obra/hash — soma o histórico
          // (min/max/OR) em vez de descartar um dos lados.
          mergeRow.run(mv.row.firstSeen, mv.row.lastSeen, mv.row.passedFilter,
            mv.row.hash, mv.row.imdb, mv.to.season, mv.to.episode);
          delRow.run(mv.row.hash, mv.row.imdb, mv.row.season, mv.row.episode);
        } else {
          insCopy.run(mv.to.season, mv.to.episode, mv.row.hash, mv.row.imdb, mv.row.season, mv.row.episode);
          delRow.run(mv.row.hash, mv.row.imdb, mv.row.season, mv.row.episode);
        }
      }
      for (const del of deletes) delRow.run(del.row.hash, del.row.imdb, del.row.season, del.row.episode);
      // WHERE title = ? torna o saneamento idempotente e prova o título visto.
      for (const s of sanitizes) updTitle.run(s.to, s.row.hash, s.from);
    });
    }
    // 2. cache.db: TODAS as chaves idx E streams das obras afetadas.
    if (affected.size > 0 && fs.existsSync(cachePath)) {
      const cache = openDb(cachePath, false);
      // Recontagem NO ESTADO ATUAL (o relatório planejado pode ser velho).
      const liveIdx: string[] = [];
      const liveStreams: Array<[string, string]> = [];
      for (const imdb of affected) {
        for (const row of cache.prepare('SELECT key FROM cache WHERE key = ? OR key LIKE ?')
          .all(`idx:v13:${imdb}`, `idx:v13:${imdb}:%`) as Array<Record<string, unknown>>) {
          liveIdx.push(String(row.key));
        }
        for (const row of cache.prepare('SELECT key FROM cache WHERE key LIKE ?')
          .all(`streams:%:series:${imdb}:%`) as Array<Record<string, unknown>>) {
          liveStreams.push([imdb, String(row.key)]);
        }
      }
      if (liveIdx.length > 0 || liveStreams.length > 0) {
        inTransaction(cache, () => {
          for (const key of liveIdx) cache.prepare('DELETE FROM cache WHERE key = ?').run(key);
          for (const [, key] of liveStreams) cache.prepare('DELETE FROM cache WHERE key = ?').run(key);
        });
        try { cache.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* best-effort */ }
      }
      console.log(`[repair]   cache: ${liveIdx.length} chave(s) idx e ${liveStreams.length} chave(s) streams apagada(s)`);
      cache.close();
    }
    // 3. crawl.db: URLs do escopo DAQUELE SITE — INDEPENDENTE de actions
    //    (series_truncated volta à fila mesmo sem moves). Só toca na linha
    //    NÃO convergida: segunda passada é no-op real.
    {
      const needsReset = plannedFila.filter((u) =>
        String(u.status) !== 'pending' || Number(u.tries) !== 0 || Number(u.next_at) !== 0
        || String(u.error) !== '' || Number(u.releases) !== 0 || String(u.progress) !== '');
      const reset = crawlDb.prepare("UPDATE crawl_url SET status = 'pending', tries = 0, next_at = 0, error = '', releases = 0, progress = '' WHERE site = ? AND url = ?");
      for (const u of needsReset) {
        console.log(`[repair]   fila: ${u.site} ${u.url} (status=${u.status}, imdb=${u.imdb ?? '—'}) -> pending`);
      }
      if (needsReset.length > 0) {
        inTransaction(crawlDb, () => {
          for (const u of needsReset) reset.run(String(u.site), String(u.url));
        });
        try { crawlDb.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* best-effort */ }
      }
    }
  }
} finally {
  // lockOwned: só o lock que ESTE processo criou é removido.
  if (lockCreated) { try { fs.rmSync(lockPath, { force: true }); } catch { /* best-effort */ } }
}

// Checkpoint é ESCRITA no arquivo: só no --apply (e fora do lock — o dado já
// está commitado; o dry-run segue read-only de verdade).
if (apply) { try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* best-effort */ } }
db.close();
if (crawlDb) { try { crawlDb.close(); } catch { /* já fechado */ } }

const movidos = actions.filter((a) => a.kind === 'move').length;
const excluidos = actions.filter((a) => a.kind === 'delete-identity').length;
const saneados = actions.filter((a) => a.kind === 'sanitize-title').length;
// hash×obra e título DISTINCTOS: a mesma hash com N linhas de obra repetia
// ação idêntica — contagem por linha esconde quantos magnets de fato mudam.
const movidosObra = new Set(actions.filter((a) => a.kind === 'move')
  .map((a) => `${(a as Extract<RepairAction, { row: unknown }>).row.hash}|${(a as Extract<RepairAction, { row: unknown }>).row.imdb}`)).size;
const saneadosTitulo = new Set(actions.filter((a) => a.kind === 'sanitize-title')
  .map((a) => (a as Extract<RepairAction, { kind: 'sanitize-title' }>).from)).size;
const saneadosHash = new Set(actions.filter((a) => a.kind === 'sanitize-title')
  .map((a) => (a as Extract<RepairAction, { row: unknown }>).row.hash)).size;
console.log(`[repair] resumo: ${movidos} linha(s) a mover (${movidosObra} hash×obra distintos), ${excluidos} por identidade, ${saneados} título(s) (${saneadosTitulo} distintos, ${saneadosHash} hashes), ${affected.size} obra(s) afetada(s) — ${apply ? 'APLICADO' : 'DRY-RUN (nada gravado; use --apply)'}`);
if (!apply) process.exitCode = 0;
