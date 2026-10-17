/**
 * Matching de episódio/temporada — decisão INTEIRA no núcleo Rust
 * (`rust/crates/adom-napi/src/episode_matching.rs`; lógica em `adom-core`,
 * golden contra o TS do `esm`). O corpo TS saiu do branch: aqui só se monta
 * a entrada e se resolve o título do stream (`title || name`).
 *
 * Módulo-folha: chama `nativeCore` direto, como `title-normalization.ts`.
 *
 * Regra de ouro: chamada direta SEM lote — medido em `tmp/g2-measure.mjs`
 * (corpus real do `magnets.db`), o laço por item dos chamadores
 * (episode-size, stream-quotas, autofetch-pools) custa <0,5 ms por ciclo.
 */
import type { ParsedSeasonEpisode, StreamCandidate } from '../../types/domain.js';
import { nativeCore } from './native-core.js';

/** Funções de matching de episódio no `.node` (camelCase do napi-rs). */
type EpisodeMatchingCore = {
  parseTitleSeasonEpisode(title: string): ParsedSeasonEpisode;
  matchesEpisode(title: string, season: number | null, episode: number | null): boolean;
  isSeasonPackRelease(title: string, season: number | null): boolean;
  isSeasonPackFillEligible(title: string, season: number | null): boolean;
  seasonCoverageExcludes(parsed: ParsedSeasonEpisode, season: number | null): boolean;
  magnetSeasonContradicts(
    magnet: string | null,
    magnetUri: string | null,
    guid: string | null,
    season: number,
    episode: number | null,
  ): boolean;
  magnetYearContradicts(
    magnet: string | null,
    magnetUri: string | null,
    guid: string | null,
    catalogYear: number,
  ): boolean;
};

const core = () => nativeCore<EpisodeMatchingCore>();

/** Título de um stream como o núcleo lê (`title || name`). */
function streamTitle(stream: StreamCandidate | null | undefined): string {
  return String(stream?.title || stream?.name || '');
}

/**
 * Extrai temporada/episódio do título da release. Cobre "S01E04", "S01E01-E10",
 * "1x04", "S01" (pack), "T01E004" BR, ordinais por extenso, faixas e packs.
 * O tipo trava o CONTRATO: campo a mais ou a menos aqui quebra a compilação.
 */
function parseTitleSeasonEpisode(title = ''): ParsedSeasonEpisode {
  return core().parseTitleSeasonEpisode(String(title));
}

/** Cobertura explícita que exclui a temporada pedida não pode virar "talvez". */
function seasonCoverageExcludes(parsed: ParsedSeasonEpisode, season: number | null | undefined) {
  return core().seasonCoverageExcludes(parsed, season ?? null);
}

/**
 * O indexer devolve a temporada inteira quando a busca é por "Nome S01E01" —
 * sem este filtro a lista de E01 vinha recheada de E03, E04, E06, E09.
 * Pack de temporada (sem episódio no título) continua valendo.
 */
function matchesEpisode(
  title: string,
  { season, episode }: { season?: number | null; episode?: number | null } = {},
) {
  return core().matchesEpisode(String(title), season ?? null, episode ?? null);
}

/**
 * A release cobre a temporada inteira pedida? ("S01", "1ª Temporada",
 * "Série Completa"). Em busca de série o autofetch prefere pack a episódio
 * avulso: um download serve o binge todo.
 */
function isSeasonPackRelease(stream: StreamCandidate, season: number | null) {
  return core().isSeasonPackRelease(streamTitle(stream), season ?? null);
}

/**
 * Variante ESTREITA do isSeasonPackRelease, só para o Season Pack Fill:
 * o título tem que PROVAR a temporada (número casando ou série completa).
 */
function isSeasonPackFillEligible(stream: StreamCandidate, season: number | null) {
  return core().isSeasonPackFillEligible(streamTitle(stream), season ?? null);
}

/** Item com os campos de magnet que as guardas leem (`||` do JS). */
type MagnetLike = {
  magnet?: string;
  MagnetUri?: string;
  Guid?: string;
};

/**
 * Temporada e episódio no `dn=` do magnet: o post BR pode ter título genérico,
 * mas o nome real do arquivo manda. Única versão no branch — a cópia TS saiu.
 */
function magnetSeasonContradicts(
  item: MagnetLike | null | undefined,
  season: number,
  episode: number | null | undefined,
) {
  return core().magnetSeasonContradicts(
    item?.magnet || null,
    item?.MagnetUri || null,
    item?.Guid || null,
    season,
    episode ?? null,
  );
}

/**
 * Ano escondido no `dn=` do magnet: um único ano além de ±2 do catálogo é
 * outra obra; vários anos em filme viram intervalo. Única versão no branch.
 */
function magnetYearContradicts(item: MagnetLike | null | undefined, catalogYear: number) {
  return core().magnetYearContradicts(
    item?.magnet || null,
    item?.MagnetUri || null,
    item?.Guid || null,
    catalogYear,
  );
}

export {
  parseTitleSeasonEpisode,
  seasonCoverageExcludes,
  matchesEpisode,
  isSeasonPackRelease,
  isSeasonPackFillEligible,
  magnetSeasonContradicts,
  magnetYearContradicts,
};
