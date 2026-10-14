// Boat Trip (2026-10-05): "O Cruzeiro das Loucas" com 0 seeds caía no piso de
// seeders antes de a Premiumize ser perguntada. Com debrid que checa cache e
// "só em cache" ligado, o ⚡ decide.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import config from '../src/config.js';
import { seedFloorFor } from '../src/providers/seed-floor.js';

test('piso some só com debrid que checa cache, chave e cachedOnly', () => {
  assert.equal(seedFloorFor(1, { cacheCheck: true, apiKey: 'k', cachedOnly: true }), 0);
  // Sem cachedOnly a lista mostra P2P: torrent morto continua cortado.
  assert.equal(seedFloorFor(1, { cacheCheck: true, apiKey: 'k', cachedOnly: false }), 1);
  // Real-Debrid/Debrid-Link não dizem o que está pronto.
  assert.equal(seedFloorFor(1, { cacheCheck: false, apiKey: 'k', cachedOnly: true }), 1);
  // Sem chave não há checagem.
  assert.equal(seedFloorFor(3, { cacheCheck: true, apiKey: '', cachedOnly: true }), 3);
});

test('SEARCH_CACHED_ONLY_IGNORES_SEEDS=false volta ao piso', () => {
  const mutable = config.search as { cachedOnlyIgnoresSeeds: boolean };
  const before = mutable.cachedOnlyIgnoresSeeds;
  mutable.cachedOnlyIgnoresSeeds = false;
  try {
    assert.equal(seedFloorFor(1, { cacheCheck: true, apiKey: 'k', cachedOnly: true }), 1);
  } finally {
    mutable.cachedOnlyIgnoresSeeds = before;
  }
});
