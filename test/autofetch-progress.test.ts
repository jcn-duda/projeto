// Fase 3 do Chupim 2.0 — derivação conservadora de parada por PROGRESSO.
// Sem rede: o módulo é puro sobre `statuses`; a integração usa o harness do
// autofetch e um stub de `torrentStatus`/`checkCached`.
//
// A política de settle da Fase 0 está PRESERVADA: entrar em settle não drena
// fila nenhuma. Só evidência comprovada (morto/parado nativo ou parada derivada
// por progresso) repõe uma cabeça.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

import * as autofetch from '../src/providers/autofetch.js';
import autofetchLive from '../src/utils/autofetch-live.js';
import { recheckLots, runRecheck } from '../src/providers/autofetch-recheck.js';
import { manageSettleLru } from '../src/providers/autofetch-settle.js';
import {
  deriveStall, forgetProgress, forgetLotProgress, progressMemorySize,
} from '../src/providers/autofetch-progress.js';
import debrid from '../src/debrid/index.js';
import config from '../src/config.js';
import * as held from '../src/debrid/protected.js';
import * as cache from '../src/utils/cache.js';
import * as metrics from '../src/utils/metrics.js';
import * as suppressed from '../src/providers/autofetch-suppressed.js';
import { accountScope } from '../src/utils/request-key.js';
import type { DebridAdapter, TorrentStatusEntry } from '../types/domain.js';
import {
  flush, sleep, brDubCandidate, makeDrainHarness, autofetchUserOpts,
} from './helpers/autofetch-fixtures.js';

const H = 'a1'.repeat(20);

type StatusMap = Record<string, TorrentStatusEntry>;
const progress = (
  bytes: number,
  opts: { speed?: number; seeders?: number; total?: number; id?: number; state?: TorrentStatusEntry['state'] } = {},
): StatusMap => ({
  [H]: {
    state: opts.state ?? 'downloading',
    id: opts.id ?? 1,
    progress: {
      bytes,
      total: opts.total ?? 1_000_000,
      speed: opts.speed ?? 0,
      seeders: opts.seeders ?? 2,
    },
  },
});

// --- derivação pura ---------------------------------------------------------

test('bytes crescendo nunca marca, mesmo com seeders 0', () => {
  const lot = { adapterId: 'prog-grow', account: 'acc', hashes: [H], threshold: 3 };
  for (let i = 0; i < 6; i += 1) {
    const r = deriveStall(lot, progress(1000 + i * 100, { speed: 0, seeders: 0 }));
    assert.equal(r.stalled.size, 0, `leitura ${i} com bytes crescendo não marca`);
    assert.equal(r.signals, 1);
  }
  forgetProgress(lot.adapterId, lot.account, H);
});

test('speed positiva zera o streak mesmo com seeders 0 e bytes parados', () => {
  const lot = { adapterId: 'prog-speed', account: 'acc', hashes: [H], threshold: 2 };
  // Bytes SEMPRE parados; a velocidade positiva é movimento. `seeders:0` não
  // sobrepõe a velocidade.
  for (let i = 0; i < 6; i += 1) {
    assert.equal(deriveStall(lot, progress(500, { speed: 42, seeders: 0 })).stalled.size, 0);
  }
  forgetProgress(lot.adapterId, lot.account, H);
});

test('parado N vezes consecutivas marca a partir do limiar', () => {
  const lot = { adapterId: 'prog-stop', account: 'acc', hashes: [H], threshold: 3 };
  // 1ª leitura = baseline; depois 1, 2 e 3 observações paradas.
  assert.equal(deriveStall(lot, progress(500)).stalled.size, 0, 'baseline');
  assert.equal(deriveStall(lot, progress(500)).stalled.size, 0, 'streak 1 < 3');
  assert.equal(deriveStall(lot, progress(500)).stalled.size, 0, 'streak 2 < 3');
  assert.equal(deriveStall(lot, progress(500)).stalled.size, 1, 'streak 3 = limiar');
  forgetProgress(lot.adapterId, lot.account, H);
});

test('threshold 0 desliga a derivação por inteiro', () => {
  const lot = { adapterId: 'prog-off', account: 'acc', hashes: [H], threshold: 0 };
  for (let i = 0; i < 5; i += 1) {
    assert.equal(deriveStall(lot, progress(500)).stalled.size, 0);
  }
  forgetProgress(lot.adapterId, lot.account, H);
});

test('campos ausentes, total 0 e progress ausente = sem sinal (memória intacta)', () => {
  const lot = { adapterId: 'prog-absent', account: 'acc', hashes: [H], threshold: 1 };
  const base = progressMemorySize();
  const semProgress: StatusMap = { [H]: { state: 'downloading', id: 1 } };
  const semProgressNativo: StatusMap = { [H]: { state: 'downloading', stalled: true, id: 1 } };
  const totalZero: StatusMap = { [H]: { state: 'downloading', id: 1, progress: { bytes: 5, total: 0, speed: 0, seeders: 0 } } };
  const campoFaltando: StatusMap = { [H]: { state: 'downloading', id: 1, progress: { bytes: 5, total: 100, speed: Number.NaN, seeders: 0 } } };
  for (const mapa of [semProgress, semProgressNativo, totalZero, campoFaltando]) {
    for (let i = 0; i < 4; i += 1) {
      const r = deriveStall(lot, mapa);
      assert.equal(r.stalled.size, 0, 'sem progresso válido nenhuma parada é derivada');
      assert.equal(r.signals, 0);
    }
  }
  assert.equal(progressMemorySize(), base, 'sem sinal não cria memória');
});

test('bytes >= total e state != downloading não são sinal', () => {
  const lot = { adapterId: 'prog-invalid', account: 'acc', hashes: [H], threshold: 1 };
  const base = progressMemorySize();
  const completo: StatusMap = { [H]: { state: 'downloading', id: 1, progress: { bytes: 1000, total: 1000, speed: 0, seeders: 0 } } };
  const acima: StatusMap = { [H]: { state: 'downloading', id: 1, progress: { bytes: 1200, total: 1000, speed: 0, seeders: 0 } } };
  const porState: Array<[TorrentStatusEntry['state'], StatusMap]> = [
    ['unknown', { [H]: { state: 'unknown', id: 1, progress: { bytes: 10, total: 1000, speed: 0, seeders: 0 } } }],
    ['ready', { [H]: { state: 'ready', id: 1, progress: { bytes: 10, total: 1000, speed: 0, seeders: 0 } } }],
    ['dead', { [H]: { state: 'dead', id: 1, progress: { bytes: 10, total: 1000, speed: 0, seeders: 0 } } }],
  ];
  for (const [label, mapa] of porState) {
    for (let i = 0; i < 3; i += 1) {
      assert.equal(deriveStall(lot, mapa).stalled.size, 0, `state ${label} não marca`);
    }
  }
  for (const mapa of [completo, acima]) {
    for (let i = 0; i < 3; i += 1) {
      const r = deriveStall(lot, mapa);
      assert.equal(r.stalled.size, 0);
      assert.equal(r.signals, 0);
    }
  }
  assert.equal(progressMemorySize(), base);
});

test('regressão de bytes e troca da transferência reiniciam a janela (sem sinal)', () => {
  const lot = { adapterId: 'prog-reset', account: 'acc', hashes: [H], threshold: 2 };
  assert.equal(deriveStall(lot, progress(1000, { id: 1 })).stalled.size, 0, 'baseline');
  assert.equal(deriveStall(lot, progress(1000, { id: 1 })).stalled.size, 0, 'streak 1');
  assert.equal(deriveStall(lot, progress(400, { id: 1 })).stalled.size, 0, 'regressão zera');
  assert.equal(deriveStall(lot, progress(400, { id: 1 })).stalled.size, 0, 'streak 1 de novo');
  assert.equal(deriveStall(lot, progress(400, { id: 2 })).stalled.size, 0, 'id novo = baseline');
  assert.equal(deriveStall(lot, progress(400, { id: 2 })).stalled.size, 0, 'streak 1 no id novo');
  assert.equal(deriveStall(lot, progress(400, { id: 2 })).stalled.size, 1, 'streak 2 no id novo');
  forgetProgress(lot.adapterId, lot.account, H);
});

test('memória é limpa por hash e por lote (fim de lote não herda streak)', () => {
  const lot = { adapterId: 'prog-mem', account: 'acc', hashes: [H], threshold: 3 };
  const base = progressMemorySize();
  deriveStall(lot, progress(100));
  assert.equal(progressMemorySize(), base + 1, 'estado criado');
  forgetProgress(lot.adapterId, lot.account, H);
  assert.equal(progressMemorySize(), base, 'forgetProgress limpa');
  deriveStall(lot, progress(100));
  forgetLotProgress(lot.adapterId, lot.account, [H]);
  assert.equal(progressMemorySize(), base, 'forgetLotProgress limpa');
  const r = deriveStall(lot, progress(100));
  assert.equal(r.stalled.size, 0, 'sem streak residual');
  forgetProgress(lot.adapterId, lot.account, H);
});

// --- LRU de settle: adapter do PRÓPRIO lote --------------------------------

test('evicção do LRU limpa a memória com o adapter do lote (lote misto)', () => {
  const chaveA = 'chave-lru-a';
  const chaveB = 'chave-lru-b';
  const accountA = accountScope(chaveA);
  const accountB = accountScope(chaveB);
  const lotA = { adapterId: 'adapter-a', account: accountA, hashes: [H], threshold: 2 };
  const lotB = { adapterId: 'adapter-b', account: accountB, hashes: [H], threshold: 2 };
  const originalMax = config.debrid.autoFetchSettleMaxLots;
  const originalNow = Date.now();
  const base = progressMemorySize();
  try {
    config.debrid.autoFetchSettleMaxLots = 1;
    deriveStall(lotA, progress(500)); // memória de A (lote mais antigo)
    deriveStall(lotB, progress(500)); // memória de B (lote mais novo)
    assert.equal(progressMemorySize(), base + 2, 'as duas memórias criadas');
    const lots = new Map<string, any>([
      ['a', { isSettle: true, createdAt: originalNow - 10_000, timer: null, ctx: { opts: { debridApiKey: chaveA }, encoded: 'a' }, hashes: new Set([H]), adapterId: 'adapter-a' }],
      ['b', { isSettle: true, createdAt: originalNow, timer: null, ctx: { opts: { debridApiKey: chaveB }, encoded: 'b' }, hashes: new Set([H]), adapterId: 'adapter-b' }],
    ]);
    manageSettleLru(lots);
    assert.equal(lots.has('a'), false, 'lote mais antigo evictado');
    assert.equal(lots.has('b'), true, 'lote mais novo preservado');
    assert.equal(progressMemorySize(), base + 1, 'só a memória do lote evictado saiu');
    // B manteve a janela: as duas leituras paradas seguintes fecham o limiar.
    assert.equal(deriveStall(lotB, progress(500)).stalled.size, 0, 'B streak 1');
    assert.equal(deriveStall(lotB, progress(500)).stalled.size, 1, 'B mantém a memória');
    // A voltou a ser baseline (memória limpa).
    assert.equal(deriveStall(lotA, progress(500)).stalled.size, 0, 'A baseline');
  } finally {
    config.debrid.autoFetchSettleMaxLots = originalMax;
    forgetProgress('adapter-a', accountA, H);
    forgetProgress('adapter-b', accountB, H);
    for (const h of [H]) { held.release(h, accountA); held.release(h, accountB); }
  }
});

test('evicção com adapterId vazio não quebra e descarta o lote', () => {
  const originalMax = config.debrid.autoFetchSettleMaxLots;
  const base = progressMemorySize();
  try {
    config.debrid.autoFetchSettleMaxLots = 0;
    const lots = new Map<string, any>([
      ['x', { isSettle: true, createdAt: 1, timer: null, ctx: null, hashes: new Set([H]), adapterId: '' }],
    ]);
    manageSettleLru(lots);
    assert.equal(lots.size, 0, 'lote sem adapter ainda é descartado');
    assert.equal(progressMemorySize(), base, 'sem chave inventada, nada a limpar');
  } finally {
    config.debrid.autoFetchSettleMaxLots = originalMax;
  }
});

// --- settle conservador -----------------------------------------------------

const seedsCandidate = (h: string, seeds: number) => ({
  infoHash: h, name: 'Coringa 1080p BluRay', title: 'Coringa 1080p BluRay',
  _br: false, _dubbed: false, _quality: '1080p', _seeders: seeds,
  _size: 2 * 1024 ** 3,
});

test('lote SEM progresso entra em settle e NÃO drena (política F0 preservada)', async () => {
  autofetchLive.reset();
  const h = makeDrainHarness('prog-settle-nosignal-x', { recheckMax: 2 });
  const hBr = 'f3'.repeat(20);
  const hSeed = 'f4'.repeat(20);
  try {
    mock.timers.enable({ apis: ['setTimeout'] });
    h.setTorrentStatus(async () => ({ [hBr]: { state: 'downloading', id: 62 } }));
    await h.run([seedsCandidate(hSeed, 500), brDubCandidate(hBr, { _quality: '1080p', _seeders: 5 })]);
    assert.deepEqual(h.enqueued, [hBr], 'só o BR primário na abertura');
    mock.timers.tick(120_000);
    await flush();
    mock.timers.tick(120_000);
    await flush();
    assert.equal(recheckLots.get(h.searchKey)?.isSettle, true, 'lote em settle');
    assert.deepEqual(h.enqueued, [hBr], 'settle sem sinal NÃO drena');
    mock.timers.tick(900_000);
    await flush();
    assert.deepEqual(h.enqueued, [hBr], 'ciclo de settle seguinte também não drena');
    assert.equal(autofetch.readQueue(h.searchKey).length, 1, 'fallback preservado na fila');
  } finally {
    mock.timers.reset();
    h.cleanup([hBr, hSeed]);
  }
});

// --- AllDebrid: settle nunca drena, colapso derivado drena ------------------

type AllDebridStub = {
  ad: DebridAdapter;
  enqueued: string[];
  removals: () => number;
  restore: () => void;
};

function stubAllDebrid(): AllDebridStub {
  const ad = debrid.BY_ID.get('alldebrid') as DebridAdapter;
  const saved = { enqueue: ad.enqueue, torrentStatus: ad.torrentStatus, removeTorrent: ad.removeTorrent };
  const enqueued: string[] = [];
  let removals = 0;
  ad.enqueue = async (_k: string, hash: string) => { enqueued.push(hash); return true; };
  ad.removeTorrent = async () => { removals += 1; return true; };
  return {
    ad, enqueued, removals: () => removals,
    restore() { ad.enqueue = saved.enqueue; ad.torrentStatus = saved.torrentStatus; ad.removeTorrent = saved.removeTorrent; },
  };
}

function cleanupAllDebrid(searchKey: string, account: string, hashes: string[], service = 'alldebrid') {
  const lote = recheckLots.get(searchKey);
  if (lote?.timer) clearTimeout(lote.timer);
  recheckLots.delete(searchKey);
  autofetch.releaseSearch(searchKey);
  autofetch.dropQueue(searchKey);
  autofetch.resetBudget(service, account);
  for (const h of hashes) {
    forgetProgress(service, account, h);
    cache.forget(autofetch.deadKey(service, account, h));
    cache.forget(autofetch.markerKey(service, account, h));
    held.release(h, account);
    suppressed.forgetSuppressed(service, account, h);
  }
}

for (const mode of ['saudavel', 'degradado', 'timeout'] as const) {
  test(`AllDebrid ${mode}: entra em settle e NÃO drena`, async () => {
    autofetchLive.reset();
    const originalCheck = debrid.checkCached;
    const originalStall = config.debrid.autoFetchStallStreak;
    const originalRecheckMax = config.debrid.autoFetchRecheckMax;
    const stub = stubAllDebrid();
    const chave = `chave-ad-settle-${mode}`;
    const account = accountScope(chave);
    const searchKey = `busca-ad-settle-${mode}`;
    const hBr = `b${mode.length}`.repeat(20);
    const hSeed = `c${mode.length}`.repeat(20);
    const userOpts = autofetchUserOpts(chave, 'alldebrid');
    let reads = 0;
    try {
      config.debrid.autoFetchStallStreak = 2;
      config.debrid.autoFetchRecheckMax = 1;
      stub.ad.torrentStatus = async () => {
        if (mode === 'degradado') throw new Error('torrentStatus fora do ar');
        if (mode === 'timeout') return {};
        reads += 1;
        return { [hBr]: { state: 'downloading', id: 71, via: 'id', progress: { bytes: reads * 1000, total: 1e9, speed: 500, seeders: 5 } } };
      };
      debrid.checkCached = async () => ({ cached: new Set(), known: true });
      autofetch.resetBudget('alldebrid', account);
      autofetch.writeQueue(searchKey, [{
        infoHash: hSeed, title: 'Seed 1080p', pool: 'seeds', quality: '1080p', seeders: 500, _size: 2 * 1024 ** 3,
      }], 3600, 'alldebrid', account);
      recheckLots.set(searchKey, {
        hashes: new Set([hBr]), attempts: 0, timer: null, inFlight: false,
        ctx: { opts: userOpts, encoded: `cfg-ad-${mode}` },
        deadStreak: new Map(), stallStreak: new Map(), seasonHints: new Map(),
        createdAt: Date.now(), isSettle: false, refusals: 0, adapterId: 'alldebrid',
      });
      runRecheck(searchKey);
      await sleep(30);
      assert.equal(recheckLots.get(searchKey)?.isSettle, true, 'lote virou settle');
      assert.equal(stub.enqueued.length, 0, 'settle não drena');
      assert.equal(autofetch.readQueue(searchKey).length, 1, 'fallback preservado');
    } finally {
      config.debrid.autoFetchStallStreak = originalStall;
      config.debrid.autoFetchRecheckMax = originalRecheckMax;
      debrid.checkCached = originalCheck;
      stub.restore();
      cleanupAllDebrid(searchKey, account, [hBr, hSeed]);
    }
  });
}

test('AllDebrid com progress: parada derivada colapsa, represa e drena sem remoção direta', async () => {
  autofetchLive.reset();
  const originalCheck = debrid.checkCached;
  const originalStall = config.debrid.autoFetchStallStreak;
  const originalRemoveById = config.debrid.removeById;
  const stub = stubAllDebrid();
  const chave = 'chave-prog-ad-x';
  const account = accountScope(chave);
  const searchKey = 'busca-prog-ad-x';
  const hBr = 'c1'.repeat(20);
  const hSeed = 'c2'.repeat(20);
  const stalledBefore = metrics.snapshot().counters['autofetch.progress.stalled'] || 0;
  const userOpts = autofetchUserOpts(chave, 'alldebrid');
  try {
    config.debrid.autoFetchStallStreak = 2;
    config.debrid.removeById = false;
    stub.ad.torrentStatus = async () => ({
      [hBr]: { state: 'downloading', id: 777, via: 'id', progress: { bytes: 1000, total: 1e9, speed: 0, seeders: 2 } },
    });
    debrid.checkCached = async () => ({ cached: new Set(), known: true });
    cache.forget(autofetch.deadKey('alldebrid', account, hBr));
    autofetch.resetBudget('alldebrid', account);
    autofetch.writeQueue(searchKey, [{
      infoHash: hSeed, title: 'Seed 1080p', pool: 'seeds',
      quality: '1080p', seeders: 500, _size: 2 * 1024 ** 3,
    }], 3600, 'alldebrid', account);
    recheckLots.set(searchKey, {
      hashes: new Set([hBr]), attempts: 0, timer: null, inFlight: false,
      ctx: { opts: userOpts, encoded: 'cfg-prog-ad-x' },
      deadStreak: new Map(), stallStreak: new Map(), seasonHints: new Map(),
      createdAt: Date.now(), isSettle: false, refusals: 0, adapterId: 'alldebrid',
    });
    // baseline + streak 1 + streak 2 (limiar): só a 3ª passagem colapsa.
    for (let i = 0; i < 3; i += 1) { runRecheck(searchKey); await sleep(30); }
    assert.equal(autofetch.isDead('alldebrid', account, hBr), true, 'colapsa no limiar');
    assert.equal(stub.removals(), 0, 'derivado nunca remove direto com removeById=false');
    assert.equal(suppressed.listSuppressed('alldebrid', account).length, 1, 'vai para os represados');
    assert.ok(stub.enqueued.includes(hSeed), 'drena o fallback');
    assert.equal(autofetch.readQueue(searchKey).length, 0, 'fila consumida');
    assert.equal((metrics.snapshot().counters['autofetch.progress.stalled'] || 0) - stalledBefore, 1);
    // Memória limpa no colapso: reler o mesmo status volta a ser baseline.
    const relido = deriveStall({ adapterId: 'alldebrid', account, hashes: [hBr], threshold: 2 },
      { [hBr]: { state: 'downloading', id: 777, progress: { bytes: 1000, total: 1e9, speed: 0, seeders: 2 } } });
    assert.equal(relido.stalled.size, 0, 'sem streak residual');
  } finally {
    config.debrid.autoFetchStallStreak = originalStall;
    config.debrid.removeById = originalRemoveById;
    debrid.checkCached = originalCheck;
    stub.restore();
    cleanupAllDebrid(searchKey, account, [hBr, hSeed], 'alldebrid');
  }
});
