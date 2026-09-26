// Banco de magnets vivo — FACHADA. Clone permanente do Jackett; fila async
// (busca nunca espera disco). Engines/merge em *-rows/-merge; leitura em
// magnet-bank-read. `passed_filter`: captura=0, filtro da busca=0/1 (não OR).
// `lied` = união global de `mag:lie` (bad por conta nunca entra).
import type { RawItem } from '../../types/domain.js';
import config from '../config.js';
import * as log from './logger.js';
import * as metrics from './metrics.js';
import { globalLieHashes } from './magnet-bank-lie.js';
import {
  open as openStore, close as closeStore, resetForTests as resetStore,
  engine, currentEngine, disarmFailNextWrite,
} from './magnet-bank-rows.js';
import type { Engine, MagnetRow, SourceRow, WorkRow, Batch, BankStats, IndexerStat } from './magnet-bank-rows.js';
import {
  inputFromItem, workTuple, mergeInputs, mergeSourceInput, mergeMagnet, mergeSource, mergeWork,
} from './magnet-bank-merge.js';
import type { MagnetInput, SourceInput, WorkCtx, WorkMark } from './magnet-bank-merge.js';
import { releaseWorkTargets } from './release-work.js';
import { magnetDisplayName } from './title-normalization.js';
import { readEngine } from './magnet-bank-read.js';

export { hashOf } from './magnet-bank-merge.js';
export { failNextWriteForTests } from './magnet-bank-rows.js';
export { readEngine, isOpen, lookup, sourcesFor, worksFor, findByWork, findByIndexer } from './magnet-bank-read.js';
export type { WorkCtx, MagnetInput, SourceInput };

const normHash = (hash: string): string => String(hash || '').toLowerCase();
const workKey = (hash: string, imdb: string, season: number, episode: number) =>
  `${hash}\u0000${imdb}\u0000${season}\u0000${episode}`;

type CaptureOp = { kind: 'capture'; items: readonly RawItem[]; indexer: string; ctx: WorkCtx };
type FilterOp = {
  kind: 'filter';
  all: string[];
  surviving: Set<string>;
  ctx: WorkCtx;
  /** Obras extras (pack) — mesma cobertura da captura; ausente = só o pedido. */
  targets?: Map<string, Array<{ season: number; episode: number }>>;
};
type Op = CaptureOp | FilterOp;

const queue: Op[] = [];
let flushScheduled = false;
let engineReported = false;

function reportEngine(e: Engine): void {
  if (engineReported) return;
  engineReported = true;
  metrics.count(e.kind === 'sql' ? 'magnetbank.engine.sql' : 'magnetbank.engine.memory');
}

/** Enfileira 1+ ops atomicamente. true = ok/no-op; false = fila cheia (0 push). */
function enqueue(ops: Op | Op[]): boolean {
  if (!config.magnetBank?.enabled) return true;
  const list = Array.isArray(ops) ? ops : [ops];
  if (list.length === 0) return true;
  const max = Math.max(1, Math.trunc(config.magnetBank.queueMax));
  if (queue.length + list.length > max) {
    metrics.count('magnetbank.queue.dropped');
    return false;
  }
  for (const op of list) queue.push(op);
  scheduleFlush();
  return true;
}

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  const run = () => { flushScheduled = false; flushNow(); };
  if (typeof setImmediate === 'function') setImmediate(run);
  else setTimeout(run, 0);
}

/**
 * Esvazia a fila e aplica o lote (síncrono). Pode LANÇAR: a falha de escrita
 * pertence a quem chamou decidir. Compartilhado por `flushNow` (engole) e
 * `flushBarrier` (reporta).
 */
function drainQueue(): number {
  const ops = queue.splice(0, queue.length);
  flushScheduled = false;
  try {
    if (ops.length === 0) return 0;
    return applyOps(ops);
  } finally {
    // O gatilho de teste vale para UM flush: nunca fica armado atravessando um
    // lote vazio (ou um lote sem escrita) para falhar uma busca real depois.
    disarmFailNextWrite();
  }
}

/** Aplica o lote acumulado (síncrono). Chamado pelo agendador, por `close()` e pelos testes.
 * A falha é engolida de propósito: o caminho da BUSCA nunca espera o disco e não
 * pode ser derrubado por ele. */
export function flushNow(): number {
  try {
    return drainQueue();
  } catch (err: unknown) {
    metrics.count('magnetbank.flush.failed');
    log.warn('[magnetbank] falha ao gravar lote:', log.errorMessage(err));
    return 0;
  }
}

/**
 * Barreira OBSERVÁVEL do lote para quem precisa da verdade da persistência — o
 * crawler de gravação. Aplica a fila AGORA e devolve `ok:false` quando a escrita
 * NÃO efetivou (o ROLLBACK desfez o lote), em vez de mentir `0` como o
 * `flushNow`. É síncrono porque a fila é alimentada de forma síncrona por
 * `captureItems`/`markFilterResult`: drenar aqui captura exatamente o lote do
 * crawler (mais o que já estava na fila — persistir antes nunca faz mal) sem
 * jamais aguardar rede. O caminho ao vivo continua sem esperar o disco.
 */
export function flushBarrier(): { ok: boolean; written: number } {
  try {
    return { ok: true, written: drainQueue() };
  } catch (err: unknown) {
    metrics.count('magnetbank.flush.failed');
    log.warn('[magnetbank] barreira de gravação falhou:', log.errorMessage(err));
    return { ok: false, written: 0 };
  }
}

/**
 * Aplica as operações NA ORDEM em que foram enfileiradas: é isso que dá o
 * "última observação vence" do `passed_filter` (captura = 0; filtro da mesma
 * busca = 0/1). O merge de magnet/fonte é coalescido por chave.
 */
function applyOps(ops: Op[]): number {
  const e = engine();
  reportEngine(e);
  const captures = new Map<string, MagnetInput>();
  const sources = new Map<string, SourceInput>();
  const works = new Map<string, WorkMark>();

  /**
   * Obra da captura. `reset` (coleta viva, seguida do filtro) escreve 0; sem
   * reset (colhedor/varredura de fundo) PRESERVA o valor existente e só cria 0
   * quando a obra ainda não existe — fundo não roda o filtro do stream-builder.
   */
  const markCaptureWork = (hash: string, imdb: string, season: number, episode: number, reset: boolean) => {
    const key = workKey(hash, imdb, season, episode);
    const prev = works.get(key);
    if (prev) {
      if (reset) prev.passedFilter = 0;
      return;
    }
    const existing = e.getWork(hash, imdb, season, episode);
    works.set(key, {
      hash, imdb, season, episode,
      passedFilter: reset ? 0 : (existing?.passedFilter ?? 0),
    });
  };

  for (const op of ops) {
    const { imdb, season, episode } = workTuple(op.ctx);
    if (op.kind === 'capture') {
      const reset = Boolean(op.ctx.resetPassedFilter);
      // Obra do pedido em forma nula, para o roteador de pack/série completa.
      const request = { season: op.ctx.season ?? null, episode: op.ctx.episode ?? null };
      for (const item of op.items) {
        const parsed = inputFromItem(item, op.indexer);
        if (!parsed) continue;
        const prevMagnet = captures.get(parsed.magnet.hash);
        captures.set(parsed.magnet.hash, prevMagnet ? mergeInputs(prevMagnet, parsed.magnet) : parsed.magnet);
        const sourceKey = `${parsed.source.hash}\u0000${parsed.source.indexer}`;
        const prevSource = sources.get(sourceKey);
        sources.set(sourceKey, prevSource ? mergeSourceInput(prevSource, parsed.source) : parsed.source);
        if (imdb) {
          // A obra do PEDIDO nunca se perde; pack de temporada/série completa
          // acrescenta a obra declarada (mesma régua do release-index). dn=
          // mais específico que o título evita inventar pack de temporada.
          for (const target of releaseWorkTargets(String(item.title || item.Title || ''), request, magnetDisplayName(item) || undefined)) {
            markCaptureWork(
              parsed.magnet.hash, imdb,
              target.season == null ? -1 : Math.trunc(target.season),
              target.episode == null ? -1 : Math.trunc(target.episode),
              reset,
            );
          }
        }
      }
      continue;
    }
    // Filtro: SÓ atualiza work que já existe (na leva ou no banco). Fonte não
    // Jackett (Prowlarr/Torrentio/BLUDV/idx) sem captura não cria work órfão.
    if (!imdb) continue;
    for (const hash of op.all) {
      const targets = op.targets?.get(hash);
      const list = targets && targets.length ? targets : [{ season, episode }];
      for (const target of list) {
        const key = workKey(hash, imdb, target.season, target.episode);
        let mark = works.get(key);
        if (!mark) {
          const prev = e.getWork(hash, imdb, target.season, target.episode);
          if (!prev) continue;
          mark = { hash, imdb, season: target.season, episode: target.episode, passedFilter: prev.passedFilter };
          works.set(key, mark);
        }
        mark.passedFilter = op.surviving.has(hash) ? 1 : 0;
      }
    }
  }

  const now = Date.now();
  const lied = globalLieHashes(new Set(captures.keys()));
  const batch: Batch = { magnets: [], sources: [], works: [] };
  for (const input of captures.values()) {
    batch.magnets.push(mergeMagnet(e.getMagnet(input.hash), input, now, lied.has(input.hash)));
  }
  for (const input of sources.values()) {
    batch.sources.push(mergeSource(e.getSource(input.hash, input.indexer), input, now));
  }
  for (const mark of works.values()) {
    batch.works.push(mergeWork(e.getWork(mark.hash, mark.imdb, mark.season, mark.episode), mark, now));
  }
  if (batch.magnets.length + batch.sources.length + batch.works.length === 0) return 0;
  const written = e.writeBatch(batch);
  // Escrita EFETIVA muda os totais: o memo do status não pode sobreviver a ela.
  invalidateStatusCache();
  if (batch.magnets.length > 0) metrics.count('magnetbank.upsert', batch.magnets.length);
  return written;
}

// ---------------------------------------------------------------------------
// API de captura
// ---------------------------------------------------------------------------

/** Captura itens com hash (caminho vivo). true=ok/no-op; false=fila cheia. */
export function captureItems(items: readonly RawItem[], indexer = '', ctx: WorkCtx = {}): boolean {
  if (!items || items.length === 0) return true;
  return enqueue({ kind: 'capture', items, indexer: String(indexer || '').toLowerCase(), ctx });
}

/** Marca passed_filter (caminho vivo). true=ok/no-op; false=fila cheia. */
export function markFilterResult(
  allHashes: Iterable<string>,
  survivingHashes: Iterable<string>,
  ctx: WorkCtx = {},
  targets?: Map<string, Array<{ season: number; episode: number }>>,
): boolean {
  const all = [...new Set([...allHashes].map(normHash).filter(Boolean))];
  if (all.length === 0) return true;
  const surviving = new Set([...survivingHashes].map(normHash).filter(Boolean));
  return enqueue({ kind: 'filter', all, surviving, ctx, targets });
}

/**
 * Capture+filter ATOMICAMENTE (crawler): os dois ou nenhum. Sem pre-flush.
 * needed = quantas ops reais (0..2); se não cabe → 1× `magnetbank.queue.dropped`.
 */
export function enqueueCaptureAndFilter(
  capture: { items: readonly RawItem[]; indexer?: string; ctx?: WorkCtx },
  filter: {
    all: Iterable<string>;
    surviving: Iterable<string>;
    ctx?: WorkCtx;
    targets?: Map<string, Array<{ season: number; episode: number }>>;
  },
): boolean {
  if (!config.magnetBank?.enabled) return true;
  const items = capture.items || [];
  const all = [...new Set([...filter.all].map(normHash).filter(Boolean))];
  const ops: Op[] = [];
  if (items.length) {
    ops.push({
      kind: 'capture', items,
      indexer: String(capture.indexer || '').toLowerCase(),
      ctx: capture.ctx || {},
    });
  }
  if (all.length) {
    ops.push({
      kind: 'filter', all,
      surviving: new Set([...filter.surviving].map(normHash).filter(Boolean)),
      ctx: filter.ctx || {},
      targets: filter.targets,
    });
  }
  return enqueue(ops);
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

// Helpers síncronos em magnet-bank-read.ts; a fachada reexporta.

/**
 * Memo do status. A leitura é síncrona (agregação na engine), então não há
 * coalescing de promise: `MAGNET_BANK_STATUS_TTL_MS` (default 60s; 0 desliga)
 * serve a MESMA foto a polls repetidos. Invalidado a cada escrita efetiva
 * (`applyOps` → `writeBatch`) e no ciclo de vida (open/reset/close).
 */
const statusTtlMs = (): number => Math.max(0, Math.trunc(Number(config.magnetBank?.statusTtlMs ?? 60000)));
type BankStatus = ReturnType<typeof computeStatus>;
// A foto guarda TAMBÉM as evictions do momento: a eviction muda os totais, e o
// guarda O(1) abaixo derruba a foto se um `writeBatch` da engine não tiver
// passado pelo `applyOps` (que já invalida) — o memo não fica preso a um só
// caminho de escrita.
let statusMemo: { at: number; value: BankStatus; evictions: number } | null = null;

/** Derruba o memo: o próximo `status()` recalcula. */
export function invalidateStatusCache(): void {
  statusMemo = null;
}

function computeStatus() {
  const e = readEngine();
  if (e) reportEngine(e);
  const stats: BankStats = e?.stats() ?? {
    magnets: 0, sources: 0, works: 0, lastSeen: 0, byIndexer: [], memoryMax: null, memoryEvictions: 0,
  };
  return {
    enabled: Boolean(config.magnetBank?.enabled),
    engine: e ? e.kind : 'disabled',
    magnets: stats.magnets,
    sources: stats.sources,
    works: stats.works,
    lastSeen: stats.lastSeen,
    byIndexer: stats.byIndexer,
    // Teto e despejos SÓ existem na engine de memória; o SQLite responde
    // `null`/`0` (acervo permanente) e o painel distingue os dois.
    memoryMax: stats.memoryMax,
    memoryEvictions: stats.memoryEvictions,
    queue: queue.length,
    queueMax: Math.max(1, Math.trunc(config.magnetBank?.queueMax ?? 500)),
  };
}

/**
 * Panorama do banco para diagnóstico/painel: totais, último visto global e a
 * quebra por indexer. A engine resolve tudo com COUNT/MAX/GROUP BY numa passada
 * (`stats()`) — sem query por indexer — e o resultado é MEMOIZADO por
 * `MAGNET_BANK_STATUS_TTL_MS` para o poll não repetir a varredura O(rows).
 */
export function status(): BankStatus {
  const ttl = statusTtlMs();
  if (ttl > 0 && statusMemo) {
    const e = currentEngine();
    // Eviction efetiva (inclusive a disparada fora do flush) invalida a foto
    // antes de ela ser servida — a checagem é O(1).
    if (e && e.memoryEvictions() !== statusMemo.evictions) invalidateStatusCache();
  }
  if (ttl > 0 && statusMemo && Date.now() - statusMemo.at < ttl) return statusMemo.value;
  const value = computeStatus();
  if (ttl > 0) statusMemo = { at: Date.now(), value, evictions: currentEngine()?.memoryEvictions() ?? 0 };
  return value;
}

export function inspectHash(hash: string) {
  const e = readEngine();
  const h = normHash(hash);
  return { hash: h, magnet: e?.getMagnet(h) ?? null, sources: e?.listSources(h) ?? [], works: e?.listWorks(h) ?? [] };
}

// ---------------------------------------------------------------------------
// Ciclo de vida
// ---------------------------------------------------------------------------

export function open(dbPathOverride?: string, opts: { forceMemory?: boolean } = {}): void {
  openStore(dbPathOverride, opts);
  invalidateStatusCache(); // engine nova: a foto anterior é de outro banco
}

/**
 * Boot do processo: só abre o arquivo quando o banco está LIGADO. Com
 * `MAGNET_BANK=false` nada de SQLite/WAL é criado e `status()` segue
 * `disabled` (os reads usam `readEngine()`, que também respeita o kill-switch).
 */
export function openIfEnabled(): void {
  if (config.magnetBank?.enabled) open();
}

export function resetForTests(): void {
  queue.length = 0;
  flushScheduled = false;
  engineReported = false;
  resetStore();
  invalidateStatusCache();
}

/** Flush + checkpoint (`wal_checkpoint` no engine SQL) antes de fechar. */
export function close(): void {
  flushNow();
  closeStore();
  invalidateStatusCache();
}

export type { MagnetRow, SourceRow, WorkRow, Engine, BankStats, IndexerStat };
