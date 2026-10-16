/**
 * Filtro de relevância em Rust (`filterRelevantRawNapi`,
 * `filterInventoryRelevantNapi`, `rust/crates/adom-napi/src/relevance.rs`):
 * `filterRelevantRaw`/`filterInventoryRelevant` decidem INTEIROS no núcleo, em
 * UMA chamada por lote. Saem só índices — nenhum veredito volta campo a campo
 * pela fronteira (era isso que tornava o caminho Rust mais lento que o TS).
 * A lógica real vive em `adom_core` (com golden contra o TS do `esm`); aqui só
 * se monta a entrada e se traduz o código do motivo de volta para o rótulo.
 */
import config from '../config.js';
import { requireCore } from './rust-core.js';

// O napi-rs desta build expõe os campos em camelCase (índice.d.ts gerado), e
// ausência é `undefined` — `null` não satisfaz `Option`.

/** Entrada do napi: os campos de `RawItem` que o filtro lê. */
export type RelevanceEntryNapi = {
  title?: string;
  titlePascal?: string;
  magnet?: string;
  magnetUri?: string;
  guid?: string;
  isBr: boolean;
};

export type RelevanceQueryNapi = {
  names: string[];
  year: string;
  altYear?: string;
  isSeries: boolean;
  season?: number;
  episode?: number;
  multiWorkRoot?: string;
  homeReleaseAt?: number;
};

export type RelevanceSettingsNapi = {
  nowMs: number;
  preHomeReleaseCut: boolean;
  preHomeReleaseMarginMs: number;
  titlePrecisionTailCut: boolean;
};

export type RelevanceOutcomeNapi = {
  kept: number[];
  rejected: Array<{ index: number; reason: number }>;
};

/** Funções do filtro no `.node`. */
export type RelevanceCore = {
  filterRelevantRawNapi(items: RelevanceEntryNapi[], query: RelevanceQueryNapi, settings: RelevanceSettingsNapi): RelevanceOutcomeNapi;
  filterRelevantRawForYearNapi(items: RelevanceEntryNapi[], query: RelevanceQueryNapi, settings: RelevanceSettingsNapi): RelevanceOutcomeNapi;
  filterInventoryRelevantNapi(items: RelevanceEntryNapi[], query: RelevanceQueryNapi, settings: RelevanceSettingsNapi): RelevanceOutcomeNapi;
};

/** Código do motivo → rótulo do `RelevanceRejectReason` do TS. */
export const REJECT_LABELS = [
  'title',
  'magnet-year',
  'named-sequel',
  'identity',
  'episode',
  'series-work',
  'movie-is-series',
  'series-is-movie',
  'pre-home-release',
  'non-feature',
] as const;

export type RelevanceRejectReasonLabel = (typeof REJECT_LABELS)[number];

const relevanceCore = () => requireCore() as unknown as RelevanceCore;

/** Item bruto (indexer, acervo) como o filtro o recebe. */
export type RelevanceItemLike = {
  title?: string;
  Title?: string;
  magnet?: string;
  MagnetUri?: string;
  Guid?: string;
  isBr?: boolean;
};

/** Monta a entrada por item: campo falsy fica de fora (o `||` do JS). */
export function buildRelevanceEntries(items: readonly RelevanceItemLike[]): RelevanceEntryNapi[] {
  return items.map((item) => ({
    ...(item?.title ? { title: item.title } : {}),
    ...(item?.Title ? { titlePascal: item.Title } : {}),
    ...(item?.magnet ? { magnet: item.magnet } : {}),
    ...(item?.MagnetUri ? { magnetUri: item.MagnetUri } : {}),
    ...(item?.Guid ? { guid: item.Guid } : {}),
    isBr: Boolean(item?.isBr),
  }));
}

/** Consulta e config (`config.search` + relógio), uma vez por lote. */
export function buildRelevanceQuery(o: {
  names?: string[];
  year?: number | string | null;
  altYear?: number | string | null;
  isSeries?: boolean;
  season?: number | null;
  episode?: number | null;
  multiWorkRoot?: string | null;
  homeReleaseAt?: number | null;
}): RelevanceQueryNapi {
  return {
    names: o.names || [],
    year: String(o.year ?? ''),
    ...(o.altYear == null || o.altYear === '' ? {} : { altYear: String(o.altYear) }),
    isSeries: Boolean(o.isSeries),
    ...(o.season == null ? {} : { season: Number(o.season) }),
    ...(o.episode == null ? {} : { episode: Number(o.episode) }),
    ...(o.multiWorkRoot ? { multiWorkRoot: o.multiWorkRoot } : {}),
    ...(o.homeReleaseAt == null ? {} : { homeReleaseAt: Number(o.homeReleaseAt) }),
  };
}

function buildSettings(): RelevanceSettingsNapi {
  return {
    nowMs: Date.now(),
    preHomeReleaseCut: config.search.preHomeReleaseCut,
    preHomeReleaseMarginMs: config.search.preHomeReleaseMarginMs,
    titlePrecisionTailCut: config.search.titlePrecisionTailCut,
  };
}

export type RelevanceRustOutcome = RelevanceOutcomeNapi & {
  labels: Map<number, RelevanceRejectReasonLabel>;
};

function labelsOf(out: RelevanceOutcomeNapi): Map<number, RelevanceRejectReasonLabel> {
  const labels = new Map<number, RelevanceRejectReasonLabel>();
  for (const { index, reason } of out.rejected) labels.set(index, REJECT_LABELS[reason] || 'title');
  return labels;
}

/** `filterRelevantRaw` no núcleo: kept + [(índice, rótulo do motivo)]. */
export function rustFilterRelevantRaw(items: readonly RelevanceItemLike[], query: RelevanceQueryNapi): RelevanceRustOutcome {
  const out = relevanceCore().filterRelevantRawNapi(buildRelevanceEntries(items), query, buildSettings());
  return { ...out, labels: labelsOf(out) };
}

/** `filterInventoryRelevant` no núcleo. */
export function rustFilterInventoryRelevant(items: readonly RelevanceItemLike[], query: RelevanceQueryNapi): RelevanceRustOutcome {
  const out = relevanceCore().filterInventoryRelevantNapi(buildRelevanceEntries(items), query, buildSettings());
  return { ...out, labels: labelsOf(out) };
}
