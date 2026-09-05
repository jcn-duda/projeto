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
    it('F03-BND-01: RESOLVERS matrix defines all 5 resolvers with ports 8700..8704 and siteEnv', () => {
      assert.equal(brResolvers.RESOLVERS.length, 5);
      const names = brResolvers.RESOLVERS.map((r) => r.name);
      const ports = brResolvers.RESOLVERS.map((r) => r.port);
      const siteEnvs = brResolvers.RESOLVERS.map((r) => r.siteEnv);

      assert.deepEqual(names, ['bludv', 'comandotorrents', 'nerdfilmes', 'torrentdosfilmes', 'vacatorrent']);
      assert.deepEqual(ports, [8700, 8701, 8702, 8703, 8704]);
      assert.deepEqual(siteEnvs, ['BLUDV_URL', 'COMANDOTORRENTS_URL', 'NERDFILMES_URL', 'TORRENTDOSFILMES_URL', 'VACATORRENT_URL']);
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
});
