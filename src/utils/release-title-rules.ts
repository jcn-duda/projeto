import config from '../config.js';
import { parseTitleSeasonEpisode } from './episode-matching.js';
import { titleTokens } from './matching-vocabulary.js';
import {
  episodeWorkTokens,
  extractSequenceMarkers,
  firstSignificantToken,
  firstUnmarkedToken,
  firstWorkToken,
  isNonLatinToken,
  isNonNamingToken,
  titlePrecision,
  yearContradicts,
} from './matching-tokens.js';
import { matchesName, nameCoverageTokens, isMultiWorkCollection } from './release-name-matching.js';

// Os portões de título: o que decide se uma release É a obra procurada. Três
// níveis de estricção, cada um calibrado contra casos reais medidos neste repo
// (ver os docstrings): o nome coberto (`matchesName`, em
// release-name-matching.ts), a identidade posicional do nome curto
// (`matchesShortNameIdentity`) e a estrutura global (`matchesTitleStructure`),
// mais as duas guardas de identidade de série (`matchesEpisodeWorkIdentity`,
// `matchesGlobalSeriesNoMarker`).

// Calibrado nos casos reais deste repo com o corte de cauda na medição da obra
// (titlePrecision com cutTail=true): releases legítimas sobem para ~1.00 e o
// piso sobe para 0.70, convergindo com SERIES_TITLE_PRECISION_MIN e fechando
// furos como "Era Uma Vez em Londres" sem derrubar releases provadas.
// Com TITLE_PRECISION_TAIL_CUT=false, o piso volta a 0.65 e o corte de cauda
// é desligado em titlePrecision.
const TITLE_PRECISION_MIN = config.search?.titlePrecisionTailCut !== false ? 0.70 : 0.65;

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
    const cutTail = config.search?.titlePrecisionTailCut !== false;
    if (titlePrecision(measured, universo, { cutTail }) < precisionMin) return false;
  }

  return matchesTitleStructure(title, name, year, { isSeries, tokens: own });
}

// Etiqueta de uploader/site ANTES do nome da obra: "[ReQ]", "[TGx]",
// "[ OxTorrent.com ]", "www.Torrenting.com -". Ela não é obra, mas o trecho
// até o SxxEyy é medido inteiro — medido no True Detective S01E01: a única
// release global do episódio ("[ReQ]True Detective s01e01 hdtv x264-KILLERS")
// fazia 2/3 de precisão e morria. Só o PREFIXO sai; etiqueta no meio ou na
// cauda continua medida (a cauda já é cortada pelo titlePrecision).
const LEADING_RELEASE_TAG_RE =
  /^(?:\s*(?:\[[^\]]{1,40}\]|\([^)]{1,40}\)|\{[^}]{1,40}\}|www\.[a-z0-9-]+(?:\.[a-z]{2,})+\s*[-–:|]?))+\s*/i;

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
  // funções no filtro em lote e cada uma renormalizava a string. Com etiqueta
  // no prefixo os tokens do lote a incluem, então renormaliza sem ela.
  const untagged = title.replace(LEADING_RELEASE_TAG_RE, '');
  const own = untagged !== title && untagged ? titleTokens(untagged) : tokens || titleTokens(title);
  const work = episodeWorkTokens(own);
  if (!work) return true;
  const universe =
    universeTokens || allNames.flatMap((name) => titleTokens(name)).filter(Boolean);
  const cutTail = config.search?.titlePrecisionTailCut !== false;
  return titlePrecision(work, universe, { cutTail }) >= SERIES_TITLE_PRECISION_MIN;
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
  const cutTail = config.search?.titlePrecisionTailCut !== false;
  return titlePrecision(tokens, universe, { cutTail }) >= SERIES_TITLE_PRECISION_MIN;
}

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

// Base efetiva da cobertura com 1–2 tokens: acima dela o corte de 0,6 já
// exige nome quase inteiro e o portão se cala. Ver `shortNameIdentity`.
const SHORT_NAME_BASE_MAX = 2;

/** Decide, por NOME, o que o portão de identidade vai exigir. A decisão é do
 *  nome e não muda entre itens: quem filtra em lote calcula uma vez. */
function shortNameIdentity(name: string): ShortNameIdentity {
  const base = nameCoverageTokens(name);
  if (base.length === 0 || base.length > SHORT_NAME_BASE_MAX) return { kind: 'skip' };
  const tokens = titleTokens(name);
  const want = firstWorkToken(tokens);
  if (!want) return { kind: 'no-token' };
  // Sequência dos tokens que NOMEIAM a obra, na ordem do nome ("attack on
  // titan" → [attack, titan]). Só com 2+ ela prova algo: ver `containsNameRun`.
  const run = tokens.filter((w) => !isNonNamingToken(w) && !isNonLatinToken(w));
  return { kind: 'prefix', want, run };
}

/**
 * O texto NOMEIA a obra, considerando o primeiro token que não é rótulo?
 *
 * Três respostas, e só uma nega: dá quando o token existe e é o esperado;
 * dá quando não há token nenhum (título só com rótulo/estrutura) ou quando o
 * token está em OUTRO SCRIPT — "光環 Halo S01E01" e "進撃の巨人 Attack on
 * Titan" são a obra com o título localizado na frente, e a escrita em outro
 * script não é prova de outra obra. Só quando o token é LATINO e não é rótulo,
 * ruído, marca nem uploader permitido é que há contradição, e a release é de
 * outra obra.
 *
 * A etiqueta de uploader/grupo do começo ("[ReQ]True Detective s01e01…",
 * "www.UIndex.org - The Boys S05E01…") é cortada antes de medir, pelo mesmo
 * `LEADING_RELEASE_TAG_RE` que a guarda de identidade por episódio já usa: sem
 * isso o token da etiqueta viraria o "primeiro token da obra" e o portão
 * cortaria release legítima.
 */
function namesTheWork(
  text: string,
  tokens: string[] | null,
  check: { want: string; run: string[] },
) {
  const untagged = String(text || '').replace(LEADING_RELEASE_TAG_RE, '');
  const own = untagged && untagged !== text ? titleTokens(untagged) : tokens || titleTokens(text);
  const first = firstUnmarkedToken(own);
  if (!first || isNonLatinToken(first)) return true;
  if (first === check.want) return true;
  return containsNameRun(own, check.run) || possessiveBeforeName(text, check.want);
}

/**
 * O nome INTEIRO aparece como sequência contínua dos tokens que nomeiam a obra
 * (ignorando rótulo/ligação entre eles): "Shingeki no Kyojin - Attack on Titan
 * S04" e "Boku no Hero Academia S06" são a obra com o título original na
 * frente, não outra obra. Exige 2+ tokens que nomeiam: com um só, "Thirst Trap
 * The Fallout" e "Shes The Boss" também conteriam o nome e voltariam a entrar.
 * O homônimo medido não tem a sequência ("The Hardy Boys", "The Detective
 * Boys": o nome "The Boys" tem um token que nomeia).
 */
function containsNameRun(tokens: string[], run: string[]) {
  if (run.length < 2) return false;
  const seq = tokens.filter((w) => !isNonNamingToken(w));
  for (let i = 0; i + run.length <= seq.length; i += 1) {
    if (run.every((w, k) => seq[i + k] === w)) return true;
  }
  return false;
}

/**
 * Posse EXPLÍCITA antes do nome ("Marvel's Daredevil", "Noah Hawley's
 * Fargo"): a marca/autor que precede o título da própria obra. Só com o
 * apóstrofo no texto cru — o "Marvels.Daredevil" de cena perdeu a prova e
 * "Walter Boys"/"Hardy Boys" não são posse; o `dn=` real continua sendo a
 * outra saída.
 */
function possessiveBeforeName(text: string, want: string) {
  const escaped = want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\p{L}['’]s[\\s._-]+${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(String(text || ''));
}

/**
 * Identidade do nome de base curta: além da COBERTURA (os tokens do nome
 * presentes no título), a release precisa NOMEAR a obra — começar pelo token
 * do nome, não por uma palavra latina que antecede o nome procurado.
 *
 * Por que só aqui. A cobertura mede a BASE EFETIVA do nome (o mesmo conjunto
 * que `matchesName` deduplica, com artigo e palavra de 1–2 letras fora quando
 * sobram dois tokens longos). Quando essa base tem um ou dois tokens, o corte
 * de 0,6 não discrimina nada: um token pede 1/1 e dois pedem 2/2 — o que
 * falta é distinguir "a obra começa aqui" de "o nome está no meio do título de
 * outra". Medido em "The Boys" (tt1520211, 2026-09-28): "The Hardy Boys S01
 * 1080p" e "Detective Conan Movie 22 The Detective Boys" (outras obras) e
 * "Trailer Park Boys" (que escapava do mesmo furo sempre que o índice
 * publicasse o artigo no nome) entravam na lista. As guardas de precisão não
 * fecharam nenhum desses casos: `matchesEpisodeWorkIdentity` só mede quando a
 * release traz o par SxxEyy num token só, e `matchesGlobalSeriesNoMarker` só
 * roda no pedido de Episódio E com o título sem marcador nenhum — pack de
 * temporada e busca de série inteira ficavam sem portão nenhum depois do
 * `matchesName`.
 *
 * Posição não é a única prova, e é por isso que a negação é estreita: (1) o
 * token que antecede o nome só nega quando é LATINO e não é rótulo, ruído,
 * marca ou uploader — outro script é título localizado; (2) o `dn=` do magnet
 * é evidência alternativa CORRETA, como em `magnetYearContradicts` e
 * `magnetSeasonContradicts`: release cujo POST não nomeia a obra mas cujo
 * torrent real nomeia entra do mesmo jeito. Nenhum dos dois nega sozinho.
 *
 * Três invariantes: se abstém para base de 3+ tokens (aí a cobertura
 * discrimina), NÃO roda no caminho BR (`matchesBrTitle` tem portão próprio) e
 * fica dentro do `names.some` — um alias que não prefixa jamais pode condenar
 * o release que casa pelo outro nome.
 *
 * Cobertura e portão dividem a MESMA base (`nameCoverageTokens`), extraída de
 * `matchesName`: duas cópias desse cálculo divergiriam em silêncio quando a
 * régua mudasse. **Não troque isso por lista de títulos proibidos:** a mesma
 * classe de homônimo com base de um token (busca "Fallout" × "Thirst Trap The
 * Fallout") fecha pelo mesmo portão, e a obra legítima que só carrega o nome em
 * outro script fecha pela cobertura, não por lista.
 */
function matchesShortNameIdentity(
  title: string,
  check: ShortNameIdentity,
  tokens: string[] | null = null,
  dn = '',
) {
  if (check.kind !== 'prefix') return true;
  if (namesTheWork(title, tokens, check)) return true;
  // `dn` é o nome do torrent de verdade: evidência alternativa, na mesma
  // linhagem do ano e da temporada contraditórios.
  return !!dn && namesTheWork(dn, null, check);
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
