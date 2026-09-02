// Rodada 2: checagem ligada.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';
import sdk from 'stremio-addon-sdk';
const { addonBuilder, getRouter } = sdk;

// Disable persistent cache database for clean in-memory test isolation
process.env.CACHE_PERSIST = 'false';

import config from '../../src/config.js';
import * as runtime from '../../src/runtime.js';
import debrid from '../../src/debrid/index.js';
import * as held from '../../src/debrid/protected.js';
import * as autofetch from '../../src/providers/autofetch.js';
import * as cache from '../../src/utils/cache.js';
import * as format from '../../src/utils/format.js';
import { signResolve, verifyResolve } from '../../src/utils/sign.js';
import * as secretBox from '../../src/utils/secret-box.js';
import { findStreams } from '../../src/providers/index.js';
import * as cinemeta from '../../src/utils/cinemeta.js';
import * as tmdb from '../../src/utils/tmdb.js';
import jackett from '../../src/providers/jackett.js';
import prowlarr from '../../src/providers/prowlarr.js';
import bludv from '../../src/providers/bludv.js';
import { accountScope, streamsCacheKey } from '../../src/utils/request-key.js';
import type { DebridAdapter } from '../../types/domain.js';

// Helper to create synthetic 40-character hex infoHashes
function makeHash(prefix: any, id = 1) {
  const seed = `${prefix}${id}`;
  return crypto.createHash('sha1').update(seed).digest('hex');
}

// Helper to create raw stream objects for testing
interface RawStreamOptions {
  infoHash?: string;
  name?: string;
  seeders?: number;
  sizeBytes?: number;
  isBr?: boolean;
  tracker?: string;
  _dubbed?: boolean;
  [key: string]: unknown;
}

function makeRawStream(title: string, options: RawStreamOptions = {}) {
  const hash = options.infoHash || makeHash(title);
  const sizeBytes = options.sizeBytes != null ? options.sizeBytes : 2 * 1024 * 1024 * 1024;
  return {
    title,
    name: options.name || title,
    infoHash: hash,
    magnet: `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title)}`,
    seeders: options.seeders != null ? options.seeders : 10,
    size: sizeBytes,
    isBr: options.isBr || false,
    tracker: options.tracker || (options.isBr ? 'bludv' : '1337x'),
    ...options,
  };
}

// Helper for asynchronous pauses
const sleep = (ms: any) => new Promise((resolve) => setTimeout(resolve, ms));

// `runtime.run` devolve unknown (o tipo do AsyncLocalStorage não propaga); o
// wrapper recebe o tipo do retorno no call site, sem cast espalhado.
const runWith = <T>(patch: object, fn: () => unknown) => runtime.run(patch, fn) as Promise<T>;

/**
 * Builds an isolated in-memory Express application replicating src/addon.js routing
 */
function createTestApp() {
  const manifest = {
    id: config.addonId,
    version: config.version,
    name: config.addonName,
    description: 'E2E test addon',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [],
    behaviorHints: { adult: false, configurable: true, configurationRequired: false },
  };

  const builder = new addonBuilder(manifest);

  builder.defineStreamHandler(async (args) => {
    try {
      const { streams, partial } = await findStreams({ type: args.type, id: args.id });
      if (!streams.length || partial) {
        return { streams, cacheMaxAge: 0 };
      }
      return {
        streams,
        cacheMaxAge: config.cacheTtl,
        staleRevalidate: config.cacheTtl * 4,
        staleError: 86400,
      };
    } catch (err) {
      return { streams: [], cacheMaxAge: 0 };
    }
  });

  const addonInterface = builder.getInterface();
  const app = express();

  async function resolveHandler(req: any, res: any) {
    const infoHash = String(req.params.infoHash || '').toLowerCase();
    if (!/^[a-f0-9]{40}$/i.test(infoHash)) {
      return res.status(400).send('infoHash inválido');
    }
    // Espelha o resolveHandler do app.js: a dica de obra (`w`) também entra
    // na assinatura e precisa ser repassada à verificação.
    const hint = typeof req.query.w === 'string' ? req.query.w : '';
    if (debrid.current()) {
      const ep = req.query.s != null && req.query.e != null ? `?s=${req.query.s}&e=${req.query.e}` : '';
      if (!verifyResolve(infoHash, ep, req.query.sig, hint)) {
        return res.status(403).send('assinatura inválida');
      }
    }
    let work: { names: string[]; year: number | null } | null = null;
    if (hint) {
      try {
        const parsed = JSON.parse(hint);
        const names = Array.isArray(parsed?.n) ? parsed.n.map(String).slice(0, 4) : [];
        if (names.length) work = { names, year: Number(parsed.y) || null };
      } catch { /* dica ilegível: trata como ausente */ }
    }
    try {
      const link = await debrid.resolveLink(infoHash, {
        season: req.query.s ? Number(req.query.s) : null,
        episode: req.query.e ? Number(req.query.e) : null,
        work,
      });
      if (!link) return res.status(404).send('nenhum arquivo de vídeo no torrent');
      return res.redirect(302, link);
    } catch (err) {
      return res.status(502).send('falha ao resolver no debrid');
    }
  }

  app.get('/health', (_, res) => res.json({ ok: true }));
  app.get('/resolve/:infoHash', resolveHandler);
  app.use(getRouter(addonInterface));

  app.use('/:userConfig', (req, res, next) => {
    const parsed = runtime.decode(req.params.userConfig);
    if (!parsed) return res.status(404).send('configuração inválida');
    runWith<void>({ opts: parsed, encoded: req.params.userConfig }, () => next());
  });

  app.get('/:userConfig/resolve/:infoHash', resolveHandler);
  app.use('/:userConfig', getRouter(addonInterface));

  return app;
}

describe('Tier 4: Real-World End-to-End Application Scenarios', () => {
  let server: any;
  let baseUrl: any;
  let originalFetch: any;
  let originalTimeout: any;
  let originalConfig: any;

  before(async () => {
    originalFetch = globalThis.fetch;
    originalTimeout = AbortSignal.timeout;
    originalConfig = {
      resolveSecret: config.debrid.resolveSecret,
      publicUrl: config.debrid.publicUrl,
      replyDeadline: config.replyDeadline,
      debridReserve: config.debridReserve,
      dropUncached: config.debrid.dropUncached,
      bludvEnabled: config.bludv.enabled,
    };

    config.bludv.enabled = false; // Isolate Bludv direct scraper in test harness

    const app = createTestApp();
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
    config.debrid.publicUrl = baseUrl;
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    AbortSignal.timeout = originalTimeout;
    Object.assign(config.debrid, {
      resolveSecret: originalConfig.resolveSecret,
      publicUrl: originalConfig.publicUrl,
      dropUncached: originalConfig.dropUncached,
    });
    config.replyDeadline = originalConfig.replyDeadline;
    config.debridReserve = originalConfig.debridReserve;
    config.bludv.enabled = originalConfig.bludvEnabled;

    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // Helper to intercept fetch calls that are NOT to our local test server
  function interceptFetch(mockFn: any) {
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : ((input as any)?.url || String(input));
      if (baseUrl && url.startsWith(baseUrl)) {
        return originalFetch(input, init);
      }
      return mockFn(url, init);
    };
  }

  // ---------------------------------------------------------------------------
  // SCENARIO 1: Brazilian Movie Search with Cached Dubbed Release & Debrid Playback
  // ---------------------------------------------------------------------------

  test('Scenario 5: High-Concurrency Multi-User Request Storm with Divergent Runtime Configs & Isolated Caches', async () => {
    const origSecret = config.debrid.resolveSecret;
    const operatorSecret = 'oper-master-secret-12345';
    config.debrid.resolveSecret = operatorSecret;

    // Generate 10 distinct user configurations
    const users = [
      { id: 1, conf: { ds: 'realdebrid', dk: 'key-user-1', p: ['jackett'], q4: 2, q1: 0, q7: 0, q5: 0, qs: 0, qn: 0, o: 1 } }, // 4K BR only
      { id: 2, conf: { ds: 'premiumize', dk: 'key-user-2', p: ['jackett'], q4: 0, q1: 2, q7: 0, q5: 0, qs: 0, qn: 0, d: 0 } }, // 1080p any audio
      { id: 3, conf: { ds: 'alldebrid', dk: 'key-user-3', p: ['jackett'], qs: 2, jl: 'bludv:1' } }, // SD, max 1 bludv
      { id: 4, conf: { ds: 'torbox', dk: 'key-user-4', p: ['jackett'], bu: 1, b: 4 } }, // Show uncached BR
      { id: 5, conf: { ds: '', dk: '', p: ['jackett'] } }, // P2P unconfigured
      { id: 6, conf: { ds: 'premiumize', dk: secretBox.seal('key-user-6'), p: ['jackett'], q1: 1 } }, // Sealed key
      { id: 7, conf: { ds: 'realdebrid', dk: 'key-user-7', p: ['jackett'], z: 3, c: 1 } }, // Max 3GB, no CAM
      { id: 8, conf: { ds: 'debridlink', dk: 'key-user-8', p: ['jackett'], bf: 0 } }, // brFirst=false
      { id: 9, conf: { ds: 'realdebrid', dk: 'key-user-1', p: ['jackett'], q4: 2, q1: 0, q7: 0, q5: 0, qs: 0, qn: 0, o: 1 } }, // Coalesced with User 1
      { id: 10, conf: { p: ['prowlarr'] } }, // Prowlarr provider
    ];

    // Mock Fetch for Cinemeta & TMDB responding to storm IMDb IDs
    interceptFetch(async (url: any) => {
      const u = String(url);
      const match = u.match(/tt\d+/);
      const id = match ? match[0] : 'tt1000001';
      if (u.includes('cinemeta.strem.io')) {
        return {
          ok: true,
          json: async () => ({ meta: { name: `Movie ${id}`, year: '2024' } }),
        };
      }
      if (u.includes('themoviedb.org')) {
        return {
          ok: true,
          json: async () => ({
            movie_results: [{ title: `Movie ${id}`, original_title: `Movie ${id}`, release_date: '2024-01-01' }],
          }),
        };
      }
      if (u.includes('premiumize.me') || u.includes('torbox.app') || u.includes('alldebrid.com')) {
        return {
          ok: true,
          json: async () => ({ status: 'success', response: [true, true, true] }),
        };
      }
      return { ok: false, status: 404 };
    });

    // Mock Jackett & Prowlarr Search returning matched streams for the queried movie
    const originalJackettSearch = jackett.search;
    const originalProwlarrSearch = prowlarr.search;

    jackett.search = async (query) => {
      const parts = query.split(' ');
      const titlePrefix = parts[0] + ' ' + (parts[1] || 'Movie');
      return [
        makeRawStream(`${titlePrefix} 2024 2160p DUBLADO Nacional`, { isBr: true, _dubbed: true, tracker: 'bludv', sizeBytes: 8 * 1024 ** 3 }),
        makeRawStream(`${titlePrefix} 2024 1080p BluRay Dual`, { isBr: true, _dubbed: true, tracker: 'nerdfilmes', sizeBytes: 2.5 * 1024 ** 3 }),
        makeRawStream(`${titlePrefix} 2024 1080p English Only`, { isBr: false, _dubbed: false, tracker: '1337x', sizeBytes: 2.0 * 1024 ** 3 }),
        makeRawStream(`${titlePrefix} 2024 720p HD CAM`, { isBr: false, tracker: '1337x', sizeBytes: 1.0 * 1024 ** 3 }),
        makeRawStream(`${titlePrefix} 2024 SD 480p DUBLADO`, { isBr: true, _dubbed: true, tracker: 'bludv', sizeBytes: 800 * 1024 ** 2 }),
      ];
    };
    prowlarr.search = jackett.search as any;

    // Mock Debrid Adapters
    const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
    const tbAdapter = debrid.BY_ID.get('torbox') as DebridAdapter;
    const adAdapter = debrid.BY_ID.get('alldebrid') as DebridAdapter;

    const origPmCheck = pmAdapter.checkCached;
    const origTbCheck = tbAdapter.checkCached;
    const origAdCheck = adAdapter.checkCached;

    pmAdapter.checkCached = async (key, hashes) => ({ cached: new Set(hashes), known: true });
    tbAdapter.checkCached = async (key, hashes) => ({ cached: new Set([hashes[0]]), known: true });
    adAdapter.checkCached = async (key, hashes) => ({ cached: new Set(hashes), known: true });

    try {
      // Fire 10 simultaneous requests across diverse IMDb IDs and configurations
      const stormTasks = users.map(async (u) => {
        const seg = runtime.encode(u.conf);
        const imdb = `tt${String(1000000 + u.id).padStart(7, '0')}`;
        const res = await fetch(`${baseUrl}/${seg}/stream/movie/${imdb}.json`);
        assert.equal(res.status, 200, `User ${u.id} received 200 OK`);
        const json = await res.json();
        return { user: u, status: res.status, data: json };
      });

      const results = await Promise.all(stormTasks);
      assert.equal(results.length, 10, 'All 10 concurrent requests completed successfully');

      // Verify User 1 (4K BR only via Real-Debrid)
      const u1 = results.find((r) => r.user.id === 1)!;
      assert.ok(u1.data.streams.length > 0);
      assert.ok(u1.data.streams.every((s: any) => s.name.includes('2160p') || s.name.includes('4K')), 'User 1 strictly limited to 2160p/4K');
      assert.ok(u1.data.streams.every((s: any) => s.name.includes('[RD download]')), 'User 1 streams marked [RD download]');

      // Verify User 2 (1080p only via Premiumize)
      const u2 = results.find((r) => r.user.id === 2)!;
      assert.ok(u2.data.streams.length > 0);
      assert.ok(u2.data.streams.every((s: any) => s.name.includes('1080p')), 'User 2 strictly limited to 1080p');
      assert.ok(u2.data.streams.every((s: any) => s.name.includes('[PM⚡]')), 'User 2 streams marked [PM⚡]');

      // Verify User 5 (P2P unconfigured)
      const u5 = results.find((r) => r.user.id === 5)!;
      assert.ok(u5.data.streams.length > 0);
      assert.ok(u5.data.streams.every((s: any) => s.infoHash != null), 'User 5 receives pure P2P streams with infoHash');
      assert.ok(u5.data.streams.every((s: any) => s.url == null), 'User 5 streams contain no resolve URLs');

      // Verify User 6 (Sealed Key with Premiumize)
      const u6 = results.find((r) => r.user.id === 6)!;
      assert.ok(u6.data.streams.length > 0);
      assert.ok(u6.data.streams[0].url.includes('/resolve/'), 'User 6 sealed key correctly signed in resolve URL');

      // Verify User 9 received identical result to User 1 (Coalescing)
      const u9 = results.find((r) => r.user.id === 9)!;
      assert.equal(u9.data.streams.length, u1.data.streams.length);
    } finally {
      config.debrid.resolveSecret = origSecret;
      jackett.search = originalJackettSearch;
      prowlarr.search = originalProwlarrSearch;
      pmAdapter.checkCached = origPmCheck;
      tbAdapter.checkCached = origTbCheck;
      adAdapter.checkCached = origAdCheck;
      cache.clear();
    }
  });
});
