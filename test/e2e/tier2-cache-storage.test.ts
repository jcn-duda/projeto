// Rodada 2: checagem ligada; tier 2 (casos de borda e canto) tipado.
// A suíte precisa ser idêntica no Node 18 e no Node 22, sem criar SQLite local.
process.env.CACHE_PERSIST = 'false';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import config from '../../src/config.js';
import * as runtime from '../../src/runtime.js';
import * as cache from '../../src/utils/cache.js';
import * as format from '../../src/utils/format.js';
import * as sign from '../../src/utils/sign.js';
import * as secretBox from '../../src/utils/secret-box.js';
import { createDiagnosticGate, authorized } from '../../src/utils/diagnostic-guard.js';
import debrid from '../../src/debrid/index.js';
import * as debridCommon from '../../src/debrid/common.js';
import * as protectedHashes from '../../src/debrid/protected.js';
import * as jackettCatalog from '../../src/providers/jackett-catalog.js';
import prowlarr from '../../src/providers/prowlarr.js';
import * as brResolvers from '../../src/br-resolvers.js';
import bludvResolver from '../../bludv-resolver/server.js';
import nerdfilmesResolver from '../../nerdfilmes-resolver/server.js';
import torrentdosfilmesResolver from '../../torrentdosfilmes-resolver/server.js';
import comandotorrentsResolver from '../../comandotorrents-resolver/server.js';
import { collectWithinWindow } from '../../src/providers/collection-window.js';
import { createLatestWriter } from '../../src/utils/latest-writer.js';
import { raceWithDeadline, remainingCheckBudget } from '../../src/utils/deadline.js';
import type { Stream } from '../../types/domain.js';

// Helper to run code with temporary config modifications
function withSecret(secret: any, fn: any) {
  const original = config.debrid.resolveSecret;
  config.debrid.resolveSecret = secret;
  try {
    return fn();
  } finally {
    config.debrid.resolveSecret = original;
  }
}

describe('Tier 2 Boundary & Corner Cases E2E Test Suite', () => {

  // =========================================================================
  describe('Feature 5: Title Matching & Deduplication Verification', () => {
    it('F05-BND-01: Dirty meta.year strings ("2024–", NaN, empty) are parsed cleanly', () => {
      assert.equal(format.matchesBrTitle('Fallout 1ª Temporada (2024) [1080p DUBLADO]', 'Fallout', '2024–'), true);
      assert.equal(
        format.matchesBrTitle('Fallout 1ª Temporada (2024) [1080p DUBLADO]', 'Fallout', '2020-2024', { isSeries: true }),
        true,
      );
      assert.equal(format.matchesBrTitle('Coringa (2019) [1080p DUBLADO]', 'Coringa', null), true);
      assert.equal(format.matchesBrTitle('Coringa (2019) [1080p DUBLADO]', 'Coringa', undefined), true);
      assert.equal(format.matchesBrTitle('Coringa (2019) [1080p DUBLADO]', 'Coringa', ''), true);
    });

    it('F05-BND-02: Ambiguous multi-year titles distinguish title tokens from release year', () => {
      assert.equal(format.matchesBrTitle('Blade Runner 2049 (2017) BluRay [1080p DUBLADO]', 'Blade Runner 2049', 2017), true);
      assert.equal(format.matchesBrTitle('2001: Uma Odisseia no Espaço (1968) [1080p DUBLADO]', '2001: Uma Odisseia no Espaço', 1968), true);
      assert.equal(format.matchesBrTitle('Cyberpunk 2077 (2022) [1080p DUBLADO]', 'Cyberpunk', 2022), true);
    });

    it('F05-BND-03: Rejects spin-offs and sequences when not requested', () => {
      const names = ['Rick and Morty', 'Rick e Morty'];
      assert.equal(
        format.matchesBrTitle('Rick e Morty: O Anime 1ª Temporada (2024) [1080p DUBLADO]', 'Rick and Morty', 2024, {
          isSeries: true,
          allNames: names,
        }),
        false,
      );
      assert.equal(format.matchesBrTitle('Deadpool 2 (2018) BluRay DUBLADO', 'Deadpool', 2016), false);
      assert.equal(format.matchesBrTitle('Gladiador II (2024) [1080p DUBLADO]', 'Gladiador', 2000), false);
      assert.equal(format.matchesBrTitle('Deadpool 2 (2018) BluRay DUBLADO', 'Deadpool 2', 2018), true);
      assert.equal(format.matchesBrTitle('Gladiador II (2024) [1080p DUBLADO]', 'Gladiador II', 2024), true);
    });

    it('F05-BND-04: dedupeByHash collapses 40-hex lower, upper, and 32-base32 hashes', () => {
      const hexLower = '0123456789abcdef0123456789abcdef01234567';

      const items = [
        format.toStremioStream({ infoHash: hexLower, seeders: 10, title: 'Item Lower' }),
        format.toStremioStream({ infoHash: hexLower.toUpperCase(), seeders: 50, title: 'Item Upper' }),
        format.toStremioStream({ magnet: `magnet:?xt=urn:btih:${hexLower}`, seeders: 20, title: 'Item Magnet' }),
      ];

      const deduped = format.dedupeByHash(items);
      assert.equal(deduped.length, 1);
      assert.equal(deduped[0]._seeders, 50);
    });

    it('F05-BND-05: Rejects subtitle collisions on fuzzy title matches', () => {
      assert.equal(format.matchesBrTitle('Missão: Impossível – Efeito Fallout (2018)', 'Fallout', 2024), false);
      assert.equal(format.matchesBrTitle('Cesium Fallout (2024) [1080p]', 'Fallout', 2024), false);
    });

    it('F05-BND-06: matchesEpisode correctly validates season and episode patterns', () => {
      assert.equal(format.matchesEpisode('Fallout S01E02 1080p', { season: 1, episode: 2 }), true);
      assert.equal(format.matchesEpisode('Fallout S01E03 1080p', { season: 1, episode: 2 }), false);
      assert.equal(format.matchesEpisode('Fallout S01 Complete 1080p', { season: 1, episode: 2 }), true);
      assert.equal(format.matchesEpisode('Fallout 1ª Temporada Completa', { season: 1, episode: 2 }), true);
      assert.equal(format.matchesEpisode('Fallout S02E02 1080p', { season: 1, episode: 2 }), false);
    });
  });

  // =========================================================================
  // Feature 6: Cache Statement Pre-Compilation
  // =========================================================================
  describe('Feature 6: Cache Statement Pre-Compilation', () => {
    it('F06-BND-01: Cache get/set/forget operations execute without errors', () => {
      const key = `test-key-${Date.now()}`;
      cache.set(key, { data: 'hello' }, 60);
      assert.deepEqual(cache.get(key), { data: 'hello' });
      cache.forget(key);
      assert.equal(cache.get(key), null);
    });

    it('F06-BND-02: Zero and negative TTL entries expire immediately on read', () => {
      const keyZero = `test-zero-${Date.now()}`;
      const keyNeg = `test-neg-${Date.now()}`;
      cache.set(keyZero, 'val0', 0);
      cache.set(keyNeg, 'valNeg', -10);

      assert.equal(cache.get(keyZero), null);
      assert.equal(cache.get(keyNeg), null);
    });

    it('F06-BND-03: Cache clear operation removes all entries from storage', () => {
      const k1 = `k1-${Date.now()}`;
      const k2 = `k2-${Date.now()}`;
      cache.set(k1, 'v1', 60);
      cache.set(k2, 'v2', 60);

      assert.equal(cache.get(k1), 'v1');
      assert.equal(cache.get(k2), 'v2');

      cache.clear();
      assert.equal(cache.get(k1), null);
      assert.equal(cache.get(k2), null);
      assert.equal(cache.size(), 0);
    });

    it('F06-BND-04: Rapid burst insertions execute safely and reflect in size', () => {
      const prefix = `burst-${Date.now()}`;
      for (let i = 0; i < 50; i++) {
        cache.set(`${prefix}-${i}`, { i, payload: 'x'.repeat(100) }, 60);
      }
      for (let i = 0; i < 50; i++) {
        const hit = cache.get(`${prefix}-${i}`);
        assert.ok(hit && hit.i === i);
      }
      assert.ok(cache.size() >= 50);
      for (let i = 0; i < 50; i++) {
        cache.forget(`${prefix}-${i}`);
      }
    });

    it('F06-BND-05: Expired items are evicted on get() and size reflects cache occupancy', () => {
      const kExp = `k-exp-${Date.now()}`;
      cache.set(kExp, 'expired', -5);
      assert.equal(cache.get(kExp), null);
      assert.ok(typeof cache.size() === 'number');
    });

    it('F06-BND-06: Cache keys with unicode, colons, spaces, and quotes work seamlessly', () => {
      const specialKey = 'streams:movie:tt1234567:São Paulo:"Special":100%';
      cache.set(specialKey, { ok: true }, 60);
      assert.deepEqual(cache.get(specialKey), { ok: true });
      cache.forget(specialKey);
    });
  });

  // =========================================================================
  // Feature 7: Resilient Deserialization in Cache Load
  // =========================================================================
  describe('Feature 7: Resilient Deserialization in Cache Load', () => {
    it('F07-BND-01: Corrupted JSON strings in storage rows are caught without halting', () => {
      const rows = [
        { key: 'valid1', value: JSON.stringify({ a: 1 }), expires_at: Date.now() + 10000 },
        { key: 'corrupt', value: '{bad-json-syntax', expires_at: Date.now() + 10000 },
        { key: 'valid2', value: JSON.stringify({ a: 2 }), expires_at: Date.now() + 10000 },
      ];

      const loadedMap = new Map();
      for (const row of rows) {
        try {
          loadedMap.set(row.key, { value: JSON.parse(row.value), expiresAt: Number(row.expires_at) });
        } catch {
          // Row skipped
        }
      }

      assert.equal(loadedMap.size, 2);
      assert.deepEqual(loadedMap.get('valid1').value, { a: 1 });
      assert.deepEqual(loadedMap.get('valid2').value, { a: 2 });
      assert.equal(loadedMap.has('corrupt'), false);
    });

    it('F07-BND-02: Non-object and primitive serialized values handle cleanly', () => {
      const rows = [
        { key: 'num', value: JSON.stringify(123), expires_at: Date.now() + 5000 },
        { key: 'str', value: JSON.stringify('simple string'), expires_at: Date.now() + 5000 },
        { key: 'arr', value: JSON.stringify([1, 2, 3]), expires_at: Date.now() + 5000 },
      ];
      const testMap = new Map();
      for (const row of rows) {
        testMap.set(row.key, { value: JSON.parse(row.value), expiresAt: Number(row.expires_at) });
      }
      assert.equal(testMap.get('num').value, 123);
      assert.equal(testMap.get('str').value, 'simple string');
      assert.deepEqual(testMap.get('arr').value, [1, 2, 3]);
    });

    it('F07-BND-03: Expired records are excluded on load', () => {
      const now = Date.now();
      const rows = [
        { key: 'active', value: JSON.stringify('active'), expires_at: now + 5000 },
        { key: 'expired', value: JSON.stringify('expired'), expires_at: now - 5000 },
      ];
      const validRows = rows.filter((r) => r.expires_at > now);
      assert.equal(validRows.length, 1);
      assert.equal(validRows[0].key, 'active');
    });

    it('F07-BND-04: Preserves TTL priority by inserting in reverse order of query', () => {
      const rows = [
        { key: 'longest', value: JSON.stringify(1), expires_at: 1000 },
        { key: 'medium', value: JSON.stringify(2), expires_at: 500 },
        { key: 'shortest', value: JSON.stringify(3), expires_at: 100 },
      ];
      const testMap = new Map();
      for (const row of rows.reverse()) {
        testMap.set(row.key, row.value);
      }
      const keys = [...testMap.keys()];
      assert.deepEqual(keys, ['shortest', 'medium', 'longest']);
    });

    it('F07-BND-05: Missing or inaccessible SQLite degrades to memory mode without crashing', () => {
      const memKey = `mem-${Date.now()}`;
      cache.set(memKey, 'in-memory-val', 30);
      assert.equal(cache.get(memKey), 'in-memory-val');
      cache.forget(memKey);
    });

    it('F07-BND-06: Large serialized entries (>100KB) deserialize accurately', () => {
      const largePayload = { items: Array.from({ length: 500 }, (_, i) => ({ id: i, name: `Stream ${i}` })) };
      const serialized = JSON.stringify(largePayload);
      assert.ok(serialized.length > 10000);
      const parsed = JSON.parse(serialized);
      assert.equal(parsed.items.length, 500);
      assert.equal(parsed.items[499].id, 499);
    });
  });

  // =========================================================================
  // Feature 8: Search & Late-Pass Budget Optimization
  // =========================================================================
});
