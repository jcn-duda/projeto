// Coleta Vaca extraída para manter o perfil abaixo de 400 linhas. Só agregados
// completos entram no cache: uma temporada falha não pode congelar as demais.
import type { createCache } from '../cache.js';
import type { ResolverLink } from '../types.js';
import {
  extractMovieLinks, seriesSeasonInternalUrl, parseSeasonInternal,
  filterSeasonCards, extractBatchTitle,
} from './vacatorrent-parsers.js';
import type { VacaWork, createParseDownloadLinks } from './vacatorrent-parsers.js';

export interface VacaSearchItem {
  post: VacaWork;
  link: ResolverLink;
  index: number;
  count: number;
}

class IncompleteLinks extends Error {
  constructor(readonly links: ResolverLink[]) {
    super('vacatorrent: falha ao obter todas as temporadas');
  }
}

interface ContentOptions {
  cachedPost: ReturnType<typeof createCache>['cached'];
  postCacheMs: number;
  fetchText: (url: string) => Promise<string>;
  parseDownloadLinks: ReturnType<typeof createParseDownloadLinks>;
}

export function createVacaContent({ cachedPost, postCacheMs, fetchText, parseDownloadLinks }: ContentOptions) {
  const NO_LINKS_SIGNAL = new Error('vacatorrent: sem link de download na página');

  async function fetchMovieLinks(post: VacaWork): Promise<ResolverLink[]> {
    const cacheKey = `movie:${post.url}`;
    try {
      return await cachedPost(cacheKey, postCacheMs, async () => {
        const pageHtml = await fetchText(post.url);
        const linksUrl = extractMovieLinks(pageHtml, post.url);
        if (!linksUrl) throw NO_LINKS_SIGNAL;
        const linksHtml = await fetchText(linksUrl);
        return parseDownloadLinks(linksHtml, linksUrl);
      });
    } catch (err) {
      if (err === NO_LINKS_SIGNAL) return [];
      throw err;
    }
  }

  async function fetchSeriesLinks(
    post: VacaWork, requestedSeason: RegExpMatchArray | null, onIncomplete?: () => void,
  ): Promise<ResolverLink[]> {
    const seasonKey = requestedSeason ? String(requestedSeason[1]) : '';
    const cacheKey = `serie:${post.url}:${seasonKey}`;
    try {
      return await cachedPost(cacheKey, postCacheMs, async () => {
        const pageHtml = await fetchText(post.url);
        const internalUrl = seriesSeasonInternalUrl(pageHtml, post.url);
        if (!internalUrl) throw NO_LINKS_SIGNAL;
        const internalHtml = await fetchText(internalUrl);
        const cards = filterSeasonCards(parseSeasonInternal(internalHtml, internalUrl), requestedSeason);
        const out: ResolverLink[] = [];
        let incomplete = false;
        for (const card of cards) {
          try {
            const cardHtml = await fetchText(card.url);
            const links = parseDownloadLinks(cardHtml, card.url, {
              season: card.season,
              ...(card.isBatch ? { realTitle: extractBatchTitle(cardHtml) || null } : {}),
            });
            out.push(...links);
          } catch (err) {
            incomplete = true;
            console.warn(`[vac] card ${card.url}: ${err.message}`);
          }
        }
        // Rejeitar DENTRO do loader impede a gravação pelo cache compartilhado.
        if (incomplete) throw new IncompleteLinks(out);
        return out;
      });
    } catch (err) {
      if (err === NO_LINKS_SIGNAL) return [];
      if (err instanceof IncompleteLinks && err.links.length) {
        // Todos os consumidores coalescidos recebem o sinal, não só o loader.
        onIncomplete?.();
        return err.links;
      }
      throw err;
    }
  }

  async function postToItems(
    post: VacaWork, requestedSeason: RegExpMatchArray | null, onIncomplete?: () => void,
  ): Promise<VacaSearchItem[]> {
    const links = post.type === 'Série'
      ? await fetchSeriesLinks(post, requestedSeason, onIncomplete)
      : await fetchMovieLinks(post);
    return links.map((link, index) => ({ post, link, index, count: links.length }));
  }

  return { fetchMovieLinks, fetchSeriesLinks, postToItems };
}
