// Movido de src/utils/rust-stream-ranking.ts na fase 1: sem chamador em produção desde o corte do
// /stream (F4.4); vive só para o oráculo congelado e os testes dele.
/**
 * Ranking de streams em Rust (`evaluateStreamRanking` e `dedupeByHashNapi`,
 * `rust/crates/adom-napi/src/ranking.rs`): dedupe por hash + sortAndLimit do
 * pool pré-debrid em UMA chamada napi. O TS dessas etapas saiu do branch (o
 * oráculo é o `esm`); aqui só se monta a entrada e se aplica a saída — os
 * cortes voltam como `drops` e entram no trace pelo `pushTraceDrops`.
 */
import { requireCore } from '../../../src/utils/rust-core.js';
import * as metrics from '../../../src/utils/metrics.js';
import { pushTraceDrops } from '../../../src/utils/stream-trace.js';
import type { StreamTraceState } from '../../../src/utils/stream-trace.js';

/** Entrada do napi (o `SortOptions` do TS com `instant` materializado). */
export type RankingInputNapi = {
  streams: unknown[];
  indexerPriority: string[];
  minSeeders: number;
  maxResults: number;
  qualityFilter: string[];
  season?: number;
  episode?: number;
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

/** Funções do ranking no `.node`. */
export type RankingCore = {
  evaluateStreamRanking(input: RankingInputNapi): RankingOutputNapi;
  dedupeByHashNapi(input: { streams: unknown[]; indexerPriority: string[] }): { streams: unknown[]; drops: unknown[] };
};

export type SortOptionsLike = {
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
  trace?: StreamTraceState | null;
};

const rankingCore = () => requireCore() as unknown as RankingCore;

/**
 * Monta a entrada do napi. O callback `instant` vira o conjunto de hashes;
 * `trace` não cruza a fronteira (o Rust devolve os drops). O napi-rs só aceita
 * campo omitido para `Option<f64>`: temporada/episódio nulos ficam de fora.
 */
export function buildRankingInput(streams: unknown[], options: SortOptionsLike): RankingInputNapi {
  const instant = options.instant;
  const instantHashes = instant
    ? (streams as Array<{ infoHash?: string } | null>)
        .filter((s): s is { infoHash?: string } => Boolean(s?.infoHash))
        .filter((s) => instant(String(s.infoHash)))
        .map((s) => String(s.infoHash))
    : [];
  return {
    // `null` (stream sem hash) o dedupe do core descarta.
    streams,
    indexerPriority: options.indexerPriority || [],
    minSeeders: options.minSeeders || 0,
    maxResults: options.maxResults == null ? 40 : options.maxResults,
    qualityFilter: options.qualityFilter || [],
    ...(options.season == null ? {} : { season: options.season }),
    ...(options.episode == null ? {} : { episode: options.episode }),
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
  };
}

/**
 * Dedupe + piso + filtros + corte do pool, no Rust. Os cortes entram no trace
 * e as métricas que o corte conta (waiver do piso BR, whitelist relaxada) saem
 * da resposta.
 */
export function rustSortAndLimit(streams: unknown[], options: SortOptionsLike): unknown[] {
  metrics.count('rust.ranking.calls');
  const out = rankingCore().evaluateStreamRanking(buildRankingInput(streams, options));
  if (!out || !Array.isArray(out.streams)) throw new Error('evaluateStreamRanking não devolveu streams');
  pushTraceDrops(options.trace, out.drops);
  if (out.waivedHashes.length) metrics.count('search.brDubbed.seedFloorWaived', out.waivedHashes.length);
  if (out.qualityRelaxed) metrics.count('search.qualityFilter.relaxed');
  return out.streams;
}

/** Só o dedupe por hash (mesma regra do primeiro passo do ranking). */
export function rustDedupeByHash(
  streams: unknown[],
  indexerPriority: string[] = [],
  trace?: StreamTraceState | null,
): unknown[] {
  const out = rankingCore().dedupeByHashNapi({ streams, indexerPriority });
  pushTraceDrops(trace, out.drops);
  return out.streams;
}
