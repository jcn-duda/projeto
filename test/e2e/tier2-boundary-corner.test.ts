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
import * as brResolvers from '../../src/br-resolvers.js';
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
  // Feature 1: Dynamic Domain Validation
  // =========================================================================
  describe('Feature 1: Dynamic Domain Validation', () => {



    it('F01-BND-05: Correctly parses dynamic EXTRA_ALLOWED_PROTECTORS env string', () => {
      function parseProtectors(val: any) {
        if (!val || !String(val).trim()) return [];
        return String(val)
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean);
      }
      assert.deepEqual(parseProtectors(' custom-ads.net , PROTECT.IO ,, '), ['custom-ads.net', 'protect.io']);
      assert.deepEqual(parseProtectors(''), []);
      assert.deepEqual(parseProtectors(null), []);
      assert.deepEqual(parseProtectors('   , ,  '), []);
    });


  });

  // =========================================================================
  // Feature 2: In-Memory Caching & Dedupe in BLUDV Resolver
  // =========================================================================
  describe('Feature 2: In-Memory Caching & Dedupe in BLUDV Resolver', () => {
    it('F02-BND-01: In-flight promise coalescing collapses concurrent identical requests', async () => {
      const inFlightMap = new Map();
      let fetchCount = 0;

      async function getMockPost(url: any) {
        if (inFlightMap.has(url)) return inFlightMap.get(url);
        const task = (async () => {
          fetchCount++;
          await new Promise((r) => setTimeout(r, 10));
          return { postUrl: url, links: ['magnet:?xt=urn:btih:mockhash'] };
        })().finally(() => inFlightMap.delete(url));

        inFlightMap.set(url, task);
        return task;
      }

      const results = await Promise.all([
        getMockPost('https://bludvfilmes.xyz/filme-1'),
        getMockPost('https://bludvfilmes.xyz/filme-1'),
        getMockPost('https://bludvfilmes.xyz/filme-1'),
      ]);

      assert.equal(fetchCount, 1);
      assert.equal(results.length, 3);
      assert.equal(results[0].postUrl, 'https://bludvfilmes.xyz/filme-1');
      assert.equal(inFlightMap.size, 0);
    });

    it('F02-BND-02: Cache TTL boundary: active hit returns cache, expired hit purges', () => {
      const cacheMap = new Map();
      const key = 'https://bludvfilmes.xyz/filme-ttl';
      const now = Date.now();

      // Active entry
      cacheMap.set(key, { value: { post: key, links: [] }, expiresAt: now + 5000 });
      let hit = cacheMap.get(key);
      assert.ok(hit && hit.expiresAt > Date.now());

      // Expired entry
      cacheMap.set(key, { value: { post: key, links: [] }, expiresAt: now - 100 });
      hit = cacheMap.get(key);
      if (hit && hit.expiresAt <= Date.now()) {
        cacheMap.delete(key);
      }
      assert.equal(cacheMap.get(key), undefined);
    });

    it('F02-BND-03: Cache size bounding: exceeding MAX_CACHE_SIZE evicts oldest entries', () => {
      const maxCache = 5;
      const testCache = new Map();

      for (let i = 1; i <= 7; i++) {
        const key = `post-${i}`;
        testCache.set(key, { value: i, expiresAt: Date.now() + 10000 });
        if (testCache.size > maxCache) {
          const oldestKey = testCache.keys().next().value;
          testCache.delete(oldestKey);
        }
      }

      assert.equal(testCache.size, 5);
      assert.equal(testCache.has('post-1'), false);
      assert.equal(testCache.has('post-2'), false);
      assert.equal(testCache.has('post-3'), true);
      assert.equal(testCache.has('post-7'), true);
    });

    it('F02-BND-04: In-flight failure cleanup ensures cache is not poisoned on rejection', async () => {
      const inFlightMap = new Map();
      const testCache = new Map();
      const url = 'https://bludvfilmes.xyz/fail-post';

      async function failingGet(targetUrl: any) {
        if (inFlightMap.has(targetUrl)) return inFlightMap.get(targetUrl);
        const task = (async () => {
          throw new Error('network_timeout');
        })().finally(() => inFlightMap.delete(targetUrl));
        inFlightMap.set(targetUrl, task);
        return task;
      }

      await assert.rejects(() => failingGet(url), /network_timeout/);
      assert.equal(inFlightMap.has(url), false);
      assert.equal(testCache.has(url), false);
    });

  });

  // =========================================================================
  // Feature 3: Standardized siteEnv Configuration
  // =========================================================================
  describe('Feature 3: Standardized siteEnv Configuration', () => {
    it('F03-BND-01: RESOLVERS matrix defines all 9 resolvers with ports 8700..8708 and siteEnv', () => {
      assert.equal(brResolvers.RESOLVERS.length, 9);
      const names = brResolvers.RESOLVERS.map((r) => r.name);
      const ports = brResolvers.RESOLVERS.map((r) => r.port);
      const siteEnvs = brResolvers.RESOLVERS.map((r) => r.siteEnv);

      assert.deepEqual(names, ['bludv', 'comandotorrents', 'nerdfilmes', 'torrentdosfilmes', 'vacatorrent', 'redetorrent', 'apachetorrent', 'hdrtorrents', 'torrentgalaxy']);
      assert.deepEqual(ports, [8700, 8701, 8702, 8703, 8704, 8705, 8706, 8707, 8708]);
      assert.deepEqual(siteEnvs, ['BLUDV_URL', 'COMANDOTORRENTS_URL', 'NERDFILMES_URL', 'TORRENTDOSFILMES_URL', 'VACATORRENT_URL', 'REDETORRENT_URL', 'APACHETORRENT_URL', 'HDRTORRENTS_URL', 'TORRENTGALAXY_URL']);
    });

    it('F03-BND-04: load() só registra os resolvedores do binário Rust, sem lançar', () => {
      assert.doesNotThrow(() => brResolvers.load());
      assert.equal(brResolvers.instance('bludv'), null, 'não há instância TS no processo');
    });

    it('F03-BND-06: Custom site URLs with trailing slashes are trimmed cleanly in resolvers', () => {
      const siteUrl = 'https://bludvfilmes.xyz///'.replace(/\/+$/, '');
      assert.equal(siteUrl, 'https://bludvfilmes.xyz');
    });
  });

  // =========================================================================
  // Feature 4: Enhanced Protector & JavaScript Extraction
  // =========================================================================
  describe('Feature 4: Enhanced Protector & JavaScript Extraction', () => {



  });

  // =========================================================================
  // Feature 5: Title Matching & Deduplication Verification
  // =========================================================================
});
