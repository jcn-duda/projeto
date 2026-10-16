import type { RawItem, MultiWorkCollection } from '../../types/domain.js';
import { matchesEpisode, seasonCoverageExcludes, parseTitleSeasonEpisode } from './episode-matching.js';
import { magnetDisplayName } from './title-normalization.js';
import {
  buildRelevanceQuery,
  rustFilterInventoryRelevant,
  rustFilterRelevantRaw,
  type RelevanceRejectReasonLabel,
} from './rust-relevance.js';

export type RelevanceRejectReason = RelevanceRejectReasonLabel;

interface MatchOptions {
  names?: string[];
  year?: number | string | null;
  isSeries?: boolean;
  season?: number | null;
  episode?: number | null;
  allNames?: string[] | null;
  tokens?: string[] | null;
  universeTokens?: string[] | null;
  /** Opt-in multiobra: quando presente, packs da franquia podem ser admitidos. */
  multiWork?: MultiWorkCollection | null;
  /** Segundo ano de catálogo quando Cinemeta e TMDB divergem (ver `catalogAltYearOf`). */
  altYear?: number | string | null;
  /** 1º lançamento doméstico no TMDB (ms), só filme recente (`tmdb-home-release.ts`). */
  homeReleaseAt?: number | null;
}

/**
 * Classificação crua compartilhada pelo corte final e pelo gatilho de pack.
 * O corte INTEIRO acontece no núcleo Rust (`rust-relevance.ts`), numa chamada
 * por lote: entram os campos que o filtro lê e a consulta, saem só índices e
 * o motivo de cada rejeição. Paridade TS × Rust medida com zero divergência
 * sobre séries, filmes, ano duplo, multiobra e pre-home-release; o oráculo do
 * golden é o TS do `esm`.
 */
function filterRelevantRaw(
  items: RawItem[] = [],
  options: MatchOptions = {},
  onRejected?: (item: RawItem, reason: RelevanceRejectReason) => void,
) {
  const names = options.names || [];
  // Sem nomes o filtro TS devolvia a lista inteira — mantém o contrato.
  if (!names.length) return items;
  const outcome = rustFilterRelevantRaw(items, buildRelevanceQuery({ ...options, names, multiWorkRoot: options.multiWork?.root || null }));
  if (onRejected) {
    for (const { index } of outcome.rejected) onRejected(items[index], outcome.labels.get(index) || 'title');
  }
  return outcome.kept.map((i) => items[i]);
}

/**
 * Relevância de item do INVENTÁRIO da conta do debrid: o caminho estrito dos
 * indexers MAIS a exceção de pack multi-obra da mesma franquia (só filme) —
 * tudo no núcleo, na mesma chamada do filtro (`filterInventoryRelevantNapi`).
 * Sem nomes devolve vazio, como o contrato TS.
 */
function filterInventoryRelevant(
  items: RawItem[] = [],
  { names = [], ...matchContext }: MatchOptions = {},
  onRejected?: (item: RawItem, reason: RelevanceRejectReason) => void,
) {
  if (!names.length) return [];
  const outcome = rustFilterInventoryRelevant(items, buildRelevanceQuery({ ...matchContext, names, multiWorkRoot: matchContext.multiWork?.root || null }));
  if (onRejected) {
    for (const { index } of outcome.rejected) onRejected(items[index], outcome.labels.get(index) || 'title');
  }
  return outcome.kept.map((i) => items[i]);
}

/**
 * Ano verdadeiro escondido no magnet: sites BR publicam o post sem ano no
 * título mapeado ("O Corvo The Crow e Dual"), mas o dn= do magnet preserva o
 * nome real da release. Um único ano explícito no magnet contradizendo o
 * catálogo além de ±2 é outra obra; vários anos em FILME viram intervalo.
 * (Consumo direto fora do filtro: `stream-builder-episode-filter.ts`.)
 */
function magnetYearContradicts(item: RawItem | null | undefined, catalogYear: number) {
  return textYearsContradict(magnetDisplayName(item), catalogYear);
}

/** Núcleo do `magnetYearContradicts` sobre um texto qualquer (título, `dn=`). */
function textYearsContradict(source: string, catalogYear: number) {
  if (!source || !catalogYear) return false;
  const cleaned = source.replace(/\d{3,4}x\d{3,4}/gi, ' ');
  const years = [
    ...new Set(
      [...cleaned.matchAll(/(?<!\d)(?:19|20)\d{2}(?!\d)/g)].map((m: any) => Number(m[0])),
    ),
  ];
  if (years.length === 0) return false;
  if (years.length === 1) return Math.abs(years[0] - catalogYear) > 2;
  // Vários anos: intervalo [min, max]. Há contradição quando NENHUM ano fica
  // a ±2 do catálogo E o catálogo está fora do intervalo.
  const minYear = Math.min(...years);
  const maxYear = Math.max(...years);
  const someNear = years.some((y) => Math.abs(y - catalogYear) <= 2);
  if (someNear) return false;
  return catalogYear < minYear || catalogYear > maxYear;
}

/**
 * Temporada e episódio no dn= do magnet: sites BR publicam posts com título
 * genérico, mas o dn= carrega a identificação real do arquivo. Se o dn=
 * excluir a temporada ou apontar para outro episódio, descarta na busca fria.
 */
function magnetSeasonContradicts(item: RawItem | null | undefined, season: number, episode: number | null | undefined) {
  const dn = magnetDisplayName(item);
  if (!dn) return false;
  const parsed = parseTitleSeasonEpisode(dn);
  if (seasonCoverageExcludes(parsed, season)) return true;
  if (episode != null && !matchesEpisode(dn, { season, episode })) return true;
  return false;
}

export {
  filterRelevantRaw,
  filterInventoryRelevant,
  magnetYearContradicts,
  magnetSeasonContradicts,
};
