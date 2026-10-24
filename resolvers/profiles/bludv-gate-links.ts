import { createLinkCollector } from '../release-rules.js';
import { decodeEntities, stripTags } from '../text.js';
import type { ResolverLink } from '../types.js';
import {
  audioFromSegment, audioFromAnchor, episodeStep, normalizeQuality,
  normalizeSource, parseDownloadLinks,
} from './bludv-parsers.js';

// Lista EXATA e local ao gate; não altera os protetores globais.
export const BLUDV_GATE_HOSTS: ReadonlySet<string> = new Set([
  'bludvfilmes.xyz', 'bludvfilmes1.xyz', 'bludvfilmes2.xyz', 'bludv.net', 'bludv.xyz', 'bludv.to',
]);

export function safeGateUrl(value: string, base?: string): URL | null {
  try {
    if (!value || value.length > 4096 || /[\s\\]/.test(value)) return null;
    const url = new URL(value, base);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return null;
    return url;
  } catch { return null; }
}

export function isGateUrl(value: string, postUrl?: string): boolean {
  const post = postUrl === undefined ? null : safeGateUrl(postUrl);
  if (postUrl !== undefined && (!post || !BLUDV_GATE_HOSTS.has(post.hostname))) return false;
  const url = safeGateUrl(value, post?.href);
  return !!url && BLUDV_GATE_HOSTS.has(url.hostname) && (!post || url.hostname === post.hostname)
    && /^\/gate\/go\/[a-f0-9]{16}$/i.test(url.pathname)
    && url.searchParams.getAll('p').length === 1 && /^\d+$/.test(url.searchParams.get('p') || '')
    && [...url.searchParams.keys()].every((key) => key === 'p');
}

type LegacyParser = (html: string) => ResolverLink[];

/**
 * Deduplica SÓ os portões: o mesmo `/gate/go/<hash>?p=<post>` repetido no post
 * é uma única sessão de anúncio, e publicá-lo duas vezes daria ao Jackett duas
 * linhas com o mesmo `h` (dois botões para o mesmo vídeo). O coletor legado não
 * deduplicava e continua intocado — mudar isso aqui alteraria os outros seis
 * perfis sem medição.
 */
function dedupeGates(links: ResolverLink[], postUrl: string): ResolverLink[] {
  const seen = new Set<string>();
  return links.filter((link) => {
    if (!isGateUrl(link.url, postUrl)) return true;
    if (seen.has(link.url)) return false;
    seen.add(link.url);
    return true;
  });
}

/**
 * Uma só máquina de metadados, na ordem do HTML, mesmo num post misto: o portão
 * entra pela allowlist local e o resto é decisão do parser do perfil.
 */
export function parseGateAndLegacyLinks(
  html: string, postUrl: string, legacy: LegacyParser = parseDownloadLinks,
): ResolverLink[] {
  const collect = createLinkCollector({
    anchorRe: /<a\s+[^>]*?href\s*=\s*(["'])([^"']+)\1[^>]*>([\s\S]*?)<\/a>/gi,
    resolveHref: (match) => {
      const href = decodeEntities(match[2].trim());
      if (isGateUrl(href, postUrl)) return { url: new URL(href, postUrl).href };
      // O parser legado decide o que é protetor/magnet; nenhum domínio do anúncio
      // é promovido a protetor. Os classificadores continuam sendo os existentes.
      const link = legacy(match[0])[0];
      return link ? { url: link.url } : { skip: true };
    },
    anchorTextOf: (match) => stripTags(match[3], decodeEntities),
    stripTags: (value) => stripTags(value, decodeEntities),
    initialAudio: 'desconhecido', audioFromSegment, audioFromAnchor,
    episodeStep, qualityFn: normalizeQuality, sourceFn: normalizeSource,
  });
  return dedupeGates(collect(html), postUrl);
}

export function parseGateLinks(html: string, postUrl: string): ResolverLink[] {
  return parseGateAndLegacyLinks(html, postUrl).filter((link) => isGateUrl(link.url, postUrl));
}
