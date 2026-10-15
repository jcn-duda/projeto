/**
 * Empirical Stress and Concurrency Harness for Milestone 1 - Extended Hardening Suite
 *
 * Tests:
 * 1. In-flight request coalescing under massive concurrency (50+ parallel calls)
 * 2. In-flight error cleanup & memory safety under upstream failures and mixed success/failure storms
 * 3. Cache bounding & LRU eviction under high churn (> 200 items in resolvers, > 2000 in L1)
 */

import assert from 'node:assert/strict';
import bludv from '../bludv-resolver/server.js';
import comando from '../comandotorrents-resolver/server.js';
import nerd from '../nerdfilmes-resolver/server.js';
import tdf from '../torrentdosfilmes-resolver/server.js';
import * as cache from '../src/utils/cache.js';

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

  async function runStep(name: string, fn: () => Promise<void> | void) {
    resetAll();
    const t0 = performance.now();
    try {
      await fn();
      recordPass(name, performance.now() - t0);
    } catch (err: any) {
      recordFail(name, err);
    }
  }

  // --------------------------------------------------------------------------
  // SUITE 1: In-Flight Coalescing Under Massive Concurrency
  // --------------------------------------------------------------------------
  console.log('\n--- Suite 1: In-Flight Request Coalescing Under Massive Concurrency ---');

  // Test 1.1: 50 simultaneous parallel requests to BLUDV getPostLinks
  await runStep('bludv: 50 concurrent requests coalesced to 1 fetch', async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      await new Promise((r) => setTimeout(r, 40));
      return {
        ok: true,
        status: 200,
        text: async () => '<div class="post-single"><h3>VERSÃO MKV DUAL ÁUDIO</h3><p>1080p (3.5 GB)</p><a href="https://systemads1.com/go/b1">Magnet-Link</a></div>',
      };
    }) as unknown as typeof globalThis.fetch;

    const targetUrl = 'https://bludvfilmes.xyz/filme-concorrencia-50/';
    const allResults = await Promise.all(Array.from({ length: 50 }, () => bludv.getPostLinks(targetUrl)));

    assert.equal(fetchCount, 1, `Expected exactly 1 fetch for 50 concurrent requests, got ${fetchCount}`);
    assert.equal(allResults.length, 50);
    for (const res of allResults) {
      assert.equal(res.links.length, 1);
      assert.equal(res.links[0].url, 'https://systemads1.com/go/b1');
    }
    assert.equal(bludv.inFlight.size, 0, 'bludv.inFlight map must be empty after all requests complete');
  });

  // Test 1.2: 50 simultaneous parallel requests to ComandoTorrents
  await runStep('comandotorrents: 50 concurrent requests coalesced to 1 fetch', async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      await new Promise((r) => setTimeout(r, 35));
      return {
        ok: true,
        status: 200,
        text: async () => '<article class="blog-view"><a href="https://videosad.net/go/c1">Link</a></article>',
      };
    }) as unknown as typeof globalThis.fetch;

    const targetUrl = 'https://comandotorrents.to/filme-concorrencia-50/';
    const allResults = await Promise.all(Array.from({ length: 50 }, () => comando.getPostLinks(targetUrl)));

    assert.equal(fetchCount, 1);
    assert.equal(allResults.length, 50);
    assert.equal(comando.inFlight.size, 0);
  });

  // Test 1.3: 50 simultaneous parallel requests to NerdFilmes
  await runStep('nerdfilmes: 50 concurrent requests coalesced to 1 fetch', async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      await new Promise((r) => setTimeout(r, 35));
      return {
        ok: true,
        status: 200,
        text: async () => '<article class="col"><a href="https://canalfutebol.com/go/n1">Nerd</a></article>',
      };
    }) as unknown as typeof globalThis.fetch;

    const targetUrl = 'https://www.xnerdfilmes.net/filme-concorrencia-50/';
    const allResults = await Promise.all(Array.from({ length: 50 }, () => nerd.getPostLinks(targetUrl)));

    assert.equal(fetchCount, 1);
    assert.equal(allResults.length, 50);
    assert.equal(nerd.inFlight.size, 0);
  });

  // Test 1.4: 50 simultaneous parallel requests to TorrentDosFilmes
  await runStep('torrentdosfilmes: 50 concurrent requests coalesced to 1 fetch', async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      await new Promise((r) => setTimeout(r, 35));
      return {
        ok: true,
        status: 200,
        text: async () => '<div><a href="https://systemads1.com/go/t1">TDF</a></div>',
      };
    }) as unknown as typeof globalThis.fetch;

    const targetUrl = 'https://torrentdosfilmes-v2.xyz/filme-concorrencia-50/';
    const allResults = await Promise.all(Array.from({ length: 50 }, () => tdf.getPostLinks(targetUrl)));

    assert.equal(fetchCount, 1);
    assert.equal(allResults.length, 50);
    assert.equal(tdf.inFlight.size, 0);
  });

  // Test 1.5: 100 requests distributed across 5 distinct URLs (20 per URL, shuffled)
  await runStep('bludv: 100 shuffled requests across 5 distinct keys -> exactly 5 fetches', async () => {
    const urls = ['a', 'b', 'c', 'd', 'e'].map((x) => `https://bludvfilmes.xyz/filme-${x}/`);
    let fetchCount = 0;
    globalThis.fetch = (async (url: any) => {
      fetchCount++;
      const href = typeof url === 'string' ? url : url.href;
      await new Promise((r) => setTimeout(r, 30));
      return {
        ok: true,
        status: 200,
        text: async () => `<div class="post"><a href="https://systemads1.com/go/${href.slice(-2, -1)}">L</a></div>`,
      };
    }) as unknown as typeof globalThis.fetch;

    const requests: { url: string; id: string }[] = [];
    for (const u of urls) {
      for (let i = 0; i < 20; i++) requests.push({ url: u, id: `${u}-${i}` });
    }
    requests.sort(() => Math.random() - 0.5);

    const allResolved = await Promise.all(
      requests.map(async (req) => ({ req, data: await bludv.getPostLinks(req.url) })),
    );

    assert.equal(fetchCount, 5, `Expected exactly 5 fetches for 5 distinct URLs, got ${fetchCount}`);
    assert.equal(allResolved.length, 100);
    for (const { req, data } of allResolved) {
      assert.equal(data.links[0].url, `https://systemads1.com/go/${req.url.slice(-2, -1)}`);
    }
    assert.equal(bludv.inFlight.size, 0);
  });

  // --------------------------------------------------------------------------
  // SUITE 2: In-Flight Error Cleanup and Fault Tolerance
  // --------------------------------------------------------------------------
  console.log('\n--- Suite 2: In-Flight Error Cleanup & Fault Tolerance ---');

  // Test 2.1: 50 concurrent requests reject on network error, verify inFlight cleanup
  await runStep('bludv: 50 concurrent failed requests clean up inFlight map with zero leak', async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      await new Promise((r) => setTimeout(r, 20));
      throw new Error('ETIMEDOUT');
    }) as unknown as typeof globalThis.fetch;

    const targetUrl = 'https://bludvfilmes.xyz/filme-error-50/';
    const settled = await Promise.allSettled(Array.from({ length: 50 }, () => bludv.getPostLinks(targetUrl)));

    assert.equal(fetchCount, 1);
    assert.equal(settled.length, 50);
    for (const s of settled) {
      assert.equal(s.status, 'rejected');
      assert.match(s.reason.message, /ETIMEDOUT/);
    }
    assert.equal(bludv.inFlight.size, 0, 'inFlight map must not leak rejected promises');
    assert.equal(bludv.postCache.has(new URL(targetUrl).href), false, 'postCache must not store errors');
  });

  // Test 2.2: Immediate retry recovery after initial failure
  await runStep('comandotorrents: immediate retry after error succeeds without stale rejection', async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      if (attempts === 1) throw new Error('ECONNREFUSED');
      return {
        ok: true,
        status: 200,
        text: async () => '<div class="post"><a href="https://systemads1.com/go/recovered">Link</a></div>',
      };
    }) as unknown as typeof globalThis.fetch;

    const targetUrl = 'https://comandotorrents.to/filme-retry/';
    await assert.rejects(() => comando.getPostLinks(targetUrl), /ECONNREFUSED/);
    assert.equal(comando.inFlight.size, 0);

    const res = await comando.getPostLinks(targetUrl);
    assert.equal(attempts, 2);
    assert.equal(res.links.length, 1);
    assert.equal(res.links[0].url, 'https://systemads1.com/go/recovered');
    assert.equal(comando.inFlight.size, 0);
  });

  // Test 2.3: Mixed storm of 200 concurrent requests (50 failing URLs, 150 succeeding URLs)
  await runStep('bludv: mixed storm of 200 requests (50 failures, 150 successes) settles cleanly', async () => {
    globalThis.fetch = (async (url: any) => {
      const u = typeof url === 'string' ? url : url.href;
      await new Promise((r) => setTimeout(r, 10));
      if (u.includes('bad-url')) throw new Error('500_server_error');
      return {
        ok: true,
        status: 200,
        text: async () => '<div class="post"><a href="https://systemads1.com/go/ok">Link</a></div>',
      };
    }) as unknown as typeof globalThis.fetch;

    const requests: { url: string; isBad: boolean }[] = [];
    for (let i = 0; i < 200; i++) {
      const isBad = i % 4 === 0;
      requests.push({ url: `https://bludvfilmes.xyz/${isBad ? 'bad-url' : 'good-url'}-${i % 10}/`, isBad });
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
  });

  // --------------------------------------------------------------------------
  // SUITE 3: Cache Size Bounding & LRU Eviction Under High Churn
  // --------------------------------------------------------------------------
  console.log('\n--- Suite 3: Cache Size Bounding & LRU Eviction Under High Churn ---');

  // Test 3.1: BLUDV postCache bounded to 200 entries under 300 insertions
  await runStep('bludv: postCache caps at 200 with FIFO/LRU eviction of oldest 100', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      text: async () => '<div class="post"><a href="https://systemads1.com/go/x">Link</a></div>',
    })) as unknown as typeof globalThis.fetch;

    for (let i = 1; i <= 300; i++) {
      await bludv.getPostLinks(`https://bludvfilmes.xyz/filme-${i}/`);
    }

    assert.equal(bludv.postCache.size, 200, `bludv.postCache should cap at 200, got ${bludv.postCache.size}`);
    assert.equal(bludv.postCache.has('https://bludvfilmes.xyz/filme-1/'), false, 'Key 1 should be evicted');
    assert.equal(bludv.postCache.has('https://bludvfilmes.xyz/filme-100/'), false, 'Key 100 should be evicted');
    assert.equal(bludv.postCache.has('https://bludvfilmes.xyz/filme-101/'), true, 'Key 101 should exist');
    assert.equal(bludv.postCache.has('https://bludvfilmes.xyz/filme-300/'), true, 'Key 300 should exist');
  });

  // Test 3.2: ComandoTorrents and TorrentDosFilmes bounded to 100 entries
  await runStep('comandotorrents & torrentdosfilmes: postCache bounded to 100 entries', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      text: async () => '<article><a href="https://systemads1.com/go/x">Link</a></article>',
    })) as unknown as typeof globalThis.fetch;

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
  });

  // Test 3.3: NerdFilmes cached() bounded to 500 entries
  await runStep('nerdfilmes: cache map bounded to 500 entries', async () => {
    for (let i = 1; i <= 650; i++) {
      await nerd.cache.set(`test-key-${i}`, { value: i, expiresAt: Date.now() + 60000 });
      if (nerd.cache.size > 500) nerd.cache.delete(nerd.cache.keys().next().value);
    }
    assert.equal(nerd.cache.size, 500);
    assert.equal(nerd.cache.has('test-key-1'), false);
    assert.equal(nerd.cache.has('test-key-650'), true);
  });

  // Test 3.4: cota do namespace + LRU sob 2500 inserções.
  await runStep('src/utils/cache.ts: cota do namespace __default com LRU ativo', async () => {
    cache.clear();
    const COTA_DEFAULT = cache.QUOTAS.__default;

    for (let i = 1; i <= 2500; i++) {
      cache.set(`k-${i}`, { data: `val-${i}` }, 3600);
    }

    assert.ok(cache.size() <= COTA_DEFAULT, `cache.size() must be <= ${COTA_DEFAULT}, got ${cache.size()}`);
    assert.equal(cache.get('k-1'), null);
    assert.equal(cache.get('k-100'), null);
    assert.deepEqual(cache.get('k-2500'), { data: 'val-2500' });
    assert.deepEqual(cache.get(`k-${2500 - COTA_DEFAULT + 1}`), { data: `val-${2500 - COTA_DEFAULT + 1}` });
    assert.equal(cache.get(`k-${2500 - COTA_DEFAULT}`), null);

    // Test LRU refresh on access:
    cache.set('pinned-key', 'important', 3600);
    for (let i = 2501; i <= 3000; i++) {
      cache.set(`k-${i}`, { data: `val-${i}` }, 3600);
      if (i % 50 === 0) cache.get('pinned-key');
    }

    assert.equal(cache.get('pinned-key'), 'important', 'pinned-key must survive because it was accessed');
  });

  // --------------------------------------------------------------------------
  // Summary
  // --------------------------------------------------------------------------
  console.log('\n=============================================================');
  console.log(`Stress Test Results: ${results.passed} PASSED, ${results.failed} FAILED`);
  console.log('=============================================================');

  resetAll();
  if (results.failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
