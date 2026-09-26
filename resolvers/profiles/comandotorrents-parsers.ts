// Parsers puros do Comando Torrents: posts da busca WordPress e o score de
// botão. Extraídos do profile (que ficou no teto de 400) sem mudar a API —
// o profile segue expondo `parsePosts` no objeto da instância e usa o mesmo
// `scoreLink` internamente.
import { attribute, decodeEntities } from '../text.js';
import { isGenericListPost } from '../matching.js';
import type { ResolverLink, ResolverPost } from '../types.js';

/** Dependências de instância injetadas na factory de posts. */
export interface ComandoParsePostsConfig {
  siteSelector: { url(): string };
  stripTags: (value: string) => string;
}

export function createParsePosts({ siteSelector, stripTags }: ComandoParsePostsConfig) {
  return function parsePosts(html: string): ResolverPost[] {
    const posts: ResolverPost[] = [];
    const seen = new Set<string>();
    const article = /<article\b[^>]*class=["'][^"']*\bblog-view\b[^"']*["'][^>]*>([\s\S]*?)(?:<\/article>|(?=<article\b)|$)/gi;
    let match: RegExpExecArray | null;
    while ((match = article.exec(html))) {
      const anchor = match[1].match(/<h2\b[^>]*class=["'][^"']*\bentry-title\b[^"']*["'][^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a>/i);
      if (!anchor) continue;
      const url = attribute(anchor[1], 'href');
      if (!url) continue;
      let resolvedUrl: string;
      try {
        resolvedUrl = new URL(decodeEntities(url), siteSelector.url()).href;
      } catch {
        continue;
      }
      if (seen.has(resolvedUrl)) continue;
      seen.add(resolvedUrl);

      const image = match[1].match(/<img\b[^>]*src=["']([^"']+)["']/i)?.[1] || null;
      const title = stripTags(attribute(anchor[1], 'title') || anchor[2]);
      if (isGenericListPost(title)) continue;
      posts.push({
        url: resolvedUrl,
        title,
        poster: image ? decodeEntities(image) : null,
      });
    }
    return posts;
  };
}

/** Score de botão: dublado primeiro, qualidade depois. */
export function scoreLink(link: ResolverLink): number {
  return (link.audio === 'dublado' ? 100_000 : link.audio === 'legendado' ? 0 : 50_000) + (link.quality || 0);
}
