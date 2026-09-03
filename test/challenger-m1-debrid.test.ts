import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import config from '../src/config.js';
import * as alldebrid from '../src/debrid/alldebrid.js';
import debrid from '../src/debrid/index.js';
import * as runtime from '../src/runtime.js';
import { AuthError, QuotaError } from '../src/debrid/common.js';

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
// 1. EMPIRICAL CHALLENGE: cache.ts Database Corruption Recovery
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
    assert.strictEqual(res.status, 0, `Subprocess failed:\nSTDOUT:\n${res.stdout}\nSTDERR:\n${res.stderr}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test('cache.ts recovery: junk ASCII data triggers .corrupt rename and clean DB', { skip: !hasNodeSqlite && 'node:sqlite unavailable' }, () => {
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
});

test('cache.ts recovery: truncated SQLite header triggers .corrupt rename and clean DB', { skip: !hasNodeSqlite && 'node:sqlite unavailable' }, () => {
  const script = `
    const assert = require('node:assert');
    const fs = require('node:fs');
    delete process.env.CACHE_PERSIST;
    const dbPath = process.env.CACHE_DB_PATH;
    const corruptPath = dbPath + '.corrupt';
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
});

test('cache.ts recovery: pre-existing .corrupt file is overwritten cleanly', { skip: !hasNodeSqlite && 'node:sqlite unavailable' }, () => {
  const script = `
    const assert = require('node:assert');
    const fs = require('node:fs');
    delete process.env.CACHE_PERSIST;
    const dbPath = process.env.CACHE_DB_PATH;
    const corruptPath = dbPath + '.corrupt';
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
});

test('cache.ts recovery: orphaned -wal and -shm sidecar files removed during recovery', { skip: !hasNodeSqlite && 'node:sqlite unavailable' }, () => {
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
    cache.set('test:sidecars', { success: true }, 3600);
    assert.deepStrictEqual(cache.get('test:sidecars'), { success: true });
    if (cache.close) cache.close();
  `;
  runIsolatedScript(script);
});

// ============================================================================
// 2. EMPIRICAL CHALLENGE: alldebrid.ts Snapshot TTL & Mock 500 Behavior
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
