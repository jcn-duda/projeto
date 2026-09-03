import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { asyncRoute } from '../src/app.js';
import * as diagGuard from '../src/utils/diagnostic-guard.js';
import { createTestServer } from './e2e/e2e-harness.js';

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
