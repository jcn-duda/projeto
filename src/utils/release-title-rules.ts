import { parseTitleSeasonEpisode } from './episode-matching.js';
import { titleTokens } from './matching-vocabulary.js';
import {
  episodeWorkTokens,
  extractSequenceMarkers,
  firstSignificantToken,
  titlePrecision,
  yearContradicts,
} from './matching-tokens.js';
import { matchesName, isMultiWorkCollection } from './release-name-matching.js';

// Os portões de título: o que decide se uma release É a obra procurada. Três
// níveis de estricção, cada um calibrado contra casos reais medidos neste repo
// (ver os docstrings): o nome coberto (`matchesName`, em
// release-name-matching.ts), a estrutura global (`matchesTitleStructure`) e o
// post BR completo (`matchesBrTitle`), mais as duas guardas de identidade de
// série (`matchesEpisodeWorkIdentity`, `matchesGlobalSeriesNoMarker`).

// Calibrado nos casos reais deste repo: o documentário "A Última Vigília" dá
// 0.60 e o pack "1ª até 8ª Temporada" dá 0.75 — o corte fica entre os dois.
const TITLE_PRECISION_MIN = 0.65;

// Séries curtas são especialmente ambíguas: "Rick e Morty" cobre 2/3 de
// "Rick e Morty O Anime", que passava no corte geral de 0,65 e tomava as
// vagas da obra original. O piso um pouco maior vale só quando temos a lista
// completa de aliases de série; o caso legítimo mais apertado do corpus (pack
// "1ª até 8ª Temporada") continua em 0,75.
const SERIES_TITLE_PRECISION_MIN = 0.70;

/**
 * Identidade estrutural da obra: prefixo, sequência e ano. Diferente da
 * precisão BR, estas regras também valem para filmes de indexers globais —
 * "Scary Movie 2" e "Titanic 2000 (Scary Sexy Disaster Movie)" não são o
 * "Scary Movie" de 2000 só porque contêm todos os tokens da busca.
 *
 */
function matchesTitleStructure(
  title: string,
  name: string,
  year: number | string | null = null,
  { isSeries = false, tokens = null }: { isSeries?: boolean; tokens?: string[] | null } = {},
) {
  // `tokens` opcionais pelo mesmo motivo do matchesName: chamada em lote já
  // trouxe o título normalizado.
  const own = tokens || titleTokens(title);
  const wanted = titleTokens(name);
  // Mesma regra do matchesName: sem token procurado não há o que casar —
  // passar adiante deixaria a release sobreviver na dúvida.
  if (wanted.length === 0) return false;
  const want = firstSignificantToken(wanted);
  if (want && firstSignificantToken(own) !== want) return false;

  // Em série o número antes do ruído é a temporada; matchesEpisode decide se
  // ela serve. Em filme, sequência não pedida é outra obra.
  if (!isSeries) {
    const wantedMarkers = extractSequenceMarkers(name);
    const ownMarkers = extractSequenceMarkers(title);
    // Sequência não pedida é outra obra: "Scary Movie 2" na busca de "Scary
    // Movie" (o candidato declara um marcador que a busca não pediu).
    if (![...ownMarkers].every((n) => wantedMarkers.has(n))) return false;
    // Guarda reversa: a busca PEDE uma sequência ("A Morte Te Dá Parabéns 2")
    // e o candidato não declara marcador nenhum ("A Morte te dá Parabéns!
    // (2017) 5.1 Dublado" — o filme 1). Sem marcador, só o ANO EXATO do
    // catálogo prova ser a continuação publicada sem o número; ano diferente
    // dentro do ±2 é a obra-base da franquia (2017 vs 2019). Pack de coleção
    // fica fora: a cobertura multi-obra é a exceção que resgata o pack no
    // inventário, e o ano em faixa (2017-2019) não é um ano único.
    //
    // Desvio deliberado do "sem ano no catálogo nada é cortado" do
    // yearContradicts: aqui a busca PEDE sequência e o candidato não a
    // declara — sem ano o candidato não provou ser a continuação, e a dúvida
    // recai a favor de NÃO entregar uma obra-base no lugar da sequência
    // pedida (fail-closed). Exposição baixa: só dispara nessa combinação.
    if (wantedMarkers.size && ownMarkers.size === 0 && !isMultiWorkCollection(title)) {
      const catalogYear = Number(String(year ?? '').match(/(?:19|20)\d{2}/)?.[0] || 0);
      const candYears = own.filter((t: string) => /^(?:19|20)\d{2}$/.test(t)).map(Number);
      if (catalogYear === 0 || candYears.length !== 1 || candYears[0] !== catalogYear) return false;
    }
  }

  return !yearContradicts(own, year, isSeries);
}

/**
 * Filtro de título mais estrito, SÓ para releases BR. Os sites BR são
 * buscadores WordPress que devolvem posts "parecidos" para query curta:
 * buscar "Fallout" trazia "Missão: Impossível – Efeito Fallout", "Fallout 4
 * (PC)" e "Cesium Fallout". `matchesName` aceita os três (a palavra casa
 * inteira) e `matchesEpisode` também (sem pista de temporada, passa) — o lixo
 * disputava as vagas reservadas BR com a fonte dublada real e as tomava.
 *
 * Duas regras por cima do `matchesName`:
 * - post BR é titulado "Nome ...": o primeiro token relevante do título tem
 *   que ser o do nome procurado — mata "Missão: Impossível…" e "Cesium…".
 *   Tokens de 1-2 letras ("o", "de", "a") são pulados dos dois lados;
 * - ano, com tolerância por tipo (mesma lógica do pacote BRDUB, calibrada
 *   contra casos reais): filme aceita ±2 (o ano do post BR costuma ser o do
 *   lançamento nacional) e série só condena quando TODOS os anos do post
 *   são anteriores à estreia −2 — o ano do post de série é o da temporada,
 *   então "Fallout 2ª Temporada (2025)" contra catálogo 2024 passa, e
 *   "Fallout 4 (PC) [2015]" continua morrendo nos dois modos. Dois ou mais
 *   anos no título ("Blade Runner 2049 (2017)") deixam o campo ambíguo e a
 *   checagem é pulada.
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
) {
  if (!matchesName(title, name, tokens)) return false;
  const own = tokens || titleTokens(title);

  // O nome procurado é PREFIXO de outra obra: "Game of Thrones: A Conquista e a
  // Rebelião" (especial animado) e "Game of Thrones – A Última Vigília"
  // (documentário) cobriam 2/2 do nome da série e entravam na lista do S01E01.
  // Cobertura não vê isso; precisão vê — é quanto do título do candidato sobra
  // FORA da busca, depois de tirar o ruído de release.
  //
  // Exige `allNames` de propósito: a release legítima carrega os DOIS nomes
  // ("Coleção Guerra nas Estrelas [Star wars]"), e medir contra um só condenaria
  // o outro como conteúdo estranho. Sem a lista completa, quem chama não tem a
  // informação necessária para esta pergunta, e a checagem não roda.
  // Release por episódio costuma carregar o NOME do episódio ("House of the
  // Dragon S01E02.The Rogue Prince…"): palavras legítimas fora da busca que
  // derrubavam a precisão. Com SxxEyy explícito no título a pergunta da
  // precisão ("é outra obra?") já está respondida — obra parecida
  // (documentário, especial, jogo) não publica marcador de episódio; temporada
  // ou episódio errados morrem no matchesEpisode.
  const episodeWork = episodeWorkTokens(own);
  if (allNames?.length) {
    const universo =
      universeTokens || allNames.flatMap((n) => titleTokens(n)).filter(Boolean);
    const measured = episodeWork || own;
    const precisionMin = isSeries ? SERIES_TITLE_PRECISION_MIN : TITLE_PRECISION_MIN;
    if (titlePrecision(measured, universo) < precisionMin) return false;
  }

  return matchesTitleStructure(title, name, year, { isSeries, tokens: own });
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
) {
  if (!allNames?.length) return true;
  // `tokens`/`universeTokens` opcionais: o mesmo título passa por várias
  // funções no filtro em lote e cada uma renormalizava a string.
  const own = tokens || titleTokens(title);
  const work = episodeWorkTokens(own);
  if (!work) return true;
  const universe =
    universeTokens || allNames.flatMap((name) => titleTokens(name)).filter(Boolean);
  return titlePrecision(work, universe) >= SERIES_TITLE_PRECISION_MIN;
}

/**
 * Filme/spin-off da MESMA franquia sem marcador de temporada/episódio algum,
 * em release GLOBAL (indexer de anime, não WordPress BR). Medido no addon:
 * "Demon Slayer: Infinity Castle" (2025, filme da franquia) entrava na lista
 * do S01E01 porque contém os 5 tokens do nome da série inteiros — não é
 * homônimo parcial (que `matchesName`/`matchesTitleStructure` já cortam), é
 * a MESMA franquia, então nome sozinho nunca vai separar os dois.
 *
 * `matchesEpisodeWorkIdentity` já abstém aqui (`episodeWorkTokens` só
 * delimita a obra a partir de um SxxEyy explícito) e `yearContradicts` só
 * condena série contra ano ANTERIOR ao catálogo — um filme mais novo da
 * mesma franquia (2025 contra catálogo 2019) não contradiz.
 *
 * O portão usa `parseTitleSeasonEpisode` (o mesmo do `matchesEpisode`, que o
 * filtro em lote `filterRelevantRaw` aplica logo antes daqui), não
 * `episodeWorkTokens`: o marcador de episódio exige o par
 * SxxEyy num token só, e recorte de scene release tipo "S01 03" (temporada e
 * episódio em tokens separados) não bate nele — mediria a precisão contra o
 * título inteiro e reprovaria pack legítimo por causa do grupo de release
 * ("Trix", "AV1", "VOSTFR") que não está no universo de nomes.
 * `parseTitleSeasonEpisode` reconhece "S01 03" como temporada 1 (mesmo sem
 * episódio), então releases desse formato nunca chegam a esta guarda.
 *
 * Só roda em item global (`!isBr`): o item BR equivalente já passa pela
 * mesma medição de precisão dentro de `matchesBrTitle` (`measured =
 * episodeWork || own`), calibrada para o formato de post BR.
 */
function matchesGlobalSeriesNoMarker(title: string, tokens: string[], universe: string[]) {
  const p = parseTitleSeasonEpisode(title);
  if (p.seasons.length || p.episodes.length || p.complete || p.seasonPack) return true;
  return titlePrecision(tokens, universe) >= SERIES_TITLE_PRECISION_MIN;
}

export {
  TITLE_PRECISION_MIN,
  SERIES_TITLE_PRECISION_MIN,
  matchesTitleStructure,
  matchesBrTitle,
  matchesEpisodeWorkIdentity,
  matchesGlobalSeriesNoMarker,
};
