import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import * as runtime from '../src/runtime.js';
import * as autofetch from '../src/providers/autofetch.js';
import * as cache from '../src/utils/cache.js';
import * as held from '../src/debrid/protected.js';
import { createStreamTrace } from '../src/utils/stream-trace.js';
import { autoFetchBrDubbed, autoFetchCandidates } from '../src/providers/autofetch-runner.js';
import {
  H1, H2, H3, H4, H5, H6, H7, H8,
  pmAdapter, originalEnqueue, account, sleep, brDub, userOpts, delta, lastReason, resetSkipState, stubEnqueue,
} from './helpers/autofetch-skip-common.js';

test.before(() => {
  pmAdapter.enqueue = stubEnqueue;
  resetSkipState();
});

test.after(() => {
  pmAdapter.enqueue = originalEnqueue;
  resetSkipState();
});

test('autoFetchBrDubbed deixa rastro nas desistências de lista', async () => {
  const cand = (h: string) => ({ stream: brDub(h) as any, account, pool: 'br' });
  const run = (fn: () => unknown) => runtime.run({ opts: userOpts(), encoded: 'cfg' }, fn);

  let d = delta('unknown-cache');
  await run(() => autoFetchBrDubbed([brDub(H1) as any], [cand(H1)], { cached: new Set(), known: false, searchKey: 'k1' }));
  assert.equal(d(), 1, 'unknown-cache');
  assert.equal(lastReason(), 'unknown-cache');

  d = delta('stop-has-br');
  await run(() => autoFetchBrDubbed(
    [brDub(H1) as any, brDub(H2) as any], [cand(H1)],
    { cached: new Set([H2]), known: true, searchKey: 'k2' },
  ));
  assert.equal(d(), 1, 'stop-has-br same-quality');
  assert.equal(lastReason(), 'stop-has-br');

  d = delta('no-candidates');
  await run(() => autoFetchBrDubbed([], [], { cached: new Set(), known: true, searchKey: 'k3' }));
  assert.equal(d(), 1, 'no-candidates');
});

test('Event Horizon: gringo ⚡ não finge stop-has-br; BR dublado uncached enfileira', async () => {
  const remux = {
    infoHash: H3,
    name: 'Event Horizon 1997 2160p REMUX',
    title: 'Event Horizon 1997 2160p REMUX',
    _br: false,
    _dubbed: false,
    _quality: '2160p',
    _seeders: 90,
  };
  const seed = {
    infoHash: H4,
    name: 'Event Horizon 1080p BluRay',
    title: 'Event Horizon 1080p BluRay',
    _br: false,
    _dubbed: false,
    _quality: '1080p',
    _seeders: 40,
  };
  const dubbed = {
    infoHash: H5,
    name: 'Event Horizon Dual 1080p',
    title: 'Event Horizon Dual Audio 1080p',
    _br: false,
    _dubbed: true,
    _quality: '1080p',
  };
  const br = brDub(H6);
  const run = (fn: () => unknown) => runtime.run({ opts: userOpts({ showUncachedBr: false }), encoded: 'cfg' }, fn);
  const cachedGringo = new Set([H3]);

  const dHasBr = delta('stop-has-br');
  const dHasCached = delta('stop-has-cached');
  await run(() => autoFetchBrDubbed(
    [remux, seed] as any,
    [{ stream: seed as any, account, pool: 'seeds' }],
    { cached: cachedGringo, known: true, searchKey: 'eh-seeds' },
  ));
  assert.equal(dHasBr(), 0, 'pool seeds + REMUX ⚡ não é has-br');
  assert.equal(dHasCached(), 1, 'stop honesto: já tem qualquer ⚡');
  assert.equal(lastReason(), 'stop-has-cached');

  const enqueued: string[] = [];
  const original = pmAdapter.enqueue;
  pmAdapter.enqueue = async (_apiKey: string, infoHash: string) => {
    enqueued.push(infoHash);
    return true;
  };
  try {
    const skipAny = delta('stop-has-br');
    await run(() => autoFetchBrDubbed(
      [remux, dubbed] as any,
      [{ stream: dubbed as any, account, pool: 'any' }],
      { cached: cachedGringo, known: true, searchKey: 'eh-any' },
    ));
    await sleep(20);
    assert.equal(skipAny(), 0, 'any não aborta por gringo ⚡');
    assert.deepEqual(enqueued, [H5]);

    enqueued.length = 0;
    const skipBr = delta('stop-has-br');
    await run(() => autoFetchBrDubbed(
      [remux, br] as any,
      [{ stream: br as any, account, pool: 'br' }],
      { cached: cachedGringo, known: true, searchKey: 'eh-br' },
    ));
    await sleep(20);
    assert.equal(skipBr(), 0, 'BR uncached enfileira mesmo com remux ⚡ e bu=0');
    assert.deepEqual(enqueued, [H6]);
  } finally {
    pmAdapter.enqueue = original;
    for (const h of [H3, H4, H5, H6]) {
      cache.forget(autofetch.markerKey('premiumize', account, h));
      autofetch.release(autofetch.markerKey('premiumize', account, h));
      held.release(h, account);
    }
    autofetch.releaseSearch('eh-any');
    autofetch.releaseSearch('eh-br');
    autofetch.releaseSearch('eh-seeds');
  }
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

// Fase 7 do Chupim 2.0 — o resumo do autofetch viaja no trace da build. A
// captura é fire-and-forget: nunca muda o retorno nem bloqueia a seleção.
test('Fase 7: seleção e despacho gravam o resumo do Chupim no trace', async () => {
  const run = (opts: Record<string, unknown>, fn: () => unknown) =>
    runtime.run({ opts: userOpts(opts), encoded: 'cfg' }, fn);

  // Seleção com BR dublado: pool=br; o seeds nem é avaliado (n/a).
  const trBr = createStreamTrace();
  const outBr = await run({}, () => autoFetchCandidates([brDub(H7) as any], { searchKey: 'f7-br', trace: trBr }));
  assert.ok(Array.isArray(outBr), 'seleção continua síncrona com o trace ligado');
  assert.match(trBr.chupim || '', /pool=br/);
  assert.match(trBr.chupim || '', /seeds=n\/a/);
  assert.match(trBr.chupim || '', /probe=off/);
  held.release(H7, account);

  // Seleção sem candidato algum: a cascata chega ao seeds e o avalia, mas
  // nenhum pool produziu candidato → pool=none.
  const trNone = createStreamTrace();
  await run({}, () => autoFetchCandidates([], { searchKey: 'f7-none', trace: trNone }));
  assert.match(trNone.chupim || '', /pool=none/);
  assert.match(trNone.chupim || '', /seeds=allowed/);

  // Despacho do pool seeds com dubbedOnly: bloqueio por política, motivo curto.
  const trSeeds = createStreamTrace();
  await run({ dubbedOnly: true }, () => autoFetchBrDubbed(
    [brDub(H8) as any],
    [{ stream: brDub(H8) as any, account, pool: 'seeds' }],
    { cached: new Set(), known: true, searchKey: 'f7-seeds', trace: trSeeds },
  ));
  assert.match(trSeeds.chupim || '', /pool=seeds/);
  assert.match(trSeeds.chupim || '', /seeds=blocked:dubbed-only/);

  // Sem trace: nenhum efeito e o retorno segue sendo a lista de candidatos.
  const semTrace = autoFetchCandidates([], { searchKey: 'f7-notrace' });
  assert.ok(Array.isArray(semTrace), 'seleção sem trace continua síncrona');
});
