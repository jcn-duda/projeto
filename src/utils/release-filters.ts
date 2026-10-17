import type { RawItem, MultiWorkCollection } from '../../types/domain.js';
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
 * As guardas de magnet (`magnetYearContradicts`/`magnetSeasonContradicts`)
 * moram em `episode-matching.ts` — versão única, ponte do núcleo. O barrel
 * (`format.ts`/`release-matching.ts`) reexporta de lá; a cópia TS daqui saiu.
 */

export { filterRelevantRaw, filterInventoryRelevant };
