import type { RawItem } from '../../types/domain.js';
import { normalizeTitle } from './title-normalization.js';
import { matchesEpisode } from './episode-matching.js';

interface MatchOptions {
  names?: string[];
  year?: number | string | null;
  isSeries?: boolean;
  season?: number | null;
  episode?: number | null;
  allNames?: string[] | null;
  tokens?: string[] | null;
  universeTokens?: string[] | null;
}

/**
 * Descarta resultados que claramente não são o título procurado — indexers
 * costumam devolver "parecidos" para queries curtas.
 *
 * Três armadilhas. As duas primeiras medidas em título pt-BR curto (que é
 * justamente o que vai pros sites BR); a terceira, em série global de nome
 * curto:
 *
 * - comparar por SUBSTRING da string inteira fazia "dia" casar dentro de
 *   "diabo": "Dia D" (Disclosure Day) aceitava "O Diabo Veste Prada 2";
 * - descartar palavra de até 2 letras esvazia o título quando ele é curto —
 *   "Dia D" virava o token único `dia` e aceitava "Um Dia de Sorte em Nova
 *   York" e "Homem-Aranha: Um Novo Dia". As seis vagas reservadas iam para o
 *   lixo e empurravam pra fora a fonte dublada correta;
 * - token repetido e artigo inglês inflavam os acertos: o filtro de ruído
 *   (até 2 letras) foi calibrado para artigo pt-BR e não pegava "the" (3
 *   letras), e o `wanted` não era deduplicado — "The Walking Dead: Dead
 *   City" pedia [the, walking, dead, dead, city] e "Shaun of the Dead
 *   (2004)" marcava the + dead + dead = 3/5 = 0.600, exatamente no corte.
 *   Como o caminho global de série não tem guarda de ano depois desta
 *   (release de filme não carrega marcador de episódio, então a checagem de
 *   identidade abstém), o filme entrava na lista da série. Artigo sai do
 *   conjunto significativo e `wanted` é deduplicado.
 *
 */
function matchesName(title: string, name: string, tokens: string[] | null = null) {
  const all = normalizeTitle(name).split(' ').filter(Boolean);
  // Palavra de 1-2 letras costuma ser ruído ("o", "de", "a") — e artigo
  // inglês também ("the" tem 3 letras e escapa do filtro de comprimento).
  // Mas quando sobra menos de dois tokens, ela É o título ("The Bear",
  // "From"): aí vale mais que o ruído que evita.
  const long = all.filter((w) => w.length > 2 && !LEADING_ARTICLES.has(w));
  const base = long.length >= 2 ? long : all;
  const wanted = [...new Set(base)];
  if (wanted.length === 0) return true;
  // Token inteiro, não pedaço de palavra. `tokens` opcionais: quem chama em
  // lote (filterRelevantRaw) já normalizou o título e não paga de novo.
  const got = new Set(tokens || normalizeTitle(title).split(' ').filter(Boolean));
  const hits = wanted.filter((w) => got.has(w)).length;
  return hits / wanted.length >= 0.6;
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
// Palavras que descrevem o EMPACOTAMENTO, não a obra. Um pack legítimo é
// "Coleção Guerra nas Estrelas" ou "Game of Thrones Todas as Temporadas": elas
// não podem contar nem como primeiro token nem contra a precisão.
const PACK_WORDS = new Set(
  'colecao coletanea trilogia saga duologia quadrilogia pentalogia antologia serie series temporada temporadas todas todos completa completo integral filmes collection complete movies films'.split(' '),
);

// Ruído de release: o que todo indexer BR carimba no título e não diz nada
// sobre QUAL obra é. Fora daqui, "Torrent (2019) Legendado WEB DL 720p" faria
// qualquer título parecer distante da busca.
// Ruído TÉCNICO: marca onde o nome da obra acabou e começou a descrição da
// release. `extractSequenceMarkers` usa isto como parada, por isso as palavras
// de ligação ficam à parte — parar em "e" cortaria "Velozes e Furiosos 5"
// antes do número que interessa.
const TECH_NOISE = ('web dl webdl bluray blu ray webrip bdrip brrip hdtv hdrip rip remux hybrid ' +
  'x264 x265 h264 h265 avc hevc av1 xvid divx 10bit 8bit hdr hdr10 dv sdr imax ' +
  'dts aac ac3 eac3 ddp ddp5 ddp2 dd atmos truehd opus mp3 dual audio nacional multi ' +
  'hmax amzn dsnp atvp pcok crav hulu h ' +
  'us uk ca au nz jp tv ' +
  'torrent torrents download baixar assistir online gratis ' +
  'dublado dublada dublagem legendado legendada legenda opcao opcoes versao estendida extendida ' +
  'mkv mp4 avi gb mb kb ' +
  '480p 540p 576p 720p 1080p 1440p 2160p 4k uhd sd hd fullhd').split(' ');

// Ligação: não diz nada sobre a obra e também não marca fim do título.
const LINK_WORDS = 'de do da das dos e a o os as um uma em no na para por com sobre ate'.split(' ');

const LANG_NOISE = 'portugues portuguesa portugueses brasil brasileiro brasileira'.split(' ');

const RELEASE_NOISE = new Set([...TECH_NOISE, ...LINK_WORDS, ...LANG_NOISE]);

// O alias do catálogo e o nome publicado pelo indexer podem divergir só no
// artigo inicial ("Hulk" / "The Hulk"). Ignoramos apenas determinantes — não
// todas as palavras de ligação — para "Para Sempre" não virar "Sempre".
const LEADING_ARTICLES = new Set(
  ('o a os as um uma uns umas the an el la los las un una unos unas le les une ' +
    'des il lo gli uno der die das den dem ein eine einen het een').split(' '),
);

// Calibrado nos casos reais deste repo: o documentário "A Última Vigília" dá
// 0.60 e o pack "1ª até 8ª Temporada" dá 0.75 — o corte fica entre os dois.
const TITLE_PRECISION_MIN = 0.65;

// Séries curtas são especialmente ambíguas: "Rick e Morty" cobre 2/3 de
// "Rick e Morty O Anime", que passava no corte geral de 0,65 e tomava as
// vagas da obra original. O piso um pouco maior vale só quando temos a lista
// completa de aliases de série; o caso legítimo mais apertado do corpus (pack
// "1ª até 8ª Temporada") continua em 0,75.
const SERIES_TITLE_PRECISION_MIN = 0.70;

const STOP_AT = new Set([...TECH_NOISE, ...PACK_WORDS]);

// Numeral por extenso/romano → dígito, para "Duna Parte Dois" e "Rocky II"
// casarem com "Duna Parte 2". "i" e "x" ficam de fora de propósito: sozinhos
// são artigo em inglês ("I Am Legend") e marca de resolução/multiplicação,
// não número de sequência.
const NUMERAL_CANON: Record<string, number> = {
  ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9,
  um: 1, dois: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

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
 */
function extractSequenceMarkers(text: string) {
  const markers = new Set();
  for (const raw of normalizeTitle(text).split(' ')) {
    if (!raw) continue;
    if (/^(?:19|20)\d{2}$/.test(raw)) break;
    if (STOP_AT.has(raw)) break;
    const n = /^\d+$/.test(raw) ? Number(raw) : NUMERAL_CANON[raw];
    if (n >= 2 && n <= 19) markers.add(n);
  }
  return markers;
}

// Marcador de episódio/temporada ("s01e01", "e07", "1x04", ordinal "1a"):
// estrutura, não conteúdo. Contá-lo como palavra estranha derrubava a precisão
// de release legítima do redetorrent ("S02E01 A Casa do Dragão S02E01 x264
// DUAL", "1A TEMPORADA COMPLETA House of the Dragon S01").
const EPISODE_TOKEN = /^(?:s\d{1,2}(?:e\d{1,3})?|t\d{1,2}(?:e\d{1,3})?|e\d{1,3}|\d{1,2}x\d{1,3}|\d{1,2}a)$/;

/**
 * Quanto do título do candidato está DENTRO da busca, ignorando ruído de
 * release, empacotamento e ano. 1 = o título não acrescenta nada; perto de 0 =
 * é outra obra que só começa com o mesmo nome.
 */
function titlePrecision(tokens: string[], wanted: Iterable<string>) {
  const want = new Set(wanted);
  const significant = tokens.filter(
    (w) =>
      !RELEASE_NOISE.has(w) &&
      !PACK_WORDS.has(w) &&
      !EPISODE_TOKEN.test(w) &&
      !/^\d+$/.test(w), // número solto é temporada, ano ou tamanho
  );
  // Título que só tem ruído não contradiz nada.
  if (significant.length === 0) return 1;
  return significant.filter((w) => want.has(w)).length / significant.length;
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

function matchesEpisodeWorkIdentity(
  title: string,
  allNames: string[] | null,
  tokens: string[] | null = null,
  universeTokens: string[] | null = null,
) {
  if (!allNames?.length) return true;
  // `tokens`/`universeTokens` opcionais: o mesmo título passa por várias
  // funções no filtro em lote e cada uma renormalizava a string.
  const own = tokens || normalizeTitle(title).split(' ').filter(Boolean);
  const work = episodeWorkTokens(own);
  if (!work) return true;
  const universe =
    universeTokens || allNames.flatMap((name) => normalizeTitle(name).split(' ')).filter(Boolean);
  return titlePrecision(work, universe) >= SERIES_TITLE_PRECISION_MIN;
}

/**
 * O ano do título contradiz o ano do catálogo? Definição ÚNICA da regra de
 * ano, com tolerância por tipo (mesma lógica do pacote BRDUB, calibrada
 * contra casos reais): filme aceita ±2 — o ano do post BR costuma ser o do
 * lançamento nacional — e condena com um ÚNICO ano contraditório; série só
 * condena quando TODOS os anos do título são anteriores à estreia −2, porque
 * o ano do post de série é o da temporada ("Fallout 2ª Temporada (2025)"
 * contra catálogo 2024 passa). Dois ou mais anos em FILME deixam o campo
 * ambíguo ("Blade Runner 2049 (2017)") e a checagem é pulada; em série
 * basta um ano recente para liberar. Sem ano no catálogo nada é cortado.
 */
function yearContradicts(tokens: string[], year: number | string | null, isSeries: boolean) {
  const catalogYear = Number(String(year || '').match(/(?:19|20)\d{2}/)?.[0] || 0);
  if (!catalogYear) return false;
  const years = tokens.filter((t) => /^(?:19|20)\d{2}$/.test(t)).map(Number);
  if (isSeries) return years.length > 0 && years.every((y) => y < catalogYear - 2);
  return years.length === 1 && Math.abs(years[0] - catalogYear) > 2;
}

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
  const own = tokens || normalizeTitle(title).split(' ').filter(Boolean);
  const wanted = normalizeTitle(name).split(' ').filter(Boolean);
  const firstSig = (arr: string[]) =>
    arr.find(
      (w) =>
        w.length > 2 &&
        !LEADING_ARTICLES.has(w) &&
        !PACK_WORDS.has(w) &&
        !EPISODE_TOKEN.test(w),
    ) || arr[0];
  const want = firstSig(wanted);
  if (want && firstSig(own) !== want) return false;

  // Em série o número antes do ruído é a temporada; matchesEpisode decide se
  // ela serve. Em filme, sequência não pedida é outra obra.
  if (!isSeries) {
    const wantedMarkers = extractSequenceMarkers(name);
    if (![...extractSequenceMarkers(title)].every((n) => wantedMarkers.has(n))) return false;
  }

  return !yearContradicts(own, year, isSeries);
}

/**
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
  const own = tokens || normalizeTitle(title).split(' ').filter(Boolean);

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
      universeTokens || allNames.flatMap((n) => normalizeTitle(n).split(' ')).filter(Boolean);
    const measured = episodeWork || own;
    const precisionMin = isSeries ? SERIES_TITLE_PRECISION_MIN : TITLE_PRECISION_MIN;
    if (titlePrecision(measured, universo) < precisionMin) return false;
  }

  return matchesTitleStructure(title, name, year, { isSeries, tokens: own });
}

// Faixa de anos descreve COLEÇÃO multi-obra: "Todos os filmes 1979-2016".
// Testada no título cru: a normalização transforma o hífen em espaço e
// separaria os dois anos.
//
// O separador aceita hífen/travessão, vírgula, palavra ("de 1979 a 2016") ou
// só espaço: o MESMO pack aparece como "1979-2016" no thepiratebay e
// "1979 2016" no 1337x, e sem isso o mesmo hash era pack num tracker e filme
// comum no outro — com o play caindo no caminho permissivo justamente lá.
const YEAR_RANGE = /\b(?:19|20)\d{2}(?:\s*[-–—,]\s*|\s+(?:de|a|ate|até)\s+|\s+)(?:19|20)\d{2}\b/i;

// Palavras que sozinhas já significam "mais de uma obra". Cobre pt-BR E inglês,
// medido em 2.551 títulos reais: pegam os packs que a faixa de anos não pega,
// com zero falso positivo — "trilogy" tem 30 ocorrências no corpus, todas packs,
// e "quadrilogy" 1, também pack.
//
// Revalidado sobre os 1203 títulos prontos de uma conta real de debrid:
// "filmografia" aparece 1 vez e é pack; "trilogia" 3, todas packs. `saga`
// segue FORA (3 ocorrências, 2 delas filme comum — "The Twilight Saga
// Breaking Dawn Part 1", "[Saga Crepúsculo]") e `completa` segue fraca
// (11 ocorrências, quase todas "Temporada Completa").
const STRONG_PACK_WORDS = new Set(
  'trilogia duologia quadrilogia pentalogia colecao coletanea antologia filmografia filmography trilogy quadrilogy duology tetralogy anthology boxset'.split(' '),
);

/**
 * Título de coleção com mais de uma obra (pack de filmes). Serve à guarda de
 * listagem: sem debrid o play acontece direto no cliente, que escolhe o MAIOR
 * arquivo do pack — "todos os filmes" tocando o filme errado em silêncio.
 * Exige os dois sinais juntos: palavra de empacotamento E faixa de anos.
 */
function isMultiWorkCollection(title = '') {
  const raw = String(title);
  const tokens = normalizeTitle(raw).split(' ');
  if (tokens.some((t) => STRONG_PACK_WORDS.has(t))) return true;
  // Palavra fraca ("todos", "filmes", "completa") só conta com faixa de anos:
  // sozinha ela também aparece em "Todas as Temporadas" e em edição especial.
  if (!YEAR_RANGE.test(raw)) return false;
  return tokens.some((token) => PACK_WORDS.has(token));
}

// Sequência no fim do título: romano canônico, número de 1-2 dígitos ou
// "Parte N". A trava de 2+ palavras na raiz protege "Distrito 9", onde o
// número É o nome da obra.
const SEQUENCE_TAIL = /\s+(?:parte\s+)?(?:[ivx]{1,4}|\d{1,2})$/i;

/**
 * Raiz da franquia de um título: corta o subtítulo ("Jornada nas Estrelas: O
 * Filme" → "Jornada nas Estrelas") e o marcador de sequência no fim ("II",
 * "2", "Parte 2"), sempre exigindo 2+ palavras no resultado — quem hospeda o
 * dublado da continuação costuma ser a COLEÇÃO da franquia, e "Jornada nas
 * Estrelas II" devolve 0 resultados onde "Jornada nas Estrelas" devolve 14.
 *
 * Alimenta a varredura pt-BR (search-plan) e a exceção de franquia do
 * inventário da conta (`filterInventoryRelevant`).
 */
function franchiseRoot(title: string) {
  const raw = String(title || '').trim();
  if (!raw) return '';
  // Casa o PRIMEIRO separador entre os três suportados; a âncora inicial
  // impede cortar no meio de um subtítulo.
  const cut = raw.match(/^([^:–—]+?)([:–—].*)?$/);
  let head = raw;
  if (cut) {
    const candidate = cut[1].trim();
    if (candidate.split(/\s+/).filter(Boolean).length >= 2) head = candidate;
  }
  const root = head.replace(SEQUENCE_TAIL, '').trim();
  if (root && root.split(/\s+/).filter(Boolean).length >= 2) return root;
  return head;
}

/** Raízes de franquia normalizadas de todos os nomes conhecidos da obra. */
function franchiseRoots(names: string[] = []): string[] {
  const roots = new Set<string>();
  for (const name of names) {
    const normalized = normalizeTitle(franchiseRoot(name)).split(' ').filter(Boolean).join(' ');
    if (normalized) roots.add(normalized);
  }
  return [...roots];
}

/** O título contém a raiz como sequência contígua de palavras normalizadas. */
function containsTokenRun(title: string, normalizedRoot: string) {
  const haystack = normalizeTitle(title).split(' ').filter(Boolean);
  const needle = String(normalizedRoot || '').split(' ').filter(Boolean);
  if (!needle.length || haystack.length < needle.length) return false;
  for (let i = 0; i <= haystack.length - needle.length; i += 1) {
    if (needle.every((tok, j) => haystack[i + j] === tok)) return true;
  }
  return false;
}

/**
 * Ano verdadeiro escondido no magnet: sites BR publicam o post sem ano no
 * título mapeado ("O Corvo The Crow e Dual"), mas o dn= do magnet preserva o
 * nome real da release. Medido no hdrtorrent: o MESMO post entrega magnets de
 * três filmes ("The Crow (2024)", "O Corvo 1994", "O Corvo (2012)") — e os
 * três se chamam "O Corvo" no Brasil, então nenhum filtro de título separa.
 * Um único ano explícito no magnet contradizendo o catálogo além de ±2 é
 * outra obra. Vários anos é ambíguo e passa, na mesma régua das regras de
 * título; resolução (1920x1080) não é ano.
 */
function magnetYearContradicts(item: RawItem | null | undefined, catalogYear: number) {
  const raw = String(item?.magnet || item?.MagnetUri || item?.Guid || '');
  if (!raw || !catalogYear) return false;
  // O dn= viaja percent-encoded ("O%20Corvo%201994"): sem decodificar, o '0'
  // do %20 cola no ano e a fronteira de dígito esconde exatamente o ano
  // verdadeiro que esta guarda procura. '+' é espaço na forma magnet.
  let source = raw.replace(/\+/g, ' ');
  try {
    source = decodeURIComponent(source);
  } catch {
    /* sequência % malformada: segue com o texto que decodificou até aqui */
  }
  const cleaned = source.replace(/\d{3,4}x\d{3,4}/gi, ' ');
  const years = [
    ...new Set(
      [...cleaned.matchAll(/(?<!\d)(?:19|20)\d{2}(?!\d)/g)].map((m: any) => Number(m[0])),
    ),
  ];
  return years.length === 1 && Math.abs(years[0] - catalogYear) > 2;
}

/**
 * Classificação crua compartilhada pelo corte final e pelo gatilho de pack.
 * Usar uma função só impede o fallback de discordar do que buildStreams vai
 * descartar alguns milissegundos depois.
 *
 */
function filterRelevantRaw(
  items: RawItem[] = [],
  { names = [], year = null, isSeries = false, season = null, episode = null }: MatchOptions = {},
) {
  if (!names.length) return items;
  // Hot path: os tokens do título e o universo de allNames dependem só de
  // strings que se repetem entre itens. Cada item renormalizava o MESMO texto
  // 3-5 vezes (matchesName, matchesBrTitle, matchesTitleStructure,
  // matchesEpisodeWorkIdentity), e o universo de nomes era remontado por item.
  const tokenMemo = new Map();
  const tokensOf = (title: string) => {
    let tokens = tokenMemo.get(title);
    if (!tokens) {
      tokens = normalizeTitle(title).split(' ').filter(Boolean);
      tokenMemo.set(title, tokens);
    }
    return tokens;
  };
  const universe = names.flatMap((n) => normalizeTitle(n).split(' ')).filter(Boolean);
  return items.filter((item) => {
    const title = item?.title || item?.Title || '';
    const tokens = tokensOf(title);
    const titleMatches = names.some((name) =>
      item?.isBr
        ? matchesBrTitle(title, name, year, { isSeries, allNames: names, tokens, universeTokens: universe })
        : matchesName(title, name, tokens) &&
          // Série global continua PULANDO prefixo e sequência — o marcador de
          // episódio delimita a obra, e o prefixo de filme mudaria formatos
          // legítimos como "S01E02.From". Mas ficar sem guarda NENHUMA depois
          // do matchesName deixava a série com um portão só: release de filme
          // não carrega marcador de episódio, a checagem de identidade
          // abstém-se, e "Shaun of the Dead (2004)" entrava na lista de
          // "Dead City" com o 0.600 do token repetido. A metade do ANO da
          // matchesTitleStructure fecha exatamente essa lacuna, sem tocar nos
          // formatos que o prefixo protegeria errado.
          (isSeries ? !yearContradicts(tokens, year, true) : matchesTitleStructure(title, name, year, { tokens })) &&
          matchesEpisodeWorkIdentity(title, names, tokens, universe),
    );
    if (!titleMatches) return false;
    // Filme: o dn= do magnet carrega o ano verdadeiro quando o título
    // mapeado não traz (e confirma quando traz). Séries ficam de fora — o
    // ano do post delas é o da temporada, com regra própria acima.
    if (!isSeries && season == null) {
      const catalogYear = Number(String(year ?? '').match(/(?:19|20)\d{2}/)?.[0] || 0);
      if (catalogYear && magnetYearContradicts(item, catalogYear)) return false;
    }
    if (season == null || episode == null) return true;
    return matchesEpisode(title, { season, episode });
  });
}

/**
 * Relevância de item do INVENTÁRIO da conta do debrid: o caminho estrito dos
 * indexers, MAIS uma exceção — pack multi-obra da MESMA franquia.
 *
 * A exceção não vale para o caminho dos indexers, de propósito: resultado de
 * tracker é palpite, coisa na conta é escolha do usuário (e já está paga).
 * Medido: "FILMOGRAFIA COMPLETA JORNADA NAS ESTRELAS-STAR TREK-PTBR" pronto
 * no debrid e invisível — "filmografia" não é o começo de nenhum nome da
 * obra e a regra de prefixo do filtro estrito o rejeitava.
 *
 * Só para filme (season == null): pack de franquia de série morreria mesmo
 * assim no corte por episódio, e temporada inteira já passa pelo caminho
 * normal ("Lost Girl (2010) S01-S05").
 *
 */
function filterInventoryRelevant(
  items: RawItem[] = [],
  { names = [], season = null, ...matchContext }: MatchOptions = {},
) {
  if (!names.length) return [];
  const direct = filterRelevantRaw(items, { names, season, ...matchContext });
  if (season != null) return direct;
  const directSet = new Set(direct);
  const leftovers = items.filter((item) => !directSet.has(item));
  if (!leftovers.length) return direct;
  const roots = franchiseRoots(names);
  if (!roots.length) return direct;
  const extra = leftovers.filter((item) => {
    const title = item?.title || item?.Title || '';
    return isMultiWorkCollection(title) && roots.some((root) => containsTokenRun(title, root));
  });
  return extra.length ? [...direct, ...extra] : direct;
}

export {
  TECH_NOISE,
  LEADING_ARTICLES,
  matchesName,
  matchesBrTitle,
  matchesTitleStructure,
  matchesEpisodeWorkIdentity,
  yearContradicts,
  isMultiWorkCollection,
  franchiseRoot,
  franchiseRoots,
  containsTokenRun,
  filterInventoryRelevant,
  filterRelevantRaw,
  magnetYearContradicts,
};
