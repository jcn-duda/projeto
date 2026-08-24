'use strict';

const { matchesResolverQuery, matchesSeasonSeason } = require('./matching');

// O parser continua pertencendo a cada profile: só a ordem do pré-filtro é
// comum. Filtrar a temporada antes do limite evita perder a temporada pedida
// quando os primeiros resultados do WordPress são de outras temporadas.
function selectSearchPosts(parsePosts, sourceHtml, query, requestedSeason, maxPosts) {
  let posts = parsePosts(sourceHtml).filter((post) => matchesResolverQuery(post, query));
  if (requestedSeason) posts = posts.filter((post) => matchesSeasonSeason(post, requestedSeason));
  return posts.slice(0, maxPosts);
}

module.exports = { selectSearchPosts };
