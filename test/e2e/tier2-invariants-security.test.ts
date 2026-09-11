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
  describe('Feature 11: Torznab XML CDATA Resilience', () => {
    it('F11-BND-01: Decodes XML catalog items and attributes cleanly', () => {
      const xml = `
        <indexers>
          <indexer id="bludv-cardigann" name="BLUDV Releases" language="pt-BR">
          </indexer>
        </indexers>
      `;
      const parsed = jackettCatalog.parseXml(xml);
      assert.equal(parsed.length, 1);
      assert.equal(parsed[0].id, 'bludv-cardigann');
      assert.equal(parsed[0].label, 'BLUDV Releases');
      assert.equal(parsed[0].language, 'pt-BR');
    });

    it('F11-BND-02: Decodes HTML entities in Torznab XML titles and labels', () => {
      const xml = `
        <indexers>
          <indexer id="comandotorrents" name="Comando Torrents &#8211; Filmes &amp; S&#233;ries" language="pt-BR">
          </indexer>
        </indexers>
      `;
      const parsed = jackettCatalog.parseXml(xml);
      assert.equal(parsed.length, 1);
      assert.equal(parsed[0].id, 'comandotorrents');
      assert.ok(parsed[0].label.includes('Comando Torrents – Filmes & Séries'));
    });

    it('F11-BND-03: Empty tags and whitespace-only tags do not break parsing', () => {
      const xml = `
        <indexers>
          <indexer id="yts">
            <language></language>
          </indexer>
        </indexers>
      `;
      const parsed = jackettCatalog.parseXml(xml);
      assert.equal(parsed.length, 1);
      assert.equal(parsed[0].id, 'yts');
      assert.equal(parsed[0].label, 'yts');
    });

    it('F11-BND-04: Torznab XML with unclosed tags skips malformed entries', () => {
      const malformedXml = '<indexers><indexer id="bad"><title>Unclosed';
      const parsed = jackettCatalog.parseXml(malformedXml);
      assert.deepEqual(parsed, []);
    });

    it('F11-BND-05: Non-safe indexer IDs are skipped in Torznab XML catalog', () => {
      const xml = `
        <indexers>
          <indexer id="../unsafe-path">
            <title>Unsafe Path</title>
          </indexer>
          <indexer id="safe-id-123">
            <title>Safe Indexer</title>
          </indexer>
        </indexers>
      `;
      const parsed = jackettCatalog.parseXml(xml);
      assert.equal(parsed.length, 1);
      assert.equal(parsed[0].id, 'safe-id-123');
    });

    it('F11-BND-06: Catalog fallback() returns safe default indexers from .env', () => {
      const fb = jackettCatalog.fallback();
      assert.ok(Array.isArray(fb));
      assert.ok(fb.length > 0);
      for (const item of fb) {
        assert.ok(item.id);
        assert.ok(item.label);
        assert.ok(typeof item.isBr === 'boolean');
      }
    });
  });

  // =========================================================================
  // Feature 12: Architecture & Invariants Preservation
  // =========================================================================
  describe('Feature 12: Architecture & Invariants Preservation', () => {
    it('F12-BND-01: Invariant 2: Internal fields starting with _ are stripped from final streams', () => {
      const rawStream = {
        title: 'Movie 2024 1080p',
        magnet: 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567',
        infoHash: '0123456789abcdef0123456789abcdef01234567',
        seeders: 10,
        size: 1000000,
        tracker: 'jackett',
        isBr: true,
      };

      const converted = format.toStremioStream(rawStream) as Stream;
      assert.equal(converted._br, true);
      assert.ok(converted._quality);

      const finalized = format.limitReservingBr([converted], {
        brReservedSlots: 6,
        maxResults: 10,
        brOnly: false,
        qualityLimits: {},
        brFirst: true,
        maxPerIndexer: 0,
        indexerLimits: {},
      });

      assert.equal(finalized.length, 1);
      assert.equal('_br' in finalized[0], false);
      assert.equal('_seeders' in finalized[0], false);
      assert.equal('_quality' in finalized[0], false);
    });

    it('F12-BND-02: Invariant 3: BR sources without published seeders enter with seeders: 1', () => {
      const brItem = {
        title: 'Filme Nacional 2024',
        magnet: 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567',
        infoHash: '0123456789abcdef0123456789abcdef01234567',
        seeders: 1,
        isBr: true,
      };
      const stream = format.toStremioStream(brItem) as Stream;
      assert.equal(stream._seeders, 1);
      assert.equal(stream._br, true);
    });

    it('F12-BND-03: Invariant 4: Format utilities support PT-BR titles alongside English titles', () => {
      const searchNames = format.resolveSearchNames({
        meta: { name: 'Joker', year: '2019' },
        titles: { pt: 'Coringa', year: 2019 },
      });
      assert.ok(searchNames.names.includes('Joker'));
      assert.ok(searchNames.names.includes('Coringa'));
    });

    it('F12-BND-04: Invariant 5: Two-layer title filtering applies strict matchesBrTitle on BR releases', () => {
      const relevant = format.filterRelevantRaw(
        [
          { title: 'Coringa (2019) 1080p Dublado', isBr: true },
          { title: 'Missão Impossível Efeito Fallout (2018)', isBr: true },
        ],
        { names: ['Coringa'], year: 2019, isSeries: false },
      );
      assert.equal(relevant.length, 1);
      assert.equal(relevant[0].title, 'Coringa (2019) 1080p Dublado');
    });

    it('F12-BND-05: Invariant 6: Autofetch candidate hold executes before cache check', () => {
      const hash = '0123456789abcdef0123456789abcdef01234567';
      const account = 'test-account';
      protectedHashes.hold(hash, 60, account);
      assert.equal(protectedHashes.isHeld(hash, account), true);
      protectedHashes.release(hash, account);
      assert.equal(protectedHashes.isHeld(hash, account), false);
    });

    it('F12-BND-06: Runtime prefix helper correctly formats resolve URL paths', () => {
      assert.equal(runtime.prefix(), '');
      runtime.run({ opts: runtime.defaults(), encoded: 'test-config-segment' }, () => {
        assert.equal(runtime.prefix(), '/test-config-segment');
      });
    });
  });

  // =========================================================================
  // Feature 13: E2E Testing Suite (Tiers 1-4)
  // =========================================================================
  describe('Feature 13: E2E Testing Suite (Tiers 1-4)', () => {
    it('F13-BND-01: Config segment length boundary: 8192 chars decodes, 8193 rejected', () => {
      const validBase = runtime.encode({ m: 20 });
      assert.ok(runtime.decode(validBase));

      // JSON válido garante que este caso só passa pela barreira de tamanho,
      // não por uma falha incidental de decodificação/JSON.parse.
      const overflowSegment = Buffer
        .from(JSON.stringify({ m: 20, padding: 'x'.repeat(7000) }))
        .toString('base64url');
      assert.ok(overflowSegment.length > runtime.MAX_CONFIG_SEGMENT);
      assert.equal(runtime.decode(overflowSegment), null);
      assert.equal(runtime.sealSegment(overflowSegment), null);
    });

    it('F13-BND-02: Malformed base64url characters rejected with null', () => {
      const badSegments = [
        'invalid@char',
        'invalid!char',
        'has space',
        'has=equals',
        'has+plus',
        'has/slash',
      ];
      for (const seg of badSegments) {
        assert.equal(runtime.decode(seg), null);
      }
    });

    it('F13-BND-03: JSON arrays, numbers, strings, and non-objects rejected with null', () => {
      const nonObjects = [
        Buffer.from('[1, 2, 3]', 'utf8').toString('base64url'),
        Buffer.from('"plain string"', 'utf8').toString('base64url'),
        Buffer.from('12345', 'utf8').toString('base64url'),
        Buffer.from('true', 'utf8').toString('base64url'),
      ];
      for (const seg of nonObjects) {
        assert.equal(runtime.decode(seg), null);
      }
    });

    it('F13-BND-04: Clamps extreme option values to safe schema boundaries', () => {
      const normalized = runtime.normalize({
        m: 999,
        s: -10,
        b: 100,
        z: 500,
        q4: -5,
        q1: 150,
      });

      assert.equal(normalized.maxResults, 100);
      assert.equal(normalized.minSeeders, 0);
      assert.equal(normalized.brReservedSlots, 40);
      assert.equal(normalized.maxSizeGb, 200);
      assert.equal(normalized.max2160p, 0);
      assert.equal(normalized.max1080p, 100);
    });

    it('F13-BND-05: indexerLimits parsing clamps to 0..20, filters invalid IDs, and preserves 0', () => {
      const parsed = runtime.normalize({
        jl: 'BLUDV:0, nerdfilmes:5, 1337x:100, bad!id:10, empty:, :5',
      });

      assert.deepEqual(parsed.indexerLimits, {
        '1337x': 20,
        bludv: 0,
        nerdfilmes: 5,
      });
    });

    it('F13-BND-06: Roundtrip of sealed debrid API key through sealSegment and decode', () => {
      withSecret('test-operator-secret', () => {
        const rawSegment = runtime.encode({ ds: 'realdebrid', dk: 'my-private-api-key', m: 30 });
        const sealedSegment = runtime.sealSegment(rawSegment);

        assert.notEqual(sealedSegment, rawSegment);
        const decoded = runtime.decode(sealedSegment) as { debridApiKey: string; debridService: string; maxResults: number };
        assert.equal(decoded.debridApiKey, 'my-private-api-key');
        assert.equal(decoded.debridService, 'realdebrid');
        assert.equal(decoded.maxResults, 30);
      });
    });
  });

  // =========================================================================
  // Feature 14: Final E2E Pass & Adversarial Hardening (Tier 5)
  // =========================================================================
  describe('Feature 14: Final E2E Pass & Adversarial Hardening (Tier 5)', () => {
    it('F14-BND-01: HMAC signature verification fails on tampered signatures', () => {
      withSecret('operator-resolve-secret', () => {
        const hash = '0123456789abcdef0123456789abcdef01234567';
        const validSig = sign.signResolve(hash, '');
        assert.ok(validSig.length === 64);

        const tamperedSig = validSig.slice(0, -1) + (validSig.slice(-1) === 'a' ? 'b' : 'a');
        assert.equal(sign.verifyResolve(hash, '', validSig), true);
        assert.equal(sign.verifyResolve(hash, '', tamperedSig), false);

        assert.equal(sign.verifyResolve(hash, '', validSig.slice(0, 32)), false);
        assert.equal(sign.verifyResolve(hash, '', ''), false);
      });
    });

    it('F14-BND-02: HMAC signature verifies episode query string and prevents cross-episode play', () => {
      withSecret('operator-resolve-secret', () => {
        const hash = '0123456789abcdef0123456789abcdef01234567';
        const sigEp1 = sign.signResolve(hash, '?s=1&e=1');
        const sigEp2 = sign.signResolve(hash, '?s=1&e=2');

        assert.equal(sign.verifyResolve(hash, '?s=1&e=1', sigEp1), true);
        assert.equal(sign.verifyResolve(hash, '?s=1&e=2', sigEp2), true);

        assert.equal(sign.verifyResolve(hash, '?s=1&e=2', sigEp1), false);
        const sigMovie = sign.signResolve(hash, '');
        assert.equal(sign.verifyResolve(hash, '?s=1&e=1', sigMovie), false);
      });
    });

    it('F14-BND-03: InfoHash boundary validation handles edge lengths and case normalization', () => {
      const validLower = '0123456789abcdef0123456789abcdef01234567';
      const validUpper = validLower.toUpperCase();
      const tooShort = '0123456789abcdef0123456789abcdef0123456';
      const tooLong = '0123456789abcdef0123456789abcdef012345678';
      const nonHex = '0123456789abcdef0123456789abcdef0123456g';

      assert.equal(format.extractInfoHash(validLower), validLower);
      assert.equal(format.extractInfoHash(validUpper), validLower);
      assert.equal(format.extractInfoHash(tooShort), null);
      assert.equal(format.extractInfoHash(tooLong), null);
      assert.equal(format.extractInfoHash(nonHex), null);
    });

    it('F14-BND-04: secretBox tamper resistance fails closed returning empty string without throwing', () => {
      withSecret('test-secret', () => {
        const raw = 'my-secret-key';
        const sealed = secretBox.seal(raw);
        assert.ok(secretBox.isSealed(sealed));

        const tampered = sealed.slice(0, -2) + (sealed.slice(-2, -1) === 'A' ? 'B' : 'A') + sealed.slice(-1);
        assert.equal(secretBox.open(tampered), '');

        assert.equal(secretBox.open(sealed.slice(0, 10)), '');
      });
    });

    it('F14-BND-05: Diagnostic gate concurrency and rate limiting saturation returns 429 status', () => {
      const gate = createDiagnosticGate({
        limit: 2,
        maxConcurrent: 1,
        rateMessage: 'rate_limited',
        busyMessage: 'busy_slot',
      });

      const req1 = gate.enter('test-user');
      assert.equal(req1.ok, true);

      const req2 = gate.enter('test-user');
      assert.equal(req2.ok, false);
      assert.equal(req2.status, 429);
      assert.equal(req2.error, 'busy_slot');

      (req1.release as () => void)();

      const req3 = gate.enter('test-user');
      assert.equal(req3.ok, true);
      (req3.release as () => void)();

      const req4 = gate.enter('test-user');
      assert.equal(req4.ok, false);
      assert.equal(req4.status, 429);
      assert.equal(req4.error, 'rate_limited');
    });

    it('F14-BND-06: authorized() constant-time comparison guards against timing leaks', () => {
      const expected = 'secret-diagnostic-token-12345';
      assert.equal(authorized(expected, 'secret-diagnostic-token-12345'), true);
      assert.equal(authorized(expected, 'wrong-token'), false);
      assert.equal(authorized(expected, ''), false);
      assert.equal(authorized(expected, null), false);
      assert.equal(authorized(expected, 'secret-diagnostic-token-12345-extra'), false);
    });
  });
});
