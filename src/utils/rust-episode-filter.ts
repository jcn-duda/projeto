/**
 * Filtro de episódio/temporada em Rust (`filterSeriesEpisodeNapi`,
 * `rust/crates/adom-napi/src/episode_filter.rs`): o laço de decisão de
 * `filterSeriesEpisodeRaw` roda INTEIRO no núcleo, em UMA chamada por lote.
 * O corte `preAirReleases` (banco de magnets) e o enriquecimento
 * `bankByHash` ficam no TS — o núcleo recebe os hashes já excluídos e os
 * magnets já enriquecidos. A lógica vive em `adom_core::series_episode_filter`
 * (testes unitários lá); aqui só se monta a entrada e se traduz o código do
 * motivo de volta para o rótulo.
 */
import { requireCore } from './rust-core.js';

// O napi-rs desta build expõe os campos em camelCase, e ausência é
// `undefined` — `null` não satisfaz `Option`.

/** Entrada do napi: os campos de `RawItem` que o laço lê. */
export type EpisodeFilterEntryNapi = {
  title?: string;
  titlePascal?: string;
  magnet?: string;
  magnetUri?: string;
  guid?: string;
  infoHash?: string;
  fromAccount: boolean;
  isBr: boolean;
};

export type SeriesEpisodeOutcomeNapi = {
  kept: number[];
  rejected: Array<{ index: number; reason: number }>;
};

/** Funções do filtro de episódio no `.node`. */
export type EpisodeFilterCore = {
  filterSeriesEpisodeNapi(
    items: EpisodeFilterEntryNapi[],
    season: number,
    episode: number,
    universe: string[],
    names: string[],
    unaired: boolean,
    preAirHashes: string[],
    titlePrecisionTailCut?: boolean,
  ): SeriesEpisodeOutcomeNapi;
};

/** Código do motivo → rótulo estável (o TS atual não rotula este laço;
 * estes rótulos definem o contrato da build e ficam na ordem do laço). */
export const EPISODE_FILTER_LABELS = [
  'pre-air',
  'episode',
  'series-work',
  'unaired',
  'article',
] as const;

export type EpisodeFilterReasonLabel = (typeof EPISODE_FILTER_LABELS)[number];

/** Item bruto (indexer, acervo) como o laço o recebe. */
export type EpisodeFilterItemLike = {
  title?: string;
  Title?: string;
  magnet?: string;
  MagnetUri?: string;
  Guid?: string;
  infoHash?: string;
  fromAccount?: boolean;
  isBr?: boolean;
};

/** Monta a entrada por item: campo falsy fica de fora (o `||` do JS). */
export function buildEpisodeFilterEntries(items: readonly EpisodeFilterItemLike[]): EpisodeFilterEntryNapi[] {
  return items.map((item) => ({
    ...(item?.title ? { title: item.title } : {}),
    ...(item?.Title ? { titlePascal: item.Title } : {}),
    ...(item?.magnet ? { magnet: item.magnet } : {}),
    ...(item?.MagnetUri ? { magnetUri: item.MagnetUri } : {}),
    ...(item?.Guid ? { guid: item.Guid } : {}),
    ...(item?.infoHash ? { infoHash: item.infoHash } : {}),
    fromAccount: Boolean(item?.fromAccount),
    isBr: Boolean(item?.isBr),
  }));
}

export type EpisodeFilterRustOutcome = SeriesEpisodeOutcomeNapi & {
  labels: Map<number, EpisodeFilterReasonLabel>;
};

/** `filterSeriesEpisodeRaw` sem pre-air/banco: laço no núcleo. */
export function rustFilterSeriesEpisode(
  items: readonly EpisodeFilterItemLike[],
  season: number,
  episode: number,
  universe: string[],
  names: string[],
  unaired: boolean,
  preAirHashes: string[],
): EpisodeFilterRustOutcome {
  const core = requireCore() as unknown as EpisodeFilterCore;
  const out = core.filterSeriesEpisodeNapi(
    buildEpisodeFilterEntries(items),
    season,
    episode,
    universe,
    names,
    unaired,
    preAirHashes,
    // `config.search.titlePrecisionTailCut` (default true) — o napi usa o
    // mesmo default quando ausente.
  );
  const labels = new Map<number, EpisodeFilterReasonLabel>();
  for (const { index, reason } of out.rejected) {
    labels.set(index, EPISODE_FILTER_LABELS[reason] || 'episode');
  }
  return { ...out, labels };
}
