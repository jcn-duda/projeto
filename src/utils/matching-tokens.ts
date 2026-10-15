import {
  EPISODE_TOKEN,
  LEADING_ARTICLES,
  PACK_WORDS,
  RELEASE_NOISE,
  STOP_AT,
  STRONG_PACK_WORDS,
  NUMERAL_CANON,
  SEQUENCE_WORDS,
  titleTokens,
} from './matching-vocabulary.js';

// Leitura estrutural de tokens: o que é sequência, o que é sobra fora da
// busca, qual trecho nomeia a obra numa release por episódio, se o ano
// contradiz o catálogo. Nada aqui decide relevância sozinho — são as métricas
// puras que `release-title-rules.ts` compõe nos portões matchesName /
// matchesBrTitle / matchesTitleStructure.

/**
 * Números de SEQUÊNCIA (sequel/parte) na parte limpa do título — lógica do
 * pacote BRDUB. "Deadpool" casa "Deadpool 2" em 100% (todos os tokens da busca
 * estão lá) e o ano só denuncia quando a sequência é distante: "Deadpool 2"
 * (2018) contra catálogo 2016 cabia na tolerância de ±2 e entrava na lista.
 *
 * Duas diferenças em relação ao BRDUB, porque aqui o texto é o título da
 * RELEASE (com tags) e não o do post:
 * - a varredura para no ANO além do ruído: "Coringa (2020) 5.1 BluRay" vira
 *   "coringa 2020 5 1 bluray", e sem parar no ano o "5 1" do canal de áudio
 *   viraria sequência 5, matando a release legítima;
 * - o 1 não conta: ele aparece em canal de áudio e em "Parte 1" da obra base,
 *   onde a busca não o traz — barraria o que deveria passar.
 *
 * Sequência também vem batizada, sem número nenhum ("… Ressurge", "… Rises"):
 * as palavras de SEQUENCE_WORDS entram no mesmo conjunto, como string. Quem
 * compara os marcadores (`matchesTitleStructure`) só pergunta se o conjunto do
 * candidato cabe no da busca, então número e palavra convivem sem caso
 * especial — e a palavra que já está no nome procurado ("A Origem") aparece
 * dos dois lados e continua passando.
 */
function extractSequenceMarkers(text: string) {
  const markers = new Set<number | string>();
  for (const raw of titleTokens(text)) {
    if (!raw) continue;
    // A varredura para no ano/ruído de release: o que vem depois
    // ("5.1 Dublado", "2017") não é parte do nome da obra.
    if (/^(?:19|20)\d{2}$/.test(raw)) break;
    if (STOP_AT.has(raw)) break;
    let marker: number | string | null = null;
    // Sequência batizada por palavra ("Ressurge", "Rises") — ver
    // SEQUENCE_WORDS em matching-vocabulary.ts.
    if (SEQUENCE_WORDS.has(raw)) marker = raw;
    else {
      // Sufixo "Nu" de sequência: "Happy Death Day 2U" é a continuação (o
      // "U" é o "you" da cola do título), e sem reconhecer o marcador a
      // dupla direção da matchesTitleStructure nunca engaja no caminho EN.
      // Limpo em 2..19 para não ler leetspeak agressivo.
      const u = /^([2-9]|1[0-9])u$/i.exec(raw);
      const n = u ? Number(u[1]) : /^\d+$/.test(raw) ? Number(raw) : NUMERAL_CANON[raw];
      if (n >= 2 && n <= 19) marker = n;
    }
    if (marker !== null) markers.add(marker);
  }
  return markers;
}

function rawPrecision(tokens: string[], want: Set<string>) {
  const significant = tokens.filter(
    (w) =>
      !RELEASE_NOISE.has(w) &&
      !PACK_WORDS.has(w) &&
      !STRONG_PACK_WORDS.has(w) &&
      !EPISODE_TOKEN.test(w) &&
      !/^\d+$/.test(w),
  );
  if (significant.length === 0) return 1;
  return significant.filter((w) => want.has(w)).length / significant.length;
}

/**
 * Quanto do título do candidato está DENTRO da busca, ignorando ruído de
 * release, empacotamento e ano. 1 = o título não acrescenta nada; perto de 0 =
 * é outra obra que só começa com o mesmo nome.
 *
 * Com cutTail=true (padrão), mede a obra parando no primeiro ano ou STOP_AT
 * e devolve o Math.max entre a cabeça e a lista completa, evitando penalizar
 * assinaturas de encoder/uploader na cauda.
 */
function titlePrecision(
  tokens: string[],
  wanted: Iterable<string>,
  { cutTail = true }: { cutTail?: boolean } = {},
) {
  const want = new Set(wanted);
  const fullScore = rawPrecision(tokens, want);
  if (!cutTail) return fullScore;

  let headStart = 0;
  while (
    headStart < tokens.length &&
    (PACK_WORDS.has(tokens[headStart]) || STRONG_PACK_WORDS.has(tokens[headStart]))
  ) {
    headStart += 1;
  }

  let headEnd = headStart;
  for (; headEnd < tokens.length; headEnd += 1) {
    const raw = tokens[headEnd];
    if (/^(?:19|20)\d{2}$/.test(raw) || STOP_AT.has(raw)) break;
  }

  // Guarda de cabeça vazia: primeiro token da obra já é ano/STOP_AT -> usa lista completa.
  if (headEnd === headStart) return fullScore;

  const headScore = rawPrecision(tokens.slice(headStart, headEnd), want);
  return Math.max(headScore, fullScore);
}

/**
 * Trecho que nomeia a OBRA numa release por episódio. O nome do episódio vem
 * depois de SxxEyy e não pode contar como obra estranha; no formato inverso do
 * RedeTorrent, o marcador vem antes do nome e costuma se repetir depois dele.
 */
function episodeWorkTokens(tokens: string[]) {
  const markers: number[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (
      /^(?:s\d{1,2}e\d{1,3}|\d{1,2}x\d{1,3})$/.test(tokens[i]) ||
      (/^t\d{1,2}$/.test(tokens[i]) && /^e\d{1,3}$/.test(tokens[i + 1] || ''))
    ) markers.push(i);
  }
  if (!markers.length) return null;
  if (markers[0] > 0) return tokens.slice(0, markers[0]);
  let end = markers.length > 1 ? markers[1] : tokens.length;
  // Com um único marcador à esquerda, o grupo da release vem depois do nome:
  // "S01E02 From 1080p WEBRip x264-EVOLVE". Parar no primeiro ruído técnico
  // mantém "From" como obra sem aceitar "Rick and Morty The Anime" — nesse
  // caso os tokens extras ficam antes de 1080p e continuam sendo medidos.
  if (markers.length === 1) {
    const noiseAt = tokens.findIndex((token: string, index: number) => index > 0 && STOP_AT.has(token));
    if (noiseAt > 0) end = noiseAt;
  }
  return tokens.slice(1, end);
}

/**
 * O ano do título contradiz o ano do catálogo? Definição ÚNICA da regra de
 * ano, com tolerância por tipo (mesma lógica do pacote BRDUB, calibrada
 * contra casos reais): filme aceita ±2 — o ano do post BR costuma ser o do
 * lançamento nacional — e condena com um ÚNICO ano contraditório; série só
 * condena quando TODOS os anos do título são anteriores à estreia −2, porque
 * o ano do post de série é o da temporada ("Fallout 2ª Temporada (2025)"
 * contra catálogo 2024 passa). Dois ou mais anos em FILME viram intervalo:
 * há contradição quando NENHUM ano fica a ±2 do catálogo E o catálogo está
 * fora do intervalo [min, max]. Assim "Blade Runner 2049 (2017)" com catálogo
 * 2017 passa (ano próximo), e "Collection 2002 2016" com catálogo 2004 passa
 * (pack contém o filme), mas "Collection 2002 2016" com catálogo 2026 morre.
 * Em série basta um ano recente para liberar. Sem ano no catálogo nada é cortado.
 */
function yearContradicts(tokens: string[], year: number | string | null, isSeries: boolean) {
  const catalogYear = Number(String(year || '').match(/(?:19|20)\d{2}/)?.[0] || 0);
  if (!catalogYear) return false;
  const years = tokens.filter((t) => /^(?:19|20)\d{2}$/.test(t)).map(Number);
  if (years.length === 0) return false;
  if (isSeries) return years.every((y) => y < catalogYear - 2);
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
 * Sequel nomeada com ano EXATO diferente do catálogo: "Resident Evil:
 * Apocalypse (2004)" na busca do filme de 2002. Exige as DUAS provas —
 * token significativo fora do universo de nomes E ano declarado ≠ catálogo
 * (===, sem ±2). Sem ano no título devolve false: SEQUENCE_WORDS / precisão
 * já cuidam de "…Ressurge" sem data. Só filme (o caller aplica).
 */
function namedSequelContradicts(
  tokens: string[],
  universe: Iterable<string>,
  catalogYear: number | string | null,
) {
  const catalog = Number(String(catalogYear || '').match(/(?:19|20)\d{2}/)?.[0] || 0);
  if (!catalog) return false;
  const want = universe instanceof Set ? universe : new Set(universe);
  const declaredYears: number[] = [];
  let hasStrange = false;
  for (const raw of tokens) {
    if (!raw) continue;
    // Mesmo espírito de extractSequenceMarkers: o que vem depois do ano /
    // ruído técnico não é parte do nome da obra.
    if (/^(?:19|20)\d{2}$/.test(raw)) {
      declaredYears.push(Number(raw));
      break;
    }
    if (STOP_AT.has(raw)) break;
    if (
      RELEASE_NOISE.has(raw) ||
      PACK_WORDS.has(raw) ||
      STRONG_PACK_WORDS.has(raw) ||
      EPISODE_TOKEN.test(raw) ||
      /^\d+$/.test(raw)
    ) continue;
    if (!want.has(raw)) hasStrange = true;
  }
  if (declaredYears.length === 0) return false;
  // Ano difere só quando NENHUM declarado é exatamente o do catálogo.
  if (declaredYears.some((y) => y === catalog)) return false;
  return hasStrange;
}

/**
 * Contaminação de identidade por ADAPTAÇÃO (Live Action × original): o post
 * declara "Live Action" e um ano LONGE da estreia da obra pedida — é outra
 * obra (One Piece live action 2023/2026 sob o anime de 1999, medido sob
 * tt0388629 em 2026-09-27), não um pack da série. Genérica de propósito:
 * depende do marcador E do ano de estreia DAQUELE imdb (nunca de ano
 * literal), e exige as DUAS provas — anime packs legítimos ("S01-S15",
 * faixas "1999-2023") não dizem "live action" e faixa que cobre a estreia
 * passa. Tolerância de estreia ±2 (ano do pack pode ser o da temporada) e
 * deriva mínima de 8 anos: o pack da própria live action (estreia 2023,
 * temporada 2026) NÃO é condenado na obra certa.
 */
const LIVE_ACTION_RE = /\blive[\s.-]?action\b/i;
const ADAPTATION_YEAR_DRIFT = 8;

function liveActionYearContradicts(text: string, premiereYear: number | string | null | undefined): boolean {
  if (!LIVE_ACTION_RE.test(String(text || ''))) return false;
  const premiere = Number(String(premiereYear ?? '').match(/(?:19|20)\d{2}/)?.[0] || 0);
  if (!premiere) return false; // sem estreia conhecida: sem condenação
  const cleaned = String(text).replace(/\d{3,4}x\d{3,4}/gi, ' ');
  const years = [...new Set([...cleaned.matchAll(/(?<!\d)(?:19|20)\d{2}(?!\d)/g)].map((m) => Number(m[0])))];
  if (years.length === 0) return false; // sem ano declarado: sem prova
  if (years.some((y) => Math.abs(y - premiere) <= 2)) return false;
  const minYear = Math.min(...years);
  const maxYear = Math.max(...years);
  if (premiere >= minYear && premiere <= maxYear) return false; // faixa cobre a estreia
  return maxYear >= premiere + ADAPTATION_YEAR_DRIFT;
}

/**
 * Veto de identidade no caminho de BUSCA/registro: só SÉRIE (filme tem as
 * regras de sequela/ano próprias) e só com as duas provas acima. O chamador
 * passa o ano de estreia da obra (catálogo/obra da página) — nunca um ano
 * literal de imdb.
 */
function adaptationIdentityContradicts(
  request: { season?: number | null },
  text: string,
  year?: number | string | null,
): boolean {
  if (request?.season == null) return false;
  return liveActionYearContradicts(text, year);
}

// Primeiro token relevante do título: pula ruído curto, artigo, empacotamento
// e marcador de episódio. Cai no primeiro token quando nada sobrevive — a
// regra de prefixo precisa de UM ponto de comparação dos dois lados.
function firstSignificantToken(arr: string[]): string | undefined {
  return arr.find(
    (w) =>
      w.length > 2 &&
      !LEADING_ARTICLES.has(w) &&
      !PACK_WORDS.has(w) &&
      !EPISODE_TOKEN.test(w),
  ) || arr[0];
}

// Letra latina (com marca): o que separa "palavra" de título localizado.
const LATIN_LETTER_RE = /[\p{Script=Latin}\p{M}]/u;

// Token de ESTRUTURA: só dígito, x, ponto ou hífen. "1280x720", "2160", "5.1"
// — o filtro de episódio do BR remove resolução antes do parse justamente
// porque esses tokens viram temporada falsa, e para a identidade eles não
// nomeiam obra nenhuma.
const STRUCTURE_TOKEN_RE = /^[\dx.\-]+$/;

// Marcador de episódio nas formas que o EPISODE_TOKEN (calibrado com
// `e\d{1,3}`) NÃO cobre, e que aparecem no acervo real: o COMPOSTO
// ("s01e01e02" — intervalo publicado, lido por `parseTitleSeasonEpisode`) e o
// LONGO ("e1176", One Piece passou de E999). É padrão do SCAN de identidade,
// não do EPISODE_TOKEN global: mexer naquele mudaria a precisão e o parse de
// episódio, que têm outra calibragem.
const EPISODE_MARK_RE = /^(?:s\d{1,2}(?:e\d{1,4})+|\d{1,2}x\d{1,4})$/;

/**
 * O token é rótulo ou estrutura — artigo, ruído de release, marca de
 * empacotamento, marcador de episódio, número — e NÃO nomeia a obra.
 *
 * É a régua única do "primeiro token que nomeia" (identidade de nome curto) e
 * a que separa a posição de uma prova. Palavra de até 2 letras entra como
 * rótulo porque em nome e em release elas são artigo ou ligação pt-BR/en
 * ("Game **of** Thrones", "The Office **US**"); o resto é medido pelos
 * conjuntos que o matching já usa, mais as duas formas de marcador acima.
 */
function isNonNamingToken(token: string): boolean {
  return (
    !token ||
    token.length <= 2 ||
    LEADING_ARTICLES.has(token) ||
    RELEASE_NOISE.has(token) ||
    PACK_WORDS.has(token) ||
    STRONG_PACK_WORDS.has(token) ||
    EPISODE_TOKEN.test(token) ||
    EPISODE_MARK_RE.test(token) ||
    STRUCTURE_TOKEN_RE.test(token)
  );
}

/** O token NÃO tem letra latina: é título localizado (光環, 進撃の巨人) ou
 *  marca em outro script. Não prova identidade — nem contra, nem a favor. */
function isNonLatinToken(token: string): boolean {
  return !!token && !LATIN_LETTER_RE.test(token);
}

/** Primeiro token que nomeia a obra, em qualquer script. */
function firstUnmarkedToken(tokens: string[]): string | undefined {
  return tokens.find((w) => !!w && !isNonNamingToken(w));
}

/**
 * Primeiro token LATINO que nomeia a obra — a versão do
 * `firstSignificantToken` que também pula ruído de release (`AMZN`, `WEB-DL`,
 * `1080p`, `Dual`, `PT-BR`), número, marcador composto/longo e escrita em
 * outro script, e devolve `undefined` em vez de cair no `arr[0]`.
 *
 * A diferença do fallback importa: aqui "nada nomeia a obra" é ausência de
 * evidência, e quem chama prefere não julgar um título que só tem rótulo —
 * quem corta é a cobertura do nome, com a régua que já existia.
 * `firstSignificantToken` continua com o `arr[0]` porque a regra de prefixo de
 * FILME precisa de um ponto de comparação dos dois lados.
 */
function firstWorkToken(tokens: string[]): string | undefined {
  return tokens.find((w) => !!w && !isNonNamingToken(w) && !isNonLatinToken(w));
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
