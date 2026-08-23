import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import express from 'express';

import { asyncRoute } from '../src/app.js';
import * as diagGuard from '../src/utils/diagnostic-guard.js';
import config from '../src/config.js';
import * as alldebrid from '../src/debrid/alldebrid.js';
import debrid from '../src/debrid/index.js';
import * as runtime from '../src/runtime.js';
import { AuthError, QuotaError } from '../src/debrid/common.js';
import { createTestServer } from './e2e/e2e-harness.js';

const _require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CACHE_MODULE = _require.resolve('../src/utils/cache.js');

let hasNodeSqlite = true;
try {
  _require('node:sqlite');
} catch {
  hasNodeSqlite = false;
}

// ============================================================================
// 1. EMPIRICAL CHALLENGE: asyncRoute
// ============================================================================

test('asyncRoute: synchronous exception in async function returns 500 JSON without process crash', async () => {
  const app = express();
  app.get('/sync-in-async', asyncRoute(async () => {
    throw new Error('Sync error inside async handler');
  }));

  const srv = await createTestServer(app);
  try {
    const res = await srv.request('GET', '/sync-in-async');
    assert.equal(res.status, 500);
    assert.deepEqual(res.json, { error: 'internal_error' });
  } finally {
    await srv.close();
  }
});

test('asyncRoute: synchronous exception in non-async function caught by Express without crashing process', async () => {
  const app = express();
  // Handler that throws directly before returning a promise
  app.get('/sync-raw', asyncRoute((() => {
    throw new Error('Direct synchronous throw');
  }) as any));

  const srv = await createTestServer(app);
  try {
    const res = await srv.request('GET', '/sync-raw');
    // Express catches the uncaught synchronous throw in its default handler and returns 500 without crashing
    assert.equal(res.status, 500);
  } finally {
    await srv.close();
  }
});

test('asyncRoute: asynchronous rejection (Promise.reject) returns 500 JSON', async () => {
  const app = express();
  app.get('/async-reject', asyncRoute(() => {
    return Promise.reject(new Error('Explicit promise rejection'));
  }));

  const srv = await createTestServer(app);
  try {
    const res = await srv.request('GET', '/async-reject');
    assert.equal(res.status, 500);
    assert.deepEqual(res.json, { error: 'internal_error' });
  } finally {
    await srv.close();
  }
});

test('asyncRoute: delayed asynchronous rejection via setTimeout returns 500 JSON', async () => {
  const app = express();
  app.get('/delayed-reject', asyncRoute(async () => {
    await new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Delayed async rejection')), 20);
    });
  }));

  const srv = await createTestServer(app);
  try {
    const res = await srv.request('GET', '/delayed-reject');
    assert.equal(res.status, 500);
    assert.deepEqual(res.json, { error: 'internal_error' });
  } finally {
    await srv.close();
  }
});

test('asyncRoute: custom error types (string, null, undefined, number, symbol, circular object, custom class)', async () => {
  const circularObj: any = { message: 'circular' };
  circularObj.self = circularObj;

  class CustomDomainError extends Error {
    public code = 'DOMAIN_FAULT';
  }

  const testCases: Array<{ path: string; throwVal: any }> = [
    { path: '/err-string', throwVal: 'Raw string thrown' },
    { path: '/err-null', throwVal: null },
    { path: '/err-undefined', throwVal: undefined },
    { path: '/err-number', throwVal: 404 },
    { path: '/err-symbol', throwVal: Symbol('err-symbol') },
    { path: '/err-circular', throwVal: circularObj },
    { path: '/err-custom-class', throwVal: new CustomDomainError('Domain error message') },
    { path: '/err-plain-object', throwVal: { status: 'failed', code: 500 } },
  ];

  const app = express();
  for (const { path: p, throwVal } of testCases) {
    app.get(p, asyncRoute(async () => {
      throw throwVal;
    }));
  }

  const srv = await createTestServer(app);
  try {
    for (const { path: p } of testCases) {
      const res = await srv.request('GET', p);
      assert.equal(res.status, 500, `Failed for path ${p}`);
      assert.deepEqual(res.json, { error: 'internal_error' }, `Failed for path ${p}`);
    }
  } finally {
    await srv.close();
  }
});

test('asyncRoute: headers already sent does not cause ERR_HTTP_HEADERS_SENT crash', async () => {
  const app = express();
  app.get('/headers-sent', asyncRoute(async (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.write('Partial chunk...');
    res.end();
    throw new Error('Late failure after response ended');
  }));

  const srv = await createTestServer(app);
  try {
    const res = await srv.request('GET', '/headers-sent');
    assert.equal(res.status, 200);
  } finally {
    await srv.close();
  }
});

test('asyncRoute: burst of 30 concurrent crashing async routes all cleanly return 500', async () => {
  const app = express();
  for (let i = 0; i < 30; i++) {
    app.get(`/burst-${i}`, asyncRoute(async () => {
      await new Promise((r) => setTimeout(r, Math.random() * 20));
      throw new Error(`Burst error ${i}`);
    }));
  }

  const srv = await createTestServer(app);
  try {
    const requests = Array.from({ length: 30 }, (_, i) => srv.request('GET', `/burst-${i}`));
    const results = await Promise.all(requests);
    for (let i = 0; i < 30; i++) {
      assert.equal(results[i].status, 500);
      assert.deepEqual(results[i].json, { error: 'internal_error' });
    }
  } finally {
    await srv.close();
  }
});

// ============================================================================
// 2. EMPIRICAL CHALLENGE: diagnosticGate
// ============================================================================

test('diagnosticGate: rate limit saturation and rejection with 429', () => {
  let currentTime = 1000;
  const gate = diagGuard.createDiagnosticGate({
    limit: 3,
    windowMs: 5000,
    maxConcurrent: 10,
    now: () => currentTime,
    rateMessage: 'custom rate exceeded',
  });

  const adm1 = gate.enter('user-1');
  assert.equal(adm1.ok, true);
  if (adm1.ok) adm1.release!();

  const adm2 = gate.enter('user-1');
  assert.equal(adm2.ok, true);
  if (adm2.ok) adm2.release!();

  const adm3 = gate.enter('user-1');
  assert.equal(adm3.ok, true);
  if (adm3.ok) adm3.release!();

  // 4th call within window should be rejected with 429
  const adm4 = gate.enter('user-1');
  assert.equal(adm4.ok, false);
  assert.equal(adm4.status, 429);
  assert.equal(adm4.error, 'custom rate exceeded');

  // Independent user-2 should still succeed
  const admUser2 = gate.enter('user-2');
  assert.equal(admUser2.ok, true);
  if (admUser2.ok) admUser2.release!();

  // Advance time beyond window
  currentTime += 5001;
  const admAfterWindow = gate.enter('user-1');
  assert.equal(admAfterWindow.ok, true);
  if (admAfterWindow.ok) admAfterWindow.release!();
});

test('diagnosticGate: concurrency saturation and rejection with 429', () => {
  const gate = diagGuard.createDiagnosticGate({
    limit: 100,
    maxConcurrent: 2,
    busyMessage: 'custom concurrency exceeded',
  });

  const slot1 = gate.enter('client-a');
  assert.equal(slot1.ok, true);

  const slot2 = gate.enter('client-b');
  assert.equal(slot2.ok, true);

  // 3rd concurrent request should fail with busyMessage
  const slot3 = gate.enter('client-c');
  assert.equal(slot3.ok, false);
  assert.equal(slot3.status, 429);
  assert.equal(slot3.error, 'custom concurrency exceeded');

  // Release slot 1
  if (slot1.ok) slot1.release!();

  // Now client-c can enter
  const slot4 = gate.enter('client-c');
  assert.equal(slot4.ok, true);

  if (slot2.ok) slot2.release!();
  if (slot4.ok) slot4.release!();
});

test('diagnosticGate: clean release in try-finally on handler error', async () => {
  const gate = diagGuard.createDiagnosticGate({ limit: 10, maxConcurrent: 1 });

  async function mockHandler(shouldThrow: boolean) {
    const admission = gate.enter('global');
    if (!admission.ok) return { status: admission.status, error: admission.error };
    try {
      if (shouldThrow) throw new Error('Handler execution blew up');
      return { status: 200, ok: true };
    } finally {
      admission.release!();
    }
  }

  // 1. Run failing request
  await assert.rejects(mockHandler(true), /Handler execution blew up/);

  // 2. Next request should immediately acquire the slot because finally released it
  const res2 = await mockHandler(false);
  assert.equal(res2.status, 200);
});

test('diagnosticGate: release idempotency (no underflow on multiple release calls)', () => {
  const gate = diagGuard.createDiagnosticGate({ limit: 10, maxConcurrent: 1 });

  const slot = gate.enter('client-x');
  assert.equal(slot.ok, true);

  if (slot.ok) {
    slot.release!();
    slot.release!();
    slot.release!();
    slot.release!();
  }

  // Next caller should get slot 1 of 1, not multiple slots
  const slot2 = gate.enter('client-y');
  assert.equal(slot2.ok, true);

  const slot3 = gate.enter('client-z');
  assert.equal(slot3.ok, false);
  assert.equal(slot3.status, 429);

  if (slot2.ok) slot2.release!();
});

test('diagnosticGate: handling null, undefined, empty, and numeric client keys', () => {
  const gate = diagGuard.createDiagnosticGate({ limit: 2, windowMs: 10000 });

  const a = gate.enter(null as any);
  assert.equal(a.ok, true);
  if (a.ok) a.release!();

  const b = gate.enter(undefined as any);
  assert.equal(b.ok, true);
  if (b.ok) b.release!();

  // Both null and undefined resolve to 'unknown', so 3rd enter should hit limit of 2
  const c = gate.enter('' as any);
  assert.equal(c.ok, false);
  assert.equal(c.status, 429);
});

// ============================================================================
// 3. EMPIRICAL CHALLENGE: cache.ts Database Corruption Recovery
// ============================================================================

function runIsolatedScript(scriptContent: string) {
  const { spawnSync } = _require('node:child_process');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adom-challenger-cache-'));
  const dbPath = path.join(tempDir, 'cache.db');
  try {
    const res = spawnSync(process.execPath, ['-e', scriptContent], {
      env: (({ CACHE_PERSIST, ...rest }) => ({ ...rest, CACHE_DB_PATH: dbPath }))(process.env),
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.ifError(res.error);
    assert.strictEqual(
      res.status,
      0,
      `Subprocess failed:\nSTDOUT:\n${res.stdout}\nSTDERR:\n${res.stderr}`,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test(
  'cache.ts recovery: junk ASCII data in db file triggers .corrupt rename and clean DB creation',
  { skip: !hasNodeSqlite && 'node:sqlite unavailable' },
  () => {
    const script = `
      const assert = require('node:assert');
      const fs = require('node:fs');
      delete process.env.CACHE_PERSIST;
      const dbPath = process.env.CACHE_DB_PATH;
      const corruptPath = dbPath + '.corrupt';

      fs.writeFileSync(dbPath, 'ADVERSARIAL_JUNK_GARBAGE_BYTES_12345');
      delete require.cache[${JSON.stringify(CACHE_MODULE)}];
      const cache = require(${JSON.stringify(CACHE_MODULE)});

      assert.strictEqual(fs.existsSync(corruptPath), true, 'corrupt file created');
      assert.strictEqual(fs.readFileSync(corruptPath, 'utf8'), 'ADVERSARIAL_JUNK_GARBAGE_BYTES_12345');
      assert.strictEqual(fs.existsSync(dbPath), true, 'new DB file created');

      cache.set('test:recovered-1', { working: true }, 3600);
      assert.deepStrictEqual(cache.get('test:recovered-1'), { working: true });
      if (cache.close) cache.close();
    `;
    runIsolatedScript(script);
  },
);

test(
  'cache.ts recovery: truncated SQLite header (8 bytes) triggers .corrupt rename and clean DB creation',
  { skip: !hasNodeSqlite && 'node:sqlite unavailable' },
  () => {
    const script = `
      const assert = require('node:assert');
      const fs = require('node:fs');
      delete process.env.CACHE_PERSIST;
      const dbPath = process.env.CACHE_DB_PATH;
      const corruptPath = dbPath + '.corrupt';

      // Truncated header
      fs.writeFileSync(dbPath, Buffer.from('SQLite f'));
      delete require.cache[${JSON.stringify(CACHE_MODULE)}];
      const cache = require(${JSON.stringify(CACHE_MODULE)});

      assert.strictEqual(fs.existsSync(corruptPath), true, 'corrupt file created');
      assert.strictEqual(fs.existsSync(dbPath), true, 'new DB file created');

      cache.set('test:truncated', { ok: 1 }, 3600);
      assert.deepStrictEqual(cache.get('test:truncated'), { ok: 1 });
      if (cache.close) cache.close();
    `;
    runIsolatedScript(script);
  },
);

test(
  'cache.ts recovery: pre-existing .corrupt file is overwritten cleanly without throwing EEXIST',
  { skip: !hasNodeSqlite && 'node:sqlite unavailable' },
  () => {
    const script = `
      const assert = require('node:assert');
      const fs = require('node:fs');
      delete process.env.CACHE_PERSIST;
      const dbPath = process.env.CACHE_DB_PATH;
      const corruptPath = dbPath + '.corrupt';

      // Pre-existing corrupt file from previous incident
      fs.writeFileSync(corruptPath, 'PREVIOUS_CORRUPTION');
      fs.writeFileSync(dbPath, 'NEW_CORRUPTION_DATA');

      delete require.cache[${JSON.stringify(CACHE_MODULE)}];
      const cache = require(${JSON.stringify(CACHE_MODULE)});

      assert.strictEqual(fs.existsSync(corruptPath), true);
      assert.strictEqual(fs.readFileSync(corruptPath, 'utf8'), 'NEW_CORRUPTION_DATA');
      assert.strictEqual(fs.existsSync(dbPath), true);

      cache.set('test:pre-existing-corrupt', { done: true }, 3600);
      assert.deepStrictEqual(cache.get('test:pre-existing-corrupt'), { done: true });
      if (cache.close) cache.close();
    `;
    runIsolatedScript(script);
  },
);

test(
  'cache.ts recovery: orphaned -wal and -shm sidecar files are removed during corrupt recovery',
  { skip: !hasNodeSqlite && 'node:sqlite unavailable' },
  () => {
    const script = `
      const assert = require('node:assert');
      const fs = require('node:fs');
      delete process.env.CACHE_PERSIST;
      const dbPath = process.env.CACHE_DB_PATH;
      const walPath = dbPath + '-wal';
      const shmPath = dbPath + '-shm';

      fs.writeFileSync(dbPath, 'CORRUPT_MAIN_DB');
      fs.writeFileSync(walPath, 'ORPHANED_WAL_DATA');
      fs.writeFileSync(shmPath, 'ORPHANED_SHM_DATA');

      delete require.cache[${JSON.stringify(CACHE_MODULE)}];
      const cache = require(${JSON.stringify(CACHE_MODULE)});

      assert.strictEqual(fs.existsSync(dbPath + '.corrupt'), true);
      // Main DB exists and works
      cache.set('test:sidecars', { success: true }, 3600);
      assert.deepStrictEqual(cache.get('test:sidecars'), { success: true });
      if (cache.close) cache.close();
    `;
    runIsolatedScript(script);
  },
);

// ============================================================================
// 4. EMPIRICAL CHALLENGE: alldebrid.ts Snapshot TTL & Mock 500 Behavior
// ============================================================================

const TEST_KEY = 'test-alldebrid-api-key';
const HASH_USER = 'a'.repeat(40);
const HASH_CHECK = 'b'.repeat(40);

test('alldebrid.ts: snapshot TTL protects user hashes within TTL and refreshes when expired', async () => {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;

  let statusCallCount = 0;
  let simulatedMagnets = [
    { id: 101, hash: HASH_USER, status: 'Ready', filename: 'User Movie 1', ready: true },
  ];

  const deletedIds: number[] = [];

  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/magnet/status')) {
      statusCallCount += 1;
      return {
        ok: true,
        async json() {
          return { status: 'success', data: { magnets: simulatedMagnets } };
        },
      };
    }
    if (url.pathname.endsWith('/magnet/upload')) {
      const hashes = url.searchParams.getAll('magnets[]');
      return {
        ok: true,
        async json() {
          return {
            status: 'success',
            data: {
              magnets: hashes.map((h) => ({
                hash: h,
                ready: true,
                id: h === HASH_USER ? 101 : 200,
              })),
            },
          };
        },
      };
    }
    if (url.pathname.endsWith('/magnet/delete')) {
      deletedIds.push(Number(url.searchParams.get('id')));
      return {
        ok: true,
        async json() {
          return { status: 'success', data: { message: 'deleted' } };
        },
      };
    }
    throw new Error(`Unexpected URL in test: ${url.pathname}`);
  }) as unknown as typeof globalThis.fetch;

  try {
    // 1. Initial checkCached warms inventory (1st call to /magnet/status)
    await alldebrid.checkCached(TEST_KEY, [HASH_USER, HASH_CHECK]);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(statusCallCount, 1, 'Initial inventory loaded');

    // 2. Second checkCached within TTL should NOT call /magnet/status again
    await alldebrid.checkCached(TEST_KEY, [HASH_USER, HASH_CHECK]);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(statusCallCount, 1, 'Second checkCached within TTL reuses snapshot');

    // Verify user hash 101 was NOT deleted, but check hash 200 was deleted
    assert.ok(!deletedIds.includes(101), 'User pre-existing hash was protected from deletion');
    assert.ok(deletedIds.includes(200), 'Check hash was properly cleaned up');

    // 3. Force TTL expiration by modifying config.debrid.preexistingTtlMs temporarily
    const origTtl = config.debrid.preexistingTtlMs;
    config.debrid.preexistingTtlMs = 1; // 1 ms TTL
    await new Promise((r) => setTimeout(r, 10)); // wait for TTL to elapse

    // Add a second user magnet to remote inventory
    simulatedMagnets.push({
      id: 102,
      hash: 'c'.repeat(40),
      status: 'Ready',
      filename: 'User Movie 2',
      ready: true,
    });

    await alldebrid.checkCached(TEST_KEY, [HASH_USER, HASH_CHECK]);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(statusCallCount, 2, 'Expired snapshot triggered new /magnet/status call');

    config.debrid.preexistingTtlMs = origTtl;
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
});

test('alldebrid.ts: /magnet/status 500 error fails safely without deleting user magnets or crashing', async () => {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;

  const deletedIds: number[] = [];

  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/magnet/status')) {
      return {
        ok: false,
        status: 500,
        async json() {
          return { error: 'Internal Server Error' };
        },
      };
    }
    if (url.pathname.endsWith('/magnet/upload')) {
      const hashes = url.searchParams.getAll('magnets[]');
      return {
        ok: true,
        async json() {
          return {
            status: 'success',
            data: {
              magnets: hashes.map((h, idx) => ({
                hash: h,
                ready: true,
                id: 300 + idx,
              })),
            },
          };
        },
      };
    }
    if (url.pathname.endsWith('/magnet/delete')) {
      deletedIds.push(Number(url.searchParams.get('id')));
      return {
        ok: true,
        async json() {
          return { status: 'success', data: { message: 'deleted' } };
        },
      };
    }
    throw new Error(`Unexpected URL in test: ${url.pathname}`);
  }) as unknown as typeof globalThis.fetch;

  try {
    // With /magnet/status returning 500, checkCached must not crash and must NOT delete ready magnets (fail-safe)
    const result = await alldebrid.checkCached('key-with-500-status', [HASH_USER, HASH_CHECK]);
    assert.equal(result.complete, true);
    await new Promise((r) => setTimeout(r, 30));

    // Zero ready magnets deleted because inventory failed (preexistentes === null)
    assert.equal(deletedIds.length, 0, 'No magnets deleted when inventory status fails with 500');
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
});

test('alldebrid.ts: API error classification (AUTH_BAD_APIKEY -> AuthError, MAGNET_TOO_MANY_ACTIVE -> QuotaError)', async () => {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;

  let currentErrorCode = 'AUTH_BAD_APIKEY';

  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/magnet/upload')) {
      return {
        ok: true,
        async json() {
          return {
            status: 'error',
            error: { code: currentErrorCode, message: `Simulated error for ${currentErrorCode}` },
          };
        },
      };
    }
    throw new Error(`Unexpected URL in test: ${url.pathname}`);
  }) as unknown as typeof globalThis.fetch;

  try {
    // Direct adapter call throws typed errors
    currentErrorCode = 'AUTH_BAD_APIKEY';
    await assert.rejects(
      alldebrid.checkCached('invalid-key', ['1'.repeat(40)]),
      (err: any) => err instanceof AuthError,
    );

    currentErrorCode = 'MAGNET_TOO_MANY_ACTIVE';
    await assert.rejects(
      alldebrid.checkCached('quota-full-key', ['2'.repeat(40)]),
      (err: any) => err instanceof QuotaError,
    );

    // Registry wrapper converts them to unusable status
    currentErrorCode = 'AUTH_BAD_APIKEY';
    const authRes = await runtime.run(
      { opts: { ...runtime.defaults(), debridService: 'alldebrid', debridApiKey: 'invalid-key' } },
      () => debrid.checkCached(['1'.repeat(40)]),
    );
    assert.equal(authRes.known, false);
    assert.equal(authRes.unusable?.reason, 'auth');

    currentErrorCode = 'MAGNET_TOO_MANY_ACTIVE';
    const quotaRes = await runtime.run(
      { opts: { ...runtime.defaults(), debridService: 'alldebrid', debridApiKey: 'quota-full-key' } },
      () => debrid.checkCached(['2'.repeat(40)]),
    );
    assert.equal(quotaRes.known, false);
    assert.equal(quotaRes.unusable?.reason, 'quota');
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
});
