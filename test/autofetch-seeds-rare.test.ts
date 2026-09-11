// --- Título raro no pool seeds (caso real The Rejuvenator, 1988) ---
//
// 5 alternativas de 1-5 seeders: com autoFetchTopSeedsMax=2 o Chupim apostava
// a obra em dois torrents fracos, e se os dois empacassem a lista seguia vazia.
// Com até DEBRID_AUTO_FETCH_RARE_THRESHOLD candidatos com swarm, o limite
// imediato sobe para DEBRID_AUTO_FETCH_RARE_MAX — estritos primeiro, sem
// duplicar hash, e a vaga por busca acompanha o limite (senão o 3º disparo
// morreria em `slot`). Título comum passa do limiar e nada muda.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import * as held from '../src/debrid/protected.js';
import * as autofetch from '../src/providers/autofetch.js';
import debrid from '../src/debrid/index.js';
import * as runtime from '../src/runtime.js';
import config from '../src/config.js';
import { accountScope } from '../src/utils/request-key.js';
import * as cache from '../src/utils/cache.js';
import * as metrics from '../src/utils/metrics.js';
import * as autofetchLive from '../src/utils/autofetch-live.js';
import { applyDebrid } from '../src/providers/index.js';
import type { DebridAdapter } from '../types/domain.js';

const counter = (key: string) => metrics.snapshot().counters[key] || 0;
const deltaOf = (key: string) => {
  const before = counter(key);
  return () => counter(key) - before;
};

const LIVE_KNOBS = { autoFetchMinSeeders: 3, autoFetchTopSeedsMax: 2, autoFetchQueueDepth: 0 };
const originalRare = { max: config.debrid.autoFetchRareMax, threshold: config.debrid.autoFetchRareThreshold };
const withRare = (max: number, threshold: number) => {
  config.debrid.autoFetchRareMax = max;
  config.debrid.autoFetchRareThreshold = threshold;
};
const rareRestore = () => {
  config.debrid.autoFetchRareMax = originalRare.max;
  config.debrid.autoFetchRareThreshold = originalRare.threshold;
};

function seedsHarness(key: string) {
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const account = accountScope(key);
  const enqueued: string[] = [];
  pmAdapter.enqueue = async (_apiKey: any, infoHash: any) => { enqueued.push(infoHash); return true; };
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: key,
    debridCachedOnly: true,
    autoFetchBr: true,
  };
  return {
    account, enqueued,
    searchKey: `busca-${key}`,
    run: (fn: () => unknown) => runtime.run({ opts: userOpts, encoded: `cfg-${key}` }, fn),
    cleanup() {
      debrid.checkCached = originalCheck;
      config.debrid.publicUrl = originalPublicUrl;
      pmAdapter.enqueue = originalEnqueue;
    },
  };
}

const releaseAll = (harness: ReturnType<typeof seedsHarness>, hashes: string[]) => {
  autofetch.releaseSearch(harness.searchKey);
  for (const h of hashes) {
    cache.forget(autofetch.markerKey('premiumize', harness.account, h));
    held.release(h, harness.account);
  }
};

async function runSearch(harness: ReturnType<typeof seedsHarness>, streams: any[]) {
  config.debrid.publicUrl = 'http://addon.test';
  debrid.checkCached = async () => ({ cached: new Set(), known: true });
  await harness.run(() => applyDebrid(streams, { searchKey: harness.searchKey } as any));
  await new Promise((r) => setTimeout(r, 20));
}

test('seeds: título raro dispara até RARE_MAX imediatos', async () => {
  autofetchLive.set({ ...LIVE_KNOBS });
  withRare(4, 6);
  const harness = seedsHarness('seeds-rare-fire');
  const hs = ['a1', 'a2', 'a3', 'a4', 'a5'].map((p) => p.repeat(20));
  try {
    const dRare = deltaOf('autofetch.seeds.rare');
    await runSearch(harness, [
      { infoHash: hs[0], name: 'Rare Case 1988 DVDRip', title: 'Rare Case 1988 DVDRip', _seeders: 5 },
      { infoHash: hs[1], name: 'Rare Case 1988 WEBRip', title: 'Rare Case 1988 WEBRip', _seeders: 4 },
      { infoHash: hs[2], name: 'Rare Case 1988 VHSRip A', title: 'Rare Case 1988 VHSRip A', _seeders: 2 },
      { infoHash: hs[3], name: 'Rare Case 1988 VHSRip B', title: 'Rare Case 1988 VHSRip B', _seeders: 1 },
      { infoHash: hs[4], name: 'Rare Case 1988 TVRip', title: 'Rare Case 1988 TVRip', _seeders: 1 },
    ]);
    assert.equal(harness.enqueued.length, 4, 'título raro dispara RARE_MAX=4, não TOP_SEEDS_MAX=2');
    assert.deepEqual(harness.enqueued.slice(0, 2), [hs[0], hs[1]], 'estritos (>=3 seeders) primeiro');
    assert.equal(new Set(harness.enqueued).size, 4, 'sem hash duplicado');
    assert.equal(dRare(), 1, 'regime raro fica mensurado');
  } finally {
    harness.cleanup();
    autofetchLive.reset();
    rareRestore();
    releaseAll(harness, hs);
  }
});

test('seeds: título comum (universo acima do limiar) mantém TOP_SEEDS_MAX', async () => {
  autofetchLive.set({ ...LIVE_KNOBS });
  withRare(4, 3);
  const harness = seedsHarness('seeds-rare-common');
  const hs = ['b1', 'b2', 'b3', 'b4'].map((p) => p.repeat(20));
  try {
    const dRare = deltaOf('autofetch.seeds.rare');
    await runSearch(harness, hs.map((h, i) => (
      { infoHash: h, name: `Common Case 1988 Rip ${i}`, title: `Common Case 1988 Rip ${i}`, _seeders: 10 - i })));
    assert.equal(harness.enqueued.length, 2, '4 candidatos > limiar 3: segue o max=2 normal');
    assert.equal(dRare(), 0, 'título comum não entra no regime raro');
  } finally {
    harness.cleanup();
    autofetchLive.reset();
    rareRestore();
    releaseAll(harness, hs);
  }
});

test('seeds: RARE_MAX abaixo de TOP_SEEDS_MAX não reduz o limite', async () => {
  autofetchLive.set({ ...LIVE_KNOBS, autoFetchTopSeedsMax: 3 });
  withRare(2, 6);
  const harness = seedsHarness('seeds-rare-lower');
  const hs = ['c1', 'c2', 'c3'].map((p) => p.repeat(20));
  try {
    await runSearch(harness, hs.map((h, i) => (
      { infoHash: h, name: `Lower Case 1988 Rip ${i}`, title: `Lower Case 1988 Rip ${i}`, _seeders: 9 - i })));
    assert.equal(harness.enqueued.length, 3, 'o raro só sobe o limite, nunca abaixa');
  } finally {
    harness.cleanup();
    autofetchLive.reset();
    rareRestore();
    releaseAll(harness, hs);
  }
});

test('seeds: poucos candidatos com enxame saudável não é título raro', async () => {
  // Poucos, mas o melhor com 59 seeders: termina sozinho. Baixar o de 1
  // seeder junto seria só lixo na conta — o limite normal vale.
  autofetchLive.set({ ...LIVE_KNOBS });
  withRare(4, 6);
  const harness = seedsHarness('seeds-rare-healthy');
  const hs = ['e1', 'e2', 'e3'].map((p) => p.repeat(20));
  try {
    const dRare = deltaOf('autofetch.seeds.rare');
    await runSearch(harness, [
      { infoHash: hs[0], name: 'Healthy Case 2003 1080p', title: 'Healthy Case 2003 1080p', _seeders: 59 },
      { infoHash: hs[1], name: 'Healthy Case 2003 720p', title: 'Healthy Case 2003 720p', _seeders: 47 },
      { infoHash: hs[2], name: 'Healthy Case 2003 DVDRip', title: 'Healthy Case 2003 DVDRip', _seeders: 1 },
    ]);
    assert.deepEqual(harness.enqueued, [hs[0], hs[1]], 'enxame saudável: segue TOP_SEEDS_MAX=2');
    assert.equal(dRare(), 0, 'melhor candidato acima de MAX_SEEDERS não é raro');
  } finally {
    harness.cleanup();
    autofetchLive.reset();
    rareRestore();
    releaseAll(harness, hs);
  }
});

test('seeds: THRESHOLD=0 desliga o regime raro', async () => {
  autofetchLive.set({ ...LIVE_KNOBS });
  withRare(4, 0);
  const harness = seedsHarness('seeds-rare-off');
  const hs = ['d1', 'd2', 'd3'].map((p) => p.repeat(20));
  try {
    const dRare = deltaOf('autofetch.seeds.rare');
    await runSearch(harness, hs.map((h, i) => (
      { infoHash: h, name: `Off Case 1988 Rip ${i}`, title: `Off Case 1988 Rip ${i}`, _seeders: 8 - i })));
    assert.equal(harness.enqueued.length, 2, 'desligado: segue TOP_SEEDS_MAX');
    assert.equal(dRare(), 0);
  } finally {
    harness.cleanup();
    autofetchLive.reset();
    rareRestore();
    releaseAll(harness, hs);
  }
});
