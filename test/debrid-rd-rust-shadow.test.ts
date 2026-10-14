// Sombra do ledger RD com núcleo stub. Não carrega .node nem sobe o addon.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

const config = (await import('../src/config.js')).default;
const metrics = await import('../src/utils/metrics.js');
const rustCore = await import('../src/utils/rust-core.js');
const { installDebridRdHook, resetDebridRdHook } = await import('../src/utils/rust-debrid-rd.js');
const { nextOnHit } = await import('../src/debrid/rd-ledger.js');

const saved = config.rustDebrid.rd;

function counter(name: string): number {
  return Number(metrics.snapshot().counters[name] || 0);
}

const input = { enabled: true, hitTtl: 60, now: 1000, current: 'unknown' as const };

beforeEach(() => {
  metrics.reset();
  rustCore.setCoreForTest(null);
  config.rustDebrid.rd = 'off';
  resetDebridRdHook();
});

after(() => {
  config.rustDebrid.rd = saved;
  rustCore.setCoreForTest(null);
  resetDebridRdHook();
});

test('shadow: divergência conta e o write continua o do TS', () => {
  config.rustDebrid.rd = 'shadow';
  installDebridRdHook(() => rustCore.getCore());
  rustCore.setCoreForTest({
    normalizeTitle: (title: string) => title,
    debridRdNextHit: () => ({ present: false, s: '', at: 0, n: 0, ttlSeconds: 0, hash: null }),
  });
  const write = nextOnHit(input);
  assert.equal(write?.s, 'hit');
  assert.equal(write?.ttlSeconds, 60);
  assert.equal(counter('rust.debrid.rd.diff'), 1);
  assert.equal(counter('rust.debrid.rd.calls'), 1);
});

test('on: o write é o do stub e um throw cai no TS', () => {
  config.rustDebrid.rd = 'on';
  installDebridRdHook(() => rustCore.getCore());
  rustCore.setCoreForTest({
    normalizeTitle: (title: string) => title,
    debridRdNextHit: () => ({ present: false, s: '', at: 0, n: 0, ttlSeconds: 0, hash: null }),
  });
  assert.equal(nextOnHit(input), null);

  metrics.reset();
  rustCore.setCoreForTest({
    normalizeTitle: (title: string) => title,
    debridRdNextHit: () => { throw new Error('núcleo estourou'); },
  });
  assert.equal(nextOnHit(input)?.s, 'hit');
  assert.equal(counter('rust.debrid.rd.error'), 1);
});
