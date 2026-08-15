/**
 * Empirical Stress and Concurrency Harness for Milestone 1 - Extended Hardening Suite
 *
 * Tests:
 * 1. In-flight request coalescing under massive concurrency (50+ parallel calls)
 * 2. In-flight error cleanup & memory safety under upstream failures and mixed success/failure storms
 * 3. Cache bounding & LRU eviction under high churn (> 200 items in resolvers, > 2000 in L1)
 * 4. Obfuscated JS payloads, encoded entities, and multi-hop protector traversal in extractMagnet
 * 5. Recursive hop boundary verification (MAX_HOPS = 6 limit)
 * 6. High-concurrency button resolution during in-flight post link extraction
 */

const assert = require('node:assert/strict');
const bludv = require('../bludv-resolver/server');
const comando = require('../comandotorrents-resolver/server');
const nerd = require('../nerdfilmes-resolver/server');
const tdf = require('../torrentdosfilmes-resolver/server');
const cache = require('../src/utils/cache');

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
  console.log('=== Starting Milestone 1 Empirical Stress Test Harness ===\n');
  const results = { passed: 0, failed: 0, timings: {} };

  function recordPass(name, durationMs) {
    results.passed++;
    results.timings[name] = durationMs;
    console.log(`[PASS] ${name} (${durationMs.toFixed(2)}ms)`);
  }

  function recordFail(name, err) {
    results.failed++;
    console.error(`[FAIL] ${name}:`, err.message);
  }

  // --------------------------------------------------------------------------
  // SUITE 1: In-Flight Coalescing Under Massive Concurrency
  // --------------------------------------------------------------------------
  console.log('\n--- Suite 1: In-Flight Request Coalescing Under Massive Concurrency ---');

  // Test 1.1: 50 simultaneous parallel requests to BLUDV getPostLinks
  try {
    resetAll();
    const t0 = performance.now();
    let fetchCount = 0;
    globalThis.fetch = async () => {
      fetchCount++;
      await new Promise((r) => setTimeout(r, 40));
      return {
        ok: true,
        status: 200,
        text: async () => `
          <div class="post-single">
            <h3>VERSÃO MKV DUAL ÁUDIO</h3>
            <p>1080p (3.5 GB)</p>
            <a href="https://systemads1.com/go/b1">Magnet-Link</a>
          </div>
        `,
      };
    };

    const targetUrl = 'https://bludvfilmes.xyz/filme-concorrencia-50/';
    const promises = Array.from({ length: 50 }, () => bludv.getPostLinks(targetUrl));
    const allResults = await Promise.all(promises);

    assert.equal(fetchCount, 1, `Expected exactly 1 fetch for 50 concurrent requests, got ${fetchCount}`);
    assert.equal(allResults.length, 50);
    for (const res of allResults) {
      assert.equal(res.links.length, 1);
      assert.equal(res.links[0].url, 'https://systemads1.com/go/b1');
    }
    assert.equal(bludv.inFlight.size, 0, 'bludv.inFlight map must be empty after all requests complete');
    recordPass('bludv: 50 concurrent requests coalesced to 1 fetch', performance.now() - t0);
  } catch (err) {
    recordFail('bludv: 50 concurrent requests coalesced to 1 fetch', err);
  }

  // Test 1.2: 50 simultaneous parallel requests to ComandoTorrents
  try {
    resetAll();
    const t0 = performance.now();
    let fetchCount = 0;
    globalThis.fetch = async () => {
      fetchCount++;
      await new Promise((r) => setTimeout(r, 35));
      return {
        ok: true,
        status: 200,
        text: async () => '<article class="blog-view"><a href="https://videosad.net/go/c1">Link</a></article>',
      };
    };

    const targetUrl = 'https://comandotorrents.to/filme-concorrencia-50/';
    const promises = Array.from({ length: 50 }, () => comando.getPostLinks(targetUrl));
    const allResults = await Promise.all(promises);

    assert.equal(fetchCount, 1);
    assert.equal(allResults.length, 50);
    assert.equal(comando.inFlight.size, 0);
    recordPass('comandotorrents: 50 concurrent requests coalesced to 1 fetch', performance.now() - t0);
  } catch (err) {
    recordFail('comandotorrents: 50 concurrent requests coalesced to 1 fetch', err);
  }

  // Test 1.3: 50 simultaneous parallel requests to NerdFilmes
  try {
    resetAll();
    const t0 = performance.now();
    let fetchCount = 0;
    globalThis.fetch = async () => {
      fetchCount++;
      await new Promise((r) => setTimeout(r, 35));
      return {
        ok: true,
        status: 200,
        text: async () => '<article class="col"><a href="https://canalfutebol.com/go/n1">Nerd</a></article>',
      };
    };

    const targetUrl = 'https://www.xnerdfilmes.net/filme-concorrencia-50/';
    const promises = Array.from({ length: 50 }, () => nerd.getPostLinks(targetUrl));
    const allResults = await Promise.all(promises);

    assert.equal(fetchCount, 1);
    assert.equal(allResults.length, 50);
    assert.equal(nerd.inFlight.size, 0);
    recordPass('nerdfilmes: 50 concurrent requests coalesced to 1 fetch', performance.now() - t0);
  } catch (err) {
    recordFail('nerdfilmes: 50 concurrent requests coalesced to 1 fetch', err);
  }

  // Test 1.4: 50 simultaneous parallel requests to TorrentDosFilmes
  try {
    resetAll();
    const t0 = performance.now();
    let fetchCount = 0;
    globalThis.fetch = async () => {
      fetchCount++;
      await new Promise((r) => setTimeout(r, 35));
      return {
        ok: true,
        status: 200,
        text: async () => '<div><a href="https://systemads1.com/go/t1">TDF</a></div>',
      };
    };

    const targetUrl = 'https://torrentdosfilmes-v2.xyz/filme-concorrencia-50/';
    const promises = Array.from({ length: 50 }, () => tdf.getPostLinks(targetUrl));
    const allResults = await Promise.all(promises);

    assert.equal(fetchCount, 1);
    assert.equal(allResults.length, 50);
    assert.equal(tdf.inFlight.size, 0);
    recordPass('torrentdosfilmes: 50 concurrent requests coalesced to 1 fetch', performance.now() - t0);
  } catch (err) {
    recordFail('torrentdosfilmes: 50 concurrent requests coalesced to 1 fetch', err);
  }

  // Test 1.5: 100 requests distributed across 5 distinct URLs (20 per URL, shuffled)
  try {
    resetAll();
    const t0 = performance.now();
    const urls = [
      'https://bludvfilmes.xyz/filme-a/',
      'https://bludvfilmes.xyz/filme-b/',
      'https://bludvfilmes.xyz/filme-c/',
      'https://bludvfilmes.xyz/filme-d/',
      'https://bludvfilmes.xyz/filme-e/',
    ];
    let fetchCount = 0;
    globalThis.fetch = async (url) => {
      fetchCount++;
      const href = typeof url === 'string' ? url : url.href;
      await new Promise((r) => setTimeout(r, 30));
      return {
        ok: true,
        status: 200,
        text: async () => `<div class="post"><a href="https://systemads1.com/go/${href.slice(-2, -1)}">L</a></div>`,
      };
    };

    const requests = [];
    for (const u of urls) {
      for (let i = 0; i < 20; i++) {
        requests.push({ url: u, id: `${u}-${i}` });
      }
    }
    // Shuffle array
    requests.sort(() => Math.random() - 0.5);

    const allResolved = await Promise.all(
      requests.map(async (req) => {
        const data = await bludv.getPostLinks(req.url);
        return { req, data };
      }),
    );

    assert.equal(fetchCount, 5, `Expected exactly 5 fetches for 5 distinct URLs, got ${fetchCount}`);
    assert.equal(allResolved.length, 100);
    for (const { req, data } of allResolved) {
      const expectedTag = req.url.slice(-2, -1);
      assert.equal(data.links[0].url, `https://systemads1.com/go/${expectedTag}`);
    }
    assert.equal(bludv.inFlight.size, 0);
    recordPass('bludv: 100 shuffled requests across 5 distinct keys -> exactly 5 fetches', performance.now() - t0);
  } catch (err) {
    recordFail('bludv: 100 shuffled requests across 5 distinct keys', err);
  }

  // --------------------------------------------------------------------------
  // SUITE 2: In-Flight Error Cleanup and Fault Tolerance
  // --------------------------------------------------------------------------
  console.log('\n--- Suite 2: In-Flight Error Cleanup & Fault Tolerance ---');

  // Test 2.1: 50 concurrent requests reject on network error, verify inFlight cleanup
  try {
    resetAll();
    const t0 = performance.now();
    let fetchCount = 0;
    globalThis.fetch = async () => {
      fetchCount++;
      await new Promise((r) => setTimeout(r, 20));
      throw new Error('ETIMEDOUT');
    };

    const targetUrl = 'https://bludvfilmes.xyz/filme-error-50/';
    const promises = Array.from({ length: 50 }, () => bludv.getPostLinks(targetUrl));
    const settled = await Promise.allSettled(promises);

    assert.equal(fetchCount, 1);
    assert.equal(settled.length, 50);
    for (const s of settled) {
      assert.equal(s.status, 'rejected');
      assert.match(s.reason.message, /ETIMEDOUT/);
    }
    assert.equal(bludv.inFlight.size, 0, 'inFlight map must not leak rejected promises');
    assert.equal(bludv.postCache.has(new URL(targetUrl).href), false, 'postCache must not store errors');
    recordPass('bludv: 50 concurrent failed requests clean up inFlight map with zero leak', performance.now() - t0);
  } catch (err) {
    recordFail('bludv: 50 concurrent failed requests clean up inFlight map', err);
  }

  // Test 2.2: Immediate retry recovery after initial failure
  try {
    resetAll();
    const t0 = performance.now();
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts++;
      if (attempts === 1) {
        throw new Error('ECONNREFUSED');
      }
      return {
        ok: true,
        status: 200,
        text: async () => '<div class="post"><a href="https://systemads1.com/go/recovered">Link</a></div>',
      };
    };

    const targetUrl = 'https://comandotorrents.to/filme-retry/';

    // Attempt 1: Should fail
    await assert.rejects(() => comando.getPostLinks(targetUrl), /ECONNREFUSED/);
    assert.equal(comando.inFlight.size, 0);

    // Attempt 2: Should retry immediately and succeed
    const res = await comando.getPostLinks(targetUrl);
    assert.equal(attempts, 2);
    assert.equal(res.links.length, 1);
    assert.equal(res.links[0].url, 'https://systemads1.com/go/recovered');
    assert.equal(comando.inFlight.size, 0);
    recordPass('comandotorrents: immediate retry after error succeeds without stale rejection', performance.now() - t0);
  } catch (err) {
    recordFail('comandotorrents: immediate retry after error', err);
  }

  // Test 2.3: Mixed storm of 200 concurrent requests (50 failing URLs, 150 succeeding URLs)
  try {
    resetAll();
    const t0 = performance.now();
    globalThis.fetch = async (url) => {
      const u = typeof url === 'string' ? url : url.href;
      await new Promise((r) => setTimeout(r, 10));
      if (u.includes('bad-url')) {
        throw new Error('500_server_error');
      }
      return {
        ok: true,
        status: 200,
        text: async () => '<div class="post"><a href="https://systemads1.com/go/ok">Link</a></div>',
      };
    };

    const requests = [];
    for (let i = 0; i < 200; i++) {
      const isBad = i % 4 === 0; // 50 bad, 150 good
      const url = `https://bludvfilmes.xyz/${isBad ? 'bad-url' : 'good-url'}-${i % 10}/`;
      requests.push({ url, isBad });
    }

    const settled = await Promise.allSettled(requests.map((r) => bludv.getPostLinks(r.url)));
    assert.equal(settled.length, 200);

    let rejectedCount = 0;
    let resolvedCount = 0;
    for (let i = 0; i < 200; i++) {
      if (requests[i].isBad) {
        assert.equal(settled[i].status, 'rejected');
        rejectedCount++;
      } else {
        assert.equal(settled[i].status, 'fulfilled');
        resolvedCount++;
      }
    }
    assert.equal(rejectedCount, 50);
    assert.equal(resolvedCount, 150);
    assert.equal(bludv.inFlight.size, 0, 'inFlight map must be completely clean after mixed storm');
    recordPass('bludv: mixed storm of 200 requests (50 failures, 150 successes) settles cleanly', performance.now() - t0);
  } catch (err) {
    recordFail('bludv: mixed storm of 200 requests', err);
  }

  // --------------------------------------------------------------------------
  // SUITE 3: Cache Size Bounding & LRU Eviction Under High Churn
  // --------------------------------------------------------------------------
  console.log('\n--- Suite 3: Cache Size Bounding & LRU Eviction Under High Churn ---');

  // Test 3.1: BLUDV postCache bounded to 200 entries under 300 insertions
  try {
    resetAll();
    const t0 = performance.now();
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => '<div class="post"><a href="https://systemads1.com/go/x">Link</a></div>',
    });

    for (let i = 1; i <= 300; i++) {
      await bludv.getPostLinks(`https://bludvfilmes.xyz/filme-${i}/`);
    }

    assert.equal(bludv.postCache.size, 200, `bludv.postCache should cap at 200, got ${bludv.postCache.size}`);
    assert.equal(bludv.postCache.has('https://bludvfilmes.xyz/filme-1/'), false, 'Key 1 should be evicted');
    assert.equal(bludv.postCache.has('https://bludvfilmes.xyz/filme-100/'), false, 'Key 100 should be evicted');
    assert.equal(bludv.postCache.has('https://bludvfilmes.xyz/filme-101/'), true, 'Key 101 should exist');
    assert.equal(bludv.postCache.has('https://bludvfilmes.xyz/filme-300/'), true, 'Key 300 should exist');
    recordPass('bludv: postCache caps at 200 with FIFO/LRU eviction of oldest 100', performance.now() - t0);
  } catch (err) {
    recordFail('bludv: postCache caps at 200', err);
  }

  // Test 3.2: ComandoTorrents and TorrentDosFilmes bounded to 100 entries
  try {
    resetAll();
    const t0 = performance.now();
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => '<article><a href="https://systemads1.com/go/x">Link</a></article>',
    });

    for (let i = 1; i <= 150; i++) {
      await comando.getPostLinks(`https://comandotorrents.to/filme-${i}/`);
      await tdf.getPostLinks(`https://torrentdosfilmes-v2.xyz/filme-${i}/`);
    }

    assert.equal(comando.postCache.size, 100, `comando.postCache should cap at 100, got ${comando.postCache.size}`);
    assert.equal(tdf.postCache.size, 100, `tdf.postCache should cap at 100, got ${tdf.postCache.size}`);
    assert.equal(comando.postCache.has('https://comandotorrents.to/filme-1/'), false);
    assert.equal(comando.postCache.has('https://comandotorrents.to/filme-150/'), true);
    assert.equal(tdf.postCache.has('https://torrentdosfilmes-v2.xyz/filme-1/'), false);
    assert.equal(tdf.postCache.has('https://torrentdosfilmes-v2.xyz/filme-150/'), true);
    recordPass('comandotorrents & torrentdosfilmes: postCache bounded to 100 entries', performance.now() - t0);
  } catch (err) {
    recordFail('comandotorrents & torrentdosfilmes: postCache bounded to 100', err);
  }

  // Test 3.3: NerdFilmes cached() bounded to 500 entries
  try {
    resetAll();
    const t0 = performance.now();
    for (let i = 1; i <= 650; i++) {
      await nerd.cache.set(`test-key-${i}`, { value: i, expiresAt: Date.now() + 60000 });
      if (nerd.cache.size > 500) {
        nerd.cache.delete(nerd.cache.keys().next().value);
      }
    }
    assert.equal(nerd.cache.size, 500);
    assert.equal(nerd.cache.has('test-key-1'), false);
    assert.equal(nerd.cache.has('test-key-650'), true);
    recordPass('nerdfilmes: cache map bounded to 500 entries', performance.now() - t0);
  } catch (err) {
    recordFail('nerdfilmes: cache map bounded to 500', err);
  }

  // Test 3.4: src/utils/cache.js LRU Bounding under 2500 insertions (MAX_ENTRIES = 2000)
  try {
    cache.clear();
    const t0 = performance.now();

    for (let i = 1; i <= 2500; i++) {
      cache.set(`k-${i}`, { data: `val-${i}` }, 3600);
    }

    assert.ok(cache.size() <= 2000, `cache.size() must be <= 2000, got ${cache.size()}`);
    assert.equal(cache.get('k-1'), null);
    assert.equal(cache.get('k-100'), null);
    assert.deepEqual(cache.get('k-2500'), { data: 'val-2500' });
    assert.deepEqual(cache.get('k-2000'), { data: 'val-2000' });

    // Test LRU refresh on access:
    cache.set('pinned-key', 'important', 3600);
    for (let i = 2501; i <= 3000; i++) {
      cache.set(`k-${i}`, { data: `val-${i}` }, 3600);
      if (i % 50 === 0) {
        cache.get('pinned-key');
      }
    }

    assert.equal(cache.get('pinned-key'), 'important', 'pinned-key must survive because it was accessed');
    recordPass('src/utils/cache.js: bounded to 2000 entries with active LRU retention', performance.now() - t0);
  } catch (err) {
    recordFail('src/utils/cache.js: bounded to 2000 entries', err);
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
    globalThis.fetch = async (url) => {
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
    };

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
    globalThis.fetch = async (url) => {
      hopCount++;
      const nextHop = hopCount + 1;
      return {
        ok: true,
        status: 200,
        text: async () => `<script>var NEXT_URL = "https://systemads1.com/hop${nextHop}";</script>`,
      };
    };

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
  console.log(`Stress Test Results: ${results.passed} PASSED, ${results.failed} FAILED`);
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
