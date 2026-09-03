/**
 * Empirical Stress and Concurrency Harness for Milestone 1 - Protectors Suite
 *
 * Tests:
 * 4. Obfuscated JS payloads, encoded entities, and multi-hop protector traversal in extractMagnet
 * 5. Recursive hop boundary verification (MAX_HOPS = 6 limit)
 */

import assert from 'node:assert/strict';
import bludv from '../bludv-resolver/server.js';
import comando from '../comandotorrents-resolver/server.js';
import nerd from '../nerdfilmes-resolver/server.js';
import tdf from '../torrentdosfilmes-resolver/server.js';

const originalFetch = globalThis.fetch;

function resetAll() {
  globalThis.fetch = originalFetch;
  bludv.postCache.clear();
  bludv.inFlight.clear();
  comando.postCache.clear();
  comando.inFlight.clear();
  nerd.cache.clear();
  nerd.inFlight.clear();
  tdf.postCache.clear();
  tdf.inFlight.clear();
}

async function runTests() {
  console.log('=== Starting Milestone 1 Protectors Stress Test Harness ===\n');
  const results: { passed: number; failed: number; timings: Record<string, number> } = { passed: 0, failed: 0, timings: {} };

  function recordPass(name: any, durationMs: any) {
    results.passed++;
    results.timings[name] = durationMs;
    console.log(`[PASS] ${name} (${durationMs.toFixed(2)}ms)`);
  }

  function recordFail(name: any, err: any) {
    results.failed++;
    console.error(`[FAIL] ${name}:`, err.message);
  }

  // --------------------------------------------------------------------------
  // SUITE 4: Obfuscated JS Payloads & Complex Magnet Extraction
  // --------------------------------------------------------------------------
  console.log('\n--- Suite 4: Obfuscated JS Payloads & Link Protector Extractions ---');

  const testHash = '4b9281a804a8b79f67a216b801a613fbf506f8c7';
  const expectedMagnet = `magnet:?xt=urn:btih:${testHash}&dn=Obfuscated+Movie`;

  // Test 4.1: Minified single line JS with multiple variable declarations
  try {
    const t0 = performance.now();
    const htmlMinified = `
      <html><head><script>
      (function(){var _0x=['a','b'];var x=10,y=20,DEST_URL="${expectedMagnet}",z=30;window.run=function(){return z;};})();
      </script></head><body>Loading...</body></html>
    `;
    assert.equal(bludv.extractMagnet(htmlMinified), expectedMagnet);
    assert.equal(comando.extractMagnet(htmlMinified), expectedMagnet);
    assert.equal(nerd.extractMagnet(htmlMinified), expectedMagnet);
    assert.equal(tdf.extractMagnet(htmlMinified), expectedMagnet);
    recordPass('extractMagnet: minified single-line JS with multiple vars', performance.now() - t0);
  } catch (err) {
    recordFail('extractMagnet: minified single-line JS', err);
  }

  // Test 4.2: Multiline whitespace and unusual variable naming conventions
  try {
    const t0 = performance.now();
    const htmlWhitespace = `
      <script>
        const
          DOWNLOAD_LINK
          =
          '${expectedMagnet}'
          ;
      </script>
    `;
    assert.equal(bludv.extractMagnet(htmlWhitespace), expectedMagnet);
    assert.equal(comando.extractMagnet(htmlWhitespace), expectedMagnet);
    assert.equal(nerd.extractMagnet(htmlWhitespace), expectedMagnet);
    assert.equal(tdf.extractMagnet(htmlWhitespace), expectedMagnet);
    recordPass('extractMagnet: multiline whitespace and unusual formatting', performance.now() - t0);
  } catch (err) {
    recordFail('extractMagnet: multiline whitespace', err);
  }

  // Test 4.3: JavaScript navigation methods (location.replace, location.assign, window.open)
  try {
    const t0 = performance.now();
    const htmlReplace = `<script>location.replace("${expectedMagnet}");</script>`;
    const htmlAssign = `<script>location.assign('${expectedMagnet}');</script>`;
    const htmlOpen = `<script>window.open("${expectedMagnet}");</script>`;

    assert.equal(bludv.extractMagnet(htmlReplace), expectedMagnet);
    assert.equal(comando.extractMagnet(htmlAssign), expectedMagnet);
    assert.equal(nerd.extractMagnet(htmlOpen), expectedMagnet);
    assert.equal(tdf.extractMagnet(htmlReplace), expectedMagnet);
    recordPass('extractMagnet: navigation methods (replace, assign, open)', performance.now() - t0);
  } catch (err) {
    recordFail('extractMagnet: navigation methods', err);
  }

  // Test 4.4: URL-encoded magnet payload
  try {
    const t0 = performance.now();
    const encoded = encodeURIComponent(expectedMagnet);
    const htmlEncoded = `<script>var download_url = "${encoded}";</script>`;

    assert.equal(bludv.extractMagnet(htmlEncoded), expectedMagnet);
    assert.equal(comando.extractMagnet(htmlEncoded), expectedMagnet);
    assert.equal(nerd.extractMagnet(htmlEncoded), expectedMagnet);
    assert.equal(tdf.extractMagnet(htmlEncoded), expectedMagnet);
    recordPass('extractMagnet: URL-encoded magnet URI decoding', performance.now() - t0);
  } catch (err) {
    recordFail('extractMagnet: URL-encoded magnet URI', err);
  }

  // Test 4.5: HTML Entities inside magnet URI query string and HTML attributes
  try {
    const t0 = performance.now();
    const entityMagnet = `magnet:?xt=urn:btih:${testHash}&amp;dn=Movie&#038;tr=udp%3A%2F%2Ftracker`;
    const decodedMagnet = `magnet:?xt=urn:btih:${testHash}&dn=Movie&tr=udp%3A%2F%2Ftracker`;
    const htmlEntities = `<a href="${entityMagnet}">Download</a>`;

    assert.equal(bludv.extractMagnet(htmlEntities), decodedMagnet);
    assert.equal(comando.extractMagnet(htmlEntities), decodedMagnet);
    assert.equal(nerd.extractMagnet(htmlEntities), decodedMagnet);
    assert.equal(tdf.extractMagnet(htmlEntities), decodedMagnet);
    recordPass('extractMagnet: HTML entity sanitization (&amp;, &#038;)', performance.now() - t0);
  } catch (err) {
    recordFail('extractMagnet: HTML entity sanitization', err);
  }

  // Test 4.6: Multi-Hop Mixed Redirect Chain Traversal (JS -> Meta Refresh -> 302 -> Data Magnet)
  try {
    resetAll();
    const t0 = performance.now();
    globalThis.fetch = (async (url: any) => {
      const u = typeof url === 'string' ? url : url.href;

      if (u === 'https://systemads1.com/hop1') {
        return {
          ok: true,
          status: 200,
          text: async () => '<script>var NEXT_URL = "https://videosad.net/hop2";</script>',
        };
      }
      if (u === 'https://videosad.net/hop2') {
        return {
          ok: true,
          status: 200,
          text: async () => '<meta http-equiv="refresh" content="0; url=https://canalfutebol.com/hop3">',
        };
      }
      if (u === 'https://canalfutebol.com/hop3') {
        return {
          status: 302,
          headers: new Map([['location', 'https://systemads.net/final']]),
        };
      }
      if (u === 'https://systemads.net/final') {
        return {
          ok: true,
          status: 200,
          text: async () => `<button data-magnet="${expectedMagnet}">Download Magnet</button>`,
        };
      }
      throw new Error(`Unexpected request to: ${u}`);
    }) as unknown as typeof globalThis.fetch;

    const resolvedBludv = await bludv.fetchFollowingAllowed('https://systemads1.com/hop1', 'https://bludvfilmes.xyz/post');
    assert.equal(resolvedBludv, expectedMagnet);

    const resolvedComando = await comando.fetchFollowingAllowed('https://systemads1.com/hop1', 'https://comandotorrents.to/post');
    assert.equal(resolvedComando, expectedMagnet);

    const resolvedNerd = await nerd.fetchFollowingAllowed('https://systemads1.com/hop1', 'https://www.xnerdfilmes.net/post');
    assert.equal(resolvedNerd, expectedMagnet);

    const resolvedTdf = await tdf.fetchFollowingAllowed('https://systemads1.com/hop1', 'https://torrentdosfilmes-v2.xyz/post');
    assert.equal(resolvedTdf, expectedMagnet);

    recordPass('fetchFollowingAllowed: 4-hop mixed chain (JS var -> Meta refresh -> 302 -> Data attr)', performance.now() - t0);
  } catch (err) {
    recordFail('fetchFollowingAllowed: 4-hop mixed chain', err);
  }

  // --------------------------------------------------------------------------
  // SUITE 5: Hop Limits & Recursion Guard
  // --------------------------------------------------------------------------
  console.log('\n--- Suite 5: Hop Limits & Recursion Guard ---');

  // Test 5.1: 7-Hop redirect loop should fail with too_many_redirects
  try {
    resetAll();
    const t0 = performance.now();
    let hopCount = 0;
    globalThis.fetch = (async (url: any) => {
      hopCount++;
      const nextHop = hopCount + 1;
      return {
        ok: true,
        status: 200,
        text: async () => `<script>var NEXT_URL = "https://systemads1.com/hop${nextHop}";</script>`,
      };
    }) as unknown as typeof globalThis.fetch;

    await assert.rejects(
      () => bludv.fetchFollowingAllowed('https://systemads1.com/hop1', 'https://bludvfilmes.xyz/post'),
      /too_many_redirects/,
    );
    assert.ok(hopCount >= 6, `Expected at least 6 hops before aborting, got ${hopCount}`);
    recordPass('fetchFollowingAllowed: strictly terminates at MAX_HOPS (6) without infinite loop', performance.now() - t0);
  } catch (err) {
    recordFail('fetchFollowingAllowed: strictly terminates at MAX_HOPS', err);
  }

  // --------------------------------------------------------------------------
  // Summary
  // --------------------------------------------------------------------------
  console.log('\n=============================================================');
  console.log(`Protectors Stress Test Results: ${results.passed} PASSED, ${results.failed} FAILED`);
  console.log('=============================================================');

  resetAll();
  if (results.failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
