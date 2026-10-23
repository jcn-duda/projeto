import type { StreamCandidate } from '../../types/domain.js';
import { normalizeTitle, dedupeNames } from './title-normalization.js';
import { LEADING_ARTICLES } from './release-matching.js';
import { catalogYearOf, catalogAltYearOf } from './catalog-year.js';
import {
  UNKNOWN_QUALITY,
} from './audio-quality.js';
import { streamQuality } from './stream-quotas-candidate.js';

interface SearchNamesOptions {
  meta?: { name?: string | null; title?: string; year?: number | string | null } | null;
  titles?: { original?: string | null; pt?: string | null; en?: string | null; br?: string[] | null; year?: number | string | null } | null;
  imdbId?: string | null;
}

interface SeasonEpisodeOptions {
  season?: number | null;
  episode?: number | null;
}

const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
];

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
 * De onde saem o nome da busca e os nomes do filtro. Uma função só porque os
 * três pontos que precisam disso (query principal, pack de temporada e o corte
 * por título) tinham que concordar — e não concordavam.
 *
 * O Cinemeta é a fonte preferida, mas não conhece todo id e pode estourar o
 * prazo: título obscuro volta 404 ou timeout. Quando isso acontecia:
 *
 * - a query virava a string crua "tt1234567", mesmo com o TMDB (outra API) já
 *   tendo respondido com o nome;
 * - o filtro de título, preso a `meta?.name`, se desligava por inteiro.
 *
 * O fallback mantém TODOS os títulos úteis: `en` (título canônico inglês do
 * TMDB, quando o original é estrangeiro) precede o original e o pt-BR como nome
 * da query, mas os três seguem em `names`. O título ORIGINAL tem degrau próprio
 * na cascata (`resolveOriginalStepName`) e o pt-BR tem a query `ptQuery`.
 */
function resolveSearchNames({ meta, titles, imdbId }: SearchNamesOptions = {}): {
  name: string;
  year: number | string | null;
  altYear: number | null;
  names: string[];
} {
  const fallback = titles?.en || titles?.original || titles?.pt;
  return {
    name: meta?.name || fallback || imdbId || '',
    year: catalogYearOf(meta?.year, titles?.year),
    altYear: catalogAltYearOf(meta?.year, titles?.year),
    // `dedupeNames` remove null/undefined/'' e colapsa repetições normalizadas
    // (o original do Cinemeta e o canônico inglês coincidem em obra anglófona),
    // mantendo só strings não vazias para `matchContext.names: string[]`.
    // Dos `alternative_titles` só entram os aliases BR já filtrados em
    // tmdb-br-aliases.ts ("Operação: Lioness"); grafias arbitrárias de outros
    // países ("Kill") continuam fora.
    names: dedupeNames([meta?.name, titles?.en, titles?.pt, titles?.original, ...(titles?.br || [])]),
  };
}

/**
 * Nome do degrau opcional do título ORIGINAL (TMDB) na cascata de consulta:
 * só existe quando ele difere do nome da query primária por normalização —
 * ausente ou equivalente, o degrau é omitido (a query mainstream não troca).
 * normalizeTitle dobra o ı turco ("Adım" = "Adim"), então o original só
 * gera degrau quando difere de fato do nome mainstream; o matching, que usa o
 * mesmo normalizeTitle via matchContext.names, aceita as duas grafias.
 */
function resolveOriginalStepName(original: string | null | undefined, primaryName: string | null | undefined): string | null {
  if (!original || !primaryName) return null;
  return normalizeTitle(original) !== normalizeTitle(primaryName) ? original : null;
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
  markDebridName,
  matchesQualityFilter,
  passesQualityFilter,
  resolveSearchNames,
  resolveOriginalStepName,
  parseStremioId,
  buildSearchQuery,
  numeralSearchVariant,
};
