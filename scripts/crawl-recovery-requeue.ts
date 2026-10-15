// SCRIPT DE RECUPERAÇÃO do raspador: devolve à fila do `crawl.db` as páginas
// que o motor marcou sem produzir acervo (diagnóstico VPS 2026-10):
//   1. `nerdfilmes` `done` com `releases=0` (a rota interna desistia por falta
//      de IMDb e a página ficou selada);
//   2. `mico` `error` com a recusa do motor Rust "ritmo próprio exige
//      adaptador dedicado" (bug do próprio motor).
//
// DRY-RUN é o DEFAULT e é read-only de verdade (conexão readOnly, byte-idêntico
// exceto o -shm transitório de concorrência): imprime contagens por critério,
// amostra de URLs e o plano de update. `--apply` é que grava, com GATES:
//   - RECUSA se o addon (porta 7000) OU o sidecar Rust (7077 — o DONO do banco
//     quando CRAWL_ENGINE=rust) responderem no loopback: atualizar sob o motor
//     vivo permite corrida com o take_next. `--port=0` / `--sidecar-port=0`
//     desligam as sondas (uso em teste/diagnóstico consciente);
//   - EXIGE `--backup=<dir>` com cópia NÃO vazia do crawl.db (o update destrói
//     tries/error/progress das linhas tocadas — reversível só com backup);
//   - LOCK exclusivo (`--lock=`, default `crawl-requeue.lock` ao lado do db):
//     presença alheia recusa; `wx` falha em corrida; só o lock CRIADO aqui é
//     removido;
//   - UMA transação com rollback: a re-seleção roda DENTRO dela e cada UPDATE
//     carrega a GUARDA de status — linha que mudou de estado entre a seleção e
//     a escrita simplesmente não é tocada (o `changes` é a verdade aplicada).
//
// Semântica do update (divergência TS × Rust documentada em
// `crawl-requeue-plan.ts`): espelha o "Reprocessar erros" do TS
// (`crawl-store.ts`): status='pending', tries=0, next_at=0, error='',
// progress=''. NUNCA DELETE, nunca VACUUM; `releases`, `checked_at` e
// `added_at` intocados.
//
// Uso:
//   node dist/scripts/crawl-recovery-requeue.js                    # relatório
//   node dist/scripts/crawl-recovery-requeue.js --apply \
//     --backup=data/backup-crawl-requeue                           # executa
//   Flags: --crawl=<path> (default $CRAWL_DB_PATH ou data/crawl.db)
//          --since-hours=<n> (default 24; 0 desliga a janela de conclusão)
//          --mico-error=<texto exato> (override do texto gravado pelo Rust)
//          --sample é fixo em 10 URLs por critério (uma-shot; não é config).
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  CANDIDATE_SQL, MICO_OWN_PACE_ERROR, NERDFILMES_SITE, MICO_SITE,
  REQUEUE_UPDATE_SQL, planRequeue, rowFromSqlite,
} from './crawl-requeue-plan.js';
import type { RequeuePlan, RequeueRow, RequeueVictim } from './crawl-requeue-plan.js';

const _require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const apply = args.includes('--apply');

function fail(message: string): never {
  console.error(`[recovery] RECUSADO: ${message}`);
  process.exit(1);
}

function flag(name: string): string | null {
  const matches = args.filter((arg) => arg.startsWith(`--${name}=`));
  if (matches.length > 1) fail(`flag --${name} repetida`);
  return matches[0]?.slice(name.length + 3) ?? null;
}

const knownFlags = new Set(['--apply', '--crawl', '--since-hours', '--mico-error', '--backup', '--port', '--sidecar-port', '--lock']);
for (const arg of args) {
  const name = arg.split('=', 1)[0];
  if (name === '--apply') continue;
  if (!knownFlags.has(name) || !arg.includes('=')) fail(`flag inválida (${name})`);
}

const crawlPath = path.resolve(flag('crawl') ?? process.env.CRAWL_DB_PATH ?? path.join('data', 'crawl.db'));
const rawHours = Number(flag('since-hours') ?? '24');
if (!Number.isFinite(rawHours) || rawHours < 0) fail('--since-hours deve ser um número >= 0 (0 desliga a janela)');
const sinceHours = Math.trunc(rawHours);
const sinceMs = sinceHours > 0 ? Date.now() - sinceHours * 3_600_000 : 0;
const micoError = flag('mico-error') ?? MICO_OWN_PACE_ERROR;
const SAMPLE_LIMIT = 10;

console.log(`[recovery] banco: ${crawlPath} (${apply ? 'ESCRITA (--apply)' : 'somente leitura — dry-run'})`);
console.log(`[recovery] janela de conclusão: ${sinceHours > 0 ? `${sinceHours}h (desde ${new Date(sinceMs).toISOString()})` : 'desligada (--since-hours=0)'} — marcador checked_at (fallback added_at)`);
console.log(`[recovery] critério mico: status='error' AND error=${JSON.stringify(micoError)}`);

function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port, timeout: 1500 });
    const done = (up: boolean) => { socket.destroy(); resolve(up); };
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}

/** Backup verificável: diretório existente com cópia não vazia do crawl.db. */
function verifyBackup(dirPath: string): void {
  if (!dirPath) fail('--apply exige --backup=<dir> com cópia não vazia do crawl.db (o update destrói tries/error/progress).');
  let stat: fs.Stats;
  try { stat = fs.statSync(dirPath); } catch { fail(`backup não encontrado: ${dirPath}`); }
  if (!stat.isDirectory()) fail(`backup não é diretório: ${dirPath}`);
  const base = path.basename(crawlPath);
  const hit = fs.readdirSync(dirPath).filter((f) => f === base || f.startsWith(`${base}.`))
    .map((f) => path.join(dirPath, f))
    .find((f) => { try { return fs.statSync(f).isFile() && fs.statSync(f).size > 0; } catch { return false; } });
  if (!hit) fail(`backup sem cópia não vazia de ${base} em ${dirPath}`);
}

function openCrawl(file: string, readOnly: boolean): any {
  if (!fs.existsSync(file)) throw new Error(`banco não encontrado: ${file}`);
  if (fs.statSync(file).size === 0) throw new Error(`banco vazio (0 bytes): ${file}`);
  const { DatabaseSync } = _require('node:sqlite') as { DatabaseSync: new (file: string, options?: { readOnly?: boolean }) => any };
  if (readOnly) {
    // Dry-run read-only DE VERDADE (sem checkpoint, sem journal_mode). Se a
    // conexão readOnly falhar (ex.: banco nunca aberto em WAL), cai na comum —
    // o dry-run só lê.
    try {
      const ro = new DatabaseSync(file, { readOnly: true });
      ro.exec('PRAGMA busy_timeout = 10000');
      return ro;
    } catch { /* segue para a abertura comum */ }
  }
  const db = new DatabaseSync(file);
  // busy_timeout alto (10s > o 5s do addon/sidecar): o operador pode rodar
  // contra um banco recém-abandonado por outro processo; esperar é melhor que
  // falhar no meio. WAL é bem-vindo; NUNCA mudamos journal_mode, NUNCA VACUUM.
  db.exec('PRAGMA busy_timeout = 10000');
  return db;
}

function loadCandidates(db: any): RequeueRow[] {
  const columns = db.prepare('PRAGMA table_info(crawl_url)').all() as Array<Record<string, unknown>>;
  if (!columns.some((column) => column.name === 'url_key')) {
    throw new Error('crawl_url sem url_key; abra o store/addon para migrar (este script não migra)');
  }
  const raw = db.prepare(CANDIDATE_SQL).all(NERDFILMES_SITE, MICO_SITE) as Array<Record<string, unknown>>;
  return raw.map(rowFromSqlite);
}

function sampleOf(victims: RequeueVictim[], label: string): void {
  for (const v of victims.slice(0, SAMPLE_LIMIT)) {
    const error = v.error.length > 90 ? `${v.error.slice(0, 90)}…` : v.error;
    console.log(`[recovery]   AMOSTRA ${label} ${v.urlKey} (tries=${v.tries}->0, next_at=${v.nextAt}->0, rel=${v.releases}) status=${v.status} erro="${error}"`);
  }
  if (victims.length > SAMPLE_LIMIT) console.log(`[recovery]   AMOSTRA ${label}: … e mais ${victims.length - SAMPLE_LIMIT} (total ${victims.length})`);
}

function reportPlan(plan: RequeuePlan): number {
  const total = plan.nerdfilmes.length + plan.mico.length;
  console.log(`[recovery] nerdfilmes (done + releases=0): ${plan.nerdfilmes.length} vítima(s)${plan.outsideWindow.nerdfilmes > 0 ? ` — FORA da janela: ${plan.outsideWindow.nerdfilmes} (alarge --since-hours se esperava mais)` : ''}`);
  console.log(`[recovery] mico (error = texto exato): ${plan.mico.length} vítima(s)${plan.outsideWindow.mico > 0 ? ` — FORA da janela: ${plan.outsideWindow.mico}` : ''}`);
  if (plan.micoLooseOnly.length > 0 || plan.outsideWindow.micoLooseOnly > 0) {
    console.log(`[recovery] mico RELATO: ${plan.micoLooseOnly.length} erro(s) de "ritmo próprio" com texto DIFERENTE do esperado (não viram vítima; use --mico-error=<texto> para incluir)`
      + `${plan.outsideWindow.micoLooseOnly > 0 ? `; fora da janela: ${plan.outsideWindow.micoLooseOnly}` : ''}`);
  }
  sampleOf(plan.nerdfilmes, NERDFILMES_SITE);
  sampleOf(plan.mico, MICO_SITE);
  sampleOf(plan.micoLooseOnly, `${MICO_SITE}/relato`);
  console.log(`[recovery] plano de update (por linha, guarda status=${apply ? 'atual' : 'da seleção'}): ${REQUEUE_UPDATE_SQL}`);
  console.log(`[recovery] total planejado: ${total} linha(s) -> pending, tries=0, next_at=0, error='', progress='' (releases/checked_at/added_at intocados)`);
  return total;
}

// --- execução ----------------------------------------------------------------

if (apply) {
  const addonPort = Number(flag('port') ?? process.env.ADDON_PORT ?? '7000');
  if (Number.isFinite(addonPort) && addonPort > 0 && await probePort(addonPort)) {
    fail(`porta ${addonPort} respondendo em 127.0.0.1 — addon vivo no volume. Pare-o antes de --apply (ou --port=<porta correta>; --port=0 desliga a sonda).`);
  }
  const sidecarPort = Number(flag('sidecar-port') ?? process.env.CRAWL_SIDECAR_PORT ?? '7077');
  if (Number.isFinite(sidecarPort) && sidecarPort > 0 && await probePort(sidecarPort)) {
    fail(`porta ${sidecarPort} respondendo em 127.0.0.1 — sidecar Rust (dono do crawl.db com CRAWL_ENGINE=rust) vivo. Pare-o antes de --apply (ou --sidecar-port=0 desliga a sonda).`);
  }
  verifyBackup(flag('backup') ?? '');
}

const lockPath = path.resolve(flag('lock') ?? path.join(path.dirname(crawlPath), 'crawl-requeue.lock'));
let lockCreated = false;
let db: any = null;
try {
  if (apply) {
    // `wx` falha em corrida; a falha é convertida na recusa legível.
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
    } catch {
      fail(`lock presente: ${lockPath} — outra execução/instância pode estar usando os bancos.`);
    }
    lockCreated = true;
  }
  try {
    db = openCrawl(crawlPath, !apply);
  } catch (err) {
    console.log(`[recovery] crawl.db indisponível/legado: ${(err as Error).message} — NADA a fazer.`);
    process.exit(0);
  }

  // Seleção (no apply, re-feita DENTRO da transação; aqui é a prévia).
  let candidates = loadCandidates(db);
  const opts = { sinceMs, micoError };
  const plan = planRequeue(candidates, opts);
  const planned = reportPlan(plan);

  if (!apply) {
    console.log(`[recovery] resumo: ${planned} vítima(s) — DRY-RUN (nada gravado; use --apply com --backup)`);
  } else {
    // Transação única: re-seleção + updates com guarda. Ou tudo, ou nada.
    db.exec('BEGIN');
    let started = true;
    try {
      candidates = loadCandidates(db);
      const fresh = planRequeue(candidates, opts);
      const update = db.prepare(REQUEUE_UPDATE_SQL);
      let executed = 0;
      for (const v of [...fresh.nerdfilmes, ...fresh.mico]) {
        const r = update.run(v.site, v.urlKey, v.guardStatus) as { changes?: number | bigint };
        executed += Number(r?.changes) || 0;
      }
      db.exec('COMMIT');
      started = false;
      console.log(`[recovery] resumo: ${executed} linha(s) reenfileirada(s) (planejado ${planned}; divergência = linha mudou de estado e a guarda protegeu) — APLICADO`);
    } finally {
      if (started) { try { db.exec('ROLLBACK'); } catch { /* erro original sobe */ } }
    }
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* best-effort */ }
  }
} finally {
  if (db) { try { db.close(); } catch { /* já fechado */ } }
  // lockOwned: só o lock que ESTE processo criou é removido.
  if (lockCreated) { try { fs.rmSync(lockPath, { force: true }); } catch { /* best-effort */ } }
}
