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

  test('4C: Autofetch is skipped when the same target quality is already cached', async () => {
    const cachedBrHash = makeHash('br_cached_avail', 1);
    const uncachedBrHash = makeHash('br_uncached_worse', 2);
    const userApiKey = 'test-pm-key';

    // Mesma faixa (1080): cobertura por qualidade para o Chupim. Upgrade
    // 720/4K com 1080⚡ é coberto em autofetch-enqueue (matriz upgrade).
    const streams = [
      makeRawStream('Movie.2024.1080p.DUBLADO.Cached', { infoHash: cachedBrHash, isBr: true, _dubbed: true }),
      makeRawStream('Movie.2024.1080p.DUBLADO.Uncached', { infoHash: uncachedBrHash, isBr: true, _dubbed: true }),
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
      assert.equal(enqueueCalls, 0, 'No enqueue when the same target quality is already cached');
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

});
