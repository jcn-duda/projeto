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

  // ---------------------------------------------------------------------------
  // SCENARIO 2: Ongoing TV Series with Season Pack Fallback & Late-Pass Cache Refresh
  // ---------------------------------------------------------------------------

  test('Scenario 2: Ongoing TV Series with Season Pack Fallback on Slow BR Scrapers & Late-Pass Cache Refresh (Fallout S01)', async () => {
    const seriesId = 'tt12637874:1:1'; // Fallout S01E01
    const fastGlobalHash = makeHash('fallout_global_s01e01', 1);
    const slowBrPackHash = makeHash('fallout_br_s01_pack', 2);
    const userApiKey = 'rd-user-token-scenario-2';

    const userConfig = {
      ds: 'realdebrid',
      dk: userApiKey,
      p: ['jackett'],
      ji: ['1337x', 'bludv-cardigann'],
      bf: 1,
      b: 2,
    };

    const configSegment = runtime.encode(userConfig);

    // Encolhe o orçamento de coleta para o cenário caber no teste. Com o default
    // (REPLY_DEADLINE 9200 − DEBRID_RESERVE 4500 = 4700ms) a fonte BR de 140ms
    // entrava na janela e a primeira resposta já saía COMPLETA — o passe tardio
    // nunca disparava e o cenário passava de qualquer jeito, mesmo com a escrita
    // do cache removida. Aqui a janela vira 1200ms e a BR fica fora dela: a
    // primeira resposta sai parcial e só o passe tardio pode completar o cache.
    config.replyDeadline = 1500;
    config.debridReserve = 300;

    // Mock Fetch for Cinemeta & TMDB
    interceptFetch(async (url: any) => {
      const u = String(url);
      if (u.includes('cinemeta.strem.io')) {
        return {
          ok: true,
          json: async () => ({ meta: { name: 'Fallout', year: '2024–' } }),
        };
      }
      if (u.includes('themoviedb.org')) {
        return {
          ok: true,
          json: async () => ({
            tv_results: [{ name: 'Fallout', original_name: 'Fallout', first_air_date: '2024-04-10' }],
          }),
        };
      }
      return { ok: false, status: 404 };
    });

    // Mock Jackett Search with fast global result and delayed BR result
    const originalJackettSearch = jackett.search;
    let globalSearchCalls = 0;
    let brSearchCalls = 0;
    jackett.search = async (query, type, indexers) => {
      const isBrIndexer = indexers && indexers.includes('bludv-cardigann');
      if (isBrIndexer) {
        brSearchCalls += 1;
        // Slow BR Season Pack scraper: o atraso (1400ms) precisa ser MAIOR que o
        // orçamento de coleta (1200ms), senão o resultado BR entraria na primeira
        // resposta e o passe tardio nunca aconteceria.
        await sleep(1400);
        return [
          makeRawStream('Fallout 1ª Temporada Completa (2024) [DUBLADO] 1080p', {
            infoHash: slowBrPackHash,
            isBr: true,
            seeders: 1,
            tracker: 'bludv-cardigann',
          }),
        ];
      }
      // Fast Global indexer
      globalSearchCalls += 1;
      return [
        makeRawStream('Fallout.S01E01.1080p.WEBRip.x264', {
          infoHash: fastGlobalHash,
          isBr: false,
          seeders: 120,
          tracker: '1337x',
        }),
      ];
    };

    // Mock Real-Debrid Adapter
    const rdAdapter = debrid.BY_ID.get('realdebrid') as DebridAdapter;
    const originalResolveLink = rdAdapter.resolveLink;
    rdAdapter.resolveLink = async (apiKey, hash, episode) => {
      assert.equal(apiKey, userApiKey);
      assert.equal(hash, slowBrPackHash);
      assert.equal(episode?.season, 1);
      assert.equal(episode?.episode, 1);
      return 'https://cdn.real-debrid.com/stream/fallout_s01e01_dublado.mkv';
    };

    try {
      // Step 1: A primeira resposta é PARCIAL — só o stream global rápido coube
      // no orçamento; a fonte BR ainda está raspando fora da janela.
      const res1 = await fetch(`${baseUrl}/${configSegment}/stream/series/${seriesId}.json`);
      assert.equal(res1.status, 200);
      const data1 = await res1.json();
      assert.equal(data1.streams.length, 1, 'First response is partial: only the fast global stream arrived');
      assert.equal(data1.cacheMaxAge, 0, 'Partial response must not be cached by the client');
      assert.ok(data1.streams[0].url.includes(fastGlobalHash), 'Partial response carries the fast global stream');

      // O passo de resposta já gravou o lote parcial no cache (TTL curto). Como
      // a primeira resposta provou-se parcial (1 stream), qualquer entrada
      // completa de 2 streams que aparecer a seguir SÓ pode ter vindo do passe
      // tardio — é exatamente a escrita que a mutação MUT-10 remove.
      const cacheKey = streamsCacheKey('series', seriesId, {
        ...runtime.decode(configSegment),
        resolveUncached: config.debrid.resolveUncached,
      });
      const responseHit = cache.get(cacheKey);
      assert.ok(responseHit, 'Response pass cached the partial result');
      assert.ok(responseHit.streams.length >= 1, 'Cached partial entry is non-empty');

      // Step 2: espera o passe tardio reescrever o cache como completo. Poll
      // determinístico no cache em memória: a condição de parada é a transição
      // partial → completo com as 2 fontes, que só a escrita tardia produz.
      const lateDeadline = Date.now() + 5000;
      let lateHit: any = null;
      while (Date.now() < lateDeadline) {
        lateHit = cache.get(cacheKey);
        if (lateHit && lateHit.partial === false && lateHit.streams.length === 2) break;
        await sleep(25);
      }
      assert.ok(lateHit && lateHit.partial === false, 'Late pass rewrote the cache entry as complete');
      assert.equal(lateHit.streams.length, 2, 'Late-pass cache holds both global and BR pack streams');
      assert.ok(
        lateHit.streams.some((s: any) => (s.url || '').includes(slowBrPackHash)),
        'Late-pass cache contains the slow BR season pack',
      );

      // Step 3: a segunda chamada é servida DO CACHE — nenhum indexer é
      // consultado de novo. Sem a escrita tardia o cache estaria vazio e a
      // busca inteira seria refeita, dobrando as chamadas abaixo.
      const res2 = await fetch(`${baseUrl}/${configSegment}/stream/series/${seriesId}.json`);
      assert.equal(res2.status, 200);
      const data2 = await res2.json();
      assert.equal(globalSearchCalls, 1, 'Global indexer queried exactly once — second request served from cache');
      assert.equal(brSearchCalls, 1, 'BR indexer queried exactly once — second request served from cache');

      assert.ok(data2.streams.length >= 2, 'Cache now contains both global stream and late BR pack stream');
      const topStream = data2.streams[0];
      assert.ok(topStream.title.includes('Fallout 1ª Temporada Completa'), 'BR Dubbed Season 1 pack ranked at top due to brFirst');
      assert.match(topStream.name, /\[RD download\]/, 'Real-Debrid download stream format');

      // Step 4: Play Episode 1 from the Season Pack
      const playUrl = new URL(topStream.url);
      assert.equal(playUrl.searchParams.get('s'), '1');
      assert.equal(playUrl.searchParams.get('e'), '1');

      const resolveRes = await fetch(playUrl.href, { redirect: 'manual' });
      assert.equal(resolveRes.status, 302);
      assert.equal(resolveRes.headers.get('location'), 'https://cdn.real-debrid.com/stream/fallout_s01e01_dublado.mkv');
    } finally {
      config.replyDeadline = originalConfig.replyDeadline;
      config.debridReserve = originalConfig.debridReserve;
      jackett.search = originalJackettSearch;
      rdAdapter.resolveLink = originalResolveLink;
      cache.clear();
    }
  });

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
