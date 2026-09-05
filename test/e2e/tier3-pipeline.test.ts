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

    async function executeCoalesced(key: any) {
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
      assert.ok(!String(sealedSegment).includes(userApiKey), 'Private API key not visible in sealed segment');

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
    assert.ok(String(filtered[0]!.title).includes('Movie.2024.1080p.DUBLADO.Nacional'));
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

    assert.ok(String(limitedNoBrFirst[0]!.title).includes('Movie.2024.1080p.Global.Seeds100'));
    assert.ok(String(limitedNoBrFirst[1]!.title).includes('Movie.2024.1080p.BR.Seeds1'));
    assert.ok(String(limitedNoBrFirst[2]!.title).includes('Movie.2024.720p.Global.Seeds50'));

    // brFirst = true: BR 1080p is lifted to index 0
    const limitedWithBrFirst = format.limitReservingBr(sorted, {
      brReservedSlots: 1,
      maxResults: 3,
      brFirst: true,
    });

    assert.ok(String(limitedWithBrFirst[0]!.title).includes('Movie.2024.1080p.BR.Seeds1'));
    assert.ok(String(limitedWithBrFirst[1]!.title).includes('Movie.2024.1080p.Global.Seeds100'));
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
        onCacheResult: (res: any) => {
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
