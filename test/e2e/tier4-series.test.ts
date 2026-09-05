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
});
