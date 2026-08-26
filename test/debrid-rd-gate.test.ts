import { test } from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import { parseRetryAfter, RateLimitError, retryAfterMsOf } from '../src/debrid/common.js';
import { createRdGate, rdGate } from '../src/debrid/rd-gate.js';
import * as realdebrid from '../src/debrid/realdebrid.js';
import { accountScope } from '../src/utils/request-key.js';
import * as autofetch from '../src/providers/autofetch.js';
import { drainNext } from '../src/providers/autofetch-runner.js';
import * as runtime from '../src/runtime.js';
import * as memo from '../src/debrid/inventory-memo.js';

function fakeClock() {
  let current = 0;
  const sleepers: Array<{ at: number; resolve: () => void }> = [];
  return {
    now: () => current,
    sleep(ms: number) {
      return new Promise<void>((resolve) => sleepers.push({ at: current + Math.max(0, ms), resolve }));
    },
    async advance(ms: number) {
      current += ms;
      for (let pass = 0; pass < 8; pass += 1) {
        const due = sleepers.filter((item) => item.at <= current);
        for (const item of due) sleepers.splice(sleepers.indexOf(item), 1);
        for (const item of due) item.resolve();
        await Promise.resolve();
      }
    },
  };
}

function gateFor(clock: ReturnType<typeof fakeClock>, overrides: Parameters<typeof createRdGate>[0] = {}) {
  return createRdGate({
    enabled: () => true,
    minGapMs: () => 0,
    maxGapMs: () => 30_000,
    cooldownMs: () => 90_000,
    playMaxWaitMs: () => 1_500,
    now: clock.now,
    sleep: clock.sleep,
    ...overrides,
  });
}

test('parseRetryAfter aceita delta-seconds e HTTP-date', () => {
  const now = Date.parse('2026-08-25T20:00:00Z');
  assert.equal(parseRetryAfter('30', now), 30_000);
  assert.equal(parseRetryAfter('Tue, 25 Aug 2026 20:00:30 GMT', now), 30_000);
  assert.equal(parseRetryAfter('inválido', now), undefined);
  assert.equal(retryAfterMsOf(new RateLimitError('429', 30_000)), 30_000);
});

test('gate mantém concorrência 1 e prioriza play, autofetch e probe', async () => {
  const clock = fakeClock();
  const gate = gateFor(clock);
  const order: string[] = [];
  let release!: () => void;
  const first = gate.run('conta', 'probe', () => new Promise<void>((resolve) => {
    order.push('primeiro');
    release = resolve;
  }));
  await clock.advance(0);
  const probe = gate.run('conta', 'probe', async () => { order.push('probe'); });
  const autofetch = gate.run('conta', 'autofetch', async () => { order.push('autofetch'); });
  const play = gate.run('conta', 'play', async () => { order.push('play'); });
  release();
  await Promise.all([first, play, autofetch, probe]);
  assert.deepEqual(order, ['primeiro', 'play', 'autofetch', 'probe']);
});

test('429 e cooldown na conta A não bloqueiam a conta B', async () => {
  const clock = fakeClock();
  const gate = gateFor(clock);
  await assert.rejects(
    gate.run('a', 'probe', async () => { throw new RateLimitError('429', 30_000); }),
    RateLimitError,
  );
  assert.equal(gate.isCoolingDown('a'), true);
  let bRan = false;
  await gate.run('b', 'autofetch', async () => { bRan = true; });
  assert.equal(bRan, true);
  assert.equal(gate.isCoolingDown('b'), false);
});

test('play fura cooldown após o teto, mas não preempta job em voo', async () => {
  const clock = fakeClock();
  const gate = gateFor(clock);
  await assert.rejects(
    gate.run('conta', 'probe', async () => { throw new RateLimitError('429'); }),
    RateLimitError,
  );
  let ran = false;
  const play = gate.run('conta', 'play', async () => { ran = true; return 'ok'; });
  await clock.advance(1_499);
  assert.equal(ran, false);
  await clock.advance(1);
  assert.equal(await play, 'ok');
  assert.equal(ran, true);
  await assert.rejects(gate.run('conta', 'autofetch', async () => true), RateLimitError);
});

test('cleanup fura cooldown imediatamente para liberar recurso', async () => {
  const clock = fakeClock();
  const gate = gateFor(clock, { minGapMs: () => 1_000 });
  await assert.rejects(
    gate.run('conta', 'probe', async () => { throw new RateLimitError('429'); }),
    RateLimitError,
  );
  let ran = false;
  await gate.run('conta', 'cleanup', async () => { ran = true; });
  assert.equal(ran, true);
});

test('cleanup espera job em voo e play enfileirado passa primeiro', async () => {
  const clock = fakeClock();
  const gate = gateFor(clock);
  const order: string[] = [];
  let release!: () => void;
  const active = gate.run('conta', 'probe', () => new Promise<void>((resolve) => {
    order.push('ativo');
    release = resolve;
  }));
  await clock.advance(0);
  const cleanup = gate.run('conta', 'cleanup', async () => { order.push('cleanup'); });
  const play = gate.run('conta', 'play', async () => { order.push('play'); });
  assert.deepEqual(gate.snapshot('conta')[0].waiting, { play: 1, cleanup: 1, autofetch: 0, probe: 0 });
  release();
  await Promise.all([active, play, cleanup]);
  assert.deepEqual(order, ['ativo', 'play', 'cleanup']);
});

test('Retry-After de 30s é honrado e o gap dobra e decai 10%', async () => {
  const clock = fakeClock();
  const gate = gateFor(clock, {
    minGapMs: () => 100,
    maxGapMs: () => 1_000,
    cooldownMs: () => 90_000,
    successThreshold: 2,
  });
  await assert.rejects(
    gate.run('conta', 'probe', async () => { throw new RateLimitError('429', 30_000); }),
    RateLimitError,
  );
  let state = gate.snapshot('conta')[0];
  assert.equal(state.gapMs, 200);
  assert.equal(state.cooldownUntil, 30_000);
  assert.equal(state.rateLimitsLastHour, 1);

  const first = gate.run('conta', 'play', async () => true);
  await clock.advance(1_500);
  await first;
  await clock.advance(0);
  const second = gate.run('conta', 'play', async () => true);
  await clock.advance(1_500);
  await second;
  state = gate.snapshot('conta')[0];
  assert.equal(state.gapMs, 180);
});

test('status expõe waiters por prioridade', async () => {
  const clock = fakeClock();
  const gate = gateFor(clock);
  let release!: () => void;
  const active = gate.run('conta', 'probe', () => new Promise<void>((resolve) => { release = resolve; }));
  await clock.advance(0);
  const queued = [
    gate.run('conta', 'play', async () => {}),
    gate.run('conta', 'cleanup', async () => {}),
    gate.run('conta', 'autofetch', async () => {}),
    gate.run('conta', 'probe', async () => {}),
  ];
  assert.deepEqual(gate.snapshot('conta')[0].waiting, { play: 1, cleanup: 1, autofetch: 1, probe: 1 });
  release();
  await Promise.all([active, ...queued]);
});

test('kill-switch restaura pass-through sem fila, gap ou cooldown', async () => {
  const clock = fakeClock();
  const gate = createRdGate({ enabled: () => false, now: clock.now, sleep: clock.sleep });
  const order: string[] = [];
  await Promise.all([
    gate.run('conta', 'probe', async () => { order.push('a'); }),
    gate.run('conta', 'play', async () => { order.push('b'); }),
  ]);
  assert.deepEqual(order.sort(), ['a', 'b']);
  assert.deepEqual(gate.snapshot(), []);
  assert.equal(gate.isCoolingDown('conta'), false);
});

test('integração RD: 429 não faz retry e Retry-After alimenta o gate da conta', async () => {
  const old = { ...config.debrid.rdGate };
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  let writes = 0;
  config.debrid.rdGate.enabled = true;
  config.debrid.rdGate.minGapMs = 0;
  config.debrid.rdGate.maxGapMs = 30_000;
  config.debrid.rdGate.cooldownMs = 90_000;
  config.debrid.rdGate.playMaxWaitMs = 1_500;
  rdGate.reset();
  AbortSignal.timeout = (() => undefined as unknown as AbortSignal) as typeof AbortSignal.timeout;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'POST') writes += 1;
    return {
      ok: false,
      status: 429,
      headers: { get: (name: string) => name.toLowerCase() === 'retry-after' ? '30' : null },
      async text() { return 'too many requests'; },
    } as Response;
  }) as typeof globalThis.fetch;
  try {
    await assert.rejects(realdebrid.enqueue('conta-rd', 'a'.repeat(40)), RateLimitError);
    assert.equal(writes, 1, '429 nunca é reenviado automaticamente');
    const state = rdGate.snapshot(accountScope('conta-rd'))[0];
    assert.equal(state.cooldownUntil > Date.now() + 29_000, true);
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
    Object.assign(config.debrid.rdGate, old);
    rdGate.reset();
  }
});

test('integração RD: removeTorrent executa DELETE durante cooldown', async () => {
  const old = { ...config.debrid.rdGate };
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  const apiKey = 'conta-rd-cleanup';
  try {
    config.debrid.rdGate.enabled = true;
    config.debrid.rdGate.minGapMs = 0;
    rdGate.reset();
    await assert.rejects(
      rdGate.run(accountScope(apiKey), 'probe', async () => { throw new RateLimitError('429', 30_000); }),
      RateLimitError,
    );
    AbortSignal.timeout = (() => undefined as unknown as AbortSignal) as typeof AbortSignal.timeout;
    let deleted = false;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      assert.equal(new URL(String(input)).pathname.endsWith('/torrents/delete/RD-CLEANUP'), true);
      assert.equal(init?.method, 'DELETE');
      deleted = true;
      return { ok: true, status: 204, async json() { throw new SyntaxError('sem corpo'); } } as unknown as Response;
    }) as typeof globalThis.fetch;
    assert.equal(await realdebrid.removeTorrent(apiKey, 'RD-CLEANUP'), true);
    assert.equal(deleted, true);
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
    Object.assign(config.debrid.rdGate, old);
    rdGate.reset();
  }
});

test('autofetch RD preserva a cabeça da fila enquanto a conta está em cooldown', async () => {
  const oldEnabled = config.debrid.rdGate.enabled;
  const oldCooldown = config.debrid.rdGate.cooldownMs;
  const apiKey = 'conta-rd-drain';
  const account = accountScope(apiKey);
  const searchKey = 'streams:v6:movie:ttRdGateDrain';
  const items = [
    { infoHash: 'b'.repeat(40), title: 'Cabeça RD', quality: '1080p' },
    { infoHash: 'c'.repeat(40), title: 'Segundo RD', quality: '720p' },
  ];
  try {
    config.debrid.rdGate.enabled = true;
    config.debrid.rdGate.cooldownMs = 90_000;
    rdGate.reset();
    await assert.rejects(
      rdGate.run(account, 'probe', async () => { throw new RateLimitError('429'); }),
      RateLimitError,
    );
    autofetch.writeQueue(searchKey, items, 3600, 'realdebrid', account);
    const before = autofetch.readQueue(searchKey);
    await runtime.run(
      { opts: { ...runtime.defaults(), debridService: 'realdebrid', debridApiKey: apiKey }, encoded: 'cfg-rd-gate' },
      async () => { drainNext(searchKey, { refusals: 0 }); },
    );
    assert.deepEqual(autofetch.readQueue(searchKey), before);
  } finally {
    config.debrid.rdGate.enabled = oldEnabled;
    config.debrid.rdGate.cooldownMs = oldCooldown;
    rdGate.reset();
    autofetch.dropQueue(searchKey);
  }
});

test('autofetch RD repõe na frente se cooldown abrir depois de takeNext', async () => {
  const oldEnabled = config.debrid.rdGate.enabled;
  const adapter = (await import('../src/debrid/index.js')).default.BY_ID.get('realdebrid')!;
  const oldEnqueue = adapter.enqueue;
  const apiKey = 'conta-rd-toctou';
  const account = accountScope(apiKey);
  const searchKey = 'streams:v6:movie:ttRdGateToctou';
  const first = { infoHash: 'd'.repeat(40), title: 'Primeiro', quality: '1080p' };
  const second = { infoHash: 'e'.repeat(40), title: 'Segundo', quality: '720p' };
  const lot = { refusals: 1 };
  let calls = 0;
  try {
    config.debrid.rdGate.enabled = true;
    rdGate.reset();
    adapter.enqueue = async () => {
      calls += 1;
      return rdGate.run(account, 'probe', async () => { throw new RateLimitError('429', 30_000); });
    };
    autofetch.writeQueue(searchKey, [first, second], 3600, 'realdebrid', account);
    await runtime.run(
      { opts: { ...runtime.defaults(), debridService: 'realdebrid', debridApiKey: apiKey }, encoded: 'cfg-rd-toctou' },
      async () => { drainNext(searchKey, lot); },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    const queue = autofetch.readQueue(searchKey);
    assert.equal(queue[0].infoHash, first.infoHash);
    assert.equal(queue[1].infoHash, second.infoHash);
    assert.equal(lot.refusals, 1, 'rate limit não é recusa do torrent');
    await runtime.run(
      { opts: { ...runtime.defaults(), debridService: 'realdebrid', debridApiKey: apiKey }, encoded: 'cfg-rd-toctou' },
      async () => { drainNext(searchKey, lot); },
    );
    assert.equal(calls, 1, 'cooldown impede nova drenagem');
  } finally {
    adapter.enqueue = oldEnqueue;
    config.debrid.rdGate.enabled = oldEnabled;
    rdGate.reset();
    autofetch.dropQueue(searchKey);
  }
});

test('resolveLink pronto evita addMagnet e play fura cooldown uma vez, sem retry', async () => {
  const old = { ...config.debrid.rdGate };
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  const apiKey = 'conta-rd-play-gate';
  const account = accountScope(apiKey);
  const hash = 'f'.repeat(40);
  const paths: string[] = [];
  try {
    config.debrid.rdGate.enabled = true;
    config.debrid.rdGate.minGapMs = 0;
    config.debrid.rdGate.playMaxWaitMs = 20;
    rdGate.reset();
    memo.store('realdebrid', apiKey, [{ title: 'Pronto.mkv', infoHash: hash, size: 10, id: 'READY' }]);
    await assert.rejects(
      rdGate.run(account, 'probe', async () => { throw new RateLimitError('429', 30_000); }),
      RateLimitError,
    );
    AbortSignal.timeout = (() => undefined as unknown as AbortSignal) as typeof AbortSignal.timeout;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      if (url.pathname.endsWith('/torrents/info/READY')) {
        return { ok: true, status: 200, async json() { return { status: 'downloaded', filename: 'Pronto.mkv', bytes: 10, files: [{ id: 1, path: '/Pronto.mkv', bytes: 10, selected: 1 }], links: ['https://real-debrid.com/d/X'] }; } } as Response;
      }
      if (url.pathname.endsWith('/unrestrict/link')) {
        return { ok: true, status: 200, async json() { return { download: 'https://cdn.real-debrid.com/X' }; } } as Response;
      }
      throw new Error(`URL inesperada: ${url.pathname}`);
    }) as typeof globalThis.fetch;
    const started = Date.now();
    const link = await realdebrid.resolveLink(apiKey, hash);
    const elapsed = Date.now() - started;
    assert.equal(link, 'https://cdn.real-debrid.com/X');
    assert.equal(paths.some((path) => path.endsWith('/torrents/addMagnet')), false);
    assert.equal(paths.filter((path) => path.endsWith('/unrestrict/link')).length, 1, 'play não faz retry');
    assert.equal(elapsed >= 15 && elapsed < 500, true, `espera observada: ${elapsed}ms`);
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
    Object.assign(config.debrid.rdGate, old);
    rdGate.reset();
    memo.forget('realdebrid', apiKey, hash);
  }
});
