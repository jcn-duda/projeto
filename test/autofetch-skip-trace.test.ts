import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import config from '../src/config.js';
import * as runtime from '../src/runtime.js';
import * as autofetch from '../src/providers/autofetch.js';
import * as autofetchLive from '../src/utils/autofetch-live.js';
import * as metrics from '../src/utils/metrics.js';
import * as cache from '../src/utils/cache.js';
import * as held from '../src/debrid/protected.js';
import debrid from '../src/debrid/index.js';
import { accountScope } from '../src/utils/request-key.js';
import { enqueueAutofetch, autoFetchBrDubbed, autoFetchCandidates, autofetchRunnerStatus } from '../src/providers/autofetch-runner.js';
import { applyDebrid } from '../src/providers/index.js';
import { noteSkip, clearSkips } from '../src/providers/autofetch-gates.js';
import * as autofetchTrace from '../src/utils/autofetch-trace.js';
import type { DebridAdapter } from '../types/domain.js';

// Instrumentação da desistência do Chupim: cada portão do enqueueAutofetch
// conta `autofetch.skip.<motivo>` e registra no trace (hash anonimizado).

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// Hash próprio evita marker/lock de um teste poluir o seguinte.
const H1 = 'a'.repeat(40);
const H2 = 'b'.repeat(40);
const H3 = 'c'.repeat(40);
const H4 = 'd'.repeat(40);
const H5 = 'e'.repeat(40);
const H6 = 'f'.repeat(40);
const H7 = '0'.repeat(40);
const H8 = '1'.repeat(40);
const H9 = '2'.repeat(40);
const API_KEY = 'chave-integrada';

const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
const originalEnqueue = pmAdapter.enqueue;
let account: string;

const brDub = (h: string, extra: Record<string, unknown> = {}) => ({
  infoHash: h,
  name: 'Coringa Dublado 1080p',
  title: 'Coringa (2019) Dublado 1080p',
  _br: true,
  _dubbed: true,
  _quality: '1080p',
  ...extra,
});

const userOpts = (extra: Record<string, unknown> = {}) => ({
  ...runtime.defaults(),
  debridService: 'premiumize',
  debridApiKey: API_KEY,
  ...extra,
});

/** Enfileira um candidato BR direto, como o passe parcial/tardio faria. */
async function runEnqueue(h: string, opts: Record<string, unknown> = {}, request: Record<string, unknown> = {}) {
  const { cached: cachedList, ...rest } = request;
  const cached = new Set((cachedList as string[]) || []);
  return runtime.run({ opts: userOpts(opts), encoded: 'cfg' }, () =>
    enqueueAutofetch(
      { stream: brDub(h) as any, account, pool: 'br' },
      { cached, searchKey: `busca-${h.slice(0, 6)}`, ...rest },
    ),
  );
}

function delta(reason: string) {
  const key = `autofetch.skip.${reason}`;
  const before = metrics.snapshot().counters[key] || 0;
  return () => (metrics.snapshot().counters[key] || 0) - before;
}

function lastReason() {
  const recent = autofetchTrace.lastSkips(1);
  return recent.length ? recent[0].reason : null;
}

test.before(() => {
  account = accountScope(API_KEY);
  pmAdapter.enqueue = async (_apiKey: string, infoHash: string) => {
    void _apiKey;
    return infoHash.length > 0;
  };
  autofetchLive.reset();
  autofetch.resetAccountGate();
  autofetch.resetBudget();
  clearSkips();
});

test.after(() => {
  pmAdapter.enqueue = originalEnqueue;
  autofetchLive.reset();
  autofetch.resetAccountGate();
  autofetch.resetBudget();
  clearSkips();
});

test('skip paused: Chupim pausado libera o hold e deixa rastro', async () => {
  autofetchLive.setPaused(true);
  try {
    held.hold(H1, 600, account);
    const d = delta('paused');
    await runEnqueue(H1);
    assert.equal(d(), 1, 'contador autofetch.skip.paused');
    assert.equal(lastReason(), 'paused');
    assert.equal(held.isHeld(H1, account), false, 'hold liberado');
  } finally {
    autofetchLive.setPaused(false);
  }
});

test('skip dead: blacklist de 24h barra a retentativa e deixa rastro', async () => {
  autofetch.blacklist('premiumize', account, H2);
  try {
    held.hold(H2, 600, account);
    const d = delta('dead');
    await runEnqueue(H2);
    assert.equal(d(), 1);
    assert.equal(lastReason(), 'dead');
    assert.equal(held.isHeld(H2, account), false, 'hold liberado');
  } finally {
    cache.forget(autofetch.deadKey('premiumize', account, H2));
  }
});

test('skip already-cached: hash que já toca não enfileira e solta o hold', async () => {
  held.hold(H3, 600, account);
  const d = delta('already-cached');
  await runEnqueue(H3, {}, { cached: [H3] });
  assert.equal(d(), 1);
  assert.equal(lastReason(), 'already-cached');
  assert.equal(held.isHeld(H3, account), false, 'hold liberado');
});

test('skip marker: marcador de 6h barra retentativa e libera o hold recém-criado', async () => {
  held.hold(H4, 600, account);
  cache.set(autofetch.markerKey('premiumize', account, H4), 1, 600);
  try {
    const d = delta('marker');
    await runEnqueue(H4);
    assert.equal(d(), 1);
    assert.equal(lastReason(), 'marker');
    // H2: o hold novo sai; o enqueue anterior já é dono do download/marker.
    // Retê-lo só estendia a proteção de um hash órfão do recheck/restart.
    assert.equal(held.isHeld(H4, account), false, 'hold recém-criado liberado');
  } finally {
    cache.forget(autofetch.markerKey('premiumize', account, H4));
  }
});

test('skip in-flight: lock em voo barra sem soltar o hold', async () => {
  held.hold(H5, 600, account);
  const lockKey = autofetch.markerKey('premiumize', account, H5);
  assert.equal(autofetch.acquire(lockKey), true);
  try {
    const d = delta('in-flight');
    await runEnqueue(H5);
    assert.equal(d(), 1);
    assert.equal(lastReason(), 'in-flight');
    assert.equal(held.isHeld(H5, account), true, 'hold retido (download em voo)');
  } finally {
    autofetch.release(lockKey);
  }
});

test('skip search-slot-busy: vaga da busca esgotada solta lock e hold', async () => {
  const searchKey = 'busca-slot-cheia';
  const max = autofetchLive.effective().autoFetchMax || 4;
  // A vaga é contada contra o LIMITE DA CHAMADA (acquireSearchSlot não guarda o
  // limit no registro), então esgotar exige consumir `max` vagas — o mesmo max
  // que o runner usará no trySlot.
  for (let i = 0; i < max; i += 1) {
    assert.equal(autofetch.acquireSearchSlot(searchKey, max), true);
  }
  held.hold(H6, 600, account);
  const locksBefore = autofetch.snapshot().pendingLocks;
  try {
    const d = delta('search-slot-busy');
    await runEnqueue(H6, {}, { searchKey });
    assert.equal(d(), 1);
    assert.equal(lastReason(), 'search-slot-busy');
    assert.equal(autofetch.snapshot().pendingLocks, locksBefore, 'lock liberado');
    assert.equal(held.isHeld(H6, account), false, 'hold liberado');
  } finally {
    autofetch.releaseSearchSlot(searchKey);
  }
});

test('skip account-gate: conta cheia (memo quente) barra e conta os DOIS contadores', async () => {
  const originalPauseAt = config.debrid.autoFetchPauseAt;
  const originalStatus = pmAdapter.accountStatus;
  try {
    config.debrid.autoFetchPauseAt = 2;
    autofetch.resetAccountGate();
    pmAdapter.accountStatus = async () => ({ magnets: 900 });
    assert.equal(autofetch.accountGateBlocked(pmAdapter, API_KEY), false, 'memo frio é fail-open');
    await sleep(20);
    assert.equal(autofetch.accountGateBlocked(pmAdapter, API_KEY), true, 'memo quente bloqueia');

    held.hold(H7, 600, account);
    const d = delta('account-gate');
    const legacyKey = 'autofetch.account-gated';
    const legacyBefore = metrics.snapshot().counters[legacyKey] || 0;
    await runEnqueue(H7);
    assert.equal(d(), 1);
    assert.equal(
      (metrics.snapshot().counters[legacyKey] || 0) - legacyBefore,
      1,
      'contador legado autofetch.account-gated continua existindo',
    );
    assert.equal(lastReason(), 'account-gate');
    assert.equal(held.isHeld(H7, account), false, 'hold liberado');
  } finally {
    config.debrid.autoFetchPauseAt = originalPauseAt;
    pmAdapter.accountStatus = originalStatus;
    autofetch.resetAccountGate();
  }
});

test('skip budget: orçamento horário esgotado barra e libera lock/slot/hold', async () => {
  (pmAdapter as any).enqueueHourlyLimit = 1;
  try {
    assert.equal(autofetch.checkAndRecordBudget('premiumize', account, 1), true, 'primeira vaga ok');
    held.hold(H8, 600, account);
    const d = delta('budget');
    await runEnqueue(H8);
    assert.equal(d(), 1);
    assert.equal(lastReason(), 'budget');
    assert.equal(held.isHeld(H8, account), false, 'hold liberado');
  } finally {
    (pmAdapter as any).enqueueHourlyLimit = undefined;
    autofetch.resetBudget();
  }
});

test('caminho positivo: enfileira sem contar nenhum skip (instrumentação não falseia sucesso)', async () => {
  const keys = ['paused', 'dead', 'already-cached', 'marker', 'in-flight', 'search-slot-busy', 'account-gate', 'budget'];
  const before: Record<string, number> = {};
  for (const k of keys) before[k] = metrics.snapshot().counters[`autofetch.skip.${k}`] || 0;
  const enqueuedBefore = metrics.snapshot().counters['autofetch.enqueued'] || 0;
  const enqueued: string[] = [];
  const original = pmAdapter.enqueue;
  pmAdapter.enqueue = async (_apiKey: string, infoHash: string) => {
    enqueued.push(infoHash);
    return true;
  };
  try {
    const ret = await runEnqueue(H9, {}, { searchKey: 'busca-positiva' });
    assert.equal(ret, true);
    await sleep(20);
    assert.deepEqual(enqueued, [H9]);
    assert.equal((metrics.snapshot().counters['autofetch.enqueued'] || 0) - enqueuedBefore, 1);
    for (const k of keys) {
      assert.equal(metrics.snapshot().counters[`autofetch.skip.${k}`] || 0, before[k], `skip.${k} não pode contar no sucesso`);
    }
  } finally {
    pmAdapter.enqueue = original;
  }
});

test('autoFetchBrDubbed deixa rastro nas desistências de lista', async () => {
  const cand = (h: string) => ({ stream: brDub(h) as any, account, pool: 'br' });
  const run = (fn: () => unknown) => runtime.run({ opts: userOpts(), encoded: 'cfg' }, fn);

  let d = delta('unknown-cache');
  await run(() => autoFetchBrDubbed([brDub(H1) as any], [cand(H1)], { cached: new Set(), known: false, searchKey: 'k1' }));
  assert.equal(d(), 1, 'unknown-cache');
  assert.equal(lastReason(), 'unknown-cache');

  // stop-has-br: outro BR do pool já cacheado — o Chupim para antes do candidato.
  d = delta('stop-has-br');
  await run(() => autoFetchBrDubbed([brDub(H1) as any, brDub(H2) as any], [cand(H1)], { cached: new Set([H2]), known: true, searchKey: 'k2' }));
  assert.equal(d(), 1, 'stop-has-br');
  assert.equal(lastReason(), 'stop-has-br');

  d = delta('no-candidates');
  await run(() => autoFetchBrDubbed([], [], { cached: new Set(), known: true, searchKey: 'k3' }));
  assert.equal(d(), 1, 'no-candidates');
});

test('autoFetchCandidates deixa rastro em disabled e no-candidate', async () => {
  const run = (opts: Record<string, unknown>, fn: () => unknown) =>
    runtime.run({ opts: userOpts(opts), encoded: 'cfg' }, fn);

  let d = delta('disabled');
  await run({ autoFetchBr: false }, () => autoFetchCandidates([brDub(H1) as any], { searchKey: 'kd' }));
  assert.equal(d(), 1, 'disabled');

  d = delta('no-candidate');
  await run({}, () => autoFetchCandidates([], { searchKey: 'kn' }));
  assert.equal(d(), 1, 'no-candidate');
});

test('kill-switch AUTOFETCH_TRACE=false: contador continua, ring fica vazio após 1000 chamadas', async () => {
  const original = config.debrid.autoFetchTrace;
  try {
    config.debrid.autoFetchTrace = false;
    autofetchTrace.clear();
    const d = delta('dead');
    for (let i = 0; i < 1000; i += 1) {
      noteSkip('dead', brDub(H1) as any, 'premiumize', 'br');
    }
    assert.equal(d(), 1000, 'contador conta mesmo com trace desligado');
    assert.deepEqual(autofetchTrace.lastSkips(), [], 'ring vazio com kill-switch desligado');
  } finally {
    config.debrid.autoFetchTrace = original;
  }
});

test('rótulo com magnet e hash 40-hex sai sanitizado no trace', async () => {
  const magnet = `Coringa magnet:?xt=urn:btih:${'b'.repeat(40)}&dn=Coringa%202019`;
  const bare = `Coringa ${'c'.repeat(40)} 1080p`;
  noteSkip('marker', brDub(H1, { title: magnet }) as any, 'torbox', 'br');
  noteSkip('marker', brDub(H1, { title: bare }) as any, 'torbox', 'br');
  const recent = autofetchTrace.lastSkips(5);
  assert.equal(recent[0].label, 'Coringa <magnet>', 'URI inteira do magnet vira <magnet>');
  assert.equal(recent[1].label, 'Coringa <hash> 1080p', '40-hex fora de magnet vira <hash>');
});

test('payload do status não expõe hash cru, searchKey, magnet nem apiKey', async () => {
  autofetchTrace.clear();
  await runEnqueue(H1, {}, { cached: [H1], searchKey: 'busca-secreta-1' });
  await runEnqueue(H2, {}, { cached: [H2], searchKey: 'busca-secreta-2' });
  noteSkip('dead', brDub(H3, { title: `Filme magnet:?xt=urn:btih:${'d'.repeat(40)}` }) as any, 'torbox', 'br');
  const body = JSON.stringify(autofetchRunnerStatus());
  assert.doesNotMatch(body, /[a-f0-9]{40}/i, 'nenhum infoHash cru no payload');
  assert.doesNotMatch(body, /magnet:/i, 'nenhum magnet cru');
  assert.equal(body.includes('busca-secreta'), false, 'nenhum searchKey cru');
  assert.equal(body.includes(API_KEY), false, 'nenhuma apiKey');
  const skips = autofetchRunnerStatus().skips;
  assert.equal(typeof skips, 'object');
  assert.ok(Array.isArray(autofetchRunnerStatus().lastSkips));
});

test('H2: settle expirado apaga o marcador junto do torrent (sem esperar o TTL)', async () => {
  // Discrimina mantendo o marker (6h) vivo além do horizonte do settle.
  const h = '3'.repeat(40);
  const searchKey = 'busca-settle-expira';
  const originalEnqueue = pmAdapter.enqueue;
  const originalTorrentStatus = pmAdapter.torrentStatus;
  const originalRemoveTorrent = pmAdapter.removeTorrent;
  const originalCheck = debrid.checkCached;
  const originalTtl = config.debrid.autoFetchTtl;
  const originalRecheckMs = config.debrid.autoFetchRecheckMs;
  const originalRecheckMax = config.debrid.autoFetchRecheckMax;
  const originalSettleMs = config.debrid.autoFetchSettleMs;
  const originalStall = config.debrid.autoFetchStallStreak;
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  try {
    config.debrid.autoFetchRecheckMs = 1000;
    config.debrid.autoFetchRecheckMax = 1;
    config.debrid.autoFetchSettleMs = 1000;
    config.debrid.autoFetchStallStreak = 0;
    pmAdapter.enqueue = async () => true;
    pmAdapter.torrentStatus = async () => ({ [h]: { state: 'downloading', id: 99 } });
    pmAdapter.removeTorrent = async () => true;
    debrid.checkCached = async () => ({ cached: new Set(), known: true });

    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    // O settle encolhe só depois do marker nascer com TTL 6h.
    config.debrid.autoFetchTtl = 3600;
    await runtime.run({ opts: userOpts(), encoded: 'cfg-settle' }, () =>
      applyDebrid([brDub(h) as any], { searchKey } as any),
    );
    await flush();
    const markerKey = autofetch.markerKey('premiumize', account, h);
    assert.equal(cache.get(markerKey), 1, 'enqueue aceito grava o marcador');

    config.debrid.autoFetchTtl = 2;
    // 1º recheck (vira settle) + 1º settle com idade >= TTL*1000.
    mock.timers.tick(1000);
    await flush();
    mock.timers.tick(1000);
    await flush();

    assert.equal(cache.get(markerKey), null, 'H2: marcador apagado no settle expirado');
    assert.equal(held.isHeld(h, account), false, 'hold liberado no settle expirado');
    assert.ok((metrics.snapshot().counters['autofetch.expired-unready'] || 0) >= 1);
  } finally {
    mock.timers.reset();
    config.debrid.autoFetchTtl = originalTtl;
    config.debrid.autoFetchRecheckMs = originalRecheckMs;
    config.debrid.autoFetchRecheckMax = originalRecheckMax;
    config.debrid.autoFetchSettleMs = originalSettleMs;
    config.debrid.autoFetchStallStreak = originalStall;
    debrid.checkCached = originalCheck;
    pmAdapter.enqueue = originalEnqueue;
    pmAdapter.torrentStatus = originalTorrentStatus;
    pmAdapter.removeTorrent = originalRemoveTorrent;
    cache.forget(autofetch.markerKey('premiumize', account, h));
    held.release(h, account);
    cache.forget(searchKey);
  }
});
