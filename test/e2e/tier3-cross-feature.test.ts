// Rodada 2: checagem ligada.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

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
import { applyDebrid } from '../../src/providers/index.js';
import { collectWithinWindow } from '../../src/providers/collection-window.js';
import { createLatestWriter } from '../../src/utils/latest-writer.js';
import { accountScope } from '../../src/utils/request-key.js';
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

/** Stream como o teste o enxerga: name/url sempre presentes na lista pos-debrid. */
interface TestStream {
  name: string;
  url: string;
  infoHash?: string;
  title?: string;
}

// `runtime.run` devolve unknown (o tipo do AsyncLocalStorage não propaga); o
// wrapper recebe o tipo do retorno no call site, sem cast espalhado.
const runWith = <T>(patch: object, fn: () => unknown) => runtime.run(patch, fn) as Promise<T>;

describe('Tier 3: Cross-Feature Combinations & System Interactions', () => {
  let originalFetch: any;
  let originalTimeout: any;
  let originalConfig: any;

  before(() => {
    originalFetch = globalThis.fetch;
    originalTimeout = AbortSignal.timeout;
    originalConfig = {
      resolveSecret: config.debrid.resolveSecret,
      replyDeadline: config.replyDeadline,
      debridReserve: config.debridReserve,
      brPartialGrace: config.brPartialGrace,
      dropUncached: config.debrid.dropUncached,
    };
  });

  after(() => {
    globalThis.fetch = originalFetch;
    AbortSignal.timeout = originalTimeout;
    Object.assign(config.debrid, {
      resolveSecret: originalConfig.resolveSecret,
      dropUncached: originalConfig.dropUncached,
    });
    config.replyDeadline = originalConfig.replyDeadline;
    config.debridReserve = originalConfig.debridReserve;
    config.brPartialGrace = originalConfig.brPartialGrace;
  });

  // ---------------------------------------------------------------------------
  // INTERACTION 1: BR Dubbed + Debrid Cache Availability + Slot Reservation
  // ---------------------------------------------------------------------------

  test('1A: BR Dubbed + Premiumize cached (known: true) -> marked [PM⚡], prioritized at index 0 via brFirst', async () => {
    const brHash = makeHash('br_movie', 1);
    const global4kHash = makeHash('global_4k', 2);
    const global1080Hash = makeHash('global_1080', 3);

    const rawList = [
      makeRawStream('Movie.2024.2160p.UHD.x265', { infoHash: global4kHash, seeders: 150, isBr: false }),
      makeRawStream('Movie.2024.1080p.BluRay.x264', { infoHash: global1080Hash, seeders: 80, isBr: false }),
      makeRawStream('Movie.2024.1080p.DUBLADO.Nacional', { infoHash: brHash, seeders: 1, isBr: true }),
    ];

    const streams = format.sortAndLimit(rawList.map(format.toStremioStream), {
      minSeeders: 1,
      maxResults: 10,
      brReservedSlots: 2,
      brFirst: true,
      preferDubbed: true,
    });

    const userOpts = {
      ...runtime.defaults(),
      debridService: 'premiumize',
      debridApiKey: 'test-pm-key',
      debridCachedOnly: true,
      brReservedSlots: 2,
      brFirst: true,
      preferDubbed: true,
    };

    const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
    const originalCheck = pmAdapter.checkCached;
    pmAdapter.checkCached = async () => ({
      cached: new Set([brHash, global1080Hash]),
      known: true,
    });

    try {
      const result = await runWith<TestStream[]>({ opts: userOpts, encoded: 'pm-conf' }, async () => {
        const afterDebrid = await applyDebrid(streams, {} as any);
        return format.limitReservingBr(afterDebrid, {
          brReservedSlots: 2,
          maxResults: 5,
          brFirst: true,
        });
      });

      assert.equal(result.length, 2, 'Uncached 4K stream filtered out by cachedOnly');
      assert.match(result[0].name, /\[PM⚡\]/, 'BR Dubbed stream branded with [PM⚡]');
      assert.match(result[0].name, /1080p/, 'BR Dubbed stream resolution displayed');
      assert.match(result[0].url, /\/resolve\//, 'Stream URL points to resolve route');
      assert.equal(result[0].infoHash, undefined, 'infoHash stripped for debrid stream');
      assert.match(result[1].name, /\[PM⚡\]/, 'Global 1080p stream branded with [PM⚡]');
    } finally {
      pmAdapter.checkCached = originalCheck;
    }
  });

  test('1B: BR Dubbed + Premiumize uncached (known: true) + showUncachedBr = false -> uncached BR filtered out', async () => {
    const brHash = makeHash('br_uncached', 1);
    const globalHash = makeHash('global_cached', 2);

    const rawList = [
      makeRawStream('Filme.2024.1080p.DUBLADO', { infoHash: brHash, seeders: 1, isBr: true }),
      makeRawStream('Movie.2024.1080p.English', { infoHash: globalHash, seeders: 50, isBr: false }),
    ];

    const streams = format.sortAndLimit(rawList.map(format.toStremioStream), {
      minSeeders: 1,
      maxResults: 10,
      brReservedSlots: 2,
      brFirst: true,
    });

    const userOpts = {
      ...runtime.defaults(),
      debridService: 'premiumize',
      debridApiKey: 'test-pm-key',
      debridCachedOnly: true,
      showUncachedBr: false,
      brReservedSlots: 2,
    };

    const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
    const originalCheck = pmAdapter.checkCached;
    pmAdapter.checkCached = async () => ({
      cached: new Set([globalHash]),
      known: true,
    });

    try {
      const result = await runWith<TestStream[]>({ opts: userOpts, encoded: 'pm-conf' }, async () => {
        const afterDebrid = await applyDebrid(streams, {} as any);
        return format.limitReservingBr(afterDebrid, {
          brReservedSlots: 2,
          maxResults: 5,
        });
      });

      assert.equal(result.length, 1, 'Only cached global stream remains');
      assert.equal(result[0].infoHash, undefined);
      assert.match(result[0].name, /\[PM⚡\]/);
    } finally {
      pmAdapter.checkCached = originalCheck;
    }
  });

  test('1C: BR Dubbed + Premiumize uncached (known: true) + showUncachedBr = true -> uncached BR preserved as P2P', async () => {
    // Este caso É sobre P2P puro, então a premissa vai fixada: a suíte carrega o
    // .env do operador, e DEBRID_RESOLVE_UNCACHED=true faz o frio sair pelo
    // /resolve com url — quebrava por config, não por código.
    const originalResolveUncached = config.debrid.resolveUncached;
    config.debrid.resolveUncached = false;
    const brHash = makeHash('br_p2p_saved', 1);
    const globalHash = makeHash('global_pm_cached', 2);

    const rawList = [
      makeRawStream('Filme.2024.1080p.DUBLADO', { infoHash: brHash, seeders: 2, isBr: true }),
      makeRawStream('Movie.2024.1080p.English', { infoHash: globalHash, seeders: 50, isBr: false }),
    ];

    const streams = format.sortAndLimit(rawList.map(format.toStremioStream), {
      minSeeders: 1,
      maxResults: 10,
      brReservedSlots: 2,
      brFirst: true,
    });

    const userOpts = {
      ...runtime.defaults(),
      debridService: 'premiumize',
      debridApiKey: 'test-pm-key',
      debridCachedOnly: true,
      showUncachedBr: true,
      brReservedSlots: 1,
    };

    const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
    const originalCheck = pmAdapter.checkCached;
    pmAdapter.checkCached = async () => ({
      cached: new Set([globalHash]),
      known: true,
    });

    try {
      const result = await runWith<TestStream[]>({ opts: userOpts, encoded: 'pm-conf' }, async () => {
        const afterDebrid = await applyDebrid(streams, {} as any);
        return format.limitReservingBr(afterDebrid, {
          brReservedSlots: 1,
          maxResults: 5,
        });
      });

      assert.equal(result.length, 2);
      const brStream = result.find((s) => s.infoHash === brHash);
      const globalStream = result.find((s) => s.url && s.url.includes(globalHash));

      assert.ok(brStream, 'Uncached BR stream preserved as P2P');
      assert.equal(brStream.url, undefined, 'P2P stream has no resolve URL');
      assert.equal(brStream.infoHash, brHash, 'P2P stream preserves infoHash');
      assert.ok(globalStream, 'Cached stream delivered via Debrid');
      assert.match(globalStream.name, /\[PM⚡\]/);
    } finally {
      pmAdapter.checkCached = originalCheck;
      config.debrid.resolveUncached = originalResolveUncached;
    }
  });

  test('1D: BR Dubbed + Real-Debrid (known: false) -> cachedOnly bypassed, all streams route via debrid download', async () => {
    const brHash = makeHash('br_rd_stream', 1);
    const globalHash = makeHash('global_rd_stream', 2);

    const rawList = [
      makeRawStream('Filme.2024.1080p.DUBLADO', { infoHash: brHash, seeders: 1, isBr: true }),
      makeRawStream('Movie.2024.1080p.English', { infoHash: globalHash, seeders: 100, isBr: false }),
    ];

    const streams = format.sortAndLimit(rawList.map(format.toStremioStream), {
      minSeeders: 1,
      maxResults: 10,
      brReservedSlots: 1,
      brFirst: true,
    });

    const userOpts = {
      ...runtime.defaults(),
      debridService: 'realdebrid',
      debridApiKey: 'test-rd-key',
      debridCachedOnly: true, // Should be bypassed because RD has cacheCheck: false
      brReservedSlots: 1,
      brFirst: true,
    };

    const result = await runWith<TestStream[]>({ opts: userOpts, encoded: 'rd-conf' }, async () => {
      const afterDebrid = await applyDebrid(streams, {} as any);
      return format.limitReservingBr(afterDebrid, {
        brReservedSlots: 1,
        maxResults: 5,
        brFirst: true,
      });
    });

    assert.equal(result.length, 2, 'Both streams preserved despite cachedOnly=true');
    assert.match(result[0].name, /\[RD download\]/, 'BR stream branded with [RD download]');
    assert.match(result[0].url, /\/resolve\//, 'Resolve URL generated');
    assert.match(result[1].name, /\[RD download\]/, 'Global stream branded with [RD download]');
  });

  // ---------------------------------------------------------------------------
  // INTERACTION 2: URL Config Overrides + Debrid Switching + Quality Limits + Indexer Limits
  // ---------------------------------------------------------------------------

});
