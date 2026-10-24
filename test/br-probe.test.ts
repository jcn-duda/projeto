// Fase 4 revisada do Chupim 2.0 — sonda dirigida. Sem rede real: a ponte com o
// colhedor nativo (`/harvest/enqueue`, `/harvest/pending`) é dublada e o
// `streams.db` tem dublê próprio. O worker, a fila, a prioridade e o dedupe de
// 12h são do gateway (`adom-server::harvest`, cobertos por `cargo test`); aqui
// se cobra o CONTRATO de estado/orquestração que sobrou no Node: pending
// bloqueia seeds de forma transitória, empty/capped/failed liberam, lease órfão
// expira e o toggle off não perde o br-gap.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import * as cache from '../src/utils/cache.js';
import config from '../src/config.js';
import * as brProbe from '../src/providers/br-probe.js';
import * as harvesterLive from '../src/utils/harvester-live.js';
import * as autofetchLive from '../src/utils/autofetch-live.js';
import * as autofetch from '../src/providers/autofetch.js';
import { takeDrainCandidate } from '../src/providers/autofetch-drain.js';
import { seedsSelectionBlock } from '../src/providers/autofetch-policy.js';
import * as runtime from '../src/runtime.js';
import { prefix as cachePrefix } from '../src/utils/cache-keys.js';
import { flushNativeStreamStores } from '../src/utils/streams-store-native.js';
import { resetHarvestBridgeForTests } from '../src/utils/harvest-native.js';
import { createStreamsBridge } from './helpers/streams-bridge.js';
import { enqueueCalls, settleProbe, stubHarvestBridge } from './helpers/harvest-bridge.js';

const MOVIE = { type: 'movie' as const, imdbId: 'tt0107953' };
const policy = { dubbedOnly: false, cachedOnly: true, maxSizeGb: 0, seedsMaxGb: 8, seedsMaxQuality: '1080p' };
const adapter = { id: 'premiumize', cacheCheck: true } as any;
// O dreno lê `opts()` — fora do contexto de request o default é dubbedOnly=true
// e o candidato seeds seria descartado por regra PERMANENTE, não deferido.
const userOpts = { ...runtime.defaults(), dubbedOnly: false, debridCachedOnly: true, autoFetchBr: false };
const runUser = <T>(fn: () => T): T => runtime.run({ opts: userOpts, encoded: 'sk-probe' }, fn) as T;

function setup() {
  const saved = {
    indexOnly: config.jackett.indexOnlyIndexers,
    ptBr: config.jackett.ptBrIndexers,
    releaseIndex: config.releaseIndex.enabled,
  };
  config.jackett.indexOnlyIndexers = ['idx-br', 'idx-glob'];
  config.jackett.ptBrIndexers = ['idx-br', 'site-br'];
  config.releaseIndex.enabled = true;
  autofetchLive.reset();
  harvesterLive.reset();
  cache.clearNamespace('autofetch');
  // `streams` é Rust-owned desde o F4.2(c): não há L1 a limpar aqui — cada
  // teste que olha a lista pronta sobe a ponte dublada.
  cache.clearNamespace('idx');
  resetHarvestBridgeForTests();
  return saved;
}

function restore(s: ReturnType<typeof setup>) {
  config.jackett.indexOnlyIndexers = s.indexOnly;
  config.jackett.ptBrIndexers = s.ptBr;
  config.releaseIndex.enabled = s.releaseIndex;
  autofetchLive.reset();
  harvesterLive.reset();
  resetHarvestBridgeForTests();
}

function writeSeedsQueue(searchKey: string) {
  autofetch.writeQueue(
    searchKey,
    [{ infoHash: 'a'.repeat(40), pool: 'seeds', imdbId: MOVIE.imdbId, quality: '1080p', size: 1_000_000_000 }] as any,
    3600,
    'premiumize',
    'acct',
  );
}

test('sonda agenda br-gap dirigido na ponte, grava pending e não duplica', async () => {
  const s = setup();
  const stub = stubHarvestBridge();
  try {
    const r1 = brProbe.requestBrProbe(MOVIE);
    assert.equal(r1.probe, true);
    assert.equal(r1.pending, true);
    assert.equal(r1.fallbackBrGap, false);
    assert.equal(brProbe.isBrProbePending(MOVIE), true);
    assert.equal(brProbe.probeBlocksSeeds(MOVIE), true);

    await settleProbe();
    const sent = enqueueCalls(stub);
    assert.equal(sent.length, 1, 'um pedido saiu para o gateway');
    const body = JSON.parse(String(sent[0].options?.body));
    assert.equal(body.imdbId, MOVIE.imdbId);
    assert.equal(body.type, 'movie');
    assert.equal(body.reason, 'br-gap');
    assert.equal(body.brProbe, true);

    const r2 = brProbe.requestBrProbe(MOVIE);
    assert.equal(r2.skipped, 'pending');
    assert.equal(enqueueCalls(stub).length, 1, 'duplicata não reenfileira');
  } finally {
    stub.restore();
    restore(s);
  }
});

test('pending bloqueia a SELEÇÃO de seeds e DEFERE o dreno sem purgar a fila', async () => {
  const s = setup();
  const stub = stubHarvestBridge();
  try {
    brProbe.requestBrProbe(MOVIE);
    await settleProbe();
    assert.equal(seedsSelectionBlock(policy, [], { brProbePending: true }), 'br-probe-pending');

    writeSeedsQueue('sk-probe');
    const pick = runUser(() => takeDrainCandidate('sk-probe', adapter, 'acct'));
    assert.equal(pick.next, null, 'dreno deferiu o seeds sob sonda pending');
    assert.equal(autofetch.readQueue('sk-probe').length, 1, 'fila seeds preservada, não purgada');
  } finally {
    autofetch.dropQueue('sk-probe');
    stub.restore();
    restore(s);
  }
});

test('empty libera seeds na hora e mantém o dedupe do estado', async () => {
  const s = setup();
  const stub = stubHarvestBridge();
  try {
    brProbe.requestBrProbe(MOVIE);
    await settleProbe();
    brProbe.finalizeBrProbe(MOVIE, 'empty');
    assert.equal(brProbe.isBrProbePending(MOVIE), false);
    assert.equal(brProbe.probeBlocksSeeds(MOVIE), false);
    assert.equal(brProbe.requestBrProbe(MOVIE).skipped, 'empty', 'dedupe do estado evita re-sondar');

    writeSeedsQueue('sk-empty');
    const pick = runUser(() => takeDrainCandidate('sk-empty', adapter, 'acct'));
    assert.ok(pick.next, 'seeds volta a drenar');
  } finally {
    autofetch.dropQueue('sk-empty');
    stub.restore();
    restore(s);
  }
});

test('pending órfão expira pelo lease e pode ser reagendado', async () => {
  const s = setup();
  const stub = stubHarvestBridge();
  try {
    brProbe.__setBrProbeRecordForTest(MOVIE, { state: 'pending', at: Date.now() - 1000, leaseUntil: Date.now() - 1 });
    assert.equal(brProbe.isBrProbePending(MOVIE), false, 'lease vencido não bloqueia para sempre');
    assert.equal(brProbe.requestBrProbe(MOVIE).pending, true, 'reagenda depois do órfão');
    await settleProbe();
  } finally {
    stub.restore();
    restore(s);
  }
});

test('toggle off não agenda nem bloqueia, mas o br-gap normal segue possível', () => {
  const s = setup();
  try {
    autofetchLive.set({ autoFetchBrProbe: false });
    const r = brProbe.requestBrProbe(MOVIE);
    assert.equal(r.probe, false);
    assert.equal(r.fallbackBrGap, true, 'chamador do índice mantém a rede de segurança');
    assert.equal(brProbe.isBrProbePending(MOVIE), false);
  } finally {
    restore(s);
  }
});

test('sem interseção ou sem RELEASE_INDEX a sonda não agenda e libera fallback', () => {
  const s = setup();
  try {
    config.jackett.ptBrIndexers = ['site-br'];
    const semIntersecao = brProbe.requestBrProbe(MOVIE);
    assert.equal(semIntersecao.skipped, 'no-intersection');
    assert.equal(semIntersecao.fallbackBrGap, true);

    config.jackett.ptBrIndexers = ['idx-br', 'site-br'];
    config.releaseIndex.enabled = false;
    const semIndice = brProbe.requestBrProbe(MOVIE);
    assert.equal(semIndice.skipped, 'release-index-off');
    assert.equal(brProbe.isBrProbePending(MOVIE), false);
  } finally {
    restore(s);
  }
});

test('capped (orçamento) libera seeds e não re-agenda na hora', async () => {
  const s = setup();
  const stub = stubHarvestBridge();
  try {
    brProbe.requestBrProbe(MOVIE);
    await settleProbe();
    brProbe.finalizeBrProbe(MOVIE, 'capped');
    assert.equal(brProbe.probeBlocksSeeds(MOVIE), false, 'quota não fica pending 12h');
    assert.equal(brProbe.requestBrProbe(MOVIE).skipped, 'retry', 'retry curto segura o martelo');
  } finally {
    stub.restore();
    restore(s);
  }
});

test('saída de pending invalida as listas em empty, failed e capped', async () => {
  const s = setup();
  const bridge = createStreamsBridge();
  try {
    for (const estado of ['empty', 'failed', 'capped'] as const) {
      const key = `${cachePrefix('streams')}movie:tt0107953:${estado}`;
      bridge.put({ type: 'movie', id: MOVIE.imdbId, key });
      brProbe.finalizeBrProbe(MOVIE, estado);
      await flushNativeStreamStores();
      assert.equal(bridge.has(key), false, `${estado} invalida a lista da obra`);
    }
  } finally {
    bridge.restore();
    restore(s);
  }
});

test('identidade de série é por episódio: pending do E2 não bloqueia o E3', async () => {
  const s = setup();
  const stub = stubHarvestBridge();
  try {
    const e2 = { type: 'series' as const, imdbId: 'tt0107953', season: 1, episode: 2 };
    const e3 = { type: 'series' as const, imdbId: 'tt0107953', season: 1, episode: 3 };
    assert.notEqual(brProbe.probeIdentity(e2), brProbe.probeIdentity(e3));
    assert.equal(brProbe.requestBrProbe(e2).pending, true);
    await settleProbe();
    assert.equal(brProbe.isBrProbePending(e2), true);
    assert.equal(brProbe.isBrProbePending(e3), false, 'a sonda do E2 não segura o E3');
  } finally {
    stub.restore();
    restore(s);
  }
});

test('preempção renova o lease do pending (não finaliza)', () => {
  const s = setup();
  try {
    brProbe.__setBrProbeRecordForTest(MOVIE, { state: 'pending', at: Date.now() - 1000, leaseUntil: Date.now() - 1 });
    assert.equal(brProbe.isBrProbePending(MOVIE), false, 'lease vencido');
    brProbe.noteBrProbePreempted(MOVIE);
    assert.equal(brProbe.isBrProbePending(MOVIE), true, 'preempção renova o lease');
  } finally {
    restore(s);
  }
});
