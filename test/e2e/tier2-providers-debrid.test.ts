// Rodada 2: checagem ligada; tier 2 (casos de borda e canto) tipado.
// A suíte precisa ser idêntica no Node 18 e no Node 22, sem criar SQLite local.
process.env.CACHE_PERSIST = 'false';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import config from '../../src/config.js';
import * as runtime from '../../src/runtime.js';
import * as cache from '../../src/utils/cache.js';
import * as format from '../../src/utils/format.js';
import * as sign from '../../src/utils/sign.js';
import * as secretBox from '../../src/utils/secret-box.js';
import { createDiagnosticGate, authorized } from '../../src/utils/diagnostic-guard.js';
import debrid from '../../src/debrid/index.js';
import * as debridCommon from '../../src/debrid/common.js';
import * as protectedHashes from '../../src/debrid/protected.js';
import * as jackettCatalog from '../../src/providers/jackett-catalog.js';
import prowlarr from '../../src/providers/prowlarr.js';
import * as brResolvers from '../../src/br-resolvers.js';
import bludvResolver from '../../bludv-resolver/server.js';
import nerdfilmesResolver from '../../nerdfilmes-resolver/server.js';
import torrentdosfilmesResolver from '../../torrentdosfilmes-resolver/server.js';
import comandotorrentsResolver from '../../comandotorrents-resolver/server.js';
import { collectWithinWindow } from '../../src/providers/collection-window.js';
import { createLatestWriter } from '../../src/utils/latest-writer.js';
import { raceWithDeadline, remainingCheckBudget } from '../../src/utils/deadline.js';
import type { Stream } from '../../types/domain.js';

// Helper to run code with temporary config modifications
function withSecret(secret: any, fn: any) {
  const original = config.debrid.resolveSecret;
  config.debrid.resolveSecret = secret;
  try {
    return fn();
  } finally {
    config.debrid.resolveSecret = original;
  }
}

describe('Tier 2 Boundary & Corner Cases E2E Test Suite', () => {

  // =========================================================================
  describe('Feature 8: Search & Late-Pass Budget Optimization', () => {
    it('F08-BND-01: collectWithinWindow returns done=false when slow provider exceeds deadline', async () => {
      const fastTask = {
        promise: new Promise((r) => setTimeout(() => r([{ title: 'Fast Stream' }]), 10)),
        priority: false,
      };
      const slowTask = {
        promise: new Promise((r) => setTimeout(() => r([{ title: 'Slow Stream' }]), 200)),
        priority: false,
      };

      const bucket = await collectWithinWindow([fastTask, slowTask], { budgetMs: 50 });
      assert.ok(bucket.items.length >= 1);
      assert.equal(bucket.items[0].title, 'Fast Stream');
      assert.equal(bucket.done, false);
      assert.ok(bucket.completion instanceof Promise);
      await bucket.completion;
    });

    it('F08-BND-02: Fast providers completing within budget return done=true', async () => {
      const t1 = {
        promise: new Promise((r) => setTimeout(() => r([{ title: 'Stream 1' }]), 5)),
        priority: false,
      };
      const t2 = {
        promise: new Promise((r) => setTimeout(() => r([{ title: 'Stream 2' }]), 10)),
        priority: false,
      };

      const bucket = await collectWithinWindow([t1, t2], { budgetMs: 100 });
      assert.equal(bucket.items.length, 2);
      assert.equal(bucket.done, true);
    });

    it('F08-BND-03: latestWriter suppresses stale background updates from earlier search phases', async () => {
      const writes: unknown[] = [];
      const build = async (input: any) => input;
      const commit = async (val: any) => writes.push(val);
      const writer = createLatestWriter(build, commit);

      const phase0 = writer.phase();
      writer.advance();
      const phase1 = writer.phase();

      await writer('stale-data', phase0);
      await writer(['fresh-data'], phase1);

      assert.equal(writes.length, 1);
      assert.deepEqual(writes[0], ['fresh-data']);
    });

    it('F08-BND-04: raceWithDeadline returns fallback value on timeout', async () => {
      const slowTask = new Promise((r) => setTimeout(() => r('done'), 100));
      const result = await raceWithDeadline(slowTask, 10, () => 'timed-out');
      assert.equal(result, 'timed-out');
    });

    it('F08-BND-05: remainingCheckBudget returns zero or positive and never negative past deadline', () => {
      const futureDeadline = Date.now() + 5000;
      const pastDeadline = Date.now() - 5000;

      assert.ok((remainingCheckBudget(futureDeadline) as number) > 0);
      assert.equal(remainingCheckBudget(pastDeadline), 0);
    });

    it('F08-BND-06: In-flight coalescing under simultaneous identical requests returns identical promise', async () => {
      const inFlight = new Map();
      let execs = 0;

      function mockSearch(id: any) {
        if (inFlight.has(id)) return inFlight.get(id);
        const task = (async () => {
          execs++;
          await new Promise((r) => setTimeout(r, 20));
          return { id, streams: ['s1', 's2'] };
        })().finally(() => inFlight.delete(id));
        inFlight.set(id, task);
        return task;
      }

      const p1 = mockSearch('tt1234567');
      const p2 = mockSearch('tt1234567');
      const p3 = mockSearch('tt1234567');

      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
      assert.equal(execs, 1);
      assert.deepEqual(r1, r2);
      assert.deepEqual(r2, r3);
    });
  });

  // =========================================================================
  // Feature 9: Prowlarr Provider Resilience & Unit Testing
  // =========================================================================
  describe('Feature 9: Prowlarr Provider Resilience & Unit Testing', () => {
    it('F09-BND-01: Prowlarr search returns empty array on empty query or missing API key', async () => {
      const emptyRes = await prowlarr.search('');
      assert.deepEqual(emptyRes, []);
    });

    it('F09-BND-02: Handles HTTP 500/502/504 responses gracefully returning empty array', async () => {
      const origFetch = global.fetch;
      const origApiKey = config.prowlarr.apiKey;
      config.prowlarr.apiKey = 'test-key';
      try {
        global.fetch = (async () => ({
          ok: false,
          status: 502,
          text: async () => 'Bad Gateway',
        })) as unknown as typeof globalThis.fetch;
        const res = await prowlarr.search('Test Query');
        assert.deepEqual(res, []);
      } finally {
        global.fetch = origFetch;
        config.prowlarr.apiKey = origApiKey;
      }
    });

    it('F09-BND-03: Handles malformed JSON response from Prowlarr returning empty array', async () => {
      const origFetch = global.fetch;
      const origApiKey = config.prowlarr.apiKey;
      config.prowlarr.apiKey = 'test-key';
      try {
        global.fetch = (async () => ({
          ok: true,
          status: 200,
          json: async () => {
            throw new Error('Unexpected token in JSON');
          },
        })) as unknown as typeof globalThis.fetch;
        const res = await prowlarr.search('Test Query');
        assert.deepEqual(res, []);
      } finally {
        global.fetch = origFetch;
        config.prowlarr.apiKey = origApiKey;
      }
    });

    it('F09-BND-04: Correctly maps valid Torznab items from Prowlarr payload', async () => {
      const origFetch = global.fetch;
      const origApiKey = config.prowlarr.apiKey;
      config.prowlarr.apiKey = 'test-key';
      try {
        global.fetch = (async () => ({
          ok: true,
          status: 200,
          json: async () => [
            {
              title: 'Movie 2024 1080p',
              magnetUrl: 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567',
              infoHash: '0123456789abcdef0123456789abcdef01234567',
              seeders: 42,
              size: 2147483648,
              indexer: '1337x',
            },
          ],
        })) as unknown as typeof globalThis.fetch;
        const res = await prowlarr.search('Movie 2024');
        assert.equal(res.length, 1);
        assert.equal(res[0].title, 'Movie 2024 1080p');
        assert.equal(res[0].infoHash, '0123456789abcdef0123456789abcdef01234567');
        assert.equal(res[0].seeders, 42);
        assert.equal(res[0].tracker, '1337x');
      } finally {
        global.fetch = origFetch;
        config.prowlarr.apiKey = origApiKey;
      }
    });

    it('F09-BND-05: Network timeout / AbortSignal triggering returns empty array', async () => {
      const origFetch = global.fetch;
      const origApiKey = config.prowlarr.apiKey;
      config.prowlarr.apiKey = 'test-key';
      try {
        global.fetch = async () => {
          throw new Error('The operation was aborted');
        };
        const res = await prowlarr.search('Movie 2024');
        assert.deepEqual(res, []);
      } finally {
        global.fetch = origFetch;
        config.prowlarr.apiKey = origApiKey;
      }
    });

    it('F09-BND-06: Prowlarr provider exports correct name identifier', () => {
      assert.equal(prowlarr.name, 'prowlarr');
      assert.equal(typeof prowlarr.search, 'function');
    });
  });

  // =========================================================================
  // Feature 10: Debrid Adapter Mock & Error Coverage
  // =========================================================================
  describe('Feature 10: Debrid Adapter Mock & Error Coverage', () => {
    it('F10-BND-01: batched() throws error when all chunks fail to prevent false empty cache', async () => {
      const hashes = ['hash1', 'hash2', 'hash3'];
      // Falha transitória: a invariante é o erro SUBIR, para que "não perguntei"
      // nunca vire "seu debrid não tem nada".
      await assert.rejects(
        () => debridCommon.batched(hashes, 2, async () => { throw new Error('Debrid timeout'); }),
        /nenhum lote de checagem de cache respondeu/,
      );

      // Credencial recusada sobe pela mesma porta, porém marcada: é o que deixa
      // o orquestrador devolver a lista como P2P em vez de prometer debrid.
      await assert.rejects(
        () => debridCommon.batched(hashes, 2, async () => { throw new Error('Debrid 401 Unauthorized'); }),
        (err) => (err as { isAuthError?: boolean }).isAuthError === true,
      );
    });

    it('F10-BND-02: batched() partitions items into chunk sizes and merges results', async () => {
      const items = ['a', 'b', 'c', 'd', 'e'];
      const batches: string[][] = [];
      const result = await debridCommon.batched(items, 2, async (batch) => {
        batches.push(batch);
        return new Set(batch);
      });

      assert.equal(batches.length, 3);
      assert.deepEqual(batches[0], ['a', 'b']);
      assert.deepEqual(batches[1], ['c', 'd']);
      assert.deepEqual(batches[2], ['e']);
      assert.equal(result.cached.size, 5);
      assert.equal(result.complete, true);
    });

    it('F10-BND-03: pickFile lança NoVideoError para torrents sem nenhum arquivo de vídeo', () => {
      const nonVideoFiles = [
        { path: 'readme.txt', name: 'readme.txt', bytes: 1024 },
        { path: 'sample.nfo', name: 'sample.nfo', bytes: 2048 },
        { path: 'subs.srt', name: 'subs.srt', bytes: 50000 },
        { path: 'setup.exe', name: 'setup.exe', bytes: 5000000 },
      ];
      // Listagem COM arquivos e nenhum vídeo é prova determinística de magnet
      // quebrado — o /resolve usa o erro para gravar bad no banco de magnets.
      assert.throws(() => debridCommon.pickFile(nonVideoFiles), (err: any) => err?.code === 'NO_VIDEO');
      // Listagem VAZIA continua null: é transferência fria, prova nenhuma.
      assert.equal(debridCommon.pickFile([]), null);
    });

    it('F10-BND-04: pickFile filters out samples and matches target episode in series pack', () => {
      const files = [
        { path: 'sample.mkv', name: 'sample.mkv', bytes: 5000000 },
        { path: 'Show.S01E01.1080p.mkv', name: 'Show.S01E01.1080p.mkv', bytes: 1073741824 },
        { path: 'Show.S01E02.1080p.mkv', name: 'Show.S01E02.1080p.mkv', bytes: 1073741824 },
        { path: 'Show.S01E03.1080p.mkv', name: 'Show.S01E03.1080p.mkv', bytes: 1073741824 },
      ];
      const picked = debridCommon.pickFile(files, { season: 1, episode: 2 });
      assert.ok(picked);
      assert.equal(picked.name, 'Show.S01E02.1080p.mkv');
    });

    it('F10-BND-05: protectedHashes hold, isHeld, and release respect account boundary', () => {
      const hash = '0123456789abcdef0123456789abcdef01234567';
      const accountA = 'acc-a';
      const accountB = 'acc-b';

      protectedHashes.hold(hash, 60, accountA);
      assert.equal(protectedHashes.isHeld(hash, accountA), true);
      assert.equal(protectedHashes.isHeld(hash, accountB), false);

      protectedHashes.release(hash, accountA);
      assert.equal(protectedHashes.isHeld(hash, accountA), false);
    });

    it('F10-BND-06: Debrid registry correctly identifies adapters by service ID', () => {
      assert.ok(debrid.SERVICES.length >= 5);
      const ids = debrid.SERVICES.map((s) => s.id);
      assert.ok(ids.includes('realdebrid'));
      assert.ok(ids.includes('premiumize'));
      assert.ok(ids.includes('alldebrid'));
      assert.ok(ids.includes('torbox'));
      assert.ok(ids.includes('debridlink'));
    });
  });

  // =========================================================================
  // Feature 11: Torznab XML CDATA Resilience
  // =========================================================================
});
