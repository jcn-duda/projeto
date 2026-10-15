// Fase 4 (B2): o pending da sonda precisa barrar também o fallback PERSISTIDO
// e os packs que a fila do Chupim guarda. Cobre pickLowerPoolFallbacks, o dreno
// por EPISÓDIO (probeEpisode separado da identidade de obra-cap) e os call
// sites reais (autoFetchCandidates e o despacho autoFetchBrDubbed).
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import config from '../src/config.js';
import * as cache from '../src/utils/cache.js';
import * as runtime from '../src/runtime.js';
import * as brProbe from '../src/providers/br-probe.js';
import * as autofetch from '../src/providers/autofetch.js';
import * as releaseIndex from '../src/utils/release-index.js';
import * as harvestQueue from '../src/providers/harvest-queue.js';
import autofetchLive from '../src/utils/autofetch-live.js';
import { pickLowerPoolFallbacks } from '../src/providers/autofetch-fallback.js';
import { takeDrainCandidate } from '../src/providers/autofetch-drain.js';
import { autoFetchCandidates } from '../src/providers/autofetch-candidates.js';
import { autoFetchBrDubbed } from '../src/providers/autofetch-runner.js';

const H = 'a'.repeat(40);
const OBRA = 'tt0107953';
const workMovie = { type: 'movie' as const, imdbId: OBRA, season: null, episode: null };
const userOpts = {
  ...runtime.defaults(),
  debridService: 'premiumize',
  debridApiKey: 'chave-probe',
  dubbedOnly: false,
  debridCachedOnly: true,
  autoFetchBr: true,
};
const runUser = <T>(fn: () => T): T => runtime.run({ opts: userOpts, encoded: 'sk-probe' }, fn) as T;

const policy = { dubbedOnly: false, cachedOnly: true, maxSizeGb: 0, seedsMaxGb: 8, seedsMaxQuality: '1080p' };
const live = {
  autoFetchAnyDubbed: false,
  autoFetchTopSeeds: true,
  autoFetchMinSeeders: 1,
  autoFetchTopSeedsMax: 2,
  autoFetchSeedsPtFirst: false,
  autoFetchRareMax: 0,
  autoFetchRareThreshold: 0,
  autoFetchRareMaxSeeders: 0,
};

function setup() {
  const saved = {
    indexOnly: config.jackett.indexOnlyIndexers,
    ptBr: config.jackett.ptBrIndexers,
    releaseIndex: config.releaseIndex.enabled,
    harvestEnabled: config.harvest.enabled,
  };
  config.jackett.indexOnlyIndexers = ['f-idx'];
  config.jackett.ptBrIndexers = ['f-idx'];
  config.releaseIndex.enabled = true;
  config.harvest.enabled = true;
  autofetchLive.reset();
  cache.clear();
  return saved;
}

function restore(saved: ReturnType<typeof setup>) {
  config.jackett.indexOnlyIndexers = saved.indexOnly;
  config.jackett.ptBrIndexers = saved.ptBr;
  config.releaseIndex.enabled = saved.releaseIndex;
  config.harvest.enabled = saved.harvestEnabled;
  autofetchLive.reset();
  cache.clear();
}

/** Marca pending sem passar pela fila do colhedor — o alvo aqui é a leitura. */
function setPending(work: brProbe.BrProbeWork) {
  brProbe.__setBrProbeRecordForTest(work, { state: 'pending', at: Date.now(), leaseUntil: Date.now() + 60_000 });
}

const seedsStream = (hex = H) => ({
  infoHash: hex,
  name: 'Probe Movie 2011 1080p WEB-DL',
  title: 'Probe Movie 2011 1080p WEB-DL',
  _seeders: 50,
  _size: 2 * 1024 ** 3,
  _quality: '1080p',
  _br: false,
  _dubbed: false,
}) as any;

test('fallback persistido de seeds é barrado pelo pending da sonda', () => {
  const saved = setup();
  try {
    const base = { primaryPool: 'br', excludeHashes: new Set<string>(), viable: () => true, policy };
    const semSonda = pickLowerPoolFallbacks([seedsStream()], live, base);
    assert.ok(semSonda.some((f) => f.pool === 'seeds'), 'sanidade: sem sonda o seeds é reposto');

    const comSonda = pickLowerPoolFallbacks([seedsStream()], live, { ...base, brProbePending: true });
    assert.equal(comSonda.some((f) => f.pool === 'seeds'), false, 'com pending o fallback seeds não entra');
  } finally {
    restore(saved);
  }
});

test('dreno defere o pack pela identidade do EPISÓDIO solicitado (probeEpisode)', () => {
  const saved = setup();
  try {
    const E5 = { ...workMovie, type: 'series' as const, season: 1, episode: 5 };
    setPending(E5); // pending do E5
    // Pack da temporada: `episode` nulo para o cap, mas a sonda é do E5.
    autofetch.writeQueue('sk-pack', [{
      infoHash: H, pool: 'seeds', imdbId: OBRA, season: 1, episode: null, isPack: true,
      probeSeason: 1, probeEpisode: 5, quality: '1080p', size: 2 * 1024 ** 3,
    }] as any, 3600, 'premiumize', 'acct');

    const pick = runUser(() => takeDrainCandidate('sk-pack', { id: 'premiumize', cacheCheck: true } as any, 'acct'));
    assert.equal(pick.next, null, 'pack do E5 deferido enquanto a sonda do E5 está pending');
    assert.equal(pick.remaining.length, 1, 'a fila é mantida, nunca purgada');
    assert.equal(autofetch.readQueue('sk-pack').length, 1, 'e persistida de volta');

    // Prova NÃO-VÁCUA: se o dreno usasse a identidade do cap (episode=null),
    // este pending do E5 não casaria e o pack drenaria — o defer prova o uso.
    brProbe.finalizeBrProbe(E5, 'empty');
    const depois = runUser(() => takeDrainCandidate('sk-pack', { id: 'premiumize', cacheCheck: true } as any, 'acct'));
    assert.ok(depois.next, 'sem pending, o pack volta a drenar');
  } finally {
    autofetch.dropQueue('sk-pack');
    restore(saved);
  }
});

test('pack de OUTRO episódio não é deferido pelo pending do E5', () => {
  const saved = setup();
  try {
    setPending({ ...workMovie, type: 'series' as const, season: 1, episode: 5 });
    autofetch.writeQueue('sk-pack-outro', [{
      infoHash: H, pool: 'seeds', imdbId: OBRA, season: 1, episode: null, isPack: true,
      probeSeason: 1, probeEpisode: 9, quality: '1080p', size: 2 * 1024 ** 3,
    }] as any, 3600, 'premiumize', 'acct');

    const pick = runUser(() => takeDrainCandidate('sk-pack-outro', { id: 'premiumize', cacheCheck: true } as any, 'acct'));
    assert.ok(pick.next, 'a sonda do E5 não segura o pack do E9');
  } finally {
    autofetch.dropQueue('sk-pack-outro');
    restore(saved);
  }
});

test('despacho de seeds (call site) defere sob pending sem purgar a fila', () => {
  const saved = setup();
  try {
    setPending(workMovie);
    autofetch.writeQueue('sk-dispatch', [{
      infoHash: H, pool: 'seeds', imdbId: OBRA, season: null, episode: null,
      quality: '1080p', size: 2 * 1024 ** 3,
    }] as any, 3600, 'premiumize', 'acct');

    const stream = seedsStream();
    const candidates = [{ stream, account: 'acct', pool: 'seeds' }];
    const n = runUser(() => autoFetchBrDubbed([stream], candidates, {
      cached: new Set<string>(), known: true, season: null, episode: null, imdbId: OBRA, searchKey: 'sk-dispatch',
    }));
    assert.equal(n, 0, 'nada despachado sob pending');
    assert.equal(autofetch.readQueue('sk-dispatch').length, 1, 'fila persistida intacta (deferida, não purgada)');
  } finally {
    autofetch.dropQueue('sk-dispatch');
    restore(saved);
  }
});

test('gate de plausibilidade (C6): obra sem evidência isBr não enfileira nem sonda nem br-gap', () => {
  const saved = setup();
  try {
    harvestQueue.clearQueue();
    // Pool BR vazio + índice sem NENHUMA release BR: a sonda não é plausível
    // e um br-gap seria colheita completa prioritizada — nada sobe.
    runUser(() => autoFetchCandidates([seedsStream()], { imdbId: OBRA, season: null, episode: null, searchKey: 'sk-noevid' }));
    assert.equal(brProbe.isBrProbePending(workMovie), false, 'sem evidência BR não grava pending');
    assert.equal(brProbe.probeBlocksSeeds(workMovie), false, 'e não bloqueia seeds');
    const q = harvestQueue.findQueued({ imdbId: OBRA, season: null, episode: null });
    assert.equal(q, undefined, 'obra sem vestígio BR não entra no colhedor');
  } finally {
    harvestQueue.clearQueue();
    autofetch.dropQueue('sk-noevid');
    restore(saved);
  }
});

test('seleção de seeds (call site) é bloqueada pelo pending e volta a escolher sem ele', () => {
  const saved = setup();
  try {
    // Gate de plausibilidade (C6): a sonda só é pedida com evidência BR no
    // índice. Com ela, o pending bloqueia seeds; sem ela, nada sobe.
    releaseIndex.record(OBRA, {}, [
      { title: 'Probe Movie 2011 1080p LEGENDADO', infoHash: 'b'.repeat(40), seeders: 5, isBr: true, indexer: 'tracker' },
    ], {});
    const streams = [seedsStream()];
    const bloqueado = runUser(() => autoFetchCandidates(streams, { imdbId: OBRA, season: null, episode: null, searchKey: 'sk-cand' }));
    assert.deepEqual(bloqueado, [], 'pending barra o pool seeds na seleção');
    assert.equal(brProbe.isBrProbePending(workMovie), true, 'o call site realmente agendou a sonda');

    brProbe.finalizeBrProbe(workMovie, 'empty');
    const liberado = runUser(() => autoFetchCandidates(streams, { imdbId: OBRA, season: null, episode: null, searchKey: 'sk-cand' }));
    assert.equal(liberado.length, 1, 'sem pending, o seeds volta a ser escolhido');
    assert.equal(liberado[0].pool, 'seeds');
  } finally {
    autofetch.dropQueue('sk-cand');
    restore(saved);
  }
});
