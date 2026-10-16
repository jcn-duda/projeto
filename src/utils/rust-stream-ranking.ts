/**
 * Ponte do lote de ranking em Rust (`evaluateStreamRanking`,
 * `rust/crates/adom-napi/src/ranking.rs`): dedupe por hash + sortAndLimit do
 * pool pré-debrid em UMA chamada napi (o core já compõe as duas etapas, com o
 * mesmo trace de cortes).
 *
 * Modos (`RUST_STREAM_RANKING`): `off` (default) = só TS; `on` = o Rust responde
 * e cai no TS se ele lançar (o rust nunca derruba a busca); `shadow` = o TS
 * responde e a comparação roda em `setImmediate`, FORA do caminho da resposta —
 * divergência vira `rust.ranking.divergence` no /metrics.json + log com teto.
 */
import config from '../config.js';
import * as log from './logger.js';
import * as metrics from './metrics.js';

/** Entrada do napi (o `SortOptions` do TS com `instant` materializado). */
export type RankingInputNapi = {
  streams: unknown[];
  indexerPriority: string[];
  minSeeders: number;
  maxResults: number;
  qualityFilter: string[];
  season: number | null;
  episode: number | null;
  preferDubbed: boolean;
  dubbedOnly: boolean;
  excludeCam: boolean;
  maxSizeGb: number;
  qualityLimits: Record<string, number>;
  brReservedSlots: number;
  brReservedPerQuality: number;
  candidateFactor: number;
  brFirst: boolean;
  instantHashes: string[];
};

export type RankingOutputNapi = {
  streams: unknown[];
  waivedHashes: string[];
  qualityRelaxed: boolean;
  drops: unknown[];
};

/** Funções que o .node expõe (binário antigo pode não as ter). */
export type RankingCore = {
  evaluateStreamRanking?(input: RankingInputNapi): RankingOutputNapi;
  dedupeByHashNapi?(input: {
    streams: unknown[];
    indexerPriority: string[];
  }): { streams: unknown[]; drops: unknown[] };
};

type GetCore = () => RankingCore | null;

let getCore: GetCore | null = null;
let warnedNoFn = false;
let loggedDiffs = 0;

function installRankingHook(get: GetCore) {
  getCore = get;
}

function resetRankingHook() {
  getCore = null;
  warnedNoFn = false;
  loggedDiffs = 0;
}

export { installRankingHook, resetRankingHook };

/** Modo atual; testes injetam config, produção lê o .env uma vez no boot. */
export function rankingMode(): 'off' | 'shadow' | 'on' {
  return config.rustStreamRanking.mode;
}

type SortOptionsLike = {
  minSeeders?: number;
  maxResults?: number;
  qualityFilter?: string[];
  season?: number | null;
  episode?: number | null;
  preferDubbed?: boolean;
  dubbedOnly?: boolean;
  excludeCam?: boolean;
  maxSizeGb?: number;
  qualityLimits?: Partial<Record<string, number>>;
  brReservedSlots?: number;
  brReservedPerQuality?: number;
  candidateFactor?: number;
  brFirst?: boolean;
  indexerPriority?: string[];
  instant?: ((hash: string) => boolean) | null;
};

/**
 * Monta a entrada do napi. Cópia RASA de cada stream: o shadow roda depois do
 * `setImmediate` e o pipeline pode mexer nos objetos originais — o que se
 * compara é o estado da hora do agendamento. Callbacks (`instant`) viram o
 * conjunto de hashes; `trace` não cruza a fronteira (o Rust devolve os drops).
 */
export function buildRankingInput(streams: unknown[], options: SortOptionsLike): RankingInputNapi {
  const instant = options.instant;
  const instantHashes = instant
    ? (streams as Array<{ infoHash?: string } | null>)
        .filter((s): s is { infoHash?: string } => Boolean(s?.infoHash))
        .filter((s) => instant(String(s.infoHash)))
        .map((s) => String(s.infoHash))
    : [];
  return dropNulls({
    // `null` (stream sem hash) o dedupe do core descarta, como o TS.
    streams: streams.map((s) => (s ? { ...(s as Record<string, unknown>) } : null)),
    indexerPriority: options.indexerPriority || [],
    minSeeders: options.minSeeders || 0,
    maxResults: options.maxResults == null ? 40 : options.maxResults,
    qualityFilter: options.qualityFilter || [],
    season: options.season ?? null,
    episode: options.episode ?? null,
    preferDubbed: Boolean(options.preferDubbed),
    dubbedOnly: Boolean(options.dubbedOnly),
    excludeCam: Boolean(options.excludeCam),
    maxSizeGb: options.maxSizeGb || 0,
    qualityLimits: Object.fromEntries(
      Object.entries(options.qualityLimits || {}).map(([k, v]) => [k, Number(v) || 0]),
    ),
    brReservedSlots: options.brReservedSlots || 0,
    brReservedPerQuality: options.brReservedPerQuality || 0,
    candidateFactor: options.candidateFactor || 1,
    brFirst: options.brFirst !== false,
    instantHashes,
  });
}

/**
 * O napi-rs só aceita `undefined` (campo omitido) para `Option<f64>`; `null`
 * explícito falha a conversão. Campos nulos são removidos antes da chamada.
 */
function dropNulls<T extends Record<string, unknown>>(input: T): T {
  const out = { ...input };
  for (const k of Object.keys(out)) {
    if (out[k] === null) delete out[k];
  }
  return out;
}

/** JSON canônico (chaves ordenadas) para comparar TS × Rust sem ruído de ordem. */
function canonJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) out[k] = (v as Record<string, unknown>)[k];
      return out;
    }
    return v;
  });
}

function logDiff(input: RankingInputNapi, ts: unknown[], rust: unknown[]) {
  metrics.count('rust.ranking.divergence');
  if (loggedDiffs >= config.rustCore.maxLoggedDiffs) return;
  loggedDiffs += 1;
  const tsLen = ts.length;
  const rustLen = rust.length;
  log.warn(
    `[rust] ranking divergiu: ts=${tsLen} streams rust=${rustLen} streams `
      + `entrada=${JSON.stringify(input.streams.length)} itens, primeiro ts=${JSON.stringify(ts[0] ?? null)} rust=${JSON.stringify(rust[0] ?? null)}`,
  );
}

/**
 * Caminho `on`: o Rust responde. `null` = off, núcleo ausente ou erro — o
 * chamador segue com o TS (o rust nunca derruba a busca). As métricas que o TS
 * conta dentro do sortAndLimit (`seedFloorWaived`, `qualityFilter.relaxed`)
 * são contadas aqui a partir da saída do Rust.
 */
export function rustSortAndLimit(streams: unknown[], options: SortOptionsLike): unknown[] | null {
  try {
    if (config.rustStreamRanking.mode !== 'on' || !getCore) return null;
    const core = getCore();
    if (!core) return null;
    if (typeof core.evaluateStreamRanking !== 'function') {
      if (!warnedNoFn) {
        warnedNoFn = true;
        log.info('[rust] núcleo sem evaluateStreamRanking (binário antigo); ranking segue no TS');
      }
      return null;
    }
    const input = buildRankingInput(streams, options);
    metrics.count('rust.ranking.calls');
    const out = core.evaluateStreamRanking(input);
    if (!out || !Array.isArray(out.streams)) throw new Error('evaluateStreamRanking não devolveu streams');
    metrics.count('rust.ranking.waived', out.waivedHashes.length);
    if (out.qualityRelaxed) metrics.count('search.qualityFilter.relaxed');
    return out.streams;
  } catch (err) {
    metrics.count('rust.ranking.error');
    log.debug('[rust] ranking lançou; usando TS:', log.errorMessage(err));
    return null;
  }
}

/**
 * Caminho `shadow`: agenda a comparação FORA do caminho da resposta. A entrada
 * já vem pronta (com cópia rasa) e a saída do TS é congelada em JSON.
 */
export function shadowSortAndLimit(input: RankingInputNapi, tsStreams: unknown[]): void {
  try {
    if (config.rustStreamRanking.mode !== 'on' && config.rustStreamRanking.mode !== 'shadow') return;
    if (config.rustStreamRanking.mode === 'on') return; // `on` já respondeu com o Rust
    const core = getCore?.();
    if (!core) return;
    if (typeof core.evaluateStreamRanking !== 'function') {
      if (!warnedNoFn) {
        warnedNoFn = true;
        log.info('[rust] núcleo sem evaluateStreamRanking (binário antigo); sombra do ranking desligada');
      }
      return;
    }
    const tsFrozen = tsStreams.map((s) => (s ? { ...(s as Record<string, unknown>) } : null));
    const bound = core.evaluateStreamRanking.bind(core);
    setImmediate(() => {
      try {
        metrics.count('rust.ranking.calls');
        const out = bound(input);
        if (!out || !Array.isArray(out.streams)) throw new Error('evaluateStreamRanking não devolveu streams');
        if (canonJson(tsFrozen) !== canonJson(out.streams)) logDiff(input, tsFrozen, out.streams);
      } catch (err) {
        metrics.count('rust.ranking.error');
        log.debug('[rust] sombra do ranking lançou:', log.errorMessage(err));
      }
    });
  } catch (err) {
    metrics.count('rust.ranking.error');
    log.debug('[rust] sombra do ranking não agendou:', log.errorMessage(err));
  }
}
