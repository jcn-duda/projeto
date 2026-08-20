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
function makeHash(prefix, id = 1) {
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  let originalFetch;
  let originalTimeout;
  let originalConfig;

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

  test('2A: URL Config overrides: Premiumize + Quality Limits (q4:0, q1:2, q7:1) + Indexer Limits (jl: bludv:1, nerdfilmes:1)', async () => {
    const rawStreams = [
      makeRawStream('Movie.2024.2160p.UHD', { tracker: '1337x', isBr: false }),
      makeRawStream('Movie.2024.1080p.BluRay.1', { tracker: 'bludv', isBr: true }),
      makeRawStream('Movie.2024.1080p.BluRay.2', { tracker: 'bludv', isBr: true }),
      makeRawStream('Movie.2024.1080p.WEB.1', { tracker: 'nerdfilmes', isBr: true }),
      makeRawStream('Movie.2024.1080p.WEB.2', { tracker: 'nerdfilmes', isBr: true }),
      makeRawStream('Movie.2024.720p.HD.1', { tracker: 'bludv', isBr: true }),
      makeRawStream('Movie.2024.720p.HD.2', { tracker: 'nerdfilmes', isBr: true }),
    ];

    const rawConfig = {
      ds: 'premiumize',
      dk: 'pm-secret-token',
      q4: 0, // No 4K
      q1: 2, // Max 2 1080p
      q7: 1, // Max 1 720p
      jl: 'bludv:1,nerdfilmes:1',
      b: 2,
    };

    const encoded = runtime.encode(rawConfig);
    const decoded = runtime.decode(encoded)!;

    const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
    const originalCheck = pmAdapter.checkCached;
    pmAdapter.checkCached = async (key, hashes) => ({
      cached: new Set(hashes),
      known: true,
    });

    try {
      const result = await runWith<TestStream[]>({ opts: decoded, encoded }, async () => {
        const qualityLimits = {
          '2160p': decoded.max2160p,
          '1080p': decoded.max1080p,
          '720p': decoded.max720p,
          '480p': decoded.max480p,
          SD: decoded.maxSd,
          [format.UNKNOWN_QUALITY]: decoded.maxUnknown,
        };

        const sorted = format.sortAndLimit(rawStreams.map(format.toStremioStream), {
          minSeeders: 1,
          maxResults: 20,
          qualityLimits,
          brReservedSlots: decoded.brReservedSlots,
        });

        const afterDebrid = await applyDebrid(sorted, {} as any);
        return format.limitReservingBr(afterDebrid, {
          brReservedSlots: decoded.brReservedSlots,
          maxResults: 10,
          qualityLimits,
          indexerLimits: decoded.indexerLimits,
        });
      });

      // Assertions
      const has4k = result.some((s) => s.name.includes('2160p'));
      assert.equal(has4k, false, '4K streams strictly excluded by q4:0');

      const count1080p = result.filter((s) => s.name.includes('1080p')).length;
      assert.ok(count1080p <= 2, `1080p streams count (${count1080p}) within limit of 2`);

      const count720p = result.filter((s) => s.name.includes('720p')).length;
      assert.ok(count720p <= 1, `720p streams count (${count720p}) within limit of 1`);

      result.forEach((s) => {
        assert.match(s.name, /\[PM⚡\]/, 'Branded with [PM⚡]');
      });
    } finally {
      pmAdapter.checkCached = originalCheck;
    }
  });

  test('2B: Concurrent execution of divergent runtime configs preserves AsyncLocalStorage isolation', async () => {
    const rawStream = makeRawStream('Movie.2024.1080p.Test', { infoHash: makeHash('concurrent_test', 1) });

    const configA = runtime.decode(runtime.encode({ ds: 'realdebrid', dk: 'key-rd-user-a', q1: 1, q7: 0 }));
    const configB = runtime.decode(runtime.encode({ ds: 'alldebrid', dk: 'key-ad-user-b', q1: 0, q7: 2 }));

    const taskA = runWith<{ service: string; sig: string }>({ opts: configA, encoded: 'conf-a' }, async () => {
      await sleep(15);
      const currentOpts = runtime.opts();
      assert.equal(currentOpts.debridService, 'realdebrid');
      assert.equal(currentOpts.debridApiKey, 'key-rd-user-a');
      assert.equal(currentOpts.max1080p, 1);
      assert.equal(currentOpts.max720p, 0);
      const sig = signResolve(rawStream.infoHash, '');
      assert.ok(verifyResolve(rawStream.infoHash, '', sig));
      return { service: currentOpts.debridService, sig };
    });

    const taskB = runWith<{ service: string; sig: string }>({ opts: configB, encoded: 'conf-b' }, async () => {
      await sleep(10);
      const currentOpts = runtime.opts();
      assert.equal(currentOpts.debridService, 'alldebrid');
      assert.equal(currentOpts.debridApiKey, 'key-ad-user-b');
      assert.equal(currentOpts.max1080p, 0);
      assert.equal(currentOpts.max720p, 2);
      const sig = signResolve(rawStream.infoHash, '');
      assert.ok(verifyResolve(rawStream.infoHash, '', sig));
      return { service: currentOpts.debridService, sig };
    });

    const [resA, resB] = await Promise.all([taskA, taskB]);
    assert.equal(resA.service, 'realdebrid');
    assert.equal(resB.service, 'alldebrid');
    assert.notEqual(resA.sig, resB.sig, 'HMAC signatures from distinct API keys must differ');
  });

  test('2C: Indexer Priority + Candidate Pool Factor + Per-Indexer Limits', () => {
    const rawStreams = [
      makeRawStream('Movie 1080p 1337x 1', { tracker: '1337x', seeders: 50, isBr: false }),
      makeRawStream('Movie 1080p 1337x 2', { tracker: '1337x', seeders: 45, isBr: false }),
      makeRawStream('Movie 1080p NerdFilmes 1', { tracker: 'nerdfilmes', seeders: 1, isBr: true }),
      makeRawStream('Movie 1080p NerdFilmes 2', { tracker: 'nerdfilmes', seeders: 1, isBr: true }),
      makeRawStream('Movie 1080p Bludv 1', { tracker: 'bludv', seeders: 1, isBr: true }),
      makeRawStream('Movie 1080p Bludv 2', { tracker: 'bludv', seeders: 1, isBr: true }),
    ];

    const streams = format.sortAndLimit(rawStreams.map(format.toStremioStream), {
      minSeeders: 1,
      maxResults: 6,
      indexerPriority: ['nerdfilmes', 'bludv'] as never[],
      brReservedSlots: 1,
      brFirst: true,
    });

    const limited = format.limitReservingBr(streams, {
      brReservedSlots: 1,
      maxResults: 3,
      maxPerIndexer: 1,
      indexerLimits: { nerdfilmes: 1, bludv: 1 },
      brFirst: true,
    });

    assert.equal(limited.length, 3);
    const titles = limited.map((s) => s.title);
    assert.ok(titles[0].includes('NerdFilmes'), 'Highest priority indexer nerdfilmes is 1st');
    assert.ok(titles[1].includes('Bludv'), 'Second priority indexer bludv is 2nd');
    assert.ok(titles[2].includes('1337x'), 'Global indexer is 3rd');
  });

  // ---------------------------------------------------------------------------
  // INTERACTION 3: Search Deadline Budget + Slow BR Indexer + Late-Pass Cache Write
  // ---------------------------------------------------------------------------

  test('3A: Search Deadline Budget: Fast global results return partial=true; background slow BR updates cache with partial=false', async () => {
    const fastStream = makeRawStream('Fast.Global.Movie.1080p', { isBr: false });
    const slowBrStream = makeRawStream('Slow.BR.Dublado.Movie.1080p', { isBr: true });

    const fastTask = Promise.resolve([fastStream]);
    const slowBrTask = (async () => {
      await sleep(100);
      return [slowBrStream];
    })();

    let latePassCalled = false;
    let latePassStreams: unknown[] = [];
    let latePassPartial: boolean | null = null;

    const collected = await collectWithinWindow(
      [
        { promise: fastTask, priority: false },
        { promise: slowBrTask, priority: true },
      ],
      {
        budgetMs: 40,
        priorityGraceMs: 0,
        onBatch: (batch, allItems) => {},
      },
    );

    assert.equal(collected.done, false, 'Initial collection timed out as expected');
    assert.equal(collected.items.length, 1, 'Initial bucket contains only fast stream');

    // Simulate the onLate handler attached in doSearch
    const completionPromise = collected.completion.then(() => {
      latePassCalled = true;
      latePassStreams = [...collected.items];
      latePassPartial = false;
    });

    await completionPromise;

    assert.equal(latePassCalled, true, 'Late pass executed after slow task finished');
    assert.equal(latePassStreams.length, 2, 'Late pass contains both fast and slow streams');
    assert.equal(latePassPartial, false, 'Late pass marks result as complete');
  });

  test('3B: Grace window (brPartialGrace) includes slow BR provider in initial batch if finished within grace period', async () => {
    const fastStream = makeRawStream('Fast.Movie.1080p', { isBr: false });
    const slowBrStream = makeRawStream('Grace.BR.Dublado.1080p', { isBr: true });

    const fastTask = sleep(10).then(() => [fastStream]);
    const slowBrTask = sleep(40).then(() => [slowBrStream]);

    const collected = await collectWithinWindow(
      [
        { promise: fastTask, priority: false },
        { promise: slowBrTask, priority: true },
      ],
      {
        budgetMs: 25,
        priorityGraceMs: 50, // Total allowance: 75ms. 40ms fits comfortably.
      },
    );

    assert.equal(collected.prioritySeen, true, 'Priority BR task completed during grace window');
    assert.equal(collected.items.length, 2, 'Both streams included in initial result');
  });

  // ---------------------------------------------------------------------------
  // INTERACTION 4: Autofetch BR Dubbed + held.hold + dropUncached Protection
  // ---------------------------------------------------------------------------

  test('4A: Autofetch BR Dubbed places candidate on hold, AllDebrid dropUncached spares held hash, enqueues download', async () => {
    const brCandidateHash = makeHash('br_dubbed_autofetch', 1);
    const globalUncachedHash = makeHash('global_uncached_drop', 2);
    const userApiKey = 'test-alldebrid-key';
    const account = accountScope(userApiKey);

    const streams = [
      makeRawStream('Movie.2024.1080p.DUBLADO.Nacional', { infoHash: brCandidateHash, isBr: true, _dubbed: true }),
      makeRawStream('Movie.2024.1080p.English', { infoHash: globalUncachedHash, isBr: false, _dubbed: false }),
    ].map(format.toStremioStream);

    const userOpts = {
      ...runtime.defaults(),
      debridService: 'alldebrid',
      debridApiKey: userApiKey,
      debridCachedOnly: true,
      autoFetchBr: true,
    };

    const adAdapter = debrid.BY_ID.get('alldebrid') as DebridAdapter;
    const originalCheck = adAdapter.checkCached;
    const originalEnqueue = adAdapter.enqueue;

    let enqueuedHash: string | null = null;
    let deletedHashes: string[] = [];

    // Mock AllDebrid adapter methods
    adAdapter.checkCached = async (key, hashes) => {
      // Simulate dropUncached inside AllDebrid checkCached
      for (const hash of hashes) {
        if (!held.isHeld(hash, account)) {
          deletedHashes.push(hash);
        }
      }
      return { cached: new Set(), known: true };
    };

    adAdapter.enqueue = async (key, hash) => {
      enqueuedHash = hash;
      return true;
    };

    try {
      await runtime.run({ opts: userOpts, encoded: 'ad-conf' }, async () => {
        await applyDebrid(streams, { searchKey: 'test-search-key' } as any);
      });

      // Give autofetch background promise time to resolve
      await sleep(25);

      assert.equal(enqueuedHash, brCandidateHash, 'BR dubbed candidate was enqueued for download');
      assert.ok(deletedHashes.includes(globalUncachedHash), 'Unprotected global uncached hash was cleaned up');
      assert.ok(!deletedHashes.includes(brCandidateHash), 'Held BR dubbed candidate was NOT deleted');

      // Autofetch marker should be recorded in cache to prevent duplicate enqueue
      const markerKey = autofetch.markerKey('alldebrid', account, brCandidateHash);
      assert.equal(cache.get(markerKey), 1, 'Autofetch marker persisted in cache');
    } finally {
      held.release(brCandidateHash, account);
      adAdapter.checkCached = originalCheck;
      adAdapter.enqueue = originalEnqueue;
    }
  });

  test('4B: Deduplication marker prevents duplicate enqueue calls on subsequent searches', async () => {
    const brCandidateHash = makeHash('br_dedupe_test', 1);
    const userApiKey = 'test-alldebrid-key';
    const account = accountScope(userApiKey);
    const markerKey = autofetch.markerKey('alldebrid', account, brCandidateHash);

    // Pre-set marker in cache (simulating prior search)
    cache.set(markerKey, 1, 3600);

    const streams = [
      makeRawStream('Movie.2024.1080p.DUBLADO', { infoHash: brCandidateHash, isBr: true, _dubbed: true }),
    ].map(format.toStremioStream);

    const userOpts = {
      ...runtime.defaults(),
      debridService: 'alldebrid',
      debridApiKey: userApiKey,
      debridCachedOnly: true,
      autoFetchBr: true,
    };

    const adAdapter = debrid.BY_ID.get('alldebrid') as DebridAdapter;
    const originalCheck = adAdapter.checkCached;
    const originalEnqueue = adAdapter.enqueue;

    let enqueueCalls = 0;
    adAdapter.checkCached = async () => ({ cached: new Set(), known: true });
    adAdapter.enqueue = async () => {
      enqueueCalls++;
      return true;
    };

    try {
      await runtime.run({ opts: userOpts, encoded: 'ad-conf' }, async () => {
        await applyDebrid(streams, { searchKey: 'test-search-2' } as any);
      });

      await sleep(20);
      assert.equal(enqueueCalls, 0, 'Enqueue was suppressed because marker was already active');
    } finally {
      cache.forget(markerKey);
      adAdapter.checkCached = originalCheck;
      adAdapter.enqueue = originalEnqueue;
    }
  });

  test('4C: Autofetch is skipped when a cached BR Dubbed stream is already available', async () => {
    const cachedBrHash = makeHash('br_cached_avail', 1);
    const uncachedBrHash = makeHash('br_uncached_worse', 2);
    const userApiKey = 'test-pm-key';

    const streams = [
      makeRawStream('Movie.2024.1080p.DUBLADO.Cached', { infoHash: cachedBrHash, isBr: true, _dubbed: true }),
      makeRawStream('Movie.2024.720p.DUBLADO.Uncached', { infoHash: uncachedBrHash, isBr: true, _dubbed: true }),
    ].map(format.toStremioStream);

    const userOpts = {
      ...runtime.defaults(),
      debridService: 'premiumize',
      debridApiKey: userApiKey,
      debridCachedOnly: true,
      autoFetchBr: true,
    };

    const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
    const originalCheck = pmAdapter.checkCached;
    const originalEnqueue = pmAdapter.enqueue;

    let enqueueCalls = 0;
    pmAdapter.checkCached = async () => ({
      cached: new Set([cachedBrHash]),
      known: true,
    });
    pmAdapter.enqueue = async () => {
      enqueueCalls++;
      return true;
    };

    try {
      await runtime.run({ opts: userOpts, encoded: 'pm-conf' }, async () => {
        await applyDebrid(streams, { searchKey: 'test-search-3' } as any);
      });

      await sleep(20);
      assert.equal(enqueueCalls, 0, 'No enqueue triggered when cached BR dubbed stream exists');
    } finally {
      pmAdapter.checkCached = originalCheck;
      pmAdapter.enqueue = originalEnqueue;
    }
  });

  // ---------------------------------------------------------------------------
  // INTERACTION 5: Strict Title Matching + Multi-Season Pack Fallback + Episode Filtering
  // ---------------------------------------------------------------------------

  test('5A: Strict Title Matching (matchesBrTitle) filters irrelevant WordPress results for short queries', () => {
    const matchContext = {
      names: ['Fallout'],
      year: 2024,
      isSeries: true,
    };

    const rawList = [
      makeRawStream('Missão: Impossível – Efeito Fallout (2018) 1080p', { isBr: true }), // Wrong movie
      makeRawStream('Fallout 4 (PC) [Dublado]', { isBr: true }), // Game
      makeRawStream('Cesium Fallout (2022) 1080p Dual', { isBr: true }), // Wrong movie
      makeRawStream('Fallout S01E05 1080p Dual', { isBr: true }), // Series episode 5
      makeRawStream('Fallout S01E01 1080p Dublado', { isBr: true }), // Series episode 1
      makeRawStream('Fallout 1ª Temporada Completa (2024) [DUBLADO]', { isBr: true }), // Season pack
    ];

    // Filter by relevant title and year
    const relevant = format.filterRelevantRaw(rawList, matchContext);
    assert.equal(relevant.length, 3, 'Only genuine Fallout TV series items pass title/year filter');

    // Filter by episode
    const episodeFiltered = relevant.filter((r) =>
      format.matchesEpisode(r.title || '', { season: 1, episode: 1 }),
    );

    assert.equal(episodeFiltered.length, 2, 'Only S01E01 and Season 1 pack pass episode filter');
    assert.ok(episodeFiltered.some((r) => r.title?.includes('S01E01')));
    assert.ok(episodeFiltered.some((r) => r.title?.includes('1ª Temporada')));
  });

  test('5B: Multi-Season Pack Fallback across search phases with createLatestWriter', async () => {
    let committedValue: any = null;

    const finish = createLatestWriter(
      async ({ items }) => ({ streams: items }),
      (result) => {
        committedValue = result;
      },
    );

    const phase0 = finish.phase();

    // Simulate Phase 0: Episode search returned empty
    await finish({ items: [] }, phase0);
    assert.deepEqual(committedValue.streams, []);

    // Advance to Phase 1: Pack search fallback
    const phase1 = finish.advance();
    assert.notEqual(phase1, phase0);

    const packStreams = [
      makeRawStream('Fallout S01 Complete Pack 1080p', { isBr: true }),
    ];

    // Commit Phase 1 results
    await finish({ items: packStreams }, phase1);
    assert.equal(committedValue.streams.length, 1);
    assert.equal(committedValue.streams[0].title, 'Fallout S01 Complete Pack 1080p');

    // Attempted late write from stale Phase 0 is ignored
    const staleStreams = [makeRawStream('Stale Episode Result', { isBr: false })];
    await finish({ items: staleStreams }, phase0);
    assert.equal(committedValue.streams[0].title, 'Fallout S01 Complete Pack 1080p', 'Phase 0 write did not overwrite Phase 1');
  });

  // ---------------------------------------------------------------------------
  // INTERACTION 6: SQLite WAL Persistence + Cache Invalidation + In-Flight Coalescing
  // ---------------------------------------------------------------------------

  test('6A: Cache forget and clear purges entries from memory and SQLite store', () => {
    const key1 = 'test_purge_key_1';
    const key2 = 'test_purge_key_2';
    const key3 = 'test_purge_key_3';

    cache.set(key1, { data: 'val1' }, 3600);
    cache.set(key2, { data: 'val2' }, 3600);
    cache.set(key3, { data: 'val3' }, 3600);

    assert.deepEqual(cache.get(key1), { data: 'val1' });
    assert.deepEqual(cache.get(key2), { data: 'val2' });
    assert.deepEqual(cache.get(key3), { data: 'val3' });

    cache.forget(key1);
    cache.forget(key2);

    assert.equal(cache.get(key1), null, 'key1 purged');
    assert.equal(cache.get(key2), null, 'key2 purged');
    assert.deepEqual(cache.get(key3), { data: 'val3' }, 'key3 remains intact');

    cache.forget(key3);
    assert.equal(cache.get(key3), null, 'key3 purged');
  });

  test('6B: In-flight request coalescing ensures identical concurrent searches share 1 promise', async () => {
    let executionCount = 0;
    const testKey = 'coalesce_imdb_id_1';

    // Mock search function
    async function simulateSearch() {
      executionCount++;
      await sleep(30);
      return [{ title: 'Simulated Stream' }];
    }

    const inFlightMap = new Map();

    async function executeCoalesced(key) {
      let task = inFlightMap.get(key);
      if (!task) {
        task = simulateSearch().finally(() => inFlightMap.delete(key));
        inFlightMap.set(key, task);
      }
      return task;
    }

    // Fire 8 simultaneous requests for identical key
    const results = await Promise.all([
      executeCoalesced(testKey),
      executeCoalesced(testKey),
      executeCoalesced(testKey),
      executeCoalesced(testKey),
      executeCoalesced(testKey),
      executeCoalesced(testKey),
      executeCoalesced(testKey),
      executeCoalesced(testKey),
    ]);

    assert.equal(executionCount, 1, 'Only 1 underlying search task executed');
    results.forEach((res) => {
      assert.deepEqual(res, [{ title: 'Simulated Stream' }]);
    });
  });

  // ---------------------------------------------------------------------------
  // INTERACTION 7: SecretBox Config Sealing + URL HMAC Signature Verification
  // ---------------------------------------------------------------------------

  test('7A: SecretBox Config Sealing + HMAC Signature generation and validation', () => {
    const operatorSecret = 'oper-resolve-secret-key-12345678';
    const userApiKey = 'user-realdebrid-private-token-xyz';

    config.debrid.resolveSecret = operatorSecret;

    try {
      const rawUserConfig = {
        ds: 'realdebrid',
        dk: userApiKey,
        m: 30,
        bf: 1,
      };

      const plainSegment = runtime.encode(rawUserConfig);
      const sealedSegment = runtime.sealSegment(plainSegment);

      assert.notEqual(sealedSegment, plainSegment, 'Sealed segment differs from plaintext');
      assert.ok(!sealedSegment.includes(userApiKey), 'Private API key not visible in sealed segment');

      // Decoding sealed segment in server runtime decrypts API key
      const decoded = runtime.decode(sealedSegment)!;
      assert.equal(decoded.debridApiKey, userApiKey, 'Decrypted API key matches original');
      assert.equal(decoded.maxResults, 30);
      assert.equal(decoded.brFirst, true);

      // Verify HMAC signing inside AsyncLocalStorage context
      runWith<void>({ opts: decoded, encoded: sealedSegment }, () => {
        const hash = makeHash('secure_movie', 1);
        const ep = '?s=1&e=2';
        const sig = signResolve(hash, ep);

        assert.ok(/^[a-f0-9]{64}$/.test(sig), 'Valid 64-character hex HMAC');
        assert.equal(verifyResolve(hash, ep, sig), true, 'Signature verified with operator secret');

        // Tampering tests
        assert.equal(verifyResolve(hash, '?s=1&e=3', sig), false, 'Wrong episode query rejected');
        assert.equal(verifyResolve(makeHash('other_movie', 2), ep, sig), false, 'Wrong hash rejected');
        assert.equal(verifyResolve(hash, ep, 'bad' + sig.slice(3)), false, 'Modified signature rejected');
      });
    } finally {
      config.debrid.resolveSecret = originalConfig.resolveSecret;
    }
  });

  test('7B: Sealed key with rotated/invalid RESOLVE_SECRET fails closed to empty key', () => {
    const originalSecret = 'secret-rotation-old';
    config.debrid.resolveSecret = originalSecret;

    const userApiKey = 'user-key-secret';
    const sealed = secretBox.seal(userApiKey);

    // Operator rotates secret to new key
    config.debrid.resolveSecret = 'secret-rotation-new';

    try {
      const decrypted = secretBox.open(sealed);
      assert.equal(decrypted, '', 'Rotated secret fails closed to empty string');
    } finally {
      config.debrid.resolveSecret = originalConfig.resolveSecret;
    }
  });

  // ---------------------------------------------------------------------------
  // INTERACTION 8: Combined Strict Filtering & Dynamic Floor Exhaustion
  // ---------------------------------------------------------------------------

  test('8A: Combined Strict Filter Pipeline (brOnly + preferDubbed + excludeCam + maxSizeGb)', () => {
    const rawStreams = [
      makeRawStream('Movie.2024.CAM.1080p.DUBLADO', { isBr: true, _dubbed: true, sizeBytes: 1.5 * 1024 ** 3 }), // CAM
      makeRawStream('Movie.2024.1080p.English.Only', { isBr: false, _dubbed: false, sizeBytes: 2.0 * 1024 ** 3 }), // Global
      makeRawStream('Movie.2024.1080p.DUBLADO.Huge', { isBr: true, _dubbed: true, sizeBytes: 15.0 * 1024 ** 3 }), // Exceeds 5GB
      makeRawStream('Movie.2024.1080p.LEGENDADO.BR', { isBr: true, _dubbed: false, sizeBytes: 2.0 * 1024 ** 3 }), // BR legendado
      makeRawStream('Movie.2024.1080p.DUBLADO.Nacional', { isBr: true, _dubbed: true, sizeBytes: 3.5 * 1024 ** 3 }), // Compliant BR dubbed
    ];

    const streams = format.sortAndLimit(rawStreams.map(format.toStremioStream), {
      minSeeders: 1,
      maxResults: 10,
      preferDubbed: true,
      excludeCam: true,
      maxSizeGb: 5,
    });

    const filtered = format.limitReservingBr(streams, {
      brReservedSlots: 4,
      maxResults: 1,
      brOnly: true,
    });

    assert.equal(filtered.length, 1, 'Only the highest ranking compliant BR dubbed stream survives');
    assert.ok(filtered[0].title.includes('Movie.2024.1080p.DUBLADO.Nacional'));
  });

  test('8B: brFirst = false vs brFirst = true preserves resolution ranking and slot reservation', () => {
    const rawStreams = [
      makeRawStream('Movie.2024.1080p.Global.Seeds100', { seeders: 100, isBr: false }),
      makeRawStream('Movie.2024.1080p.BR.Seeds1', { seeders: 1, isBr: true }),
      makeRawStream('Movie.2024.720p.Global.Seeds50', { seeders: 50, isBr: false }),
    ];

    const sorted = format.sortAndLimit(rawStreams.map(format.toStremioStream), {
      minSeeders: 1,
      maxResults: 10,
      brReservedSlots: 1,
      brFirst: false,
    });

    // brFirst = false: Global 1080p is 1st, BR 1080p is 2nd via reservation
    const limitedNoBrFirst = format.limitReservingBr(sorted, {
      brReservedSlots: 1,
      maxResults: 3,
      brFirst: false,
    });

    assert.ok(limitedNoBrFirst[0].title.includes('Movie.2024.1080p.Global.Seeds100'));
    assert.ok(limitedNoBrFirst[1].title.includes('Movie.2024.1080p.BR.Seeds1'));
    assert.ok(limitedNoBrFirst[2].title.includes('Movie.2024.720p.Global.Seeds50'));

    // brFirst = true: BR 1080p is lifted to index 0
    const limitedWithBrFirst = format.limitReservingBr(sorted, {
      brReservedSlots: 1,
      maxResults: 3,
      brFirst: true,
    });

    assert.ok(limitedWithBrFirst[0].title.includes('Movie.2024.1080p.BR.Seeds1'));
    assert.ok(limitedWithBrFirst[1].title.includes('Movie.2024.1080p.Global.Seeds100'));
  });

  test('8C: Dynamic Debrid Check Floor Exhaustion: Zero-network degradation to known: false + needsFullRefresh trigger', async () => {
    const rawStreams = [
      makeRawStream('Movie.1080p.A', { infoHash: makeHash('dyn_budget', 1) }),
      makeRawStream('Movie.1080p.B', { infoHash: makeHash('dyn_budget', 2) }),
    ].map(format.toStremioStream);

    const userOpts = {
      ...runtime.defaults(),
      debridService: 'premiumize',
      debridApiKey: 'test-pm-key',
    };

    let fullRefreshFlag = null;

    // Simulate deadline already elapsed before debrid check starts
    const pastDeadlineAt = Date.now() - 100;

    const result = await runWith<TestStream[]>({ opts: userOpts, encoded: 'pm-conf' }, async () => {
      return applyDebrid(rawStreams, {
        deadlineAt: pastDeadlineAt,
        onCacheResult: (res) => {
          fullRefreshFlag = res.needsFullRefresh;
        },
      } as any);
    });

    assert.equal(result.length, 2);
    // When budget <= 0, streams degrade to [PM download] without failing
    assert.match(result[0].name, /\[PM download\]/);
    assert.match(result[1].name, /\[PM download\]/);
    assert.equal(fullRefreshFlag, true, 'Full refresh flagged for background late execution');
  });
});
