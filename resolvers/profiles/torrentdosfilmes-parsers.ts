// Parsers PRÓPRIOS do TorrentDosFilmes, extraídos do profile pela catraca de
// 400 linhas — é a mesma divisão que `nerdfilmes-parsers.ts` e
// `vacatorrent-parsers.ts` já fazem: o profile fica com a REDE e as rotas, e o
// que só sabe LER HTML do site mora aqui.
//
// Nada deste módulo faz rede. O profile injeta o que é dele (`isProtectorHost`
// da allowlist, `stripTags` com o decoder do perfil) e recebe de volta a mesma
// superfície pública que expunha antes — a extração não muda contrato.
import { attribute } from '../text.js';
import { isGenericListPost } from '../matching.js';
import {
  createEpisodeStep,
  createLinkCollector,
  lastAudioMarker,
  NERD_AUDIO_RE,
  NERD_LEGENDADO_RE,
  NARROW_PACK_RESET_RE,
  NARROW_EPISODE_RE,
} from '../release-rules.js';
import type { ResolverLink, ResolverPost } from '../types.js';

/** Texto cru do botão: o profile decide o `stripTags` (o decoder é o dele). */
export type TdfStripTags = (value?: string) => string;
/** Decoder do profile (o tdf é `decodeEntitiesBasic`). */
export type TdfDecode = (value: string) => string;

// Classificadores do tdf com saída PRÓPRIA (R-4: o token casado sai com [. ]
// trocado por '-', então "BLU RAY" vira "BLU-RAY" e "BLURAY" fica inteiro).
// Regexes no topo do módulo, fora do laço (R-7).
const TDF_QUALITY_RE = /(?:\b(\d{3,4})\s*P\b|\b(4K)\b)/g;
const TDF_SOURCE_RE = /(REMUX|BLU[- ]?RAY|WEB[-. ]?DL|WEB[-. ]?RIP|HDTV|CAMRIP|CAM)/g;

function qualityOf(context: string): number | null {
  const quality = [...context.matchAll(TDF_QUALITY_RE)].pop();
  return quality ? (quality[1] ? Number(quality[1]) : 2160) : null;
}

function sourceOf(context: string): string | null {
  const source = [...context.matchAll(TDF_SOURCE_RE)].pop();
  return source ? source[1].replace(/[. ]/g, '-') : null;
}

/**
 * Resultados da busca WordPress do tdf: `div.title > a` (o theme ComandoFilmes,
 * o mesmo que o comandotorrents usa). O `title` do atributo vem antes do texto
 * da âncora porque no tdf o texto é truncado com reticências pelo theme.
 */
function parsePosts(html: string, stripTags: TdfStripTags, decodeEntities: TdfDecode, baseUrl: string): ResolverPost[] {
  const posts: ResolverPost[] = [];
  const title = /<div\b[^>]*class=["'][^"']*\btitle\b[^"']*["'][^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = title.exec(html))) {
    const url = attribute(match[1], 'href');
    if (!url) continue;
    const clean = stripTags(attribute(match[1], 'title') || match[2]);
    if (isGenericListPost(clean)) continue;
    posts.push({ url: new URL(decodeEntities(url), baseUrl).href, title: clean });
  }
  return [...new Map(posts.map((post) => [post.url, post])).values()];
}

/**
 * Título do post do tdf, na variante CURTA deste profile (7 passos: torrent,
 * blob de qualidades, `\d{3,4}p`, tags de vitrine, colapso). É o que
 * `createReleaseTitle` consome: por isso o `release_title` do card vivo e o do
 * adaptador de raspagem saem do MESMO lugar (mesma régua de título, uma só).
 *
 * O que ela NÃO tira (e o raspador do site tira, com a régua própria do crawl):
 * fonte (`BluRay`, `WEB-DL`, `HDTV`…) e canais de áudio (`5.1`). Aqui elas viram
 * ruído dentro do título da release — que é o que o site publica —, e lá viram
 * parte do NOME da obra. Ver `crawl-sites/torrentdosfilmes-discovery.ts`.
 */
function cleanPostTitle(title = ''): string {
  return String(title)
    .replace(/\s*Torrent\s*(?:[–-]|&#8211;)?\s*/gi, ' ')
    .replace(/\b(?:720p|1080p|2160p|4K)(?:\s*\/\s*(?:720p|1080p|2160p|4K|5\.1|dual|dublado|legendado))*/gi, '')
    .replace(/\b\d{3,4}p\b/gi, '')
    .replace(/\b(?:Dublado|Legendado|Dual\s*Áudio|Download|Online|Grátis|Completo|Completa)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Coletor de botões de download. Mesma máquina de estados do nerd (`scope:
 * 'segment-only'`, a âncora NUNCA interfere no estado do episódio) e a mesma
 * lista de marcadores de áudio — o que muda aqui é a FORMA da href: o tdf
 * publica o magnet DIRETO no `href` (medido 2026-09-28: 1 a 3 por post, sem
 * salto de protetor) e o `startsWith` é case-SENSITIVE de propósito
 * (comportamento histórico do profile, fixado pelo `br-parsers`).
 */
function createTdfDownloadLinks(options: {
  isProtectorHost: (hostname: string | null | undefined) => boolean;
  stripTags: TdfStripTags;
  decodeEntities: TdfDecode;
}): (html: string | null | undefined, baseUrl?: string) => ResolverLink[] {
  const { isProtectorHost, stripTags, decodeEntities } = options;
  const episodeStep = createEpisodeStep({
    scope: 'segment-only',
    packRe: NARROW_PACK_RESET_RE,
    epRe: NARROW_EPISODE_RE,
    epRangeGroup: 2,
  });
  return createLinkCollector({
    anchorRe: /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    resolveHref: (match) => {
      const rawHref = decodeEntities(match[1]);
      if (rawHref.startsWith('magnet:?')) return { url: rawHref };
      let u: URL;
      try {
        u = new URL(rawHref);
      } catch {
        return { skip: true };
      }
      if (!isProtectorHost(u.hostname)) return { skip: true };
      return { url: rawHref };
    },
    anchorTextOf: (match) => stripTags(match[2]),
    stripTags,
    initialAudio: 'desconhecido',
    audioFromSegment: (segment) => lastAudioMarker(segment, NERD_AUDIO_RE, NERD_LEGENDADO_RE),
    episodeStep,
    qualityFn: qualityOf,
    sourceFn: sourceOf,
  });
}

export { cleanPostTitle, createTdfDownloadLinks, parsePosts, qualityOf, sourceOf };
