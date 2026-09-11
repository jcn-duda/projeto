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

  // ---------------------------------------------------------------------------
  // SCENARIO 3: Uncached BR Dubbed Release with Autofetch & AllDebrid Protection
  // ---------------------------------------------------------------------------

  test('Scenario 3: Uncached BR Dubbed Release triggering Autofetch with AllDebrid Ghost-Download Protection', async () => {
    const imdbId = 'tt15398776'; // Oppenheimer
    const uncachedBrHash = makeHash('oppenheimer_br_uncached', 1);
    const uncachedGlobalHash = makeHash('oppenheimer_global_uncached', 2);
    const userApiKey = 'ad-user-token-scenario-3';
    const account = accountScope(userApiKey);

    const userConfig = {
      ds: 'alldebrid',
      dk: userApiKey,
      p: ['jackett'],
      // Chaves CURTAS do schema (`ab`/`dc`): `runtime.normalize` ignora chaves
      // desconhecidas, então `autoFetchBr: true`/`debridCachedOnly: true` eram
      // descartadas em silêncio e o efetivo vinha do .env do operador — com
      // DEBRID_CACHED_ONLY=false o autofetch nem ligava e o hold nunca protegia
      // o candidato BR da limpeza simulada no checkCached.
      ab: 1, // autoFetchBr
      dc: 1, // debridCachedOnly
      b: 2,
    };

    const configSegment = runtime.encode(userConfig);

    // Mock Fetch for Cinemeta & TMDB
    interceptFetch(async (url: any) => {
      const u = String(url);
      if (u.includes('cinemeta.strem.io')) {
        return {
          ok: true,
          json: async () => ({ meta: { name: 'Oppenheimer', year: '2023' } }),
        };
      }
      if (u.includes('themoviedb.org')) {
        return {
          ok: true,
          json: async () => ({
            movie_results: [{ title: 'Oppenheimer', original_title: 'Oppenheimer', release_date: '2023-07-21' }],
          }),
        };
      }
      return { ok: false, status: 404 };
    });

    // Mock Jackett Search
    const originalJackettSearch = jackett.search;
    jackett.search = async () => [
      makeRawStream('Oppenheimer 2023 1080p DUAL Dublado Nacional', { infoHash: uncachedBrHash, isBr: true, seeders: 1, _dubbed: true }),
      makeRawStream('Oppenheimer 2023 1080p BluRay English', { infoHash: uncachedGlobalHash, isBr: false, seeders: 100, _dubbed: false }),
    ];

    // Mock AllDebrid Adapter
    const adAdapter = debrid.BY_ID.get('alldebrid') as DebridAdapter;
    const originalCheckCached = adAdapter.checkCached;
    const originalEnqueue = adAdapter.enqueue;
    const originalAbortSafe = adAdapter.abortSafeCacheCheck;

    // Enable abortSafeCacheCheck for synchronous testing inside applyDebrid
    adAdapter.abortSafeCacheCheck = true;

    const deletedMagnetHashes: string[] = [];
    const enqueuedHashes: string[] = [];

    adAdapter.checkCached = async (apiKey, hashes) => {
      // Simulate dropUncached inside AllDebrid checkCached
      for (const hash of hashes) {
        if (!held.isHeld(hash, account)) {
          deletedMagnetHashes.push(hash);
        }
      }
      return { cached: new Set(), known: true };
    };

    adAdapter.enqueue = async (apiKey, hash) => {
      enqueuedHashes.push(hash);
      return true;
    };

    try {
      // Step 1: User queries movie stream
      const res = await fetch(`${baseUrl}/${configSegment}/stream/movie/${imdbId}.json`);
      assert.equal(res.status, 200);

      // Allow background autofetch to settle
      await sleep(50);

      // Step 2: Ghost-Download Protection & Autofetch assertions
      assert.ok(deletedMagnetHashes.includes(uncachedGlobalHash), 'Unprotected global torrent deleted from AllDebrid account');
      assert.ok(!deletedMagnetHashes.includes(uncachedBrHash), 'Held BR dubbed candidate protected from deletion');
      assert.equal(enqueuedHashes.length, 1, 'Exactly 1 autofetch enqueue call dispatched');
      assert.equal(enqueuedHashes[0], uncachedBrHash, 'Autofetch correctly enqueued the BR dubbed candidate');

      // Step 3: Second request suppresses duplicate autofetch
      await fetch(`${baseUrl}/${configSegment}/stream/movie/${imdbId}.json`);
      await sleep(30);
      assert.equal(enqueuedHashes.length, 1, 'Duplicate autofetch prevented by cache marker');
    } finally {
      held.release(uncachedBrHash, account);
      jackett.search = originalJackettSearch;
      adAdapter.checkCached = originalCheckCached;
      adAdapter.enqueue = originalEnqueue;
      adAdapter.abortSafeCacheCheck = originalAbortSafe;
      cache.clear();
    }
  });

  // ---------------------------------------------------------------------------
  // SCENARIO 4: Extreme Network Degradation & Provider Outage
  // ---------------------------------------------------------------------------

  test('Scenario 4: Extreme Network Degradation & Provider Outage (Graceful fallback without 500 error)', async () => {
    const imdbId = 'tt9999999';
    const userConfig = {
      ds: 'premiumize',
      dk: 'pm-key-degraded',
      p: ['jackett', 'prowlarr'],
    };

    const configSegment = runtime.encode(userConfig);

    // Mock total infrastructure failure across external dependencies
    interceptFetch(async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:80 (Network outage)');
    });

    const originalJackettSearch = jackett.search;
    const originalProwlarrSearch = prowlarr.search;
    const originalBludvSearch = bludv.search;

    jackett.search = async () => {
      throw new Error('AbortError: The operation was aborted (Jackett timeout)');
    };
    prowlarr.search = async () => {
      throw new Error('Invalid XML payload from Prowlarr');
    };
    bludv.search = async () => {
      throw new Error('DNS lookup failed for bludvfilmes.xyz');
    };

    try {
      // Execute stream request against crashing providers
      const res = await fetch(`${baseUrl}/${configSegment}/stream/movie/${imdbId}.json`);

      // System must never return HTTP 500 or crash Express
      assert.equal(res.status, 200, 'Server gracefully returns 200 OK despite backend failures');
      const data = await res.json();
      assert.deepEqual(data.streams, [], 'Empty stream list safely returned');
      assert.equal(data.cacheMaxAge, 0, 'Empty failure result cached with max-age=0 for rapid retry');
    } finally {
      jackett.search = originalJackettSearch;
      prowlarr.search = originalProwlarrSearch;
      bludv.search = originalBludvSearch;
      cache.clear();
    }
  });

  // ---------------------------------------------------------------------------
  // SCENARIO 5: High-Concurrency Multi-User Request Storm with Isolated Caches
  // ---------------------------------------------------------------------------
});
