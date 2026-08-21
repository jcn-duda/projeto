import { priorityMap, compareIndexerPriority } from './indexer-priority.js';
import config from '../config.js';
import type { RawItem, Stream, ParsedSeasonEpisode, DebridAdapter } from '../../types/domain.js';

// Tamanho <= 1 KB é o sentinela de "desconhecido" dos indexers BR (ver
// UNKNOWN_SIZE nos resolvedores), não um torrent de verdade.

interface StreamDisplayOptions {
  title?: string;
  quality?: string;
  audio?: string;
  source?: string;
  edition?: string;
  tracker?: string;
  isBr?: boolean;
  seeders?: number;
  style?: string;
  showSource?: boolean;
}

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

interface PoolsOptions {
  season?: number | null;
  minSeeders?: number;
}

interface AutofetchOptions {
  autoFetchBr?: boolean;
}

interface SearchNamesOptions {
  meta?: { name?: string | null; title?: string; year?: number | string | null } | null;
  titles?: { original?: string | null; pt?: string | null; year?: number | string | null } | null;
  imdbId?: string | null;
}

interface SeasonEpisodeOptions {
  season?: number | null;
  episode?: number | null;
}

const UNKNOWN_SIZE_MAX = 1024;

// Teto de sanidade, do outro lado da mesma moeda. A definição Cardigann do
// redetorrent carimba 1.784.881.034.035 bytes (1,62 TB) em 53 das 93 releases
// de uma busca — valor fabricado, não medido. Exibi-lo é mentir para o
// usuário, e pior: com filtro de tamanho ligado ele apagava a fonte dublada
// inteira. Nem remux 4K de temporada completa chega perto de 500 GB.
const IMPLAUSIBLE_SIZE_MIN = 500 * 1024 ** 3;

// Resolução que o título não informa. Balde e cota próprios, separados do SD.
const UNKNOWN_QUALITY = 'sem resolução';

const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
];

function bytesToSize(bytes: unknown) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * btih em base32 (32 chars) para os 40 hex que o Stremio exige.
 * Magnet de indexer BR às vezes vem nesse formato; repassado cru, o item
 * aparece na lista mas o cliente não monta o magnet e o play morre.
 */
function base32ToHex(input: string) {
  const s = String(input).toUpperCase();
  let bits = '';
  for (const ch of s) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) return null;
    bits += idx.toString(2).padStart(5, '0');
  }
  let hex = '';
  for (let i = 0; i + 4 <= 160; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

function extractInfoHash(magnetOrHash: unknown) {
  if (!magnetOrHash) return null;
  const raw = String(magnetOrHash).trim();

  if (/^[a-fA-F0-9]{40}$/.test(raw)) return raw.toLowerCase();
  if (/^[a-zA-Z2-7]{32}$/.test(raw)) return base32ToHex(raw);

  const m = raw.match(/btih:([a-zA-Z0-9]{32,40})/i);
  if (!m) return null;
  const hash = m[1];
  if (/^[a-fA-F0-9]{40}$/.test(hash)) return hash.toLowerCase();
  if (hash.length === 32) return base32ToHex(hash);
  return null;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
};

/**
 * Indexers que raspam WordPress devolvem o título com entidade crua — o BLUDV
 * e o Comando mandam "Episódio II &#8211; Ataque dos Clones". Sem decodificar,
 * a entidade aparece literal na lista do cliente.
 */
function decodeEntities(text = '') {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (whole: string, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? whole);
}

/**
 * "Não sei" é diferente de "é ruim". Título sem resolução vira UNKNOWN_QUALITY,
 * não SD: os sites BR quase nunca publicam resolução ("Nome (2026) [opção 3]"),
 * e enquanto isso caía no balde do SD, zerar a cota de SD desligava a
 * prioridade brasileira inteira — inclusive as vagas reservadas.
 * SD agora exige uma marca explícita de baixa qualidade.
 */
function qualityFromTitle(title = '') {
  const t = title.toUpperCase();
  if (/\b(2160P|4K|UHD)\b/.test(t)) return '2160p';
  if (/\b1080P\b/.test(t)) return '1080p';
  if (/\b720P\b/.test(t)) return '720p';
  if (/\b480P\b/.test(t)) return '480p';
  // 576p/540p são resoluções SD de verdade (PAL), não "não sei".
  if (/\b(576P|540P|360P|240P|SDTV|DVD[- ]?(?:RIP|SCR)|VHS[- ]?RIP|TS|TC|CAM[- ]?RIP|CAM)\b/.test(t)) return 'SD';
  return UNKNOWN_QUALITY;
}

function sourceFromTitle(title = '') {
  const t = title.toUpperCase();
  if (/\b(BLURAY|BLU-RAY|BDREMUX|BD\b)/.test(t)) return 'BluRay';
  if (/\bWEB[-. ]?DL\b/.test(t)) return 'WEB-DL';
  if (/\bWEB[-. ]?RIP\b/.test(t)) return 'WEBRip';
  if (/\bHDTV\b/.test(t)) return 'HDTV';
  // CAMRip e HDCAM não têm fronteira de palavra em volta de "CAM" e escapavam
  // do teste anterior (`\bCAM\b`): passavam como fonte desconhecida. Isso pesa
  // mais desde que o autofetch baixa por swarm — gravação de cinema é
  // justamente o que costuma ter o maior número de seeders num lançamento.
  if (/\b(?:HD[-. ]?)?CAM(?:[-. ]?RIP)?\b/.test(t)) return 'CAM';
  return '';
}

/**
 * Corte do filme, quando o release anuncia um. Não é firula: numa lista de
 * quatro 4K do mesmo filme, "Theatrical" e "Alternate Ending" são FILMES
 * DIFERENTES no fim, e a linha compacta não tinha como diferenciá-los — só o
 * número de seeders mudava. Escolher pelo maior seed levava ao corte errado.
 *
 * Rótulos curtos de propósito: isto divide a coluna estreita com qualidade,
 * fonte e áudio.
 */
function editionFromTitle(title = '') {
  const t = title.toUpperCase();
  if (/\bALTERNAT(E|IVO|IVA)\s+(ENDING|FINAL)\b/.test(t)) return 'Alt.End';
  // "Alternate Version" não diz QUAL é a diferença, mas diz que não é o corte
  // padrão — e isso já basta para o usuário não escolher por acidente.
  if (/\bALTERNAT(E|IVO|IVA)\s+(VERSION|VERS[AÃ]O|CUT)\b|\bVERS[AÃ]O\s+ALTERNATIVA\b/.test(t)) return 'Alt.Ver';
  if (/\b(DIRECTOR'?S\s+CUT|DIRECTORS\s+CUT)\b/.test(t)) return 'DC';
  if (/\b(EXTENDED|VERS[AÃ]O\s+ESTENDIDA)\b/.test(t)) return 'Extended';
  if (/\b(THEATRICAL|VERS[AÃ]O\s+DE\s+CINEMA)\b/.test(t)) return 'Cinema';
  if (/\b(REMASTER(ED)?|REMASTERIZAD[OA])\b/.test(t)) return 'Remaster';
  if (/\bIMAX\b/.test(t)) return 'IMAX';
  if (/\b(UNCUT|UNRATED|SEM\s+CORTES)\b/.test(t)) return 'Uncut';
  return '';
}

function explicitPtAudio(title = '') {
  const t = title.toUpperCase();
  const isExplicitSub =
    /\b(LEGENDAD[OA]|LEGENDAS?|LEG[-.]?PT[-.]?BR|SUB[-.]?PT[-.]?BR|SOFT[- ]?SUB)\b/.test(t) ||
    /\[\s*LEG\s*\]|\(\s*LEG\s*\)|\bLEG\b/.test(t);

  return (
    /\b(DUBLAD[OA]|DUBLAGEM|DUBBED|DUB[-.]?BR|AUDIO[- ]?PT[-.]?BR|DUBLADO[- ]?PT[-.]?BR)\b/.test(t) ||
    /\[\s*DUB\s*\]|\(\s*DUB\s*\)|\bDUB\b/.test(t) ||
    (/\b(PT[-.]?BR|PTBR|PORTUGU[EÊ]S|BRAZILIAN)\b/.test(t) && !isExplicitSub)
  );
}

/**
 * Áudio é a informação que mais importa neste addon (foco em dublado) e os
 * sites BR a escrevem no título. Sem ela o usuário abre o torrent pra descobrir.
 */
function audioFromTitle(title = '') {
  const t = title.toUpperCase();

  // Dual / Multi áudio
  if (/\b(DUAL|DOUBLE|DUAL[- ]?AUDIO|AUDIO[- ]?DUPLO|DUPLO[- ]?AUDIO|MULTI[- ]?AUDIO|MULTIAUDIO)\b/.test(t)) {
    return 'Dual';
  }

  // Produções nacionais brasileiras (áudio original em PT-BR)
  if (/\b(NACIONAL|NAC)\b/.test(t) && !/\b(LEG|LEGENDAD[OA]|SUB|SUBBED)\b/.test(t)) {
    return 'Nacional';
  }

  // Legendado explícito
  const isExplicitSub =
    /\b(LEGENDAD[OA]|LEGENDAS?|LEG[-.]?PT[-.]?BR|SUB[-.]?PT[-.]?BR|SOFT[- ]?SUB)\b/.test(t) ||
    /\[\s*LEG\s*\]|\(\s*LEG\s*\)|\bLEG\b/.test(t);
  const isExplicitDub = explicitPtAudio(title);

  if (isExplicitDub && isExplicitSub) return 'Dual';
  if (isExplicitDub) return 'Dublado';
  if (isExplicitSub) return 'Legendado';

  return '';
}

// Marcas estrangeiras explícitas não devem vencer por seeders quando o objetivo
// é aquecer um pack utilizável. MULTI/DUAL ficam fora desta lista: carregam a
// faixa original e não provam que o torrent não serve ao usuário.
function hasExplicitForeignAudio(title = '') {
  const t = String(title).toUpperCase();
  if (explicitPtAudio(title)) return false;
  return /\b(TRUEFRENCH|FRENCH|VOSTFR|VF|ITA|SUBITA|ESPANOL|CASTELLANO|RUS|GERMAN|NL)\b/.test(t);
}

/**
 * Dublado pt-BR visível no TÍTULO, independente do indexer. Tracker global
 * hospeda bastante release dublada titulada em português ("Jornada Nas
 * Estrelas … Dublado"); sem essa marca o resultado chegava com isBr=false,
 * era julgado contra o nome em inglês e morria antes das vagas BR.
 *
 * "Dual" sozinho não basta: em tracker global pode ser EN+qualquer idioma —
 * só conta com o PT explícito ao lado. Reusa os classificadores de áudio já
 * calibrados, em vez de uma segunda lista que divergiria.
 */
function looksPtBr(title = '') {
  const audio = audioFromTitle(title);
  if (audio === 'Dublado' || audio === 'Nacional') return true;
  return audio === 'Dual' && explicitPtAudio(title);
}

function compactAudio(audio = '') {
  if (audio === 'Dublado') return 'DUB';
  if (audio === 'Legendado') return 'LEG';
  if (audio === 'Dual') return 'DUAL';
  if (audio === 'Nacional') return 'NAC';
  return '';
}

const TRACKER_LABEL_MAX = 14;

/**
 * Nome da fonte para a coluna estreita: o TLD não ajuda a reconhecer o site e,
 * passando de TRACKER_LABEL_MAX, o rótulo empurra o seeder para fora.
 *
 * A escada existe porque cortar seco parte a palavra no meio ("kickasstorrents"
 * virava "kickasstorrent"), e nome truncado assim é pior que nome curto: o
 * usuário lê como se fosse outra fonte.
 */
function compactTracker(tracker = '') {
  let label = String(tracker).trim().replace(/(?:\.[a-z]{2,})+$/i, '');
  if (label.length <= TRACKER_LABEL_MAX) return label;

  // Todos esses sites repetem "torrent(s)" no nome — é a parte que menos
  // identifica ("ComandoTorrents" → "Comando", como o Torrentio exibe).
  const withoutSuffix = label.replace(/[\s_-]*torrents?$/i, '');
  if (withoutSuffix.length >= 4) label = withoutSuffix;
  if (label.length <= TRACKER_LABEL_MAX) return label;

  // Última fronteira que ainda cabe: separador ou transição camelCase
  // ("NerdFilmesTorrent" → "NerdFilmes"). Sobrando menos de 4 chars o corte
  // não identifica mais nada, e aí o corte seco é menos ruim.
  const window = label.slice(0, TRACKER_LABEL_MAX + 1);
  const boundaries = [...window.matchAll(/[\s_-]+|(?<=[a-z0-9])(?=[A-Z])/g)]
    .map((m) => m.index)
    .filter((index) => index >= 4);
  if (boundaries.length) return label.slice(0, boundaries[boundaries.length - 1]);

  return label.slice(0, TRACKER_LABEL_MAX);
}

/**
 * `name` ocupa a coluna estreita do Stremio: marca + qualidade, como Torrentio.
 * A release completa fica em `title`, na coluna larga de detalhes.
 *
 * A release já foi duplicada aqui por causa de cliente que renderiza SÓ o
 * `name`. O preço apareceu na tela: com o título inteiro ("Mestres do Universo
 * (2026) 5.1 WEB-DL | [2160p WEB-DL DUBLADO 20.17 GB]") mais o prefixo do
 * debrid, a coluna estreita quebrava em uma palavra por linha e CADA stream
 * ocupava ~11 linhas de altura — cabiam três na tela inteira. Compacto, o mesmo
 * item ocupa duas linhas e a lista volta a ser navegável.
 *
 * `STREAM_NAME_STYLE=full` devolve o comportamento antigo para quem depende de
 * um cliente que ignora o `title`.
 *
 */
function streamDisplayName({
  title = '',
  quality,
  audio,
  source,
  edition,
  tracker,
  isBr = false,
  seeders = 0,
  style = config.streamNameStyle,
  showSource = config.streamNameShowSource,
}: StreamDisplayOptions = {}) {
  // A ordem é a da decisão: primeiro a resolução, depois QUAL corte do filme é,
  // depois de onde veio. Sem corte e fonte, quatro releases 4K do mesmo filme
  // saíam com a linha idêntica e a escolha virava sorteio pelo seed.
  const details = [
    quality === UNKNOWN_QUALITY ? null : quality === '2160p' ? '4K' : quality,
    edition || null,
    source || null,
    compactAudio(audio),
    isBr ? 'BR' : null,
  ].filter(Boolean).join(' ');
  const stats = [
    details,
    showSource ? compactTracker(tracker) : null,
    Number(seeders) > 0 ? `👤 ${seeders}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  // Sem o nome do addon: o cliente já o exibe no badge do card ("Localhost:7000",
  // "Power Movie"), e repeti-lo em toda linha só gastava a coluna estreita.
  if (style === 'full') return [title, stats].filter(Boolean).join('\n');
  // Release que não anuncia resolução, corte, fonte nem áudio não tem o que
  // resumir: sobraria "👤 1", que não identifica nada. Aí o título é a única
  // informação existente e vale mais que a coluna curta.
  return details ? stats : [title, stats].filter(Boolean).join('\n');
}

/**
 * Prefixo no formato do Torrentio, com ⚡ no lugar do "+": a sigla é do DEBRID,
 * não do addon — `[AD⚡]` toca na hora, `[AD download]` ainda precisa baixar.
 * Sem debrid não há prefixo, porque não há nada a prometer sobre o play.
 *
 * O `[PM+]` fixo de antes usava a sigla para "Power Movie" e colidia com a do
 * Premiumize, dizendo "instantâneo" até para quem estava em P2P puro.
 */
function markDebridName(name = '', short = '', cached = false) {
  const tag = String(short || '').trim();
  if (!tag) return String(name);
  return `[${tag}${cached ? '⚡' : ' download'}] ${name}`;
}

function matchesQualityFilter(title: string, filters?: string[]) {
  if (!filters || filters.length === 0) return true;
  const upper = String(title).toUpperCase();
  return filters.some((f: string) => upper.includes(String(f).toUpperCase()));
}

const QUALITY_FILTER_ALIASES: Record<string, string> = { '4k': '2160p', uhd: '2160p' };

/**
 * A whitelist julga `_quality`, não substring do título: "4K"/"UHD" já viram
 * 2160p na declaração e o chip é `2160p`. Fonte BR sem resolução tem balde
 * próprio; excluí-la aqui tornaria `maxUnknown` inoperante.
 */
function passesQualityFilter(stream: any, filters?: string[], qualityLimits: Record<string, any> = {}) {
  if (!filters || filters.length === 0) return true;
  const quality = streamQuality(stream);
  if (stream?._br && quality === UNKNOWN_QUALITY) {
    const unknownLimit = qualityLimits[UNKNOWN_QUALITY];
    return unknownLimit == null || Number(unknownLimit) > 0;
  }
  const allowed = new Set(
    filters.map((f: string) => QUALITY_FILTER_ALIASES[String(f).toLowerCase()] || String(f)),
  );
  return allowed.has(quality);
}

/**
 * Normaliza resultados de Jackett/Prowlarr/demo para o formato do Stremio.
 *
 * É a FÁBRICA do que chega ao cliente: o tipo de retorno faz o typecheck cobrar
 * aqui a união do `Stream` (todo item precisa de ação — `url`, `infoHash`,
 * `externalUrl` ou a marca `notice`), na origem e não na tela. Devolve `null`
 * quando o item não tem infoHash extraível — não há o que tocar.
 */
function toStremioStream(item: RawItem): Stream | null {
  const infoHash = extractInfoHash(item.infoHash || item.magnet || item.MagnetUri || item.Guid);
  if (!infoHash) return null;

  const title = decodeEntities(item.title || item.Title || 'Torrent');
  // Origem BR pelo indexer E pelo título: tracker global também hospeda
  // dublado titulado em português, e é o título que denuncia. O flag muda o
  // chip BR, as vagas reservadas e a priorização de dublado.
  const isBr = Boolean(item.isBr) || looksPtBr(title);
  const seeders = Number(item.seeders ?? item.Seeders ?? 0) || 0;
  const rawSize = Number(item.size ?? item.Size);
  // Os indexers BR mandam 1 KB quando o post não publica tamanho: o Jackett
  // descarta release sem tamanho, então o sentinela é o preço de não perder a
  // release. Aqui ele volta a ser "desconhecido" — nenhum vídeo tem 1 KB.
  const knownSize =
    Number.isFinite(rawSize) && rawSize > UNKNOWN_SIZE_MAX && rawSize < IMPLAUSIBLE_SIZE_MIN
      ? rawSize
      : 0;
  const size = bytesToSize(knownSize);
  const tracker = item.tracker || item.Tracker || item.Indexer || item.indexer || '';
  const quality = qualityFromTitle(title);
  const source = sourceFromTitle(title);
  const audio = audioFromTitle(title);
  const edition = editionFromTitle(title);

  // Convenção do Torrentio: 👤 seeders, 💾 tamanho, ⚙️ indexer. Os clientes
  // (Stremio e Power Movie) reconhecem esses marcadores e montam a linha de
  // metadados a partir deles — com "•" eles não exibiam seeds nem a fonte.
  const bits = [
    `👤 ${seeders}`,
    size ? `💾 ${size}` : null,
    tracker ? `⚙️ ${tracker}` : null,
  ].filter(Boolean);

  return {
    // A coluna esquerda precisa ficar curta. O título bruto nesta posição fazia
    // o Stremio quebrar uma palavra por linha em telas estreitas.
    name: streamDisplayName({
      title,
      quality,
      audio,
      source,
      edition,
      tracker,
      isBr,
      seeders,
    }),
    title: `${title}\n${bits.join(' ')}`,
    infoHash,
    sources: TRACKERS.map((t) => `tracker:${t}`),
    behaviorHints: {
      // Binge de uma release sem resolução não pode cair no grupo do SD.
      bingeGroup: `powerm-${quality === UNKNOWN_QUALITY ? 'na' : quality}-${source || 'any'}`,
    },
    _seeders: seeders,
    _quality: quality,
    // 0 = desconhecido, e o filtro de tamanho máximo já trata 0 como "passa".
    _size: knownSize,
    // Agregadores BR espelham magnets globais: DUAL sem PT explícito não pode
    // ganhar vaga, prioridade ou autofetch só porque o post foi marcado BR.
    _dubbed: isBr
      ? audio === 'Dublado' || audio === 'Dual' || audio === 'Nacional'
      : explicitPtAudio(title),
    // Origem BR vem marcada pelo provider OU pelo título (dublado em tracker
    // global). Release de site BR sem marca nenhuma no título continua valendo
    // pelo flag do provider: comandotorrents/nerdfilmes não citam "DUBLADO".
    _br: isBr,
    // O label exibido não é estável o bastante para a prioridade, mas precisa
    // sobreviver ao merge para que o `name` do vencedor não perca a fonte.
    _tracker: tracker,
    // ID estável do indexer (não o label mutável) para o desempate de prioridade.
    _indexer: String(item.indexer || tracker || '').trim().toLowerCase(),
    // Pack multi-obra detectado pelo título da listagem: o /resolve precisa
    // saber que aqui NÃO vale cair no maior arquivo.
    _multiWork: isMultiWorkCollection(title),
  };
}

function normalizeTitle(s = '') {
  return String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Descarta resultados que claramente não são o título procurado — indexers
 * costumam devolver "parecidos" para queries curtas.
 *
 * Duas armadilhas, ambas medidas em título pt-BR curto (que é justamente o que
 * vai pros sites BR):
 *
 * - comparar por SUBSTRING da string inteira fazia "dia" casar dentro de
 *   "diabo": "Dia D" (Disclosure Day) aceitava "O Diabo Veste Prada 2";
 * - descartar palavra de até 2 letras esvazia o título quando ele é curto —
 *   "Dia D" virava o token único `dia` e aceitava "Um Dia de Sorte em Nova
 *   York" e "Homem-Aranha: Um Novo Dia". As seis vagas reservadas iam para o
 *   lixo e empurravam pra fora a fonte dublada correta.
 *
 */
function matchesName(title: string, name: string, tokens: string[] | null = null) {
  const all = normalizeTitle(name).split(' ').filter(Boolean);
  // Palavra de 1-2 letras costuma ser ruído ("o", "de", "a"). Mas quando sobra
  // menos de dois tokens, ela É o título: aí vale mais que o ruído que evita.
  const long = all.filter((w) => w.length > 2);
  const wanted = long.length >= 2 ? long : all;
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

// Marcas de idioma da dublagem: descrevem o ÁUDIO, não qual obra é. Fora
// daqui, "… Dublado Portugues Brasil" vindo de tracker global media precisão
// 0 no matchesBrTitle (portugues/brasil fora de qualquer universo de nomes)
// e morria no filtro logo depois de ser classificado BR pelo título.
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

// Numeral por extenso/romano → dígito, para "Duna Parte Dois" e "Rocky II"
// casarem com "Duna Parte 2". "i" e "x" ficam de fora de propósito: sozinhos
// são artigo em inglês ("I Am Legend") e marca de resolução/multiplicação,
// não número de sequência.
// Onde o nome da obra termina: ruído técnico ou palavra de empacotamento.
const STOP_AT = new Set([...TECH_NOISE, ...PACK_WORDS]);

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

  const catalogYear = Number(String(year || '').match(/(?:19|20)\d{2}/)?.[0] || 0);
  if (catalogYear) {
    const years = own.filter((t) => /^(?:19|20)\d{2}$/.test(t)).map(Number);
    if (isSeries) {
      if (years.length && years.every((y) => y < catalogYear - 2)) return false;
    } else if (years.length === 1 && Math.abs(years[0] - catalogYear) > 2) {
      return false;
    }
  }
  return true;
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
          // Séries globais já usam identidade delimitada pelo marcador de
          // episódio; aplicar o prefixo de filme nelas mudaria formatos
          // legítimos como "S01E02.From" sem relação com este bug.
          (isSeries || matchesTitleStructure(title, name, year, { tokens })) &&
          matchesEpisodeWorkIdentity(title, names, tokens, universe),
    );
    if (!titleMatches) return false;
    if (season == null || episode == null) return true;
    return matchesEpisode(title, { season, episode });
  });
}

/**
 * Extrai temporada/episódio do título da release. Cobre os formatos que os
 * indexers usam de fato: "S01E04", "S01E01-E10", "1x04", "S01" (pack) e as
 * variações pt-BR dos sites BR ("1ª Temporada", "Temporada 1", "Episódio 4").
 *
 * O tipo de retorno trava o CONTRATO: acrescentar ou tirar campo daqui sem
 * mexer na interface vira erro na hora. Foi assim que `seasonPack` quebrou oito
 * `deepEqual` de uma vez — o teste só acusou depois de rodar a suíte inteira.
 */
function parseTitleSeasonEpisode(title = ''): ParsedSeasonEpisode {
  const raw = String(title);
  const t = normalizeTitle(title);
  const seasons = new Set<number>();
  const episodes = new Set<number>();

  // "s01e04", "s01 e04", "s01e01 e10" (intervalo), "s01e01e02"
  for (const m of t.matchAll(/s(\d{1,2})((?:\s?e\s?\d{1,3})+)/g)) {
    seasons.add(Number(m[1]));
    const eps = [...m[2].matchAll(/e\s?(\d{1,3})/g)].map((x) => Number(x[1]));
    if (eps.length >= 2) {
      // Intervalo ("E01-E10" chega como "e01 e10"): tudo entre o menor e o maior.
      const lo = Math.min(...eps);
      const hi = Math.max(...eps);
      for (let i = lo; i <= hi; i += 1) episodes.add(i);
    } else {
      eps.forEach((e) => episodes.add(e));
    }
  }

  // Trackers BR usam "T01 E004" e "T01E004". Lemos a sequência no título
  // cru porque a normalização apaga hífen: E001-E010 é intervalo, enquanto
  // E001 e E002, E001, E002 e E001 E010 são listas.
  for (const m of raw.matchAll(/(?:^|[^a-z0-9])t(\d{1,2})\s*e\s?(\d{1,3})/gi)) {
    seasons.add(Number(m[1]));
    const eps = [Number(m[2])];
    let cursor = m.index + m[0].length;
    let ranged = false;
    while (cursor < raw.length) {
      const next = raw.slice(cursor).match(/^(?:\s*([-–—])\s*|\s*(?:e|and)\s+|\s*,\s*|\s+)e\s?(\d{1,3})/i);
      if (!next) break;
      ranged ||= Boolean(next[1]);
      eps.push(Number(next[2]));
      cursor += next[0].length;
    }
    if (ranged) {
      const lo = Math.min(...eps);
      const hi = Math.max(...eps);
      for (let i = lo; i <= hi; i += 1) episodes.add(i);
    } else {
      eps.forEach((episode) => episodes.add(episode));
    }
  }

  // "1x04"
  for (const m of t.matchAll(/(\d{1,2})x(\d{1,3})/g)) {
    seasons.add(Number(m[1]));
    episodes.add(Number(m[2]));
  }

  // Faixa: "1ª até 8ª Temporada", "1 a 5 temporadas". Antes só o último número
  // era lido, então o pack de 1 a 8 não cobria o S01E01 que o usuário pediu.
  // `(?:\s*a)?` cobre o ordinal: o site escreve tanto "1ª até 8ª" (o ª vira
  // espaço na normalização) quanto "1a ate 8a" (o a fica colado no dígito).
  for (const m of t.matchAll(/(?<!\d)(\d{1,2})(?:\s*a)?\s*(?:ate|a)\s*(\d{1,2})(?!\d)(?:\s*a)?\s*temporadas?/g)) {
    const lo = Math.min(Number(m[1]), Number(m[2]));
    const hi = Math.max(Number(m[1]), Number(m[2]));
    // Faixa absurda é erro de leitura, não pack de 50 temporadas.
    if (hi - lo <= 30) for (let i = lo; i <= hi; i += 1) seasons.add(i);
  }

  // LISTA de ordinais antes de "Temporadas" no PLURAL: "1ª 2ª 3ª 4ª 5ª 6ª e 7ª
  // Temporadas". Só o último número encosta na palavra, então o padrão de
  // temporada única lia [7] sozinho e o pack inteiro sumia das seis primeiras.
  // Medido no hdrtorrent, em Game of Thrones: era o único falso corte numa
  // varredura de 3.794 títulos reais dos indexers BR.
  //
  // O plural é a âncora: no singular ("… e 7ª Temporada") o número colado é a
  // temporada do item, e os anteriores são outra coisa. `(?<![a-z0-9])` impede
  // que dígito preso a palavra técnica entre na conta ("DDP5 1 Atmos").
  for (const m of t.matchAll(/((?:(?<![a-z0-9])\d{1,2}\s+){2,}(?:e\s+)?(?<![a-z0-9])\d{1,2}\s+)temporadas/g)) {
    for (const num of m[1].match(/\d{1,2}/g) || []) {
      const season = Number(num);
      // Mesmo teto da faixa: número fora disso é ruído lido como temporada.
      if (season >= 1 && season <= 30) seasons.add(season);
    }
  }

  // Pack: "s01", "s01 s03" (multi-temporada), "season 1", "1 temporada", "temporada 1"
  for (const m of t.matchAll(/s(\d{1,2})(?![\de])/g)) seasons.add(Number(m[1]));
  // `(?!\d)` impede que o ANO logo depois vire temporada: "Temporada (2011)"
  // casava como temporada 20, pegando os dois primeiros dígitos.
  for (const m of t.matchAll(/(?:season|temporada)\s?(\d{1,2})(?!\d)/g)) seasons.add(Number(m[1]));
  for (const m of t.matchAll(/(?<!\d)(\d{1,2})(?!\d)\s?a?\s?temporada/g)) seasons.add(Number(m[1]));

  // Série inteira: "Todas as Temporadas", "Série Completa", "Temporadas
  // Completas" (plural). Sem isto o pack completo não declarava temporada
  // nenhuma e só sobrevivia pela brecha de "título sem pista nenhuma passa".
  const complete = /(?:todas?\s+(?:as\s+)?temporadas|serie\s+completa|temporadas\s+completas)/.test(t);
  // "2ª Temporada Completa" é pack da temporada nomeada, não da série inteira.
  // Tratar o singular como cobertura total fazia S01/S02 entrar no S04E06.
  const seasonPack = /temporada\s+completa/.test(t);

  // Episódio solto em pt-BR só conta quando a temporada já apareceu; senão
  // "Episódio II" de filme (Star Wars) viraria episódio de série.
  if (seasons.size && episodes.size === 0) {
    for (const m of t.matchAll(/epis[oó]dio\s?(\d{1,3})/g)) episodes.add(Number(m[1]));
    // Os resolvers BR titulam "1ª Temporada (2022) WEB-DL E02": o "e02" solto
    // é o episódio da release. Sem este parse, o E02 passava pelo filtro do
    // E01 e tomava as vagas reservadas BR. Fora do contexto de temporada o
    // "e" é conjunção ("Lilo e Stitch 2"), por isso a mesma trava do Episódio.
    const loose = [...t.matchAll(/(?<![a-z0-9])e(\d{1,3})(?![a-z0-9])/g)].map((m) => Number(m[1]));
    if (loose.length >= 2) {
      // "E01 a E10" é intervalo, como no formato SxxEyy acima.
      const lo = Math.min(...loose);
      const hi = Math.max(...loose);
      for (let i = lo; i <= hi; i += 1) episodes.add(i);
    } else {
      loose.forEach((e) => episodes.add(e));
    }
  }

  return { seasons: [...seasons], episodes: [...episodes], complete, seasonPack };
}

/**
 * O indexer devolve a temporada inteira quando a busca é por "Nome S01E01" —
 * sem este filtro a lista de E01 vinha recheada de E03, E04, E06, E09.
 * Pack de temporada (sem episódio no título) continua valendo: é dele que o
 * debrid tira o arquivo certo, e é o formato que as fontes BR publicam.
 *
 */
function matchesEpisode(title: string, { season, episode }: SeasonEpisodeOptions = {}) {
  if (season == null || episode == null) return true;
  const { seasons, episodes, complete } = parseTitleSeasonEpisode(title);

  // Série inteira cobre o episódio pedido. Pack de uma temporada não: quem
  // decide é a temporada que o título nomeia, no teste logo abaixo.
  if (complete && seasons.length === 0) return true;

  // Nenhuma pista de temporada/episódio: não dá pra afirmar que é errado
  // (release BR costuma vir só como "Nome Dublado"), então passa.
  if (seasons.length === 0 && episodes.length === 0) return true;

  if (seasons.length && !seasons.includes(season)) return false;
  if (episodes.length && !episodes.includes(episode)) return false;
  return true;
}

/**
 * Reescreve a linha do vencedor BR quando o perdedor traz metadados melhores.
 * Origem e áudio pertencem ao post vencedor; só o post BR pode aproveitar o
 * título scene do perdedor, porque ele costuma ser esparso nesses campos.
 *
 * Fonte e corte saem do mesmo texto, pela mesma razão do áudio: reconstruir sem
 * eles apagava o "BluRay"/"Extended" que o rótulo já mostrava, e duas releases
 * do mesmo filme voltavam a ficar indistinguíveis depois do merge. Vale nos
 * dois modos: em `full` o texto é a release, em `compact` é o resumo — que
 * carrega os mesmos termos.
 */
function relabel(stream: any, { isBr, dubbedFrom }: { isBr?: boolean; dubbedFrom?: any }) {
  const [title = '', stats = ''] = String(stream.name || '').split('\n');
  const seeders = Number(String(stats).match(/👤\s*(\d+)/)?.[1] || stream._seeders || 0);
  const borrowedTitle = isBr ? dubbedFrom : '';
  const audio = audioFromTitle(title) || audioFromTitle(borrowedTitle);
  return streamDisplayName({
    title,
    quality: stream._quality,
    audio,
    source: sourceFromTitle(title) || sourceFromTitle(borrowedTitle),
    edition: editionFromTitle(title) || editionFromTitle(borrowedTitle),
    tracker: stream._tracker,
    isBr,
    seeders,
  });
}

/** Mesma release aparece em vários indexers; fica a de maior seeders. */
function dedupeByHash(streams: any[], indexerPriority: string[] = []) {
  const best = new Map();
  const ranks = priorityMap(indexerPriority);
  for (const s of streams) {
    if (!s) continue;
    const prev = best.get(s.infoHash);
    if (!prev) {
      best.set(s.infoHash, s);
      continue;
    }
    // Agregadores BR espelham magnets públicos: mesma hash não prova que o
    // arquivo global tenha áudio PT. Origem e áudio ficam com o post vencedor.
    const seedDiff = (s._seeders || 0) - (prev._seeders || 0);
    // Hash idêntico é a mesma release. Seeders continuam sendo a evidência
    // principal; no empate, a listagem com áudio PT declarado vence — é a
    // única informação que o espelho em inglês não carrega, e a varredura
    // pt-BR devolve justamente esse título para o MESMO hash. Sem o critério,
    // o merge ficava com a chegada mais antiga e o _br sumia junto.
    // Persistindo o empate, a preferência do usuário torna o merge estável.
    let winner;
    if (seedDiff > 0) winner = s;
    else if (seedDiff < 0) winner = prev;
    else if (Boolean(s._dubbed) !== Boolean(prev._dubbed)) winner = s._dubbed ? s : prev;
    else winner = compareIndexerPriority(s, prev, ranks) < 0 ? s : prev;
    const loser = winner === s ? prev : s;
    // O indexer BR priorizado pode omitir resolução/tamanho enquanto o global
    // traz metadados completos para o mesmo hash. A prioridade escolhe o rótulo
    // e a origem, mas não deve degradar cota, bingeGroup ou tamanho conhecido.
    const richerQuality = winner._quality === UNKNOWN_QUALITY && loser._quality !== UNKNOWN_QUALITY
      ? loser
      : winner;
    const merged = {
      ...winner,
      _quality: richerQuality._quality,
      _size: winner._size || loser._size || 0,
      behaviorHints: richerQuality.behaviorHints || winner.behaviorHints,
      _br: winner._br,
      _dubbed: winner._dubbed,
      _tracker: winner._tracker,
      // Hash idêntico tem o mesmo conteúdo: se QUALQUER listagem marcou como
      // pack, a marca precisa sobreviver ao merge — senão o perdedor BR com
      // título de coleção perderia o estrito para o vencedor EN sem marca.
      _multiWork: Boolean(winner._multiWork || loser._multiWork),
    };
    if (merged._quality !== winner._quality) {
      merged.name = relabel(merged, {
        isBr: winner._br,
        dubbedFrom: winner._br ? String(loser.name || '').split('\n')[0] : '',
      });
    }
    best.set(s.infoHash, merged);
  }
  return [...best.values()];
}

const QUALITY_KEYS = ['2160p', '1080p', '720p', '480p', 'SD', UNKNOWN_QUALITY];

function streamQuality(stream: any) {
  return stream?._quality || qualityFromTitle(stream?.title || stream?.name || '');
}

/**
 * Separa espaço no pool pré-debrid para cada qualidade configurada. Sem isso,
 * centenas de 4K poderiam ocupar o pool inteiro e impedir que a cota pedida de
 * 1080p tivesse candidatos para sobreviver ao filtro de cache.
 */
function selectQualityCandidates(
  streams: any[],
  {
    maxResults = 40,
    qualityLimits = {} as Record<string, any>,
    brReservedSlots = 0,
    candidateFactor = 1,
    brFirst = true,
    indexerPriority = [],
  } = {},
) {
  const poolSize = Math.max(0, Math.trunc(maxResults));
  const custom = QUALITY_KEYS.filter((quality: string) => Number(qualityLimits[quality]) < 100);
  const customSet = new Set(custom);
  // Os mapas abaixo são populados para TODA qualidade de `custom` na criação,
  // então `.get(quality)` nunca devolve undefined quando `quality` pertence a
  // `custom`. O strictNullChecks não enxerga esse invariante; os casts
  // documentam a garantia sem mudar runtime.
  const buckets = new Map<string, Stream[]>(custom.map((quality) => [quality, []]));
  for (const stream of streams) {
    const bucket = buckets.get(streamQuality(stream));
    if (bucket) bucket.push(stream);
  }

  const selected = new Set();
  const positions = new Map<string, number>(custom.map((quality) => [quality, 0]));
  const counts = new Map<string, number>(custom.map((quality) => [quality, 0]));
  const factor = Math.max(1, Math.trunc(candidateFactor));
  const targets = new Map<string, number>(
    custom.map((quality) => [
      quality,
      Math.max(0, Math.trunc(Number(qualityLimits[quality]) || 0)) * factor,
    ]),
  );

  // A reserva precisa existir também quando a qualidade está em 100. Se os BR
  // forem considerados só no corte final, seeders globais podem preencher o
  // pool ampliado antes deles chegarem ao debrid.
  const brTarget = brFirst ? poolSize : brReservedSlots;
  for (const stream of streams) {
    if (selected.size >= poolSize || selected.size >= brTarget) break;
    if (!stream._br) continue;
    const quality = streamQuality(stream);
    if (customSet.has(quality) &&
      (counts.get(quality) as number) >= (targets.get(quality) as number)) continue;
    selected.add(stream);
    if (customSet.has(quality)) counts.set(quality, (counts.get(quality) as number) + 1);
  }

  // Round-robin evita que a primeira qualidade consuma todo o pool quando a
  // soma das cotas configuradas ultrapassa o máximo global.
  let progressed = true;
  while (selected.size < poolSize && progressed) {
    progressed = false;
    for (const quality of custom) {
      const bucket = buckets.get(quality) as Stream[];
      let position = positions.get(quality) as number;
      while (position < bucket.length && selected.has(bucket[position])) position += 1;
      positions.set(quality, position);
      if ((counts.get(quality) as number) >= (targets.get(quality) as number) ||
        position >= bucket.length) continue;
      selected.add(bucket[position]);
      positions.set(quality, position + 1);
      counts.set(quality, (counts.get(quality) as number) + 1);
      progressed = true;
      if (selected.size >= poolSize) break;
    }
  }

  // Qualidades em 100 são ilimitadas e preenchem o espaço restante sem tomar
  // as vagas já separadas para as cotas explícitas.
  for (const stream of streams) {
    if (selected.size >= poolSize) break;
    if (selected.has(stream)) continue;
    if (customSet.has(streamQuality(stream))) continue;
    selected.add(stream);
  }

  // A seleção reserva espaço, mas a ordem original de qualidade/seeders segue
  // intacta para a listagem e para o debrid.
  return streams.filter((stream: any) => selected.has(stream));
}

/**
 * Cota por indexador: teto de quantos streams cada fonte (YTS, BluDV, TheRARBG…)
 * pode ocupar na lista final. Sem isso um indexador com muitos resultados leva
 * quase todas as vagas e as outras fontes somem.
 *
 * `0` é SEM LIMITE, não "nenhum" — ao contrário das cotas por qualidade. Aqui o
 * default é desligado, e um 0 herdado de config antiga zerando a lista inteira
 * seria bem pior que um teto que não pega.
 *
 * `exempt` são as vagas reservadas BR: elas passam mesmo acima da cota, mas
 * continuam contando. Assim a reserva fura o teto sem ampliá-lo para os itens
 * seguintes da mesma fonte.
 */
function limitByIndexer(streams: any[], maxPerIndexer = 0, exempt: Set<any> = new Set(), indexerLimits: Record<string, any> = {}) {
  const globalLimit = Math.max(0, Math.trunc(Number(maxPerIndexer) || 0));
  const hasOverrides = indexerLimits && typeof indexerLimits === 'object' &&
    Object.keys(indexerLimits).length > 0;
  if (!globalLimit && !hasOverrides) return streams;
  const counts = new Map();
  return streams.filter((stream: any) => {
    // Stream sem indexador conhecido não vira um balde comum com os outros:
    // eles se limitariam entre si por acidente de metadado ausente.
    const source = String(stream?._indexer || '').trim().toLowerCase();
    if (!source) return true;
    const ownLimit = Object.prototype.hasOwnProperty.call(indexerLimits, source)
      ? Math.max(0, Math.trunc(Number(indexerLimits[source]) || 0))
      : globalLimit;
    const count = counts.get(source) || 0;
    // A vaga reservada ESTOURA o teto, mas continua contando: se ela não
    // contasse, uma reserva de 2 com cota 1 deixaria passar um terceiro stream
    // da mesma fonte — a reserva ampliaria a cota em vez de só furá-la.
    if (exempt.has(stream)) {
      counts.set(source, count + 1);
      return true;
    }
    if (ownLimit && count >= ownLimit) return false;
    counts.set(source, count + 1);
    return true;
  });
}

/**
 * Aplica as duas cotas numa passada só. Se a cota individual rejeitar um item,
 * ele não pode consumir a vaga de qualidade — outra fonte precisa poder fazer
 * o backfill da lista final.
 */
function limitByQualityAndIndexer(
  streams: any[],
  qualityLimits: Record<string, any>,
  maxPerIndexer: number,
  exempt: Set<any>,
  indexerLimits: Record<string, any>,
) {
  const qualityCounts = new Map();
  const indexerCounts = new Map();
  const globalLimit = Math.max(0, Math.trunc(Number(maxPerIndexer) || 0));

  return streams.filter((stream: any) => {
    const quality = streamQuality(stream);
    const rawQualityLimit = qualityLimits[quality];
    const qualityLimit = rawQualityLimit == null || rawQualityLimit >= 100
      ? Infinity
      : Math.max(0, Math.trunc(rawQualityLimit));
    const qualityCount = qualityCounts.get(quality) || 0;
    if (qualityCount >= qualityLimit) return false;

    const source = String(stream?._indexer || '').trim().toLowerCase();
    const sourceCount = source ? indexerCounts.get(source) || 0 : 0;
    const sourceLimit = source && Object.prototype.hasOwnProperty.call(indexerLimits, source)
      ? Math.max(0, Math.trunc(Number(indexerLimits[source]) || 0))
      : globalLimit;
    if (source && !exempt.has(stream) && sourceLimit && sourceCount >= sourceLimit) return false;

    qualityCounts.set(quality, qualityCount + 1);
    if (source) indexerCounts.set(source, sourceCount + 1);
    return true;
  });
}

/** Aplica as cotas na lista pós-debrid, quando só os streams reais são contados. */
function limitByQuality(streams: any[], qualityLimits: Record<string, any> = {}) {
  const counts = new Map();
  return streams.filter((stream: any) => {
    const quality = streamQuality(stream);
    const rawLimit = qualityLimits[quality];
    const limit = rawLimit == null || rawLimit >= 100 ? Infinity : Math.max(0, Math.trunc(rawLimit));
    const count = counts.get(quality) || 0;
    if (count >= limit) return false;
    counts.set(quality, count + 1);
    return true;
  });
}

/**
 * A release cobre a temporada inteira pedida? ("S01", "1ª Temporada",
 * "Série Completa"/"Todas as Temporadas"). Em busca de série o autofetch
 * prefere pack a episódio avulso: um download serve o binge todo.
 */
function isSeasonPackRelease(stream: any, season: number | null) {
  if (season == null || !stream) return false;
  const { seasons, episodes, complete, seasonPack } = parseTitleSeasonEpisode(stream.title || stream.name || '');
  if (complete && !seasons.length) return true;
  if (episodes.length) return false;
  if (seasons.length) return seasons.includes(season);
  // Sem número no título, a busca que trouxe o item era da temporada pedida.
  return seasonPack;
}

// Peso de resolução dos pools de autofetch (BR e global): 1080p/720p vencem
// 2160p porque o download esquenta o cache para o play rápido, não para baixar
// o maior arquivo; SD fica por último.
const DUBBED_QUALITY_WEIGHT: Record<string, number> = {
  '1080p': 6,
  '720p': 5,
  '2160p': 4,
  [UNKNOWN_QUALITY]: 3,
  '480p': 2,
  SD: 1,
};

/**
 * O que mandar o debrid baixar quando NÃO existe fonte BR dublada tocável.
 * `null` = não faça nada, e é o retorno na maioria das buscas.
 *
 * Cuidado deliberado aqui, porque o efeito é escrever na conta do usuário:
 * - só olha o que tem infoHash (stream já resolvido não tem o que enfileirar);
 * - se QUALQUER candidato BR já está em cache, não baixa nada — já dá play;
 * - `streams` chega ordenado, então o primeiro é o melhor candidato;
 * - BR sem marca de áudio no título entra como dublado só quando nenhum
 *   candidato tiver a marca: é o padrão dos sites BR ("Nome (2026) [opção 3]"),
 *   mas um "LEGENDADO" explícito nunca é tratado como dublado.
 *
 */
function brDubbedPool(streams: Stream[] = [], { season }: PoolsOptions = {}) {
  const br = streams.filter(
    (s) => s && s.infoHash && s._br && sourceFromTitle(s.title || s.name || '') !== 'CAM',
  );
  if (br.length === 0) return [];
  const tagged = br.filter((s) => s._dubbed);
  const candidates = tagged.length
    ? tagged
    : br.filter((s) => audioFromTitle(s.title || s.name || '') !== 'Legendado');

  // Pré-computado uma vez: o sort consultaria o mesmo parse n·log n vezes.
  const packOf = season == null
    ? null
    : new Map(candidates.map((s) => [s, isSeasonPackRelease(s, season)]));

  return [...candidates].sort((a, b) => {
    // 1. Quem tem marcação explícita de dublado/dual/nacional
    const dubDiff = (b._dubbed ? 1 : 0) - (a._dubbed ? 1 : 0);
    if (dubDiff !== 0) return dubDiff;

    // 2. Pack da temporada pedida (só em busca de série): um download serve o
    // binge inteiro em vez de um episódio, e vale mais que resolução/seeders.
    if (packOf) {
      const packDiff = (packOf.get(b) ? 1 : 0) - (packOf.get(a) ? 1 : 0);
      if (packDiff !== 0) return packDiff;
    }

    // 3. Resolução ideal para download e playback rápido
    const qA = streamQuality(a);
    const qB = streamQuality(b);
    const qDiff = (DUBBED_QUALITY_WEIGHT[qB] || 0) - (DUBBED_QUALITY_WEIGHT[qA] || 0);
    if (qDiff !== 0) return qDiff;

    // 4. Mais seeders para o debrid baixar o torrent rapidamente
    return (b._seeders || 0) - (a._seeders || 0);
  });
}

/**
 * Pool do fallback global do autofetch: quando a busca não achou NENHUMA fonte
 * BR dublada, o que resta baixar são as releases com áudio dublado/dual/
 * nacional marcado no título (`_dubbed`). Sem a marca não entra — fora dos
 * sites BR o padrão é o contrário, legendado domina, e o fallback "sem marca
 * vale como dublado" do pool BR encheria a conta com o que o usuário não
 * pediu. (BR elegível aqui é impossível na prática: se existisse, o pool BR
 * já teria sido escolhido no lugar deste.)
 *
 */
function anyDubbedPool(streams: Stream[] = [], { season }: PoolsOptions = {}) {
  const candidates = streams.filter(
    (s) => s && s.infoHash && s._dubbed && sourceFromTitle(s.title || s.name || '') !== 'CAM',
  );
  // Mesmo bônus de pack do pool BR, pré-computado para o sort.
  const packOf = season == null
    ? null
    : new Map(candidates.map((s) => [s, isSeasonPackRelease(s, season)]));
  return [...candidates].sort((a, b) => {
    if (packOf) {
      const packDiff = (packOf.get(b) ? 1 : 0) - (packOf.get(a) ? 1 : 0);
      if (packDiff !== 0) return packDiff;
    }
    const qDiff =
      (DUBBED_QUALITY_WEIGHT[streamQuality(b)] || 0) - (DUBBED_QUALITY_WEIGHT[streamQuality(a)] || 0);
    if (qDiff !== 0) return qDiff;
    return (b._seeders || 0) - (a._seeders || 0);
  });
}

/**
 * Pool de segurança: prioriza o swarm, não a resolução, para o download terminar.
 *
 */
function topSeededPool(streams: Stream[] = [], { season, minSeeders = 0 }: PoolsOptions = {}) {
  const seedersOf = (s: any) => Number(s?._seeders ?? (String(s?.name || '').match(/👤\s*(\d+)/)?.[1] || 0));
  const candidates = streams.filter((s) =>
    s && s.infoHash && sourceFromTitle(s.title || s.name || '') !== 'CAM' &&
    seedersOf(s) >= minSeeders && !hasExplicitForeignAudio(s.title || s.name || ''),
  );
  const packOf = season == null ? null : new Map(candidates.map((s) => [s, isSeasonPackRelease(s, season)]));
  return [...candidates].sort((a, b) => {
    if (packOf) {
      const packDiff = (packOf.get(b) ? 1 : 0) - (packOf.get(a) ? 1 : 0);
      if (packDiff) return packDiff;
    }
    const seedDiff = seedersOf(b) - seedersOf(a);
    if (seedDiff) return seedDiff;
    return (DUBBED_QUALITY_WEIGHT[streamQuality(b)] || 0) - (DUBBED_QUALITY_WEIGHT[streamQuality(a)] || 0);
  });
}

/**
 * Set de hashes comparável com `stream.infoHash`.
 *
 * O conjunto de cacheados é sempre minúsculo (debrid/index.js normaliza na ida,
 * os adapters na volta), mas o infoHash do stream vem cru do Jackett — e o
 * Torznab devolve o btih em MAIÚSCULO. Comparar os dois direto erra silencioso:
 * o hash cacheado não é reconhecido e o autofetch baixa o que já estava pronto.
 */
function hashSet(hashes: Iterable<string> | null | undefined) {
  return new Set([...(hashes || [])].map((h) => String(h || '').toLowerCase()).filter(Boolean));
}

/**
 * Seleciona até `limit` candidatos de um pool JÁ ordenado (a ordem é a
 * prioridade), sem olhar cache:
 *
 * - dedupe de hash case-insensitive (indexers BR às vezes alternam a caixa do
 *   btih entre os posts que duplicam a mesma release);
 * - pula hashes já em cache — não há o que baixar para eles;
 * - no máximo `limit` candidatos.
 */
function pickFromPool(pool: Stream[] = [], cachedHashes: Set<string> = new Set(), limit = 1) {
  const max = Math.max(0, Math.trunc(Number(limit) || 0));
  if (max === 0) return [];
  const cached = hashSet(cachedHashes);
  const seen = new Set();
  const out: Stream[] = [];
  for (const stream of pool) {
    if (!stream || !stream.infoHash) continue;
    const key = String(stream.infoHash).toLowerCase();
    if (seen.has(key) || cached.has(key)) continue;
    seen.add(key);
    out.push(stream);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Melhores candidatos BR dublados para o autofetch: o pool brDubbedPool já
 * ordena por marca de áudio, resolução e seeders.
 */
function pickBrDubbedCandidates(streams: Stream[] = [], cachedHashes: Set<string> = new Set(), limit = 1, options: PoolsOptions = {}) {
  return pickFromPool(brDubbedPool(streams, options), cachedHashes, limit);
}

/** Compatibilidade: o melhor candidato BR dublado, sem olhar cache. */
function pickBrDubbedCandidate(streams: Stream[] = [], cachedHashes: Set<string> = new Set()) {
  return pickBrDubbedCandidates(streams, cachedHashes, 1)[0] || null;
}

/** Candidatos do fallback global: mesmas regras do pick BR, sobre anyDubbedPool. */
function pickAnyDubbedCandidates(streams: Stream[] = [], cachedHashes: Set<string> = new Set(), limit = 1, options: PoolsOptions = {}) {
  return pickFromPool(anyDubbedPool(streams, options), cachedHashes, limit);
}

function pickTopSeededCandidates(streams: Stream[] = [], cachedHashes: Set<string> = new Set(), limit = 1, options: PoolsOptions = {}) {
  return pickFromPool(topSeededPool(streams, options), cachedHashes, limit);
}

/** Já existe fonte BR dublada tocável na hora? Então não há o que baixar. */
function hasCachedBrDubbed(streams: Stream[] = [], cachedHashes: Set<string> = new Set()) {
  const cached = hashSet(cachedHashes);
  return brDubbedPool(streams).some((s) => cached.has(String(s.infoHash || '').toLowerCase()));
}

function canAutoFetchBr({ autoFetchBr }: AutofetchOptions = {}, adapter?: DebridAdapter | null) {
  // cachedOnly não é mais trava: o objetivo do autofetch é justamente esquentar
  // o cache quando não há BR dublada pronta, independente do modo. As travas
  // reais são o toggle, o cacheCheck confiável ou fonte de autofetch por inventário (RD/DL).
  return Boolean(autoFetchBr && (adapter?.cacheCheck || adapter?.autofetchSource));
}

/**
 * Exceção explícita ao cachedOnly: as fontes globais continuam instantâneas,
 * mas as vagas reservadas BR não viram um vazio quando o dublado ainda não
 * chegou ao debrid. O stream fica como torrent P2P, sem selo ⚡.
 */
function uncachedBrHashes(streams: Stream[] = [], cachedHashes: Set<string> = new Set(), limit = 0) {
  const selected = new Set();
  const max = Math.max(0, Math.trunc(Number(limit) || 0));
  // Mesmo pool do autofetch: a vaga P2P tem que ser o torrent que vamos baixar,
  // não um LEGENDADO que só estava mais acima na lista.
  for (const stream of brDubbedPool(streams)) {
    if (selected.size >= max) break;
    if (!cachedHashes.has(String(stream.infoHash))) selected.add(String(stream.infoHash));
  }
  return selected;
}

function filterKnownCache(streams: Stream[] = [], cachedHashes: Set<string> = new Set(), {
  cachedOnly = true,
  showUncachedBr = false,
  brReservedSlots = 0,
} = {}) {
  const cachedBr = brDubbedPool(streams).filter((stream) =>
    cachedHashes.has(String(stream.infoHash)),
  ).length;
  const uncachedSlots = Math.max(0, Math.trunc(Number(brReservedSlots) || 0) - cachedBr);
  const visibleBr = cachedOnly && showUncachedBr
    ? uncachedBrHashes(streams, cachedHashes, uncachedSlots)
    : new Set();
  return {
    visibleBr,
    streams: streams.filter((stream) =>
      cachedHashes.has(String(stream.infoHash)) || !cachedOnly || visibleBr.has(String(stream.infoHash)),
    ),
  };
}

/** Reserva origem BR, aplica as cotas finais e remove todos os campos internos. */
function limitReservingBr(
  streams: Stream[],
  {
    brReservedSlots = 0,
    maxResults = 40,
    brOnly = false,
    qualityLimits = {},
    brFirst = true,
    maxPerIndexer = 0,
    indexerLimits = {},
  } = {},
) {
  const pool = brOnly ? streams.filter((stream) => stream._br) : streams;

  // As cotas por qualidade contam as fontes BR ANTES das globais. Elas publicam
  // seeders=1, então chegam aqui no fim do próprio balde; com cota apertada
  // (max1080p=3) as três globais mais semeadas levavam as vagas e a fonte BR
  // era cortada AQUI — antes de `brFirst`/`brReservedSlots` terem chance de
  // agir. `selectQualityCandidates` já faz essa passada BR no pool pré-debrid;
  // sem o mesmo cuidado no corte final, a reserva não valia nada.
  const reserved = brFirst ? Infinity : Math.max(0, Math.trunc(Number(brReservedSlots) || 0));
  const priority = pool
    .filter((stream) => stream._br)
    .sort((a, b) => (b._dubbed ? 1 : 0) - (a._dubbed ? 1 : 0))
    .slice(0, reserved);
  const prioritized = new Set(priority);
  // A isenção da cota por indexador é o TAMANHO DA RESERVA, não todo o pool BR:
  // com brFirst (default) `priority` é o BR inteiro, e isentá-lo por completo
  // deixaria o indexador BR sem teto nenhum — o oposto do que a cota faz.
  // Mesmo critério da reserva mais abaixo (`brStreams.slice`): `_br` puro. O
  // pool dublado exige infoHash, que um stream já resolvido no debrid não tem —
  // usá-lo aqui esvaziaria a isenção justamente na lista com play instantâneo.
  const brSlots = Math.max(0, Math.trunc(Number(brReservedSlots) || 0));
  const exemptFromIndexerQuota = new Set(
    pool
      .filter((stream) => stream._br)
      .sort((a, b) => (b._dubbed ? 1 : 0) - (a._dubbed ? 1 : 0))
      .slice(0, brSlots),
  );
  const kept = new Set(
    limitByQualityAndIndexer(
      [...priority, ...pool.filter((stream) => !prioritized.has(stream))],
      qualityLimits,
      maxPerIndexer,
      exemptFromIndexerQuota,
      indexerLimits,
    ),
  );
  // Volta à ordem original: sem `brFirst` o corte final depende dela.
  const eligible = pool.filter((stream) => kept.has(stream));
  const brStreams = eligible
    .filter((stream) => stream._br)
    .sort((a, b) => (b._dubbed ? 1 : 0) - (a._dubbed ? 1 : 0));
  let selected;

  if (brFirst) {
    selected = [...brStreams, ...eligible.filter((stream) => !stream._br)].slice(0, maxResults);
  } else {
    // Sem prioridade visual, as vagas continuam garantidas: entram no lugar
    // dos últimos globais e preservam sua posição natural na ordem original.
    const reserved = brStreams.slice(0, brReservedSlots);
    const chosen = new Set(eligible.slice(0, maxResults));
    for (const stream of reserved) {
      if (chosen.has(stream)) continue;
      const replace = [...chosen].reverse().find((item) => !item._br);
      if (replace) chosen.delete(replace);
      if (chosen.size < maxResults) chosen.add(stream);
    }
    selected = eligible.filter((stream) => chosen.has(stream)).slice(0, maxResults);
  }

  return selected
    .map(({ _br, _seeders, _quality, _size, _dubbed, _indexer, _tracker, _multiWork, ...stream }) => stream);
}

function sortAndLimit(
  streams: (Stream | null)[],
  {
    minSeeders = 0,
    maxResults = 40,
    qualityFilter = [],
    season = null,
    episode = null,
    preferDubbed = false,
    excludeCam = false,
    maxSizeGb = 0,
    qualityLimits = {},
    brReservedSlots = 0,
    candidateFactor = 1,
    brFirst = true,
    indexerPriority = [],
    instant = null as null | ((hash: string) => boolean),
  } = {},
) {
  // Release que nomeia o episódio pedido vem antes do pack da temporada: o pack
  // serve, mas quem pediu o E01 quer ver o E01 no topo da lista.
  // O marcador é estático por stream; o comparador o lia via
  // parseTitleSeasonEpisode a cada comparação (~n·log n parses do mesmo
  // título), então ele é pré-computado uma vez antes do sort.
  const dubbed = (s: any) => (s._dubbed ? 1 : 0);
  const maxSizeBytes = maxSizeGb > 0 ? maxSizeGb * 1024 ** 3 : 0;
  const indexerRanks = priorityMap(indexerPriority);

  const candidates = dedupeByHash(streams, indexerPriority)
    .filter((s) => (s._seeders || 0) >= minSeeders)
    .filter((s) => passesQualityFilter(s, qualityFilter, qualityLimits))
    .filter((s) => !excludeCam || sourceFromTitle(s.title) !== 'CAM')
    // Tamanho ausente não é tratado como zero real: sem dado confiável, o
    // stream continua visível em vez de ser descartado silenciosamente.
    .filter((s) => !maxSizeBytes || !s._size || s._size <= maxSizeBytes);

  const exactFlag = new Map();
  if (season != null && episode != null) {
    for (const s of candidates) {
      exactFlag.set(s, parseTitleSeasonEpisode(s.title).episodes.includes(episode) ? 1 : 0);
    }
  }

  const ordered = candidates
    .sort((a, b) => {
      const ed = (exactFlag.get(b) || 0) - (exactFlag.get(a) || 0);
      if (ed !== 0) return ed;
      // Sem resolução fica acima do SD e abaixo do 720p: é quase sempre um
      // WEB-DL BR que não anuncia resolução, não uma cópia ruim.
      const qOrder: Record<string, number> = { '2160p': 5, '1080p': 4, '720p': 3, [UNKNOWN_QUALITY]: 2, '480p': 1, SD: 0 };
      const qd = (qOrder[b._quality] || 0) - (qOrder[a._quality] || 0);
      if (qd !== 0) return qd;
      if (preferDubbed) {
        const ad = dubbed(b) - dubbed(a);
        if (ad !== 0) return ad;
      }
      // "Priorizar dublado" é uma escolha explícita mais específica que a
      // fonte preferida. Depois dela, o indexador desempata sem vencer qualidade.
      const pd = compareIndexerPriority(a, b, indexerRanks);
      if (pd !== 0) return pd;
      // Histórico durável do banco de magnets: hash que o debrid comprovou
      // como play instantâneo vence a aposta de seeders — evidência medida
      // contra probabilidade.
      if (instant) {
        const hd = (instant(b.infoHash) ? 1 : 0) - (instant(a.infoHash) ? 1 : 0);
        if (hd !== 0) return hd;
      }
      return (b._seeders || 0) - (a._seeders || 0);
    });

  return selectQualityCandidates(ordered, {
    maxResults,
    qualityLimits,
    brReservedSlots,
    candidateFactor,
    brFirst,
  })
    // `_quality` e `_br` precisam sobreviver ao debrid: as cotas e a reserva
    // são aplicadas só depois que cachedOnly remove os streams indisponíveis.
    // `_dubbed` também precisa chegar ao autofetch: sem ele uma fonte BR sem
    // marca de áudio venceria mesmo quando existe uma explicitamente dublada.
    // `_indexer` idem, para a cota por indexador do corte final; quem apaga
    // todos os campos internos é `limitReservingBr`.
    .map(({ _seeders, _size, ...rest }: any) => rest);
}

/**
 * De onde saem o nome da busca e os nomes do filtro. Uma função só porque os
 * três pontos que precisam disso (query principal, pack de temporada e o corte
 * por título) tinham que concordar — e não concordavam.
 *
 * O Cinemeta é a fonte preferida, mas ele não conhece todo id: título obscuro,
 * regional ou lançamento recente demais volta 404. Quando isso acontecia:
 *
 * - a query virava a string crua "tt1234567", mesmo com o TMDB (outra API) já
 *   tendo respondido com o nome;
 * - o filtro de título, preso a `meta?.name`, se desligava por inteiro e
 *   qualquer lixo que o indexador devolvesse ia direto pro usuário.
 *
 * `name` prefere o título ORIGINAL: é o que os indexadores globais publicam.
 * O pt-BR tem query própria (`ptQuery`) e entra em `names` de qualquer forma.
 *
 */
function resolveSearchNames({ meta, titles, imdbId }: SearchNamesOptions = {}): {
  name: string;
  year: number | string | null;
  names: string[];
} {
  const fallback = titles?.original || titles?.pt;
  return {
    name: meta?.name || fallback || imdbId || '',
    year: meta?.year || titles?.year || null,
    // `.filter(Boolean)` remove null/undefined/'' do array de nome; o cast
    // torna explícito o que o filtro já garante no runtime (só strings não
    // vazias sobram) para o consumidor `matchContext.names: string[]`.
    names: [meta?.name, titles?.pt, titles?.original].filter(Boolean) as string[],
  };
}

function parseStremioId(id: string) {
  // movie: tt1234567 | series: tt1234567:1:2
  const parts = String(id).split(':');
  return {
    imdbId: parts[0],
    season: parts[1] ? Number(parts[1]) : null,
    episode: parts[2] ? Number(parts[2]) : null,
  };
}

function buildSearchQuery(
  meta: { name?: string | null; title?: string | null; year?: number | string | null } | null | undefined,
  { season, episode }: SeasonEpisodeOptions = {},
) {
  const name = meta?.name || meta?.title || '';
  const year = meta?.year ? String(meta.year).slice(0, 4) : '';
  if (season != null && episode != null) {
    const s = String(season).padStart(2, '0');
    const e = String(episode).padStart(2, '0');
    return `${name} S${s}E${e}`.trim();
  }
  return [name, year].filter(Boolean).join(' ').trim();
}

// Romanos canônicos de sequência (2..9) → numeral arábico, para a segunda
// tentativa de busca dos indexers BR. Um filme numerado costuma sair do TMDB em
// romano ("Jornada nas Estrelas II") MAS os sites BR ora grafam romano, ora
// arábico ("... 2 ..."); o WordPress casa com o texto literal, então a grafia
// única perdia a metade dos releases.
//
// Regras de segurança, calibradas contra casos reais:
// - no máximo UMA variante: dois ou mais numerais convertíveis ("Rocky II:
//   Parte IV") são ambíguos e devolvem null — trocar um e deixar o outro
//   inventaria um filme que não existe;
// - "I" e "X" isolados ficam de fora: "i" é artigo em inglês ("I Am Legend") e
//   "x" marca resolução/multiplicação, e os dois estão fora da faixa II..IX;
// - números já em arábico (Apollo 13, District 9, 1917) não casam com o padrão
//   romano e passam intactos;
// - pontuação colada ("II:", "II.") é preservada — troca-se só o numeral, e o
//   ano e o SxxEyy não tocam o padrão romano (são dígitos).
const ROMAN_SEQUENCE_NUMERAL =
  /(?<![\p{L}\p{N}])(?:VIII|VII|IV|III|IX|VI|II|V)(?![\p{L}\p{N}])/gu;
const ROMAN_SEQUENCE_VALUE: Record<string, number> = { viii: 8, vii: 7, vi: 6, v: 5, iv: 4, iii: 3, ix: 9, ii: 2 };

function numeralSearchVariant(query: string) {
  const raw = String(query || '');
  const matches = [...raw.matchAll(ROMAN_SEQUENCE_NUMERAL)];
  if (matches.length !== 1) return null;
  const m = matches[0];
  // O numeral precisa vir depois do nome-base da obra. Assim "Rocky V" e
  // "Jornada nas Estrelas II" geram variante, mas "V de Vingança" (inclusive
  // com artigo inicial) não vira a consulta inventada "5 de Vingança".
  const prefixTokens = normalizeTitle(raw.slice(0, m.index)).split(' ').filter(Boolean);
  if (!prefixTokens.some((token) => !LEADING_ARTICLES.has(token))) return null;
  const digit = ROMAN_SEQUENCE_VALUE[m[0].toLowerCase()];
  return raw.slice(0, m.index) + digit + raw.slice(m.index + m[0].length);
}

export {
  TRACKERS,
  UNKNOWN_QUALITY,
  QUALITY_KEYS,
  bytesToSize,
  extractInfoHash,
  qualityFromTitle,
  sourceFromTitle,
  audioFromTitle,
  explicitPtAudio,
  editionFromTitle,
  streamDisplayName,
  markDebridName,
  toStremioStream,
  sortAndLimit,
  parseStremioId,
  resolveSearchNames,
  buildSearchQuery,
  numeralSearchVariant,
  matchesQualityFilter,
  passesQualityFilter,
  matchesName,
  matchesBrTitle,
  filterRelevantRaw,
  filterInventoryRelevant,
  franchiseRoot,
  franchiseRoots,
  containsTokenRun,
  matchesEpisode,
  parseTitleSeasonEpisode,
  isSeasonPackRelease,
  dedupeByHash,
  selectQualityCandidates,
  limitByQuality,
  limitByIndexer,
  limitReservingBr,
  pickBrDubbedCandidate,
  pickBrDubbedCandidates,
  pickAnyDubbedCandidates,
  pickTopSeededCandidates,
  topSeededPool,
  hasExplicitForeignAudio,
  hasCachedBrDubbed,
  canAutoFetchBr,
  uncachedBrHashes,
  filterKnownCache,
  normalizeTitle,
  decodeEntities,
  looksPtBr,
  isMultiWorkCollection,
};
