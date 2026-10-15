// Sombra do lote de autofetch com núcleo stub. Não carrega .node nem sobe o
// runner: exercita o `observeAutofetch` direto (captura, comparação com teto,
// kill-switch e fail-open), como o rust-release-index.test.ts.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

const config = (await import('../src/config.js')).default;
const metrics = await import('../src/utils/metrics.js');
const rustCore = await import('../src/utils/rust-core.js');
const {
  observeAutofetch,
  autofetchShadowEnabled,
  installAutofetchHook,
  resetAutofetchHook,
} = await import('../src/utils/rust-autofetch.js');
import type { AutofetchCapture, AutofetchDecisionNapi } from '../src/utils/rust-autofetch.js';

const savedMode = config.rustAutofetch.mode;

function counter(name: string): number {
  return Number(metrics.snapshot().counters[name] || 0);
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function titles(): { normalizeTitle(title: string): string } {
  return { normalizeTitle: (title: string) => title };
}

/** Captura mínima: 1 imediato BR, sem fila. */
function capture(overrides: Partial<AutofetchCapture> = {}): AutofetchCapture {
  return {
    streams: [{ infoHash: 'aaa', title: 'Filme 1988 1080p DUBLADO', _br: true, _dubbed: true, _seeders: 10 }],
    pool: 'br',
    immediateHashes: ['aaa'],
    queueEntries: [],
    season: null,
    queueDepth: 0,
    live: {
      autoFetchMinSeeders: 1,
      autoFetchSeedsPtFirst: true,
      autoFetchMax: 3,
      autoFetchTopSeedsMax: 2,
      autoFetchRareMax: 0,
      autoFetchRareThreshold: 0,
      autoFetchRareMaxSeeders: 0,
      autoFetchAnyDubbed: true,
      autoFetchTopSeeds: true,
    },
    policy: { dubbedOnly: false, cachedOnly: true, maxSizeGb: 0, seedsMaxGb: 0, seedsMaxQuality: '1080p' },
    autoFetchBr: true,
    adapter: { cacheCheck: true },
    ...overrides,
  };
}

/** Stub que devolve uma decisão fixa do lote. */
function stub(decision: AutofetchDecisionNapi) {
  return { ...titles(), evaluateAutofetchCandidates: () => decision };
}

const agree: AutofetchDecisionNapi = {
  immediates: [{ infoHash: 'AAA', pool: 'br', rare: false }],
  queue: [],
  skips: [],
};

beforeEach(() => {
  metrics.reset();
  rustCore.setCoreForTest(null);
  config.rustAutofetch.mode = 'off';
  resetAutofetchHook();
});

after(() => {
  config.rustAutofetch.mode = savedMode;
  rustCore.setCoreForTest(null);
  resetAutofetchHook();
});

test('default off: observeAutofetch é no-op e o hook reporta desligado', async () => {
  assert.equal(config.rustAutofetch.mode, 'off');
  assert.equal(autofetchShadowEnabled(), false);
  observeAutofetch(capture());
  await flush();
  assert.equal(counter('rust.autofetch.calls'), 0);
});

test('shadow: TS e Rust de acordo não geram divergência', async () => {
  config.rustAutofetch.mode = 'shadow';
  assert.equal(autofetchShadowEnabled(), true);
  installAutofetchHook(() => rustCore.getCore());
  rustCore.setCoreForTest(stub(agree));
  observeAutofetch(capture());
  await flush();
  assert.equal(counter('rust.autofetch.calls'), 1);
  assert.equal(counter('rust.autofetch.divergence'), 0);
});

test('shadow: imediatos diferentes contam divergência', async () => {
  config.rustAutofetch.mode = 'shadow';
  installAutofetchHook(() => rustCore.getCore());
  rustCore.setCoreForTest(stub({ immediates: [], queue: [], skips: [] }));
  observeAutofetch(capture());
  await flush();
  assert.equal(counter('rust.autofetch.divergence'), 1);
});

test('shadow: fila divergente (hash+pool) conta divergência', async () => {
  config.rustAutofetch.mode = 'shadow';
  installAutofetchHook(() => rustCore.getCore());
  const cap = capture({ immediateHashes: [], queueEntries: [{ hash: 'bbb', pool: 'any' }] });
  rustCore.setCoreForTest(stub({ immediates: [], queue: [{ infoHash: 'bbb', pool: 'seeds', rare: false }], skips: [] }));
  observeAutofetch(cap);
  await flush();
  assert.equal(counter('rust.autofetch.divergence'), 1);
});

test('shadow: skip do Rust (portão fechado) conta divergência', async () => {
  config.rustAutofetch.mode = 'shadow';
  installAutofetchHook(() => rustCore.getCore());
  rustCore.setCoreForTest(stub({ immediates: [{ infoHash: 'aaa', pool: 'br', rare: false }], queue: [], skips: [{ reason: 'paused', rollback: ['hold'], infoHash: 'aaa' }] }));
  observeAutofetch(capture());
  await flush();
  assert.equal(counter('rust.autofetch.divergence'), 1);
});

test('shadow: stub que lança vira erro contado, sem derrubar', async () => {
  config.rustAutofetch.mode = 'shadow';
  installAutofetchHook(() => rustCore.getCore());
  rustCore.setCoreForTest({ ...titles(), evaluateAutofetchCandidates: () => { throw new Error('núcleo estourou'); } });
  observeAutofetch(capture());
  await flush();
  assert.equal(counter('rust.autofetch.error'), 1);
  assert.equal(counter('rust.autofetch.divergence'), 0);
});

test('shadow sem núcleo carregado é no-op', async () => {
  config.rustAutofetch.mode = 'shadow';
  installAutofetchHook(() => rustCore.getCore());
  observeAutofetch(capture());
  await flush();
  assert.equal(counter('rust.autofetch.calls'), 0);
});

test('shadow sem evaluateAutofetchCandidates (binário antigo) é no-op', async () => {
  config.rustAutofetch.mode = 'shadow';
  installAutofetchHook(() => rustCore.getCore());
  rustCore.setCoreForTest(titles());
  observeAutofetch(capture());
  await flush();
  assert.equal(counter('rust.autofetch.calls'), 0);
});

test('teto de log: divergências além de maxLoggedDiffs continuam contadas', async () => {
  config.rustAutofetch.mode = 'shadow';
  installAutofetchHook(() => rustCore.getCore());
  rustCore.setCoreForTest(stub({ immediates: [], queue: [], skips: [] }));
  const savedMax = config.rustCore.maxLoggedDiffs;
  config.rustCore.maxLoggedDiffs = 1;
  try {
    for (let i = 0; i < 4; i += 1) {
      observeAutofetch(capture({ immediateHashes: [`h${i}`] }));
      await flush();
    }
  } finally {
    config.rustCore.maxLoggedDiffs = savedMax;
  }
  assert.equal(counter('rust.autofetch.divergence'), 4);
});
