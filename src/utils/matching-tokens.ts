/**
 * Leitura estrutural de tokens — decisão INTEIRA no núcleo Rust
 * (`adom-core::matching_tokens`, `matching_decisions`, `matching_vocabulary` e
 * `episode_series_matching`, com golden contra o TS do `esm`). O corpo TS saiu
 * do branch: aqui só se monta a entrada e se traduz o `Option` do Rust de volta
 * para `undefined` (os `first*Token` do TS devolvem `undefined`, não `null`).
 *
 * Módulo-folha: chama `nativeCore` direto, como `title-normalization.ts`.
 *
 * Regra de ouro: chamada direta SEM lote. Medido em `tmp/g5-measure.mjs`
 * (corpus real do `magnets.db`), o laço por item dos chamadores custa <0,5 ms
 * por ciclo — o mesmo piso que decidiu G1/G2.
 */
import { nativeCore } from './native-core.js';

/** Funções de tokens/decisões no `.node` (camelCase do napi-rs). */
type TokensCore = {
  extractSequenceMarkersNapi(text: string): string[];
  titlePrecisionNapi(tokens: string[], wanted: string[], cutTail: boolean): number;
  episodeWorkTokensNapi(tokens: string[]): string[] | null;
  yearContradictsNapi(tokens: string[], year: string, isSeries: boolean): boolean;
  namedSequelContradictsNapi(tokens: string[], universe: string[], catalogYear: string): boolean;
  liveActionYearContradictsNapi(text: string, premiereYear: string): boolean;
  adaptationIdentityContradictsNapi(seasonPresent: boolean, text: string, year: string): boolean;
  firstSignificantTokenNapi(tokens: string[]): string | null;
  isNonNamingTokenNapi(token: string): boolean;
  isNonLatinTokenNapi(token: string): boolean;
  firstUnmarkedTokenNapi(tokens: string[]): string | null;
  firstWorkTokenNapi(tokens: string[]): string | null;
};

const core = () => nativeCore<TokensCore>();

/** Ano como texto, que é o que o núcleo lê (`String(x ?? '')`, como o TS). */
function yearText(year: number | string | null | undefined): string {
  return String(year ?? '');
}

/**
 * Números de SEQUÊNCIA (sequel/parte) e palavras que anunciam continuação
 * ("Ressurge", "Rises"). O conjunto do TS mistura número e string; o núcleo
 * devolve o texto do marcador e aqui ele volta ao tipo original.
 */
function extractSequenceMarkers(text: string): Set<number | string> {
  const markers = core().extractSequenceMarkersNapi(String(text));
  return new Set(markers.map((marker) => (/^\d+$/.test(marker) ? Number(marker) : marker)));
}

/**
 * Quanto do título do candidato está DENTRO da busca, ignorando ruído de
 * release, empacotamento e ano. 1 = o título não acrescenta nada.
 */
function titlePrecision(
  tokens: string[],
  wanted: Iterable<string>,
  { cutTail = true }: { cutTail?: boolean } = {},
): number {
  return core().titlePrecisionNapi(tokens, [...wanted], cutTail);
}

/**
 * Trecho que nomeia a OBRA numa release por episódio; `null` quando não há
 * marcador. O nome do episódio vem depois de SxxEyy e não conta como obra
 * estranha.
 */
function episodeWorkTokens(tokens: string[]): string[] | null {
  return core().episodeWorkTokensNapi(tokens);
}

/**
 * O ano do título contradiz o ano do catálogo? Definição ÚNICA da regra de
 * ano, com tolerância por tipo (filme ±2; série só condena quando TODOS os
 * anos são anteriores à estreia −2).
 */
function yearContradicts(tokens: string[], year: number | string | null, isSeries: boolean): boolean {
  return core().yearContradictsNapi(tokens, yearText(year), isSeries);
}

/**
 * Sequel nomeada com ano EXATO diferente do catálogo: exige as DUAS provas —
 * token significativo fora do universo de nomes E ano declarado ≠ catálogo.
 */
function namedSequelContradicts(
  tokens: string[],
  universe: Iterable<string>,
  catalogYear: number | string | null,
): boolean {
  return core().namedSequelContradictsNapi(tokens, [...universe], yearText(catalogYear));
}

/**
 * Contaminação de identidade por ADAPTAÇÃO (Live Action × original): o post
 * declara "Live Action" e um ano LONGE da estreia da obra pedida.
 */
function liveActionYearContradicts(
  text: string,
  premiereYear: number | string | null | undefined,
): boolean {
  return core().liveActionYearContradictsNapi(String(text ?? ''), yearText(premiereYear));
}

/**
 * Veto de identidade no caminho de BUSCA/registro: só SÉRIE (filme tem as
 * regras de sequela/ano próprias) e só com as duas provas da live action.
 */
function adaptationIdentityContradicts(
  request: { season?: number | null },
  text: string,
  year?: number | string | null,
): boolean {
  return core().adaptationIdentityContradictsNapi(request?.season != null, String(text ?? ''), yearText(year));
}

/** Primeiro token relevante do título; cai no primeiro token da lista. */
function firstSignificantToken(arr: string[]): string | undefined {
  return core().firstSignificantTokenNapi(arr) ?? undefined;
}

/**
 * O token é rótulo ou estrutura — artigo, ruído de release, marca de
 * empacotamento, marcador de episódio, número — e NÃO nomeia a obra.
 */
function isNonNamingToken(token: string): boolean {
  return core().isNonNamingTokenNapi(String(token));
}

/** O token NÃO tem letra latina: é título localizado (光環) ou outra marca. */
function isNonLatinToken(token: string): boolean {
  return core().isNonLatinTokenNapi(String(token));
}

/** Primeiro token que nomeia a obra, em qualquer script. */
function firstUnmarkedToken(tokens: string[]): string | undefined {
  return core().firstUnmarkedTokenNapi(tokens) ?? undefined;
}

/**
 * Primeiro token LATINO que nomeia a obra — a versão do `firstSignificantToken`
 * que também pula ruído de release e devolve `undefined` em vez do `arr[0]`.
 */
function firstWorkToken(tokens: string[]): string | undefined {
  return core().firstWorkTokenNapi(tokens) ?? undefined;
}

export {
  extractSequenceMarkers,
  titlePrecision,
  episodeWorkTokens,
  yearContradicts,
  namedSequelContradicts,
  liveActionYearContradicts,
  adaptationIdentityContradicts,
  firstSignificantToken,
  isNonNamingToken,
  isNonLatinToken,
  firstUnmarkedToken,
  firstWorkToken,
};
