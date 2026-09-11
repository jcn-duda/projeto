import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import config from '../src/config.js';
import * as autofetch from '../src/providers/autofetch.js';
import * as autofetchLive from '../src/utils/autofetch-live.js';
import * as cache from '../src/utils/cache.js';
import * as held from '../src/debrid/protected.js';
import * as metrics from '../src/utils/metrics.js';
import {
  H1, H2, H3, H4, H5, H6, H7, H8, H9, API_KEY,
  pmAdapter, originalEnqueue, account, sleep, runEnqueue, delta, lastReason, resetSkipState, stubEnqueue,
} from './helpers/autofetch-skip-common.js';

test.before(() => {
  pmAdapter.enqueue = stubEnqueue;
  resetSkipState();
});

test.after(() => {
  pmAdapter.enqueue = originalEnqueue;
  resetSkipState();
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
