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
    assert.ok(String(titles[0]).includes('NerdFilmes'), 'Highest priority indexer nerdfilmes is 1st');
    assert.ok(String(titles[1]).includes('Bludv'), 'Second priority indexer bludv is 2nd');
    assert.ok(String(titles[2]).includes('1337x'), 'Global indexer is 3rd');
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

});
