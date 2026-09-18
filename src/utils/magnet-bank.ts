// Banco de magnets vivo — FACHADA.
//
// Clone permanente de TUDO que o Jackett devolveu (o site some, o acervo
// fica), com a obra/episódio de cada busca e a URI do post por hash. A camada
// de linhas/engines mora em `magnet-bank-rows.ts` e as regras puras de merge /
// extração em `magnet-bank-merge.ts` (extraídas pela catraca de 400 linhas);
// aqui vivem a captura, o lie global e a fila assíncrona.
//
// A captura roda no `jackett.search` (por indexer e no `/all` agregado, depois
// da resolução Cardigann) e é enfileirada — a busca NUNCA espera o disco. A
// gravação acontece em UMA transação por lote, fora do caminho da resposta.
//
// `passed_filter` NÃO é OR: a captura nasce 0 e o resultado do filtro da mesma
// busca escreve 0/1; uma captura futura que não sobreviver derruba para 0.
//
// `lied` inclui a leitura GLOBAL do `mag` (lie de qualquer conta, união): o
// banco é global e NÃO duplica a evidência por conta — essa continua no `mag`.
// `bad` por conta nunca é lido aqui.
import type { RawItem } from '../../types/domain.js';
import config from '../config.js';
import * as cache from './cache.js';
import * as log from './logger.js';
import * as metrics from './metrics.js';
import { prefix } from './cache-keys.js';
import {
  open as openStore, close as closeStore, resetForTests as resetStore,
  engine, currentEngine, disarmFailNextWrite,
} from './magnet-bank-rows.js';
import type { Engine, MagnetRow, SourceRow, WorkRow, Batch } from './magnet-bank-rows.js';
import {
  inputFromItem, workTuple, mergeInputs, mergeSourceInput, mergeMagnet, mergeSource, mergeWork,
} from './magnet-bank-merge.js';
import type { MagnetInput, SourceInput, WorkCtx, WorkMark } from './magnet-bank-merge.js';

export { hashOf } from './magnet-bank-merge.js';
export { failNextWriteForTests } from './magnet-bank-rows.js';
export type { WorkCtx, MagnetInput, SourceInput };

const normHash = (hash: string): string => String(hash || '').toLowerCase();
const workKey = (hash: string, imdb: string, season: number, episode: number) =>
  `${hash}\u0000${imdb}\u0000${season}\u0000${episode}`;

// ---------------------------------------------------------------------------
// Lie GLOBAL (união de contas)
// ---------------------------------------------------------------------------

/**
 * Hashes com `lie` VIVO no `mag` de QUALQUER conta. O banco é global, então a
 * evidência de mentira vira um booleano global (não se duplica a conta); o
 * `mag` continua sendo a autoridade por credencial.
 *
 * `keysMatching` filtra pelo prefixo do lado (`mag:v1:lie:`) e só chaves cujo
 * último segmento é um hash DA LEVA são lidas: `cache.peek` descarta a chave
 * EXPIRADA e nada mais é parseado. SEM memo: a varredura roda a cada flush com
 * hashes, então uma mentira recém-gravada antes do flush é vista. Sem
 * `infoHash`/`bad` por conta (isso é do `mag`).
 */
function globalLieHashes(hashes: Set<string>): Set<string> {
  const out = new Set<string>();
  if (hashes.size === 0) return out;
  if (!config.magnetDb?.enabled || !config.magnetDb?.lieEnabled) return out;
  try {
    // O prefixo já prova o lado `lie`; o último segmento da chave é o hash.
    for (const key of cache.keysMatching(`${prefix('mag')}lie:`)) {
      const hash = key.slice(key.lastIndexOf(':') + 1);
      if (!hashes.has(hash)) continue;
      if (cache.peek(key) === 1) out.add(hash);
    }
  } catch (err: unknown) {
    log.warn('[magnetbank] leitura do lie global falhou:', log.errorMessage(err));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fila assíncrona (uma transação por lote)
// ---------------------------------------------------------------------------

type CaptureOp = { kind: 'capture'; items: readonly RawItem[]; indexer: string; ctx: WorkCtx };
type FilterOp = { kind: 'filter'; all: string[]; surviving: Set<string>; ctx: WorkCtx };
type Op = CaptureOp | FilterOp;

const queue: Op[] = [];
let flushScheduled = false;
let engineReported = false;

function reportEngine(e: Engine): void {
  if (engineReported) return;
  engineReported = true;
  metrics.count(e.kind === 'sql' ? 'magnetbank.engine.sql' : 'magnetbank.engine.memory');
}

function enqueue(op: Op): void {
  if (!config.magnetBank?.enabled) return;
  const max = Math.max(1, Math.trunc(config.magnetBank.queueMax));
  if (queue.length >= max) {
    // Busca nunca espera o disco: fila cheia descarta a leva e o operador vê
    // no contador. A próxima captura do mesmo hash cobre o que ficou de fora.
    metrics.count('magnetbank.queue.dropped');
    return;
  }
  queue.push(op);
  scheduleFlush();
}

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  const run = () => { flushScheduled = false; flushNow(); };
  if (typeof setImmediate === 'function') setImmediate(run);
  else setTimeout(run, 0);
}

/** Aplica o lote acumulado (síncrono). Chamado pelo agendador, por `close()` e pelos testes. */
export function flushNow(): number {
  const ops = queue.splice(0, queue.length);
  flushScheduled = false;
  try {
    if (ops.length === 0) return 0;
    return applyOps(ops);
  } catch (err: unknown) {
    metrics.count('magnetbank.flush.failed');
    log.warn('[magnetbank] falha ao gravar lote:', log.errorMessage(err));
    return 0;
  } finally {
    // O gatilho de teste vale para UM flush: nunca fica armado atravessando um
    // lote vazio (ou um lote sem escrita) para falhar uma busca real depois.
    disarmFailNextWrite();
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
      for (const item of op.items) {
        const parsed = inputFromItem(item, op.indexer);
        if (!parsed) continue;
        const prevMagnet = captures.get(parsed.magnet.hash);
        captures.set(parsed.magnet.hash, prevMagnet ? mergeInputs(prevMagnet, parsed.magnet) : parsed.magnet);
        const sourceKey = `${parsed.source.hash}\u0000${parsed.source.indexer}`;
        const prevSource = sources.get(sourceKey);
        sources.set(sourceKey, prevSource ? mergeSourceInput(prevSource, parsed.source) : parsed.source);
        if (imdb) markCaptureWork(parsed.magnet.hash, imdb, season, episode, reset);
      }
      continue;
    }
    // Filtro: SÓ atualiza work que já existe (na leva ou no banco). Fonte não
    // Jackett (Prowlarr/Torrentio/BLUDV/idx) sem captura não cria work órfão.
    if (!imdb) continue;
    for (const hash of op.all) {
      const key = workKey(hash, imdb, season, episode);
      let mark = works.get(key);
      if (!mark) {
        const prev = e.getWork(hash, imdb, season, episode);
        if (!prev) continue;
        mark = { hash, imdb, season, episode, passedFilter: prev.passedFilter };
        works.set(key, mark);
      }
      mark.passedFilter = op.surviving.has(hash) ? 1 : 0;
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
  if (batch.magnets.length > 0) metrics.count('magnetbank.upsert', batch.magnets.length);
  return written;
}

// ---------------------------------------------------------------------------
// API de captura
// ---------------------------------------------------------------------------

/**
 * Captura TODOS os itens com hash de uma consulta ao Jackett. `indexer` é o do
 * plano (minúsculo); vazio (caminho `/all` agregado) usa o indexer do próprio
 * item. `ctx` leva a obra da busca — os itens viram `magnet_work` para o
 * fallback futuro.
 */
export function captureItems(items: readonly RawItem[], indexer = '', ctx: WorkCtx = {}): void {
  if (!items || items.length === 0) return;
  enqueue({ kind: 'capture', items, indexer: String(indexer || '').toLowerCase(), ctx });
}

/**
 * Resultado do filtro de título para a obra: escreve `passed_filter` 1 nos
 * hashes sobreviventes e 0 nos demais da leva. Só toca work que JÁ existe (a
 * captura do Jackett cria; fonte não Jackett nunca cria órfão). A ordem na fila
 * garante que o resultado desta busca vence a captura que o alimentou e perde
 * para uma captura posterior.
 */
export function markFilterResult(allHashes: Iterable<string>, survivingHashes: Iterable<string>, ctx: WorkCtx = {}): void {
  const all = [...new Set([...allHashes].map(normHash).filter(Boolean))];
  if (all.length === 0) return;
  const surviving = new Set([...survivingHashes].map(normHash).filter(Boolean));
  enqueue({ kind: 'filter', all, surviving, ctx });
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

/**
 * Engine para LEITURA: reusa o aberto; se ainda não há, abre — mas com o banco
 * DESLIGADO devolve null em vez de criar o SQLite à toa (status/consulta em
 * instância com a captura desligada não paga disco).
 */
function readEngine(): Engine | null {
  const open = currentEngine();
  if (open) return open;
  if (!config.magnetBank?.enabled) return null;
  return engine();
}

const clampLimit = (limit: number): number => Math.max(1, Math.min(500, Math.trunc(Number(limit)) || 100));

/** Lookup síncrono por hash (PK). Alimenta o play na Etapa 3. */
export function lookup(hash: string): MagnetRow | null {
  return readEngine()?.getMagnet(normHash(hash)) ?? null;
}

export function sourcesFor(hash: string): SourceRow[] {
  return readEngine()?.listSources(normHash(hash)) ?? [];
}

export function worksFor(hash: string): WorkRow[] {
  return readEngine()?.listWorks(normHash(hash)) ?? [];
}

/** Obras indexadas para (imdb, season, episode) — prepara a consulta do fallback. */
export function findByWork(imdb: string, season: number | null, episode: number | null, limit = 100): Array<{ work: WorkRow; magnet: MagnetRow | null }> {
  const e = readEngine();
  if (!e) return [];
  const ep = workTuple({ season, episode });
  return e.listWorksByObra(String(imdb || ''), ep.season, ep.episode, clampLimit(limit))
    .map((work) => ({ work, magnet: e.getMagnet(work.hash) }));
}

/** Fontes de um indexer (mais recentes primeiro) — prepara a consulta do fallback. */
export function findByIndexer(indexer: string, limit = 100): Array<{ source: SourceRow; magnet: MagnetRow | null }> {
  const e = readEngine();
  if (!e) return [];
  return e.listSourcesByIndexer(String(indexer || '').toLowerCase(), clampLimit(limit))
    .map((source) => ({ source, magnet: e.getMagnet(source.hash) }));
}

/** Panorama básico e detalhe de um hash para diagnóstico/painel. */
export function status() {
  const e = readEngine();
  if (e) reportEngine(e);
  return {
    enabled: Boolean(config.magnetBank?.enabled),
    engine: e ? e.kind : 'disabled',
    magnets: e?.countMagnets() ?? 0,
    sources: e?.countSources() ?? 0,
    works: e?.countWorks() ?? 0,
    queue: queue.length,
    queueMax: Math.max(1, Math.trunc(config.magnetBank?.queueMax ?? 500)),
  };
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
}

/** Flush + checkpoint (`wal_checkpoint` no engine SQL) antes de fechar. */
export function close(): void {
  flushNow();
  closeStore();
}

export type { MagnetRow, SourceRow, WorkRow, Engine };
