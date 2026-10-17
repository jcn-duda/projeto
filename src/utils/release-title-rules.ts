/**
 * Os portões de título: o que decide se uma release É a obra procurada —
 * decisão INTEIRA no núcleo Rust (`adom-core::matches_br_title`,
 * `release_title_rules`, `episode_series_matching` e `franchise`, com golden
 * contra o TS do `esm`). O corpo TS saiu do branch: aqui só se monta a entrada
 * (o `cutTail` da config chega como parâmetro, como em `relevance.ts`) e se
 * traduz a identidade de nome curto de/para o objeto da fronteira.
 *
 * Módulo-folha: chama `nativeCore` direto, como `title-normalization.ts`.
 * `config` continua aqui só pelas DUAS constantes de piso, que derivam dele.
 *
 * Regra de ouro: chamada direta SEM lote (medido em `tmp/g5-measure.mjs`).
 */
import config from '../config.js';
import { nativeCore } from './native-core.js';

// Calibrado nos casos reais deste repo com o corte de cauda na medição da obra
// (titlePrecision com cutTail=true): releases legítimas sobem para ~1.00 e o
// piso sobe para 0.70, convergindo com SERIES_TITLE_PRECISION_MIN e fechando
// furos como "Era Uma Vez em Londres" sem derrubar releases provadas.
// Com TITLE_PRECISION_TAIL_CUT=false, o piso volta a 0.65 e o corte de cauda
// é desligado no núcleo (`cut_tail`).
const TITLE_PRECISION_MIN = config.search?.titlePrecisionTailCut !== false ? 0.70 : 0.65;

// Séries curtas são especialmente ambíguas: "Rick e Morty" cobre 2/3 de
// "Rick e Morty O Anime", que passava no corte geral de 0,65 e tomava as
// vagas da obra original. O piso um pouco maior vale só quando temos a lista
// completa de aliases de série; o caso legítimo mais apertado do corpus (pack
// "1ª até 8ª Temporada") continua em 0,75.
const SERIES_TITLE_PRECISION_MIN = 0.70;

/**
 * Resultado da decisão de identidade de nome curto, com os três estados
 * separados DE PROPÓSITO — um `null` único diria "não há prova" tanto para o
 * nome que o portão não se aplica quanto para o nome sem token comparável, e
 * a diferença importa: o primeiro é "a cobertura discrimina e eu me calo", o
 * segundo é "a cobertura é a ÚNICA prova e eu não afirmo identidade".
 *
 * - `skip`: a base efetiva da cobertura tem 3+ tokens (o corte de 0,6 já exige
 *   nome quase inteiro) ou é VAZIA (aí `matchesName` nega por fail-closed, e o
 *   portão nem é consultado).
 * - `no-token`: base de 1–2 tokens SEM token latino comparável — nome de uma ou
 *   duas letras ("It", "Up", "Oz") ou alias em outro script (光环). Não há
 *   prova posicional possível; a cobertura exata do token segue sendo a
 *   decisão, e nada aqui a substitui.
 * - `prefix`: há token comparável, e a release precisa nomear a obra por ele.
 */
type ShortNameIdentity =
  | { kind: 'skip' }
  | { kind: 'no-token' }
  | { kind: 'prefix'; want: string; run: string[] };

/** Identidade como o `.node` a devolve (`undefined` nos campos ausentes). */
type ShortNameIdentityNapi = {
  kind: string;
  want?: string;
  run?: string[];
};

/** Funções dos portões de título no `.node` (camelCase do napi-rs). */
type TitleRulesCore = {
  matchesTitleStructureNapi(
    title: string,
    name: string,
    year: string,
    isSeries: boolean,
    tokens: string[] | null,
  ): boolean;
  matchesBrTitle(
    title: string,
    name: string,
    year: string,
    isSeries: boolean,
    allNames: string[] | null,
    tokens: string[] | null,
    universeTokens: string[] | null,
    cutTail: boolean,
  ): boolean;
  shortNameIdentityNapi(name: string): ShortNameIdentityNapi;
  matchesShortNameIdentityNapi(
    title: string,
    check: { kind: string; want?: string; run?: string[] },
    tokens: string[] | null,
    dn: string,
  ): boolean;
  matchesEpisodeWorkIdentityNapi(
    title: string,
    allNames: string[] | null,
    tokens: string[] | null,
    universeTokens: string[] | null,
    cutTail: boolean,
  ): boolean;
  matchesGlobalSeriesNoMarkerNapi(title: string, tokens: string[], universe: string[], cutTail: boolean): boolean;
};

const core = () => nativeCore<TitleRulesCore>();

/** `config.search.titlePrecisionTailCut` como o núcleo espera (default true). */
function cutTail(): boolean {
  return config.search?.titlePrecisionTailCut !== false;
}

/** Ano como texto, que é o que o núcleo lê (`String(x ?? '')`, como o TS). */
function yearText(year: number | string | null | undefined): string {
  return String(year ?? '');
}

/**
 * Identidade estrutural da obra: prefixo, sequência e ano. Diferente da
 * precisão BR, estas regras também valem para filmes de indexers globais —
 * "Scary Movie 2" e "Titanic 2000 (Scary Sexy Disaster Movie)" não são o
 * "Scary Movie" de 2000 só porque contêm todos os tokens da busca.
 */
function matchesTitleStructure(
  title: string,
  name: string,
  year: number | string | null = null,
  { isSeries = false, tokens = null }: { isSeries?: boolean; tokens?: string[] | null } = {},
): boolean {
  return core().matchesTitleStructureNapi(String(title), String(name), yearText(year), isSeries, tokens);
}

/**
 * Filtro de título mais estrito, SÓ para releases BR: `matchesName` + precisão
 * de título (piso por tipo, com `allNames`) + estrutura. Os sites BR devolvem
 * posts "parecidos" para query curta — buscar "Fallout" trazia "Missão:
 * Impossível – Efeito Fallout", "Fallout 4 (PC)" e "Cesium Fallout".
 */
function matchesBrTitle(
  title: string,
  name: string,
  year: number | string | null = null,
  {
    isSeries = false,
    allNames = null,
    tokens = null,
    universeTokens = null,
  }: {
    isSeries?: boolean;
    allNames?: string[] | null;
    tokens?: string[] | null;
    universeTokens?: string[] | null;
  } = {},
): boolean {
  return core().matchesBrTitle(
    String(title),
    String(name),
    yearText(year),
    isSeries,
    allNames,
    tokens,
    universeTokens,
    cutTail(),
  );
}

/**
 * Guarda de identidade de obra em release GLOBAL por episódio: o trecho que o
 * marcador SxxEyy delimita tem que pertencer ao universo de nomes da obra.
 */
function matchesEpisodeWorkIdentity(
  title: string,
  allNames: string[] | null,
  tokens: string[] | null = null,
  universeTokens: string[] | null = null,
): boolean {
  return core().matchesEpisodeWorkIdentityNapi(String(title), allNames, tokens, universeTokens, cutTail());
}

/**
 * Filme/spin-off da MESMA franquia sem marcador de temporada/episódio algum,
 * em release GLOBAL (indexer de anime, não WordPress BR).
 */
function matchesGlobalSeriesNoMarker(title: string, tokens: string[], universe: string[]): boolean {
  return core().matchesGlobalSeriesNoMarkerNapi(String(title), tokens, universe, cutTail());
}

/** Decide, por NOME, o que o portão de identidade vai exigir. */
function shortNameIdentity(name: string): ShortNameIdentity {
  const value = core().shortNameIdentityNapi(String(name));
  if (value.kind === 'prefix' && value.want != null) {
    return { kind: 'prefix', want: value.want, run: value.run ?? [] };
  }
  return value.kind === 'no-token' ? { kind: 'no-token' } : { kind: 'skip' };
}

/**
 * Identidade do nome de base curta: além da COBERTURA (os tokens do nome
 * presentes no título), a release precisa NOMEAR a obra. `dn` é o nome do
 * torrent de verdade: evidência alternativa, na mesma linhagem do ano e da
 * temporada contraditórios. Só `prefix` é julgado; os outros dois se calam.
 */
function matchesShortNameIdentity(
  title: string,
  check: ShortNameIdentity,
  tokens: string[] | null = null,
  dn = '',
): boolean {
  const value =
    check.kind === 'prefix' ? { kind: check.kind, want: check.want, run: check.run } : { kind: check.kind };
  return core().matchesShortNameIdentityNapi(String(title), value, tokens, String(dn));
}

export {
  TITLE_PRECISION_MIN,
  SERIES_TITLE_PRECISION_MIN,
  matchesTitleStructure,
  matchesShortNameIdentity,
  shortNameIdentity,
  matchesBrTitle,
  matchesEpisodeWorkIdentity,
  matchesGlobalSeriesNoMarker,
  type ShortNameIdentity,
};
