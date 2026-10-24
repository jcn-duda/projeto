import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import * as cache from '../src/utils/cache.js';
import { prefix } from '../src/utils/cache-keys.js';
import * as harvestWorker from '../src/providers/harvest-worker.js';

test('teto horário: balde persiste no cache e sobrevive a Map limpo (restart)', () => {
  const hour = Math.floor(Date.now() / 3_600_000);
  const key = `${prefix('harvest')}hour`;
  const before = harvestWorker.queriesThisHour();
  try {
    harvestWorker.noteQueries(5);
    assert.equal(harvestWorker.queriesThisHour(), before + 5, 'Map reflete o incremento');
    const stored = cache.get(key) as { hour?: number; count?: number } | undefined;
    assert.ok(stored, 'grava harvest:v1:hour');
    assert.equal(stored.hour, hour);
    assert.equal(stored.count, before + 5);
    // Simula processo novo: memória vazia, L1/L2 intacto.
    harvestWorker.clearHourBuckets();
    assert.equal(harvestWorker.queriesThisHour(), before + 5, 'hidrata do cache após restart');
  } finally {
    harvestWorker.clearHourBuckets();
    cache.forget(key);
  }
});
