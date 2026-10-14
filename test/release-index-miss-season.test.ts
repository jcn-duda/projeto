import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import config from '../src/config.js';
import * as cache from '../src/utils/cache.js';
import * as metrics from '../src/utils/metrics.js';
import { markMissing, markMissingSeason, isMissing, isMissingQuiet } from '../src/utils/release-index-miss.js';

test('release-index-miss: markMissingSeason marca temporada e isMissing respeita para qualquer episódio da temporada', () => {
  cache.clear();
  metrics.reset();

  const imdb = 'tt1234567';
  const hash = 'a'.repeat(40);

  // Antes de marcar
  assert.equal(isMissing(imdb, { season: 3, episode: 1 }, hash), false);
  assert.equal(isMissingQuiet(imdb, { season: 3, episode: 1 }, hash), false);

  // Marca temporada 3 ausente
  const marked = markMissingSeason(imdb, 3, hash);
  assert.equal(marked, 1, 'primeira marcação retorna 1');
  assert.equal(metrics.snapshot().counters['search.idx.missSeason'], 1, 'métrica incrementada');

  // Segunda marcação é idempotente na métrica
  const markedAgain = markMissingSeason(imdb, 3, hash);
  assert.equal(markedAgain, 0, 'marcação repetida retorna 0');
  assert.equal(metrics.snapshot().counters['search.idx.missSeason'], 1);

  // isMissing e isMissingQuiet reportam true para qualquer episódio da temporada 3
  assert.equal(isMissing(imdb, { season: 3, episode: 1 }, hash), true);
  assert.equal(isMissing(imdb, { season: 3, episode: 2 }, hash), true);
  assert.equal(isMissing(imdb, { season: 3, episode: 99 }, hash), true);
  assert.equal(isMissingQuiet(imdb, { season: 3, episode: 1 }, hash), true);
  assert.equal(isMissingQuiet(imdb, { season: 3, episode: 5 }, hash), true);

  // Temporadas diferentes NÃO são afetadas
  assert.equal(isMissing(imdb, { season: 1, episode: 1 }, hash), false);
  assert.equal(isMissing(imdb, { season: 2, episode: 1 }, hash), false);
  assert.equal(isMissing(imdb, { season: 4, episode: 1 }, hash), false);
  assert.equal(isMissingQuiet(imdb, { season: 1, episode: 1 }, hash), false);

  // Outros hashes NÃO são afetados
  const outroHash = 'b'.repeat(40);
  assert.equal(isMissing(imdb, { season: 3, episode: 1 }, outroHash), false);

  cache.clear();
  metrics.reset();
});

test('release-index-miss: markMissingSeason respeita gates de input inválido', () => {
  cache.clear();
  metrics.reset();

  assert.equal(markMissingSeason('', 3, 'a'.repeat(40)), 0);
  assert.equal(markMissingSeason('1234567', 3, 'a'.repeat(40)), 0); // sem prefixo tt
  assert.equal(markMissingSeason('tt1234567', 3, ''), 0); // sem hash
  assert.equal(markMissingSeason('tt1234567', null as any, 'a'.repeat(40)), 0); // sem temporada

  assert.equal(metrics.snapshot().counters['search.idx.missSeason'] || 0, 0);
});

test('release-index-miss: isMissing combina miss por episódio e miss por temporada', () => {
  cache.clear();
  metrics.reset();

  const imdb = 'tt1234568';
  const hashEpOnly = 'c'.repeat(40);
  const hashSeason = 'd'.repeat(40);

  // hashEpOnly marca apenas S1E2
  markMissing(imdb, { season: 1, episode: 2 }, hashEpOnly);
  assert.equal(isMissing(imdb, { season: 1, episode: 1 }, hashEpOnly), false);
  assert.equal(isMissing(imdb, { season: 1, episode: 2 }, hashEpOnly), true);
  assert.equal(isMissing(imdb, { season: 1, episode: 3 }, hashEpOnly), false);

  // hashSeason marca temporada 2 inteira
  markMissingSeason(imdb, 2, hashSeason);
  assert.equal(isMissing(imdb, { season: 2, episode: 1 }, hashSeason), true);
  assert.equal(isMissing(imdb, { season: 2, episode: 2 }, hashSeason), true);
  assert.equal(isMissing(imdb, { season: 1, episode: 1 }, hashSeason), false);

  cache.clear();
  metrics.reset();
});
