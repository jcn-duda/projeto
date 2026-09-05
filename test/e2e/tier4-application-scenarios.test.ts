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

  test('Scenario 1: Brazilian Movie Search with Cached Dubbed Release & Debrid Playback (Auto da Compadecida on Premiumize)', async () => {
    const imdbId = 'tt0271383';
    const brHash = makeHash('auto_da_compadecida_br', 1);
    const globalHash = makeHash('dogs_will_global', 2);
    const userApiKey = 'pm-user-token-scenario-1';

    const userConfig = {
      ds: 'premiumize',
      dk: userApiKey,
      p: ['jackett'],
      d: 1, // dubbedOnly
      bf: 1, // brFirst
      b: 4, // brReservedSlots
      dc: 1, // debridCachedOnly
    };

    const configSegment = runtime.encode(userConfig);

    // Mock Fetch for Cinemeta, TMDB, and Premiumize
    interceptFetch(async (url: any) => {
      const u = String(url);
      if (u.includes('cinemeta.strem.io')) {
        return {
          ok: true,
          json: async () => ({ meta: { name: 'O Auto da Compadecida', year: '2000' } }),
        };
      }
      if (u.includes('themoviedb.org')) {
        return {
          ok: true,
          json: async () => ({
            movie_results: [{ title: 'O Auto da Compadecida', original_title: 'O Auto da Compadecida', release_date: '2000-09-15' }],
            tv_results: [],
          }),
        };
      }
      if (u.includes('premiumize.me')) {
        return {
          ok: true,
          json: async () => ({ status: 'success', response: [true, false] }),
        };
      }
      return { ok: false, status: 404 };
    });

    // Mock Jackett Search
    const originalJackettSearch = jackett.search;
    jackett.search = async () => [
      makeRawStream('O Auto da Compadecida (2000) 1080p Nacional BluRay', { infoHash: brHash, isBr: true, seeders: 1 }),
      makeRawStream('A Dog\'s Will (2000) 720p English Subtitles', { infoHash: globalHash, isBr: false, seeders: 45 }),
    ];

    // Mock Premiumize Adapter
    const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
    const originalCheckCached = pmAdapter.checkCached;
    const originalResolveLink = pmAdapter.resolveLink;

    pmAdapter.checkCached = async (apiKey, hashes) => {
      assert.equal(apiKey, userApiKey);
      return { cached: new Set([brHash]), known: true };
    };

    pmAdapter.resolveLink = async (apiKey, hash) => {
      assert.equal(apiKey, userApiKey);
      assert.equal(hash, brHash);
      return 'https://cdn.premiumize.me/stream/auto_compadecida_1080p_nacional.mp4';
    };

    try {
      // Step 1: Fetch user manifest
      const manifestRes = await fetch(`${baseUrl}/${configSegment}/manifest.json`);
      assert.equal(manifestRes.status, 200);
      const manifestData = await manifestRes.json();
      assert.equal(manifestData.id, config.addonId);
      assert.equal(manifestData.behaviorHints.configurable, true);

      // Step 2: Search for movie streams
      const streamRes = await fetch(`${baseUrl}/${configSegment}/stream/movie/${imdbId}.json`);
      assert.equal(streamRes.status, 200);
      assert.match(streamRes.headers.get('cache-control') || '', /max-age=900/);

      const streamData = await streamRes.json();
      assert.ok(Array.isArray(streamData.streams));
      assert.equal(streamData.streams.length, 1, 'Only the cached BR Dubbed stream survived cachedOnly filter');

      const stream = streamData.streams[0];
      assert.match(stream.name, /\[PM⚡\]/, 'Branded with instant play mark [PM⚡]');
      assert.match(stream.name, /1080p/, 'Display resolution extracted correctly');
      assert.ok(stream.url.startsWith(`${baseUrl}/${configSegment}/resolve/${brHash}`), 'Resolve URL contains proper prefix');
      assert.equal(stream.infoHash, undefined, 'infoHash stripped for debrid routing');

      // Step 3: Client clicks play (calls /resolve endpoint with signature)
      const playUrl = new URL(stream.url);
      const resolveRes = await fetch(playUrl.href, { redirect: 'manual' });
      assert.equal(resolveRes.status, 302, 'Redirects to direct CDN playback URL');
      assert.equal(resolveRes.headers.get('location'), 'https://cdn.premiumize.me/stream/auto_compadecida_1080p_nacional.mp4');

      // Step 4: Verify HMAC anti-tampering protection
      const tamperedUrl = new URL(playUrl.href);
      tamperedUrl.searchParams.set('sig', 'deadbeef'.repeat(8));
      const badSigRes = await fetch(tamperedUrl.href, { redirect: 'manual' });
      assert.equal(badSigRes.status, 403, 'Tampered HMAC signature rejected with 403 Forbidden');
    } finally {
      jackett.search = originalJackettSearch;
      pmAdapter.checkCached = originalCheckCached;
      pmAdapter.resolveLink = originalResolveLink;
      cache.clear();
    }
  });
});
