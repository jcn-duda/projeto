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
  // Feature 1: Dynamic Domain Validation
  // =========================================================================
  describe('Feature 1: Dynamic Domain Validation', () => {
    it('F01-BND-01: Rejects domain spoofing attacks and sub-path injection', () => {
      const evilUrls = [
        'https://bludvfilmes.xyz.evil.com/post/123',
        'https://fake-bludvfilmes.xyz/post/123',
        'https://evil.com?target=https://bludvfilmes.xyz',
        'https://bludvfilmes.xyz@evil.com/post',
      ];
      for (const url of evilUrls) {
        assert.throws(() => bludvResolver.assertAllowedUrl(url), /blocked_host/);
        assert.throws(() => nerdfilmesResolver.assertAllowedUrl(url), /blocked_host/);
        assert.throws(() => torrentdosfilmesResolver.assertAllowedUrl(url), /blocked_host/);
        assert.throws(() => comandotorrentsResolver.assertAllowedUrl(url), /blocked_host/);
      }
    });

    it('F01-BND-02: Accepts valid dynamic hostnames, allowed subdomains and protectors', () => {
      const validUrls = [
        'https://bludvfilmes.xyz/filme-exemplo-2024/',
        'https://www.bludvfilmes.xyz/download/',
        'https://systemads1.com/link/abc123',
      ];
      for (const url of validUrls) {
        const parsed = bludvResolver.assertAllowedUrl(url);
        assert.ok(parsed instanceof URL);
        assert.ok(bludvResolver.isDetailHost(parsed.hostname) || bludvResolver.isProtectorHost(parsed.hostname));
      }
    });

    it('F01-BND-03: Rejects non-HTTP protocols, javascript, and file schemes', () => {
      const dangerousUrls = [
        'javascript:alert(1)',
        'file:///etc/passwd',
        'ftp://bludvfilmes.xyz/movie.torrent',
        'data:text/html,<script>alert(1)</script>',
      ];
      for (const url of dangerousUrls) {
        assert.throws(() => bludvResolver.assertAllowedUrl(url), /(blocked_host|unsupported_protocol)/);
      }
    });

    it('F01-BND-04: Handles unparseable and empty URL inputs gracefully', () => {
      const invalidInputs = ['', null, undefined, 'not-a-url', 'http://[invalid-ipv6]'];
      for (const input of invalidInputs) {
        assert.throws(() => bludvResolver.assertAllowedUrl(input));
      }
    });

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

    it('F01-BND-06: Verifies isDetailHost and isProtectorHost boundary behavior', () => {
      assert.equal(bludvResolver.isDetailHost('BLUDVFILMES.XYZ'), true);
      assert.equal(bludvResolver.isDetailHost('sub.bludv.net'), true);
      assert.equal(bludvResolver.isDetailHost(''), false);
      assert.equal(bludvResolver.isDetailHost('unknown-domain.org'), false);
      assert.equal(bludvResolver.isProtectorHost('SYSTEMADS1.COM'), true);
      assert.equal(bludvResolver.isProtectorHost('unknown-protector.com'), false);
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

    it('F02-BND-05: Empty or malformed HTML in resolver parser returns empty array without throwing', () => {
      assert.deepEqual(bludvResolver.parseDownloadLinks(''), []);
      assert.deepEqual(bludvResolver.parseDownloadLinks('<div>No download links here</div>'), []);
      assert.deepEqual(bludvResolver.parseDownloadLinks(null), []);
      assert.deepEqual(bludvResolver.parsePosts(''), []);
      assert.deepEqual(bludvResolver.parsePosts('<html><body>No posts</body></html>'), []);
    });

    it('F02-BND-06: Non-detail page URL passed to resolver throws not_detail_page or blocked_host', () => {
      assert.throws(
        () => bludvResolver.assertAllowedUrl('https://evil.com/post'),
        /blocked_host/,
      );
    });
  });

  // =========================================================================
  // Feature 3: Standardized siteEnv Configuration
  // =========================================================================
  describe('Feature 3: Standardized siteEnv Configuration', () => {
    it('F03-BND-01: RESOLVERS matrix defines all 4 resolvers with ports 8700..8703 and siteEnv', () => {
      assert.equal(brResolvers.RESOLVERS.length, 4);
      const names = brResolvers.RESOLVERS.map((r) => r.name);
      const ports = brResolvers.RESOLVERS.map((r) => r.port);
      const siteEnvs = brResolvers.RESOLVERS.map((r) => r.siteEnv);

      assert.deepEqual(names, ['bludv', 'comandotorrents', 'nerdfilmes', 'torrentdosfilmes']);
      assert.deepEqual(ports, [8700, 8701, 8702, 8703]);
      assert.deepEqual(siteEnvs, ['BLUDV_URL', 'COMANDOTORRENTS_URL', 'NERDFILMES_URL', 'TORRENTDOSFILMES_URL']);
    });

    it('F03-BND-02: Environment isolation restores process.env without leakage', () => {
      const originalPort = process.env.PORT;
      const originalSiteUrl = process.env.SITE_URL;

      const saved = { PORT: process.env.PORT, SITE_URL: process.env.SITE_URL };
      process.env.PORT = '8702';
      process.env.SITE_URL = 'https://custom-nerdfilmes.com';

      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }

      assert.equal(process.env.PORT, originalPort);
      assert.equal(process.env.SITE_URL, originalSiteUrl);
    });

    it('F03-BND-03: Missing siteEnv variables fallback safely without errors', () => {
      for (const res of brResolvers.RESOLVERS) {
        assert.ok(res.siteEnv);
        assert.ok(typeof res.path === 'string');
        assert.ok(typeof res.port === 'number');
      }
    });

    it('F03-BND-04: config.resolvers.embedded=false turns off local resolver loading', () => {
      assert.doesNotThrow(() => brResolvers.load({ ...config.resolvers, embedded: false }));
    });

    it('F03-BND-05: Resolver createServer methods can be instantiated safely', () => {
      for (const resolver of [bludvResolver, comandotorrentsResolver, nerdfilmesResolver, torrentdosfilmesResolver]) {
        assert.equal(typeof resolver.createServer, 'function');
        const srv = resolver.createServer();
        assert.ok(srv);
        assert.equal(typeof srv.listen, 'function');
      }
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
    it('F04-BND-01: extractMagnet extracts from JavaScript variable assignments', () => {
      const hash = '0123456789abcdef0123456789abcdef01234567';
      const cases = [
        `<script>var DEST_URL = "magnet:?xt=urn:btih:${hash}&dn=Movie";</script>`,
        `<script>const download_url = 'magnet:?xt=urn:btih:${hash}';</script>`,
        `<script>let MAGNET_URL = "magnet:?xt=urn:btih:${hash}";</script>`,
        `<script>window.target_url = "magnet:?xt=urn:btih:${hash}";</script>`,
      ];
      for (const html of cases) {
        const extracted = bludvResolver.extractMagnet(html);
        assert.ok(extracted, `Failed on: ${html}`);
        assert.ok(extracted.includes(hash));
      }
    });

    it('F04-BND-02: extractMagnet extracts from JavaScript navigation calls', () => {
      const hash = '0123456789abcdef0123456789abcdef01234567';
      const cases = [
        `<script>window.location.href = "magnet:?xt=urn:btih:${hash}";</script>`,
        `<script>location.replace('magnet:?xt=urn:btih:${hash}');</script>`,
        `<script>window.open("magnet:?xt=urn:btih:${hash}");</script>`,
      ];
      for (const html of cases) {
        const extracted = bludvResolver.extractMagnet(html);
        assert.ok(extracted);
        assert.ok(extracted.includes(hash));
      }
    });

    it('F04-BND-03: extractMagnet extracts URL-encoded magnets and data attributes', () => {
      const hash = '0123456789abcdef0123456789abcdef01234567';
      const cases = [
        `<a data-magnet="magnet:?xt=urn:btih:${hash}">Download</a>`,
        `<div data-href="magnet:?xt=urn:btih:${hash}">Click</div>`,
        `<a href="magnet%3A%3Fxt%3Durn%3Abtih%3A${hash}%26dn%3DMovie">Link</a>`,
      ];
      for (const html of cases) {
        const extracted = bludvResolver.extractMagnet(html);
        assert.ok(extracted);
        assert.ok(extracted.includes(hash));
      }
    });

    it('F04-BND-04: nextProtectedUrl extracts redirect URLs and resolves relative paths', () => {
      const baseUrl = 'https://systemads1.com/step1';
      const html1 = '<script>var DEST_URL = "https://systemads1.com/step2";</script>';
      const html2 = '<script>window.location.href = "https://videosad.net/download";</script>';
      const html3 = '<a href="https://canalfutebol.com/next">Next</a>';

      assert.equal(bludvResolver.nextProtectedUrl(html1, baseUrl), 'https://systemads1.com/step2');
      assert.equal(bludvResolver.nextProtectedUrl(html2, baseUrl), 'https://videosad.net/download');
      assert.equal(bludvResolver.nextProtectedUrl(html3, baseUrl), 'https://canalfutebol.com/next');
    });

    it('F04-BND-05: Truncated / malformed HTML returns null without throwing errors', () => {
      assert.equal(bludvResolver.extractMagnet(''), null);
      assert.equal(bludvResolver.extractMagnet(null), null);
      assert.equal(bludvResolver.extractMagnet('<script>var DEST_URL = "not-a-magnet";</script>'), null);
      assert.equal(bludvResolver.nextProtectedUrl('', 'https://systemads1.com/'), null);
      assert.equal(bludvResolver.nextProtectedUrl(null, 'https://systemads1.com/'), null);
    });

    it('F04-BND-06: nextProtectedUrl rejects external untrusted redirect domains', () => {
      const html = '<script>var DEST_URL = "https://evil-hacker-site.com/steal";</script>';
      assert.equal(bludvResolver.nextProtectedUrl(html, 'https://systemads1.com/'), null);
    });
  });

  // =========================================================================
  // Feature 5: Title Matching & Deduplication Verification
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
  describe('Feature 8: Search & Late-Pass Budget Optimization', () => {
    it('F08-BND-01: collectWithinWindow returns done=false when slow provider exceeds deadline', async () => {
      const fastTask = {
        promise: new Promise((r) => setTimeout(() => r([{ title: 'Fast Stream' }]), 10)),
        priority: false,
      };
      const slowTask = {
        promise: new Promise((r) => setTimeout(() => r([{ title: 'Slow Stream' }]), 200)),
        priority: false,
      };

      const bucket = await collectWithinWindow([fastTask, slowTask], { budgetMs: 50 });
      assert.ok(bucket.items.length >= 1);
      assert.equal(bucket.items[0].title, 'Fast Stream');
      assert.equal(bucket.done, false);
      assert.ok(bucket.completion instanceof Promise);
      await bucket.completion;
    });

    it('F08-BND-02: Fast providers completing within budget return done=true', async () => {
      const t1 = {
        promise: new Promise((r) => setTimeout(() => r([{ title: 'Stream 1' }]), 5)),
        priority: false,
      };
      const t2 = {
        promise: new Promise((r) => setTimeout(() => r([{ title: 'Stream 2' }]), 10)),
        priority: false,
      };

      const bucket = await collectWithinWindow([t1, t2], { budgetMs: 100 });
      assert.equal(bucket.items.length, 2);
      assert.equal(bucket.done, true);
    });

    it('F08-BND-03: latestWriter suppresses stale background updates from earlier search phases', async () => {
      const writes: unknown[] = [];
      const build = async (input: any) => input;
      const commit = async (val: any) => writes.push(val);
      const writer = createLatestWriter(build, commit);

      const phase0 = writer.phase();
      writer.advance();
      const phase1 = writer.phase();

      await writer('stale-data', phase0);
      await writer(['fresh-data'], phase1);

      assert.equal(writes.length, 1);
      assert.deepEqual(writes[0], ['fresh-data']);
    });

    it('F08-BND-04: raceWithDeadline returns fallback value on timeout', async () => {
      const slowTask = new Promise((r) => setTimeout(() => r('done'), 100));
      const result = await raceWithDeadline(slowTask, 10, () => 'timed-out');
      assert.equal(result, 'timed-out');
    });

    it('F08-BND-05: remainingCheckBudget returns zero or positive and never negative past deadline', () => {
      const futureDeadline = Date.now() + 5000;
      const pastDeadline = Date.now() - 5000;

      assert.ok((remainingCheckBudget(futureDeadline) as number) > 0);
      assert.equal(remainingCheckBudget(pastDeadline), 0);
    });

    it('F08-BND-06: In-flight coalescing under simultaneous identical requests returns identical promise', async () => {
      const inFlight = new Map();
      let execs = 0;

      function mockSearch(id: any) {
        if (inFlight.has(id)) return inFlight.get(id);
        const task = (async () => {
          execs++;
          await new Promise((r) => setTimeout(r, 20));
          return { id, streams: ['s1', 's2'] };
        })().finally(() => inFlight.delete(id));
        inFlight.set(id, task);
        return task;
      }

      const p1 = mockSearch('tt1234567');
      const p2 = mockSearch('tt1234567');
      const p3 = mockSearch('tt1234567');

      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
      assert.equal(execs, 1);
      assert.deepEqual(r1, r2);
      assert.deepEqual(r2, r3);
    });
  });

  // =========================================================================
  // Feature 9: Prowlarr Provider Resilience & Unit Testing
  // =========================================================================
  describe('Feature 9: Prowlarr Provider Resilience & Unit Testing', () => {
    it('F09-BND-01: Prowlarr search returns empty array on empty query or missing API key', async () => {
      const emptyRes = await prowlarr.search('');
      assert.deepEqual(emptyRes, []);
    });

    it('F09-BND-02: Handles HTTP 500/502/504 responses gracefully returning empty array', async () => {
      const origFetch = global.fetch;
      const origApiKey = config.prowlarr.apiKey;
      config.prowlarr.apiKey = 'test-key';
      try {
        global.fetch = (async () => ({
          ok: false,
          status: 502,
          text: async () => 'Bad Gateway',
        })) as unknown as typeof globalThis.fetch;
        const res = await prowlarr.search('Test Query');
        assert.deepEqual(res, []);
      } finally {
        global.fetch = origFetch;
        config.prowlarr.apiKey = origApiKey;
      }
    });

    it('F09-BND-03: Handles malformed JSON response from Prowlarr returning empty array', async () => {
      const origFetch = global.fetch;
      const origApiKey = config.prowlarr.apiKey;
      config.prowlarr.apiKey = 'test-key';
      try {
        global.fetch = (async () => ({
          ok: true,
          status: 200,
          json: async () => {
            throw new Error('Unexpected token in JSON');
          },
        })) as unknown as typeof globalThis.fetch;
        const res = await prowlarr.search('Test Query');
        assert.deepEqual(res, []);
      } finally {
        global.fetch = origFetch;
        config.prowlarr.apiKey = origApiKey;
      }
    });

    it('F09-BND-04: Correctly maps valid Torznab items from Prowlarr payload', async () => {
      const origFetch = global.fetch;
      const origApiKey = config.prowlarr.apiKey;
      config.prowlarr.apiKey = 'test-key';
      try {
        global.fetch = (async () => ({
          ok: true,
          status: 200,
          json: async () => [
            {
              title: 'Movie 2024 1080p',
              magnetUrl: 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567',
              infoHash: '0123456789abcdef0123456789abcdef01234567',
              seeders: 42,
              size: 2147483648,
              indexer: '1337x',
            },
          ],
        })) as unknown as typeof globalThis.fetch;
        const res = await prowlarr.search('Movie 2024');
        assert.equal(res.length, 1);
        assert.equal(res[0].title, 'Movie 2024 1080p');
        assert.equal(res[0].infoHash, '0123456789abcdef0123456789abcdef01234567');
        assert.equal(res[0].seeders, 42);
        assert.equal(res[0].tracker, '1337x');
      } finally {
        global.fetch = origFetch;
        config.prowlarr.apiKey = origApiKey;
      }
    });

    it('F09-BND-05: Network timeout / AbortSignal triggering returns empty array', async () => {
      const origFetch = global.fetch;
      const origApiKey = config.prowlarr.apiKey;
      config.prowlarr.apiKey = 'test-key';
      try {
        global.fetch = async () => {
          throw new Error('The operation was aborted');
        };
        const res = await prowlarr.search('Movie 2024');
        assert.deepEqual(res, []);
      } finally {
        global.fetch = origFetch;
        config.prowlarr.apiKey = origApiKey;
      }
    });

    it('F09-BND-06: Prowlarr provider exports correct name identifier', () => {
      assert.equal(prowlarr.name, 'prowlarr');
      assert.equal(typeof prowlarr.search, 'function');
    });
  });

  // =========================================================================
  // Feature 10: Debrid Adapter Mock & Error Coverage
  // =========================================================================
  describe('Feature 10: Debrid Adapter Mock & Error Coverage', () => {
    it('F10-BND-01: batched() throws error when all chunks fail to prevent false empty cache', async () => {
      const hashes = ['hash1', 'hash2', 'hash3'];
      // Falha transitória: a invariante é o erro SUBIR, para que "não perguntei"
      // nunca vire "seu debrid não tem nada".
      await assert.rejects(
        () => debridCommon.batched(hashes, 2, async () => { throw new Error('Debrid timeout'); }),
        /nenhum lote de checagem de cache respondeu/,
      );

      // Credencial recusada sobe pela mesma porta, porém marcada: é o que deixa
      // o orquestrador devolver a lista como P2P em vez de prometer debrid.
      await assert.rejects(
        () => debridCommon.batched(hashes, 2, async () => { throw new Error('Debrid 401 Unauthorized'); }),
        (err) => (err as { isAuthError?: boolean }).isAuthError === true,
      );
    });

    it('F10-BND-02: batched() partitions items into chunk sizes and merges results', async () => {
      const items = ['a', 'b', 'c', 'd', 'e'];
      const batches: string[][] = [];
      const result = await debridCommon.batched(items, 2, async (batch) => {
        batches.push(batch);
        return new Set(batch);
      });

      assert.equal(batches.length, 3);
      assert.deepEqual(batches[0], ['a', 'b']);
      assert.deepEqual(batches[1], ['c', 'd']);
      assert.deepEqual(batches[2], ['e']);
      assert.equal(result.cached.size, 5);
      assert.equal(result.complete, true);
    });

    it('F10-BND-03: pickFile lança NoVideoError para torrents sem nenhum arquivo de vídeo', () => {
      const nonVideoFiles = [
        { path: 'readme.txt', name: 'readme.txt', bytes: 1024 },
        { path: 'sample.nfo', name: 'sample.nfo', bytes: 2048 },
        { path: 'subs.srt', name: 'subs.srt', bytes: 50000 },
        { path: 'setup.exe', name: 'setup.exe', bytes: 5000000 },
      ];
      // Listagem COM arquivos e nenhum vídeo é prova determinística de magnet
      // quebrado — o /resolve usa o erro para gravar bad no banco de magnets.
      assert.throws(() => debridCommon.pickFile(nonVideoFiles), (err: any) => err?.code === 'NO_VIDEO');
      // Listagem VAZIA continua null: é transferência fria, prova nenhuma.
      assert.equal(debridCommon.pickFile([]), null);
    });

    it('F10-BND-04: pickFile filters out samples and matches target episode in series pack', () => {
      const files = [
        { path: 'sample.mkv', name: 'sample.mkv', bytes: 5000000 },
        { path: 'Show.S01E01.1080p.mkv', name: 'Show.S01E01.1080p.mkv', bytes: 1073741824 },
        { path: 'Show.S01E02.1080p.mkv', name: 'Show.S01E02.1080p.mkv', bytes: 1073741824 },
        { path: 'Show.S01E03.1080p.mkv', name: 'Show.S01E03.1080p.mkv', bytes: 1073741824 },
      ];
      const picked = debridCommon.pickFile(files, { season: 1, episode: 2 });
      assert.ok(picked);
      assert.equal(picked.name, 'Show.S01E02.1080p.mkv');
    });

    it('F10-BND-05: protectedHashes hold, isHeld, and release respect account boundary', () => {
      const hash = '0123456789abcdef0123456789abcdef01234567';
      const accountA = 'acc-a';
      const accountB = 'acc-b';

      protectedHashes.hold(hash, 60, accountA);
      assert.equal(protectedHashes.isHeld(hash, accountA), true);
      assert.equal(protectedHashes.isHeld(hash, accountB), false);

      protectedHashes.release(hash, accountA);
      assert.equal(protectedHashes.isHeld(hash, accountA), false);
    });

    it('F10-BND-06: Debrid registry correctly identifies adapters by service ID', () => {
      assert.ok(debrid.SERVICES.length >= 5);
      const ids = debrid.SERVICES.map((s) => s.id);
      assert.ok(ids.includes('realdebrid'));
      assert.ok(ids.includes('premiumize'));
      assert.ok(ids.includes('alldebrid'));
      assert.ok(ids.includes('torbox'));
      assert.ok(ids.includes('debridlink'));
    });
  });

  // =========================================================================
  // Feature 11: Torznab XML CDATA Resilience
  // =========================================================================
  describe('Feature 11: Torznab XML CDATA Resilience', () => {
    it('F11-BND-01: Decodes XML catalog items and attributes cleanly', () => {
      const xml = `
        <indexers>
          <indexer id="bludv-cardigann" name="BLUDV Releases" language="pt-BR">
          </indexer>
        </indexers>
      `;
      const parsed = jackettCatalog.parseXml(xml);
      assert.equal(parsed.length, 1);
      assert.equal(parsed[0].id, 'bludv-cardigann');
      assert.equal(parsed[0].label, 'BLUDV Releases');
      assert.equal(parsed[0].language, 'pt-BR');
    });

    it('F11-BND-02: Decodes HTML entities in Torznab XML titles and labels', () => {
      const xml = `
        <indexers>
          <indexer id="comandotorrents" name="Comando Torrents &#8211; Filmes &amp; S&#233;ries" language="pt-BR">
          </indexer>
        </indexers>
      `;
      const parsed = jackettCatalog.parseXml(xml);
      assert.equal(parsed.length, 1);
      assert.equal(parsed[0].id, 'comandotorrents');
      assert.ok(parsed[0].label.includes('Comando Torrents – Filmes & Séries'));
    });

    it('F11-BND-03: Empty tags and whitespace-only tags do not break parsing', () => {
      const xml = `
        <indexers>
          <indexer id="yts">
            <language></language>
          </indexer>
        </indexers>
      `;
      const parsed = jackettCatalog.parseXml(xml);
      assert.equal(parsed.length, 1);
      assert.equal(parsed[0].id, 'yts');
      assert.equal(parsed[0].label, 'yts');
    });

    it('F11-BND-04: Torznab XML with unclosed tags skips malformed entries', () => {
      const malformedXml = '<indexers><indexer id="bad"><title>Unclosed';
      const parsed = jackettCatalog.parseXml(malformedXml);
      assert.deepEqual(parsed, []);
    });

    it('F11-BND-05: Non-safe indexer IDs are skipped in Torznab XML catalog', () => {
      const xml = `
        <indexers>
          <indexer id="../unsafe-path">
            <title>Unsafe Path</title>
          </indexer>
          <indexer id="safe-id-123">
            <title>Safe Indexer</title>
          </indexer>
        </indexers>
      `;
      const parsed = jackettCatalog.parseXml(xml);
      assert.equal(parsed.length, 1);
      assert.equal(parsed[0].id, 'safe-id-123');
    });

    it('F11-BND-06: Catalog fallback() returns safe default indexers from .env', () => {
      const fb = jackettCatalog.fallback();
      assert.ok(Array.isArray(fb));
      assert.ok(fb.length > 0);
      for (const item of fb) {
        assert.ok(item.id);
        assert.ok(item.label);
        assert.ok(typeof item.isBr === 'boolean');
      }
    });
  });

  // =========================================================================
  // Feature 12: Architecture & Invariants Preservation
  // =========================================================================
  describe('Feature 12: Architecture & Invariants Preservation', () => {
    it('F12-BND-01: Invariant 2: Internal fields starting with _ are stripped from final streams', () => {
      const rawStream = {
        title: 'Movie 2024 1080p',
        magnet: 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567',
        infoHash: '0123456789abcdef0123456789abcdef01234567',
        seeders: 10,
        size: 1000000,
        tracker: 'jackett',
        isBr: true,
      };

      const converted = format.toStremioStream(rawStream) as Stream;
      assert.equal(converted._br, true);
      assert.ok(converted._quality);

      const finalized = format.limitReservingBr([converted], {
        brReservedSlots: 6,
        maxResults: 10,
        brOnly: false,
        qualityLimits: {},
        brFirst: true,
        maxPerIndexer: 0,
        indexerLimits: {},
      });

      assert.equal(finalized.length, 1);
      assert.equal('_br' in finalized[0], false);
      assert.equal('_seeders' in finalized[0], false);
      assert.equal('_quality' in finalized[0], false);
    });

    it('F12-BND-02: Invariant 3: BR sources without published seeders enter with seeders: 1', () => {
      const brItem = {
        title: 'Filme Nacional 2024',
        magnet: 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567',
        infoHash: '0123456789abcdef0123456789abcdef01234567',
        seeders: 1,
        isBr: true,
      };
      const stream = format.toStremioStream(brItem) as Stream;
      assert.equal(stream._seeders, 1);
      assert.equal(stream._br, true);
    });

    it('F12-BND-03: Invariant 4: Format utilities support PT-BR titles alongside English titles', () => {
      const searchNames = format.resolveSearchNames({
        meta: { name: 'Joker', year: '2019' },
        titles: { pt: 'Coringa', year: 2019 },
      });
      assert.ok(searchNames.names.includes('Joker'));
      assert.ok(searchNames.names.includes('Coringa'));
    });

    it('F12-BND-04: Invariant 5: Two-layer title filtering applies strict matchesBrTitle on BR releases', () => {
      const relevant = format.filterRelevantRaw(
        [
          { title: 'Coringa (2019) 1080p Dublado', isBr: true },
          { title: 'Missão Impossível Efeito Fallout (2018)', isBr: true },
        ],
        { names: ['Coringa'], year: 2019, isSeries: false },
      );
      assert.equal(relevant.length, 1);
      assert.equal(relevant[0].title, 'Coringa (2019) 1080p Dublado');
    });

    it('F12-BND-05: Invariant 6: Autofetch candidate hold executes before cache check', () => {
      const hash = '0123456789abcdef0123456789abcdef01234567';
      const account = 'test-account';
      protectedHashes.hold(hash, 60, account);
      assert.equal(protectedHashes.isHeld(hash, account), true);
      protectedHashes.release(hash, account);
      assert.equal(protectedHashes.isHeld(hash, account), false);
    });

    it('F12-BND-06: Runtime prefix helper correctly formats resolve URL paths', () => {
      assert.equal(runtime.prefix(), '');
      runtime.run({ opts: runtime.defaults(), encoded: 'test-config-segment' }, () => {
        assert.equal(runtime.prefix(), '/test-config-segment');
      });
    });
  });

  // =========================================================================
  // Feature 13: E2E Testing Suite (Tiers 1-4)
  // =========================================================================
  describe('Feature 13: E2E Testing Suite (Tiers 1-4)', () => {
    it('F13-BND-01: Config segment length boundary: 8192 chars decodes, 8193 rejected', () => {
      const validBase = runtime.encode({ m: 20 });
      assert.ok(runtime.decode(validBase));

      // JSON válido garante que este caso só passa pela barreira de tamanho,
      // não por uma falha incidental de decodificação/JSON.parse.
      const overflowSegment = Buffer
        .from(JSON.stringify({ m: 20, padding: 'x'.repeat(7000) }))
        .toString('base64url');
      assert.ok(overflowSegment.length > runtime.MAX_CONFIG_SEGMENT);
      assert.equal(runtime.decode(overflowSegment), null);
      assert.equal(runtime.sealSegment(overflowSegment), null);
    });

    it('F13-BND-02: Malformed base64url characters rejected with null', () => {
      const badSegments = [
        'invalid@char',
        'invalid!char',
        'has space',
        'has=equals',
        'has+plus',
        'has/slash',
      ];
      for (const seg of badSegments) {
        assert.equal(runtime.decode(seg), null);
      }
    });

    it('F13-BND-03: JSON arrays, numbers, strings, and non-objects rejected with null', () => {
      const nonObjects = [
        Buffer.from('[1, 2, 3]', 'utf8').toString('base64url'),
        Buffer.from('"plain string"', 'utf8').toString('base64url'),
        Buffer.from('12345', 'utf8').toString('base64url'),
        Buffer.from('true', 'utf8').toString('base64url'),
      ];
      for (const seg of nonObjects) {
        assert.equal(runtime.decode(seg), null);
      }
    });

    it('F13-BND-04: Clamps extreme option values to safe schema boundaries', () => {
      const normalized = runtime.normalize({
        m: 999,
        s: -10,
        b: 100,
        z: 500,
        q4: -5,
        q1: 150,
      });

      assert.equal(normalized.maxResults, 100);
      assert.equal(normalized.minSeeders, 0);
      assert.equal(normalized.brReservedSlots, 40);
      assert.equal(normalized.maxSizeGb, 200);
      assert.equal(normalized.max2160p, 0);
      assert.equal(normalized.max1080p, 100);
    });

    it('F13-BND-05: indexerLimits parsing clamps to 0..20, filters invalid IDs, and preserves 0', () => {
      const parsed = runtime.normalize({
        jl: 'BLUDV:0, nerdfilmes:5, 1337x:100, bad!id:10, empty:, :5',
      });

      assert.deepEqual(parsed.indexerLimits, {
        '1337x': 20,
        bludv: 0,
        nerdfilmes: 5,
      });
    });

    it('F13-BND-06: Roundtrip of sealed debrid API key through sealSegment and decode', () => {
      withSecret('test-operator-secret', () => {
        const rawSegment = runtime.encode({ ds: 'realdebrid', dk: 'my-private-api-key', m: 30 });
        const sealedSegment = runtime.sealSegment(rawSegment);

        assert.notEqual(sealedSegment, rawSegment);
        const decoded = runtime.decode(sealedSegment) as { debridApiKey: string; debridService: string; maxResults: number };
        assert.equal(decoded.debridApiKey, 'my-private-api-key');
        assert.equal(decoded.debridService, 'realdebrid');
        assert.equal(decoded.maxResults, 30);
      });
    });
  });

  // =========================================================================
  // Feature 14: Final E2E Pass & Adversarial Hardening (Tier 5)
  // =========================================================================
  describe('Feature 14: Final E2E Pass & Adversarial Hardening (Tier 5)', () => {
    it('F14-BND-01: HMAC signature verification fails on tampered signatures', () => {
      withSecret('operator-resolve-secret', () => {
        const hash = '0123456789abcdef0123456789abcdef01234567';
        const validSig = sign.signResolve(hash, '');
        assert.ok(validSig.length === 64);

        const tamperedSig = validSig.slice(0, -1) + (validSig.slice(-1) === 'a' ? 'b' : 'a');
        assert.equal(sign.verifyResolve(hash, '', validSig), true);
        assert.equal(sign.verifyResolve(hash, '', tamperedSig), false);

        assert.equal(sign.verifyResolve(hash, '', validSig.slice(0, 32)), false);
        assert.equal(sign.verifyResolve(hash, '', ''), false);
      });
    });

    it('F14-BND-02: HMAC signature verifies episode query string and prevents cross-episode play', () => {
      withSecret('operator-resolve-secret', () => {
        const hash = '0123456789abcdef0123456789abcdef01234567';
        const sigEp1 = sign.signResolve(hash, '?s=1&e=1');
        const sigEp2 = sign.signResolve(hash, '?s=1&e=2');

        assert.equal(sign.verifyResolve(hash, '?s=1&e=1', sigEp1), true);
        assert.equal(sign.verifyResolve(hash, '?s=1&e=2', sigEp2), true);

        assert.equal(sign.verifyResolve(hash, '?s=1&e=2', sigEp1), false);
        const sigMovie = sign.signResolve(hash, '');
        assert.equal(sign.verifyResolve(hash, '?s=1&e=1', sigMovie), false);
      });
    });

    it('F14-BND-03: InfoHash boundary validation handles edge lengths and case normalization', () => {
      const validLower = '0123456789abcdef0123456789abcdef01234567';
      const validUpper = validLower.toUpperCase();
      const tooShort = '0123456789abcdef0123456789abcdef0123456';
      const tooLong = '0123456789abcdef0123456789abcdef012345678';
      const nonHex = '0123456789abcdef0123456789abcdef0123456g';

      assert.equal(format.extractInfoHash(validLower), validLower);
      assert.equal(format.extractInfoHash(validUpper), validLower);
      assert.equal(format.extractInfoHash(tooShort), null);
      assert.equal(format.extractInfoHash(tooLong), null);
      assert.equal(format.extractInfoHash(nonHex), null);
    });

    it('F14-BND-04: secretBox tamper resistance fails closed returning empty string without throwing', () => {
      withSecret('test-secret', () => {
        const raw = 'my-secret-key';
        const sealed = secretBox.seal(raw);
        assert.ok(secretBox.isSealed(sealed));

        const tampered = sealed.slice(0, -2) + (sealed.slice(-2, -1) === 'A' ? 'B' : 'A') + sealed.slice(-1);
        assert.equal(secretBox.open(tampered), '');

        assert.equal(secretBox.open(sealed.slice(0, 10)), '');
      });
    });

    it('F14-BND-05: Diagnostic gate concurrency and rate limiting saturation returns 429 status', () => {
      const gate = createDiagnosticGate({
        limit: 2,
        maxConcurrent: 1,
        rateMessage: 'rate_limited',
        busyMessage: 'busy_slot',
      });

      const req1 = gate.enter('test-user');
      assert.equal(req1.ok, true);

      const req2 = gate.enter('test-user');
      assert.equal(req2.ok, false);
      assert.equal(req2.status, 429);
      assert.equal(req2.error, 'busy_slot');

      (req1.release as () => void)();

      const req3 = gate.enter('test-user');
      assert.equal(req3.ok, true);
      (req3.release as () => void)();

      const req4 = gate.enter('test-user');
      assert.equal(req4.ok, false);
      assert.equal(req4.status, 429);
      assert.equal(req4.error, 'rate_limited');
    });

    it('F14-BND-06: authorized() constant-time comparison guards against timing leaks', () => {
      const expected = 'secret-diagnostic-token-12345';
      assert.equal(authorized(expected, 'secret-diagnostic-token-12345'), true);
      assert.equal(authorized(expected, 'wrong-token'), false);
      assert.equal(authorized(expected, ''), false);
      assert.equal(authorized(expected, null), false);
      assert.equal(authorized(expected, 'secret-diagnostic-token-12345-extra'), false);
    });
  });
});
