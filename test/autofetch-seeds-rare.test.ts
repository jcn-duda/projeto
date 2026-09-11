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
import { applySeedsStopGate } from '../src/providers/autofetch-seeds-pool.js';
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

test('seeds: raro × fila — runner dispara RARE_MAX imediatos e enfileira exatamente queueDepth', async () => {
  // Strict vazio (todos 1-2 seeders), 6 viáveis <= limiar 6: raro → imediato
  // RARE_MAX=4. Os 2 excedentes vão para a fila PERSISTENTE pelo runner
  // (writeQueue/readQueue), não apenas no array do pick.
  autofetchLive.set({ ...LIVE_KNOBS, autoFetchQueue: true, autoFetchQueueDepth: 2 });
  withRare(4, 6);
  const harness = seedsHarness('seeds-rare-queue');
  const hs = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'].map((p) => p.repeat(20));
  try {
    const dRare = deltaOf('autofetch.seeds.rare');
    await runSearch(harness, hs.map((h, i) => (
      { infoHash: h, name: `Rare Queue 1988 VHSRip ${i}`, title: `Rare Queue 1988 VHSRip ${i}`, _seeders: i < 3 ? 2 : 1 })));
    assert.equal(dRare(), 1, 'regime raro dispara');
    assert.equal(harness.enqueued.length, 4, 'quatro imediatos conforme RARE_MAX');
    assert.deepEqual(harness.enqueued.slice(0, 3), [hs[0], hs[1], hs[2]], 'maiores swarms primeiro');
    const queue = autofetch.readQueue(harness.searchKey);
    assert.equal(queue.length, 2, 'exatamente queueDepth=2 excedentes na fila persistente');
    const all = [...harness.enqueued, ...queue.map((q: any) => String(q.infoHash).toLowerCase())];
    assert.equal(new Set(all).size, 6, 'sem hash duplicado entre imediatos e fila');
    assert.equal(new Set(all).size, all.length, 'fila cobre todos os 6 sem repetição');
    assert.ok(queue.every((q: any) => q.pool === 'seeds'), 'fila marca o pool seeds');
  } finally {
    harness.cleanup();
    autofetchLive.reset();
    rareRestore();
    autofetch.dropQueue(harness.searchKey);
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

// --- Caso real Mortuary (tt0087746): exceção do título raro sobre o
// `stop-has-cached`. O RUSTED 720p (3 seeds) passava no ranking, mas o único
// global não-dublado em cache abortava o aquecimento (stop-has-cached) e a
// lista ficava só com o [AD⚡] 1080p do Torrentio — o usuário confirmou "não
// achou". Com o regime raro REAL e adapter com cacheCheck, as alternativas
// frias são aquecidas mesmo com o global ⚡; o hash já cacheado nunca
// enfileira e nunca entra na fila persistente.

async function runSearchCached(harness: ReturnType<typeof seedsHarness>, streams: any[], cached: string[]) {
  config.debrid.publicUrl = 'http://addon.test';
  debrid.checkCached = async () => ({ cached: new Set(cached), known: true });
  await harness.run(() => applyDebrid(streams, { searchKey: harness.searchKey } as any));
  await new Promise((r) => setTimeout(r, 20));
}

test('seeds: raro sobre cache global não-dublado aquece SÓ as alternativas frias', async () => {
  autofetchLive.set({ ...LIVE_KNOBS, autoFetchQueue: true, autoFetchQueueDepth: 3 });
  withRare(4, 6);
  const harness = seedsHarness('seeds-rare-overcached');
  const globalCached = 'g1'.repeat(20); // o "Torrentio 1080p ⚡" do caso real
  const hs = ['h1', 'h2', 'h3', 'h4'].map((p) => p.repeat(20)); // RUSTED, YTS, frios
  const streams = [
    { infoHash: globalCached, name: 'Mortuary 1983 1080p WEBRip', title: 'Mortuary 1983 1080p WEBRip', _seeders: 3 },
    { infoHash: hs[0], name: 'Mortuary 1983 720p DVDRip', title: 'Mortuary 1983 720p DVDRip', _seeders: 3 },
    { infoHash: hs[1], name: 'Mortuary 1983 VHSRip', title: 'Mortuary 1983 VHSRip', _seeders: 2 },
    { infoHash: hs[2], name: 'Mortuary 1983 TVRip', title: 'Mortuary 1983 TVRip', _seeders: 1 },
    { infoHash: hs[3], name: 'Mortuary 1983 Betamax', title: 'Mortuary 1983 Betamax', _seeders: 1 },
  ];
  try {
    const dOver = deltaOf('autofetch.seeds.rareOverCached');
    const dStop = deltaOf('autofetch.skip.stop-has-cached');
    await runSearchCached(harness, streams, [globalCached]);
    assert.equal(dStop(), 0, 'exceção: NÃO aborta por stop-has-cached');
    assert.equal(dOver(), 1, 'exceção fica mensurada em autofetch.seeds.rareOverCached');
    assert.ok(harness.enqueued.length >= 3, 'aquece as alternativas frias (não só o ⚡ existente)');
    assert.ok(harness.enqueued.length <= 4, 'limite RARE_MAX preservado mesmo na exceção');
    assert.ok(!harness.enqueued.includes(globalCached), 'hash já cacheado nunca é enfileirado');
    const queue = autofetch.readQueue(harness.searchKey).map((q: any) => String(q.infoHash).toLowerCase());
    assert.ok(!queue.includes(globalCached), 'hash já cacheado não fica na fila persistente');
  } finally {
    harness.cleanup();
    autofetchLive.reset();
    rareRestore();
    autofetch.dropQueue(harness.searchKey);
    releaseAll(harness, [globalCached, ...hs]);
  }
});

test('seeds: fora do regime raro, qualquer cache continua stop-has-cached', async () => {
  autofetchLive.set({ ...LIVE_KNOBS });
  withRare(4, 3); // universo de 5 > limiar 3: título COMUM
  const harness = seedsHarness('seeds-common-overcached');
  const globalCached = 'k1'.repeat(20);
  const hs = ['k2', 'k3', 'k4', 'k5', 'k6'].map((p) => p.repeat(20));
  try {
    const dOver = deltaOf('autofetch.seeds.rareOverCached');
    const dStop = deltaOf('autofetch.skip.stop-has-cached');
    await runSearchCached(harness, [
      { infoHash: globalCached, name: 'Common Cache 1988 Rip A', title: 'Common Cache 1988 Rip A', _seeders: 9 },
      ...hs.map((h, i) => ({ infoHash: h, name: `Common Cache 1988 Rip ${i}`, title: `Common Cache 1988 Rip ${i}`, _seeders: 8 - i })),
    ], [globalCached]);
    assert.equal(dStop(), 1, 'comum + cache: stop-has-cached preservado');
    assert.equal(dOver(), 0, 'exceção não é usada fora do regime raro');
    assert.deepEqual(harness.enqueued, [], 'nenhum download com a exceção desligada');
  } finally {
    harness.cleanup();
    autofetchLive.reset();
    rareRestore();
    releaseAll(harness, [globalCached, ...hs]);
  }
});

test('seeds: dublado em cache continua stop-has-br mesmo em título raro', async () => {
  autofetchLive.set({ ...LIVE_KNOBS });
  withRare(4, 6);
  const harness = seedsHarness('seeds-rare-dubcached');
  const dubbedCached = 'm1'.repeat(20);
  const hs = ['m2', 'm3', 'm4'].map((p) => p.repeat(20));
  try {
    const dBr = deltaOf('autofetch.skip.stop-has-br');
    const dOver = deltaOf('autofetch.seeds.rareOverCached');
    await runSearchCached(harness, [
      { infoHash: dubbedCached, name: 'Rare Dub 1988 Dual', title: 'Rare Dub 1988 Dual', _seeders: 2, _dubbed: true },
      ...hs.map((h, i) => ({ infoHash: h, name: `Rare Dub 1988 Rip ${i}`, title: `Rare Dub 1988 Rip ${i}`, _seeders: 2 - i })),
    ], [dubbedCached]);
    assert.equal(dBr(), 1, 'dublado ⚡ em cache: stop-has-br');
    assert.equal(dOver(), 0);
    assert.deepEqual(harness.enqueued, []);
  } finally {
    harness.cleanup();
    autofetchLive.reset();
    rareRestore();
    releaseAll(harness, [dubbedCached, ...hs]);
  }
});

test('seeds: tudo cacheado — exceção usada, zero enqueue', async () => {
  autofetchLive.set({ ...LIVE_KNOBS });
  withRare(3, 6);
  const harness = seedsHarness('seeds-rare-allcached');
  const cached = ['n1', 'n2', 'n3', 'n4'].map((p) => p.repeat(20));
  try {
    const dOver = deltaOf('autofetch.seeds.rareOverCached');
    await runSearchCached(harness, cached.map((h, i) => (
      { infoHash: h, name: `All Cached 1988 Rip ${i}`, title: `All Cached 1988 Rip ${i}`, _seeders: 3 - (i % 3) })), cached);
    assert.equal(dOver(), 1, 'exceção usada (regime raro + cache não-dublado)');
    assert.deepEqual(harness.enqueued, [], 'todos cacheados: nenhum download');
  } finally {
    harness.cleanup();
    autofetchLive.reset();
    rareRestore();
    releaseAll(harness, cached);
  }
});

test('seeds: THRESHOLD=0 com cache segue stop-has-cached (exceção desligada)', async () => {
  autofetchLive.set({ ...LIVE_KNOBS });
  withRare(4, 0);
  const harness = seedsHarness('seeds-rareoff-overcached');
  const globalCached = 'o1'.repeat(20);
  const hs = ['o2', 'o3', 'o4'].map((p) => p.repeat(20));
  try {
    const dOver = deltaOf('autofetch.seeds.rareOverCached');
    const dStop = deltaOf('autofetch.skip.stop-has-cached');
    await runSearchCached(harness, [
      { infoHash: globalCached, name: 'Thresh Off 1988 Rip A', title: 'Thresh Off 1988 Rip A', _seeders: 3 },
      ...hs.map((h, i) => ({ infoHash: h, name: `Thresh Off 1988 Rip ${i}`, title: `Thresh Off 1988 Rip ${i}`, _seeders: 2 - i })),
    ], [globalCached]);
    assert.equal(dStop(), 1, 'threshold 0: portão antigo vale');
    assert.equal(dOver(), 0);
    assert.deepEqual(harness.enqueued, []);
  } finally {
    harness.cleanup();
    autofetchLive.reset();
    rareRestore();
    releaseAll(harness, [globalCached, ...hs]);
  }
});

test('seeds: raro — cacheado SÓ na fila é purgado mesmo sem imediato cacheado', async () => {
  // O gate recebe só a fatia IMEDIATA: sem imediato cacheado, o early return
  // antigo pulava a purga e o cacheado que ficou só na fila persistia. Strict
  // VAZIO (todos 1-2 seeders) é o regime que enche imediato + queueDepth:
  // universo 5 <= limiar 6, > RARE_MAX=3, melhor com 2 seeders → raro.
  autofetchLive.set({ ...LIVE_KNOBS, autoFetchTopSeedsMax: 1, autoFetchQueue: true, autoFetchQueueDepth: 3 });
  withRare(3, 6);
  const harness = seedsHarness('seeds-rare-queue-purge');
  const hs = ['a1', 'b2', 'c3', 'd4', 'e5'].map((p) => p.repeat(20)); // 40-hex válidos
  const streams = hs.map((h, i) => ({
    infoHash: h, name: `Queue Purge 1988 Rip ${i}`, title: `Queue Purge 1988 Rip ${i}`, _seeders: [2, 2, 2, 1, 1][i],
  }));
  try {
    const dOver = deltaOf('autofetch.seeds.rareOverCached');
    await runSearchCached(harness, streams, [hs[3]]);
    assert.equal(dOver(), 1, 'exceção raro-sobre-cache em uso');
    assert.deepEqual(harness.enqueued, [hs[0], hs[1], hs[2]], 'imediatos frios até RARE_MAX; cacheado nunca enfileirado');
    const queue = autofetch.readQueue(harness.searchKey).map((q: any) => String(q.infoHash).toLowerCase());
    assert.deepEqual(queue, [hs[4]], 'cacheado sai da fila; frio permanece; ordem útil preservada');
  } finally {
    harness.cleanup();
    autofetchLive.reset();
    rareRestore();
    autofetch.dropQueue(harness.searchKey);
    releaseAll(harness, hs);
  }
});

test('applySeedsStopGate: adapter sem cacheCheck não usa a exceção', () => {
  const cached = new Set(['c1']);
  const cand = [{ stream: { infoHash: 'c2' }, account: 'acc' }];
  const stop = applySeedsStopGate(cand, {
    rare: true, rareThreshold: 6, adapterCacheCheck: false, cached, hasCachedDubbed: false, queue: null,
  });
  assert.equal(stop.stop, 'stop-has-cached', 'sem cacheCheck EFETIVO a exceção não vale (RD só com ledger+oráculo ativos)');
  const fila = { searchKey: 'sq', ttl: 60, adapterId: 'premiumize', account: 'acc' };
  const comFila = applySeedsStopGate(cand, {
    rare: true, rareThreshold: 0, adapterCacheCheck: true, cached, hasCachedDubbed: false, queue: fila,
  });
  assert.equal(comFila.stop, 'stop-has-cached', 'threshold 0 no portão: exceção desligada');
});
