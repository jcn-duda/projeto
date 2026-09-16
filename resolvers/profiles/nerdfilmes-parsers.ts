import {
  decodeEntitiesBasic,
  stripTags,
  attribute as attributeShared,
} from '../text.js';
import type { DecodeEntities } from '../text.js';
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
import type { LinkCollectorConfig } from '../release-rules.js';
import { BASE_PROTECTOR_SUFFIXES, hasAllowedHost } from '../protector.js';
import type { ResolverLink, ResolverPost } from '../types.js';

const decodeEntities: DecodeEntities = decodeEntitiesBasic;

const attribute = (tag: string | null | undefined, name: string): string | null =>
  attributeShared(tag, name, { decode: decodeEntities, allowWhitespace: true });

// Classificadores do nerd com saída PRÓPRIA (R-4: não passa pela factory
// comum — "BluRay"/"WEB-DL"/"WEBRip" em vez de "BLU-RAY"/"WEBRIP" maiúsculo).
function normalizeSource(value: string | null | undefined): string | null {
  const source = String(value || '').toUpperCase().replace(/[. ]/g, '-');
  if (source.startsWith('BLU')) return 'BluRay';
  if (source.startsWith('WEB-DL')) return 'WEB-DL';
  if (source.startsWith('WEB-RIP')) return 'WEBRip';
  if (source === 'HDTV') return 'HDTV';
  return null;
}

// Regex de descoberta de qualidade/fonte no contexto (segmento + âncora) —
// nascem no topo do módulo, fora do laço (R-7).
const NERD_QUALITY_RE = /(?:\b(\d{3,4})\s*P\b|\b(4K)\b)/g;
const NERD_SOURCE_RE = /(WEB[-. ]?DL|WEB[-. ]?RIP|BLU[- ]?RAY|HDTV)/g;

function qualityOf(context: string): number | null {
  const qualityHit = [...context.matchAll(NERD_QUALITY_RE)].pop();
  return qualityHit ? (qualityHit[1] ? Number(qualityHit[1]) : 2160) : null;
}

function sourceOf(context: string): string | null {
  const sourceHit = [...context.matchAll(NERD_SOURCE_RE)].pop();
  return sourceHit ? normalizeSource(sourceHit[1]) : null;
}

/** Resultados da busca WordPress: article.col > .item > .image > a. */
function parsePosts(html: string | null | undefined): ResolverPost[] {
  const posts: ResolverPost[] = [];
  const article = /<article\b[^>]*class=["'][^"']*\bcol\b[^"']*["'][^>]*>([\s\S]*?)<\/article>/gi;
  let match: RegExpExecArray | null;
  while ((match = article.exec(String(html || '')))) {
    const image = match[1].match(
      /<div\b[^>]*class=["'][^"']*\bimage\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    );
    const anchor = image?.[1].match(/<a\b[^>]*>/i);
    const url = anchor ? attribute(anchor[0], 'href') : null;
    const title = anchor ? attribute(anchor[0], 'title') : null;
    const clean = title ? stripTags(title) : null;
    if (url && clean && !isGenericListPost(clean) && !posts.some((post) => post.url === url)) {
      posts.push({ url, title: clean });
    }
  }
  return posts;
}

function cleanPostTitle(title: string | null | undefined = ''): string {
  return String(title)
    .replace(/\s*Torrent\s*(?:[–-]|&#8211;)?\s*/gi, ' ')
    .replace(/\b(?:720p|1080p|2160p|4K)(?:\s*\/\s*(?:720p|1080p|2160p|4K|5\.1|dual|dublado|legendado))*/gi, '')
    .replace(/\b\d{3,4}p\b/gi, '')
    .replace(/\b(?:Dublado|Legendado|Dual\s*Áudio|Download|Online|Grátis|Completo|Completa)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Scheme de URI é case-insensitive (RFC 3986) e o site pode publicar MAGNET:.
// Reconhecer nas duas caixas é só metade: o filtro regexp do cardigann
// (`magnet:\?…`) e o cliente de torrent esperam o scheme minúsculo, então todo
// magnet é normalizado na SAÍDA do resolver — aceitar sem normalizar apenas
// moveria a falha para depois do Jackett.
function hasMagnetScheme(value: unknown): boolean {
  return /^magnet:/i.test(String(value || ''));
}

function normalizeMagnetScheme(value: unknown): string {
  return String(value).replace(/^magnet:/i, 'magnet:');
}

// Magnet direto no href só é aceito se QUALQUER parâmetro xt (nome
// case-insensitive) for urn:btih com hash 40 hex ou 32 base32, em qualquer
// posição dos parâmetros (um xt=urn:btmh pode vir antes do btih). Tudo mais
// segue a allowlist de http(s).
function isValidDirectMagnet(value: unknown): boolean {
  const href = String(value || '');
  if (!hasMagnetScheme(href)) return false;
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return false;
  }
  if (u.protocol !== 'magnet:') return false;
  for (const [name, xt] of u.searchParams.entries()) {
    if (name.toLowerCase() !== 'xt') continue;
    const btihMatch = xt.match(/^urn:btih:(.+)$/i);
    if (!btihMatch) continue;
    const hash = btihMatch[1];
    if (/^[0-9a-f]{40}$/i.test(hash) || /^[A-Z2-7]{32}$/i.test(hash)) return true;
  }
  return false;
}

function parsePostDate(html: string | null | undefined): string | null {
  const meta = String(html).match(
    /<meta\b[^>]*(?:property|name)=["'](?:article:published_time|datePublished)["'][^>]*>/i,
  );
  const content = meta ? attribute(meta[0], 'content') : null;
  const json = String(html).match(/["']datePublished["']\s*:\s*["']([^"']+)["']/i)?.[1];
  const date = new Date(content || json || '');
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// Compat/factory-only: este singleton NÃO lê mais env (antes lia
// EXTRA_ALLOWED_PROTECTORS a cada chamada). A lista dinâmica entra pela factory
// createNerdDownloadLinks({ isProtectorHost }), que o profile injeta com o
// bootstrap da instância. O default fica base-only para import ser puro.
function isProtectorHost(hostname: string | null | undefined): boolean {
  return hasAllowedHost(hostname, BASE_PROTECTOR_SUFFIXES);
}

// Plugin botoes-viatorrents: o post aponta para /link.php?id=<blob> no MESMO
// host do detalhe; o magnet só aparece no HTML do gate. Aceitar qualquer path
// do site como "protetor" abriria o domínio inteiro — só este path, e só com
// a origem do post (baseUrl) conhecida.
function isNerdSameOriginLinkPhp(url: URL, baseUrl: string): boolean {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return false;
  }
  if (url.origin !== base.origin) return false;
  return url.pathname.toLowerCase() === '/link.php';
}

/** Cada botão protegido representa uma qualidade/tamanho diferente. Máquina
 * de estados do núcleo (createLinkCollector), com escopo anchor-local (o sinal
 * da âncora vale SÓ para o botão) e o par estreito de pack/episódio do nerd.
 * Falha de validação NUNCA avança o cursor — corte de segmento do laço
 * original. */
const episodeStep = createEpisodeStep({
  scope: 'anchor-local',
  packRe: NARROW_PACK_RESET_RE,
  epRe: NARROW_EPISODE_RE,
});

function createNerdDownloadLinks(options: { isProtectorHost?: (hostname: string) => boolean } = {}) {
  const checkProtector = options.isProtectorHost || isProtectorHost;
  const cfg: LinkCollectorConfig = {
    anchorRe: /<a\b[^>]*>[\s\S]*?<\/a>/gi,
    resolveHref: (match, _html, baseUrl) => {
      const tag = match[0].match(/<a\b[^>]*>/i)?.[0] || '';
      const rawHref = attribute(tag, 'href');
      if (!rawHref) return { skip: true };
      const href = decodeEntities(rawHref);
      if (isValidDirectMagnet(href)) return { url: href };

      // Protetor externo: URL absoluta (contrato histórico — relativo nunca
      // era protetor). Mesma origem /link.php entra no ramo abaixo.
      try {
        const abs = new URL(href);
        if (checkProtector(abs.hostname)) return { url: href };
      } catch {
        // relativo: cai no gate same-origin se houver baseUrl
      }

      if (!baseUrl) return { skip: true };
      let u: URL;
      try {
        u = new URL(href, baseUrl);
      } catch {
        return { skip: true };
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return { skip: true };
      if (!isNerdSameOriginLinkPhp(u, baseUrl)) return { skip: true };
      return { url: u.href };
    },
    anchorTextOf: (match) => stripTags(match[0]),
    stripTags,
    initialAudio: 'desconhecido',
    audioFromSegment: (segment) => lastAudioMarker(segment, NERD_AUDIO_RE, NERD_LEGENDADO_RE),
    audioFromAnchor: (anchorText) => lastAudioMarker(anchorText, NERD_AUDIO_RE, NERD_LEGENDADO_RE),
    episodeStep,
    qualityFn: qualityOf,
    sourceFn: sourceOf,
  };
  return createLinkCollector(cfg);
}

// Instância default base-only (sem env). Consumidores que precisam do conjunto
// dinâmico (o profile nerdfilmes) chamam createNerdDownloadLinks({ isProtectorHost }).
const parseDownloadLinks = createNerdDownloadLinks();

function scoreLink(link: ResolverLink): number {
  const audio = link.audio === 'dublado' ? 100_000 : link.audio === 'legendado' ? 0 : 50_000;
  return audio + Number(link.quality || 0);
}

export {
  attribute,
  normalizeSource,
  NERD_QUALITY_RE,
  NERD_SOURCE_RE,
  qualityOf,
  sourceOf,
  parsePosts,
  cleanPostTitle,
  hasMagnetScheme,
  normalizeMagnetScheme,
  isValidDirectMagnet,
  parsePostDate,
  isProtectorHost,
  isNerdSameOriginLinkPhp,
  episodeStep,
  createNerdDownloadLinks,
  parseDownloadLinks,
  scoreLink,
};
