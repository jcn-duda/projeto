// Coleta Vaca extraída para manter o perfil abaixo de 400 linhas. Só agregados
// completos entram no cache: uma temporada falha não pode congelar as demais.
import type { createCache } from '../cache.js';
import type { ResolverLink, ParsedResolverLink } from '../types.js';
import {
  extractMovieLinks, seriesSeasonInternalUrl, parseSeasonInternal,
  filterSeasonCards, extractBatchTitle,
} from './vacatorrent-parsers.js';
import { seasonFromCardSlug, declaredSeriesLocation } from '../../src/providers/crawl-sites/vaca-series-locate.js';
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
        const out: ParsedResolverLink[] = [];
        let incomplete = false;
        for (const card of cards) {
          try {
            const cardHtml = await fetchText(card.url);
            // Alinhado ao crawl (`vaca-series.ts`): o slug dá a temporada do
            // card; o batch publica o título real NORMALIZADO (sem "BATCH – ",
            // que a regra de prefixo do filtro não perdoa).
            const season = card.season ?? seasonFromCardSlug(card.url);
            const batchTitle = card.isBatch ? (extractBatchTitle(cardHtml) || null) : null;
            const links = parseDownloadLinks(cardHtml, card.url, {
              season,
              ...(card.isBatch ? { realTitle: batchTitle } : {}),
            });
            // Locação POR EVIDÊNCIA por botão (mesma régua do crawl): o
            // rótulo/título do card vence o slug, o pack de temporada sai
            // {S, null} SEM o episódio do bloco e o título nasce coerente.
            for (const link of links) {
              const loc = declaredSeriesLocation({
                cardSeason: season,
                cardTitle: card.title,
                isBatch: card.isBatch,
                realTitle: batchTitle,
                dn: null,
                linkEpisode: link.episode ?? null,
              });
              out.push({ ...link, season: loc.season, episode: loc.episode });
            }
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
