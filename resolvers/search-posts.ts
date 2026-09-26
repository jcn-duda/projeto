import type { MatchablePost } from './matching.js';
import { matchesResolverQuery, matchesSeasonSeason } from './matching.js';

export type RequestedSeason = RegExpMatchArray | readonly string[] | string | number | null | undefined;

// O parser continua pertencendo a cada profile: só a ordem do pré-filtro é
// comum. Filtrar a temporada antes do limite evita perder a temporada pedida
// quando os primeiros resultados do WordPress são de outras temporadas.
function selectSearchPosts<T extends MatchablePost>(
  parsePosts: (html: string) => T[],
  sourceHtml: string,
  query: string,
  requestedSeason: RequestedSeason,
  maxPosts: number,
): T[] {
  let posts = parsePosts(sourceHtml).filter((post) => matchesResolverQuery(post, query));
  if (requestedSeason) posts = posts.filter((post) => matchesSeasonSeason(post, requestedSeason));
  return posts.slice(0, maxPosts);
}

export { selectSearchPosts };
