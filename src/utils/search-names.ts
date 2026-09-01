import config from '../config.js';
import { opts } from '../runtime.js';
import type { RawItem, Stream, StreamCandidate } from '../../types/domain.js';
import { extractInfoHash, decodeEntities, bytesToSize, normalizeTitle } from './title-normalization.js';
import { LEADING_ARTICLES, isMultiWorkCollection } from './release-matching.js';
import {
  UNKNOWN_QUALITY,
  qualityFromTitle,
  sourceFromTitle,
  audioFromTitle,
  editionFromTitle,
  explicitPtAudio,
  looksPtBr,
  compactAudio,
  compactTracker,
} from './audio-quality.js';
import { streamQuality } from './stream-quotas.js';

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

const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
];

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
  style,
  showSource,
}: StreamDisplayOptions = {}) {
  let userOpts: { streamNameStyle?: string; streamNameShowSource?: boolean } | null = null;
  try { userOpts = opts(); } catch {}
  const effectiveStyle = style || userOpts?.streamNameStyle || config.streamNameStyle;
  const effectiveShowSource = showSource !== undefined
    ? showSource
    : (userOpts?.streamNameShowSource !== undefined ? userOpts.streamNameShowSource : config.streamNameShowSource);

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
    effectiveShowSource ? compactTracker(tracker) : null,
    Number(seeders) > 0 ? `👤 ${seeders}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  // Sem o nome do addon: o cliente já o exibe no badge do card ("Localhost:7000",
  // "Power Movie"), e repeti-lo em toda linha só gastava a coluna estreita.
  if (effectiveStyle === 'full') return [title, stats].filter(Boolean).join('\n');
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
function passesQualityFilter(stream: StreamCandidate, filters?: string[], qualityLimits: Partial<Record<string, number>> = {}) {
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
  // Prova pelo ARQUIVO tem precedência sobre o título do post: o nome do
  // arquivo é fato, o título é palpite — e mente sobre áudio e resolução.
  // Quem grava é o play/tail via releaseIndex; aqui só consumimos o campo.
  const quality = item.provenQuality || qualityFromTitle(title);
  const source = sourceFromTitle(title);
  // Prova VAZIA (release EN sem marca PT no arquivo) é veredito sobre DUBLADO,
  // não sobre o rótulo. Quando o título já diz "Legendado" ele CONCORDA com a
  // prova — apagá-lo trocava "720p WEB-DL LEG BR" por "720p WEB-DL BR" e
  // escondia do usuário a única informação de áudio que existia, sem mudar
  // decisão nenhuma (`_dubbed` é false dos dois jeitos). Rótulo que afirma
  // dublado continua sendo derrubado pela prova, que é o motivo dela existir.
  const provenAudio = item.provenAudio;
  const titleAudio = audioFromTitle(title);
  const audio = provenAudio !== undefined
    ? provenAudio || (titleAudio === 'Legendado' ? 'Legendado' : '')
    : titleAudio;
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
    // A prova do arquivo troca a FONTE do rótulo, não a regra: "DUAL" segue
    // valendo só em origem BR, e fora dela ainda exige PT explícito — agora
    // lido no nome do arquivo, que é o que de fato existe dentro do torrent.
    //
    // Origem BR via `brOriginOnly` (inventário da conta, caso Zumbilândia)
    // marca `_br` para a vaga reservada e NUNCA `_dubbed`: origem não prova
    // áudio. O branch Dublado/Dual/Nacional fica para quem veio de looksPtBr
    // ou do flag do provider; para a origem-só, `_dubbed` segue a prova
    // explícita — que por construção é falsa (título que provasse PT já teria
    // looksPtBr), salvo prova de arquivo futura via `provenName`.
    _dubbed: isBr && !item.brOriginOnly
      ? audio === 'Dublado' || audio === 'Dual' || audio === 'Nacional'
      : explicitPtAudio(item.provenName || title),
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
      _lied: Boolean(item.lied),
  };
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
  streamDisplayName,
  markDebridName,
  matchesQualityFilter,
  passesQualityFilter,
  toStremioStream,
  resolveSearchNames,
  parseStremioId,
  buildSearchQuery,
  numeralSearchVariant,
};
