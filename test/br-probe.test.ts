// Fase 4 revisada do Chupim 2.0 — sonda dirigida. Sem rede real: o worker é
// exercitado com `jackett.search` dublado e o fetch stubado (mesmo padrão do
// index-only-harvest). O que se cobra é o CONTRATO de estado/orquestração:
// pending bloqueia seeds de forma transitória, empty/capped/failed liberam,
// lease órfão expira, dedupe não re-agenda e o toggle off não perde o br-gap.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import * as cache from '../src/utils/cache.js';
import config from '../src/config.js';
import * as brProbe from '../src/providers/br-probe.js';
import * as harvestQueue from '../src/providers/harvest-queue.js';
import harvester from '../src/providers/harvester.js';
import * as harvestWorker from '../src/providers/harvest-worker.js';
import * as harvesterLive from '../src/utils/harvester-live.js';
import * as autofetchLive from '../src/utils/autofetch-live.js';
import * as releaseIndex from '../src/utils/release-index.js';
import * as autofetch from '../src/providers/autofetch.js';
import { takeDrainCandidate } from '../src/providers/autofetch-drain.js';
import { seedsSelectionBlock } from '../src/providers/autofetch-policy.js';
import * as runtime from '../src/runtime.js';
import jackett from '../src/providers/jackett.js';
import debrid from '../src/debrid/index.js';
import { stubFetch } from './helpers/stub.js';
import { prefix as cachePrefix } from '../src/utils/cache-keys.js';
import { flushNativeStreamStores } from '../src/utils/streams-store-native.js';
import { createStreamsBridge } from './helpers/streams-bridge.js';

const A = 'a'.repeat(40);
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
    indexers: config.jackett.indexers,
    releaseIndex: config.releaseIndex.enabled,
    harvestEnabled: config.harvest.enabled,
    maxPerHour: config.harvest.maxPerHour,
    idleWindow: config.harvest.idleWindowMs,
    delay: config.harvest.indexerDelayMs,
    bludv: config.bludv.enabled,
    rdWarm: config.debrid.rdWarm.enabled,
  };
  config.jackett.indexOnlyIndexers = ['idx-br', 'idx-glob'];
  config.jackett.ptBrIndexers = ['idx-br', 'site-br'];
  config.releaseIndex.enabled = true;
  config.harvest.enabled = true;
  config.harvest.maxPerHour = 50;
  config.harvest.idleWindowMs = 0;
  config.harvest.indexerDelayMs = 0;
  config.bludv.enabled = false;
  config.debrid.rdWarm.enabled = false;
  autofetchLive.reset();
  harvesterLive.reset();
  cache.clearNamespace('harvest');
  cache.clearNamespace('autofetch');
  // `streams` é Rust-owned desde o F4.2(c): não há L1 a limpar aqui — cada
  // teste que olha a lista pronta sobe a ponte dublada.
  cache.clearNamespace('idx');
  harvester.clearQueue();
  return saved;
}

function restore(s: ReturnType<typeof setup>) {
  config.jackett.indexOnlyIndexers = s.indexOnly;
  config.jackett.ptBrIndexers = s.ptBr;
  config.jackett.indexers = s.indexers;
  config.releaseIndex.enabled = s.releaseIndex;
  config.harvest.enabled = s.harvestEnabled;
  config.harvest.maxPerHour = s.maxPerHour;
  config.harvest.idleWindowMs = s.idleWindow;
  config.harvest.indexerDelayMs = s.delay;
  config.bludv.enabled = s.bludv;
  config.debrid.rdWarm.enabled = s.rdWarm;
  autofetchLive.reset();
  harvesterLive.reset();
  harvester.clearQueue();
}

function writeSeedsQueue(searchKey: string) {
  autofetch.writeQueue(
    searchKey,
    [{ infoHash: A, pool: 'seeds', imdbId: MOVIE.imdbId, quality: '1080p', size: 1_000_000_000 }] as any,
    3600,
    'premiumize',
    'acct',
  );
}

test('sonda agenda br-gap dirigido, grava pending e não duplica', () => {
  const s = setup();
  try {
    const r1 = brProbe.requestBrProbe(MOVIE);
    assert.equal(r1.probe, true);
    assert.equal(r1.pending, true);
    assert.equal(r1.fallbackBrGap, false);
    const queued = harvestQueue.findQueued({ imdbId: MOVIE.imdbId, season: null, episode: null });
    assert.ok(queued, 'entrada dirigida na fila');
    assert.equal(queued.reason, 'br-gap');
    assert.equal(queued.brProbe, true);
    assert.equal(brProbe.isBrProbePending(MOVIE), true);
    assert.equal(brProbe.probeBlocksSeeds(MOVIE), true);

    const depth = harvestQueue.depth();
    const r2 = brProbe.requestBrProbe(MOVIE);
    assert.equal(r2.skipped, 'pending');
    assert.equal(harvestQueue.depth(), depth, 'duplicata não reenfileira');
  } finally {
    restore(s);
  }
});

test('pending bloqueia a SELEÇÃO de seeds e DEFERE o dreno sem purgar a fila', () => {
  const s = setup();
  try {
    brProbe.requestBrProbe(MOVIE);
    assert.equal(seedsSelectionBlock(policy, [], { brProbePending: true }), 'br-probe-pending');

    writeSeedsQueue('sk-probe');
    const pick = runUser(() => takeDrainCandidate('sk-probe', adapter, 'acct'));
    assert.equal(pick.next, null, 'dreno deferiu o seeds sob sonda pending');
    assert.equal(autofetch.readQueue('sk-probe').length, 1, 'fila seeds preservada, não purgada');
  } finally {
    autofetch.dropQueue('sk-probe');
    restore(s);
  }
});

test('empty libera seeds na hora e mantém o dedupe do estado', () => {
  const s = setup();
  try {
    brProbe.requestBrProbe(MOVIE);
    brProbe.finalizeBrProbe(MOVIE, 'empty');
    assert.equal(brProbe.isBrProbePending(MOVIE), false);
    assert.equal(brProbe.probeBlocksSeeds(MOVIE), false);
    assert.equal(brProbe.requestBrProbe(MOVIE).skipped, 'empty', 'dedupe do estado evita re-sondar');

    writeSeedsQueue('sk-empty');
    const pick = runUser(() => takeDrainCandidate('sk-empty', adapter, 'acct'));
    assert.ok(pick.next, 'seeds volta a drenar');
  } finally {
    autofetch.dropQueue('sk-empty');
    restore(s);
  }
});

test('pending órfão expira pelo lease e pode ser reagendado', () => {
  const s = setup();
  try {
    brProbe.__setBrProbeRecordForTest(MOVIE, { state: 'pending', at: Date.now() - 1000, leaseUntil: Date.now() - 1 });
    assert.equal(brProbe.isBrProbePending(MOVIE), false, 'lease vencido não bloqueia para sempre');
    assert.equal(brProbe.requestBrProbe(MOVIE).pending, true, 'reagenda depois do órfão');
  } finally {
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
    assert.equal(harvestQueue.findQueued({ imdbId: MOVIE.imdbId, season: null, episode: null }), undefined);
    harvester.enqueue({ imdbId: MOVIE.imdbId, type: 'movie', reason: 'br-gap' });
    const q = harvestQueue.findQueued({ imdbId: MOVIE.imdbId, season: null, episode: null });
    assert.equal(Boolean(q?.brProbe), false, 'sem modo dirigido com a sonda desligada');
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

test('dedupe de 12h impede a sonda e não bloqueia seeds', () => {
  const s = setup();
  try {
    harvester.enqueue({ imdbId: MOVIE.imdbId, type: 'movie', reason: 'br-gap' });
    harvester.clearQueue();
    const r = brProbe.requestBrProbe(MOVIE);
    assert.equal(r.probe, false);
    assert.equal(r.skipped, 'dedupe');
    assert.equal(brProbe.probeBlocksSeeds(MOVIE), false);
  } finally {
    restore(s);
  }
});

test('next-episode + brProbe preserva o motivo forte e a flag dirigida', () => {
  const s = setup();
  try {
    harvester.enqueue({ imdbId: MOVIE.imdbId, type: 'movie', reason: 'next-episode' });
    assert.equal(brProbe.requestBrProbe(MOVIE).pending, true);
    const q = harvestQueue.findQueued({ imdbId: MOVIE.imdbId, season: null, episode: null });
    assert.equal(q?.reason, 'next-episode', 'promoção não rebaixa o play real');
    assert.equal(q?.brProbe, true, 'flag dirigida é OR-aderente');
    assert.equal(brProbe.isBrProbePending(MOVIE), true);
  } finally {
    restore(s);
  }
});

test('capped (orçamento) libera seeds e não re-agenda na hora', () => {
  const s = setup();
  try {
    brProbe.requestBrProbe(MOVIE);
    brProbe.finalizeBrProbe(MOVIE, 'capped');
    assert.equal(brProbe.probeBlocksSeeds(MOVIE), false, 'quota não fica pending 12h');
    assert.equal(brProbe.requestBrProbe(MOVIE).skipped, 'retry', 'retry curto segura o martelo');
  } finally {
    restore(s);
  }
});

test('worker dirigido consulta SÓ a interseção, sequencial, e registra DUAL BR', async () => {
  const s = setup();
  const originalSearch = jackett.search;
  const chamadas: string[] = [];
  const unitarias: boolean[] = [];
  const opcoes: any[] = [];
  const tmdbHandler = (url: string) => {
    if (url.includes('api.themoviedb.org')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          movie_results: [{ title: 'Coringa', original_title: 'Joker', release_date: '2019-10-02' }],
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const stub = stubFetch(tmdbHandler);
  // A lista pronta da obra vive no `streams.db`: a ponte dublada é o único
  // lugar onde a invalidação de `found` pode aparecer. Ela delega o resto
  // (Cinemeta/TMDB) ao mesmo handler do stub.
  const streamKey = `${cachePrefix('streams')}movie:tt0107953:cfg`;
  const bridge = createStreamsBridge({
    // A entrada nasce DEPOIS do harvest: a própria transição BR do registro já
    // invalida a obra, e o que este teste isola é a invalidação do `found`.
    onOther: tmdbHandler,
  });
  jackett.search = (async (_q: string, _t: string, indexers: string[] | null, options: any) => {
    // Uma chamada por indexer: a sonda é sequencial e cada consulta carrega UM.
    unitarias.push((indexers || []).length === 1);
    opcoes.push(options);
    for (const indexer of indexers || []) chamadas.push(indexer);
    if ((indexers || []).includes('idx-br')) {
      return [{ title: 'Coringa (2019) 1080p DUAL Dublado', infoHash: A, seeders: 3, indexer: 'idx-br', isBr: true }];
    }
    return [];
  }) as typeof jackett.search;
  try {
    config.jackett.indexers = ['glob-a', 'idx-br', 'site-br'];
    config.jackett.indexOnlyIndexers = ['idx-br', 'idx-br2'];
    config.jackett.ptBrIndexers = ['idx-br', 'idx-br2', 'site-br'];
    cache.set('meta:movie:tt0107953', { name: 'Coringa', year: '2019', type: 'movie' }, 3600);

    const r = await harvestWorker.harvestOne({ imdbId: MOVIE.imdbId, type: 'movie', season: null, episode: null, reason: 'br-gap', brProbe: true } as any);
    assert.deepEqual(chamadas, ['idx-br', 'idx-br2'], 'só a interseção, na ordem e uma por vez');
    assert.ok(unitarias.length > 0 && unitarias.every(Boolean), 'cada consulta carrega UM indexer');
    assert.ok(
      opcoes.every((o) => o.background === true && o.recordStatus === false && o.timeoutMs === config.jackett.indexOnlyHarvestTimeout),
      'opções do colhedor preservadas na consulta dirigida',
    );
    assert.equal(r.brFound, true);
    const idx = releaseIndex.lookup(MOVIE.imdbId, {});
    assert.ok(idx.some((x) => x.isBr && x.dubbed), 'DUAL BR entrou no índice com isBr+dubbed');

    assert.equal(bridge.has(streamKey), false, 'o harvest (transição br) já invalidou a obra');
    bridge.put({ type: 'movie', id: MOVIE.imdbId, key: streamKey });
    assert.equal(bridge.has(streamKey), true, 'lista pronta existe antes de finalizar');
    brProbe.finalizeBrProbe(MOVIE, 'found');
    await flushNativeStreamStores();
    assert.equal(bridge.has(streamKey), false, 'found invalida a lista da obra');
    assert.equal(brProbe.probeBlocksSeeds(MOVIE), false, 'found NÃO bloqueia seeds: o índice decide na próxima abertura');
    assert.equal(brProbe.requestBrProbe(MOVIE).skipped, 'found', 'mas o dedupe de 12h do estado permanece');
  } finally {
    bridge.restore();
    stub.restore();
    jackett.search = originalSearch;
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

test('identidade de série é por episódio: pending do E2 não bloqueia o E3', () => {
  const s = setup();
  try {
    const e2 = { type: 'series' as const, imdbId: 'tt0107953', season: 1, episode: 2 };
    const e3 = { type: 'series' as const, imdbId: 'tt0107953', season: 1, episode: 3 };
    assert.notEqual(brProbe.probeIdentity(e2), brProbe.probeIdentity(e3));
    assert.equal(brProbe.requestBrProbe(e2).pending, true);
    assert.equal(brProbe.isBrProbePending(e2), true);
    assert.equal(brProbe.isBrProbePending(e3), false, 'a sonda do E2 não segura o E3');
  } finally {
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
