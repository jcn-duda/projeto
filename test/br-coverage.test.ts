import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import config from '../src/config.js';
import * as cache from '../src/utils/cache.js';
import { prefix } from '../src/utils/cache-keys.js';
import * as metrics from '../src/utils/metrics.js';
import * as releaseIndex from '../src/utils/release-index.js';
import * as rdLedger from '../src/debrid/rd-ledger.js';
import * as magnetdb from '../src/utils/magnetdb.js';
import { accountScope } from '../src/utils/request-key.js';
import * as brCoverage from '../src/utils/br-coverage.js';
import { nextSeeds, popularCohort } from '../src/providers/imdb-seed.js';
import { stubFetch } from './helpers/stub.js';

const SEED_LAST = `${prefix('seed')}last`;
const SEED_COHORT = `${prefix('seed')}cohort`;

function brItem(hash: string, title: string) {
  // isBr=true + título com marcador de áudio PT deixa `dubbed` true no índice.
  return { infoHash: hash, title, isBr: true, indexer: 'br-idx', seeders: 1 };
}

/** Config completa (operador + seed + ledger) para restaurar no `finally`. */
type SavedCfg = Record<string, any>;

function saveConfig(): SavedCfg {
  return {
    allowEnvKey: config.debrid.allowEnvKey,
    service: config.debrid.service,
    apiKey: config.debrid.apiKey,
    ledger: config.debrid.rdLedger.enabled,
    seedApiKey: config.seed.apiKey,
    seedEnabled: config.seed.enabled,
    seedMax: config.seed.maxPerCycle,
    seedMin: config.seed.minVotes,
    seedIntervalH: config.seed.intervalH,
    topPerType: config.f3.br.topPerType,
    f3Enabled: config.f3.enabled,
    brEnabled: config.f3.br.enabled,
    sampleMs: config.f3.br.sampleMs,
  };
}

function restoreConfig(saved: SavedCfg) {
  config.debrid.allowEnvKey = saved.allowEnvKey;
  config.debrid.service = saved.service;
  config.debrid.apiKey = saved.apiKey;
  config.debrid.rdLedger.enabled = saved.ledger;
  config.seed.apiKey = saved.seedApiKey;
  config.seed.enabled = saved.seedEnabled;
  config.seed.maxPerCycle = saved.seedMax;
  config.seed.minVotes = saved.seedMin;
  config.seed.intervalH = saved.seedIntervalH;
  config.f3.br.topPerType = saved.topPerType;
  config.f3.enabled = saved.f3Enabled;
  config.f3.br.enabled = saved.brEnabled;
  config.f3.br.sampleMs = saved.sampleMs;
}

function resetAll() {
  cache.clearNamespace('idx');
  cache.clearNamespace('rdc');
  cache.clearNamespace('davail');
  cache.clearNamespace('mag');
  cache.clearNamespace('seed');
  cache.clearNamespace('cfg');
  rdLedger.reset();
  brCoverage.reset();
  metrics.reset();
}

/** Modo "só ledger" (sem conta do operador): davail/magnet não leem nada. */
function ledgerOnly() {
  config.debrid.allowEnvKey = false;
  config.debrid.service = '';
  config.debrid.apiKey = '';
  config.seed.apiKey = 'seed-key';
  config.seed.enabled = true;
  config.seed.maxPerCycle = 50;
  config.seed.minVotes = 0;
  config.seed.intervalH = 24;
}

function imdbItem(id: string, isSeries: boolean) {
  return {
    id,
    type: isSeries ? 'tvSeries' : 'movie',
    title: `T ${id}`,
    releaseDate: '2020-01-01',
    startYear: 2020,
    numVotes: 50_000,
  };
}

/**
 * Grava a `PopularCohort` PELO CAMINHO REAL (nextSeeds + fetch stub), nunca
 * escrevendo a chave interna à mão. Limpa o cooldown e a coorte anteriores para
 * o ciclo ocorrer de fato, e prova que a gravação passou pelo módulo.
 */
async function seedCohort(movies: string[], series: string[]) {
  cache.forget(SEED_LAST);
  cache.forget(SEED_COHORT);
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  globalThis.fetch = (async (url: any) => {
    const u = String(url);
    const body = u.includes('most-popular-tv')
      ? series.map((id) => imdbItem(id, true))
      : movies.map((id) => imdbItem(id, false));
    return { ok: true, status: 200, json: async () => body };
  }) as unknown as typeof globalThis.fetch;
  try {
    await nextSeeds();
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
  const coorte = popularCohort();
  assert.ok(coorte, 'a coorte foi persistida pelo nextSeeds (fetch stub)');
  return coorte;
}

test('3.1: sem coorte, sample devolve null e a baseline fica em 0', () => {
  const saved = saveConfig();
  try {
    ledgerOnly();
    resetAll(); // garante nenhuma coorte
    assert.equal(brCoverage.sample(), null, 'sem denominador não há o que medir');
    const st = brCoverage.status();
    assert.equal(st.baselineAt, 0);
    assert.equal(st.latest, null);
    assert.equal(st.samples, 0);
    assert.equal(st.popularCoverage, null, 'sem coorte não inventa 0%');
    assert.equal(st._origem?.popularCoverage, 'naomedido');
    assert.equal(st._origem?.brWarmRate, 'naomedido');
    assert.equal(st._origem?.discoveryRate, 'naomedido');
    const g = metrics.snapshot().gauges;
    assert.equal(g['f3.br.popular.target'], undefined, 'nenhum gauge sem coorte');
  } finally {
    restoreConfig(saved);
    resetAll();
  }
});

test('3.1: coorte expirada limpa latest, gauges e reinicia a janela de 48h', async () => {
  const saved = saveConfig();
  try {
    ledgerOnly();
    await seedCohort(['tt3000100'], []);
    assert.ok(brCoverage.sample());
    assert.ok(brCoverage.status().baselineAt > 0);
    cache.forget(SEED_COHORT);
    assert.equal(brCoverage.sample(), null);
    assert.equal(brCoverage.status().baselineAt, 0);
    assert.equal(brCoverage.status().latest, null);
    assert.equal(metrics.snapshot().gauges['f3.br.popular.target'], undefined);
  } finally {
    restoreConfig(saved);
    resetAll();
  }
});

test('3.1: start faz sample imediato, usa guard contra timer duplo e reset encerra', async () => {
  const saved = saveConfig();
  try {
    ledgerOnly();
    config.f3.enabled = true;
    config.f3.br.enabled = true;
    await seedCohort(['tt3000103'], []);
    brCoverage.start();
    assert.equal(brCoverage.status().samples, 1, 'boot mede imediatamente');
    brCoverage.start();
    assert.equal(brCoverage.status().samples, 1, 'segunda chamada não cria timer nem sample duplicado');
    brCoverage.reset();
    assert.equal(brCoverage.status().samples, 0);
  } finally {
    restoreConfig(saved);
    resetAll();
  }
});

test('3.1: coorte via nextSeeds define target=movies+series; ledger hit confirma ⚡', async () => {
  const saved = saveConfig();
  try {
    ledgerOnly();
    await seedCohort(['tt3000101'], ['tt3000102']);
    const h1 = 'aa'.repeat(20);
    const h2 = 'bb'.repeat(20);
    releaseIndex.record('tt3000101', {}, [brItem(h1, 'Filme M (2020) 1080p DUBLADO')]);
    releaseIndex.record('tt3000102', {}, [brItem(h2, 'Serie S (2020) 1080p DUBLADO')]);
    rdLedger.noteHit([h1]); // só o filme tem ⚡

    const s = brCoverage.sample();
    assert.ok(s, 'com coorte o sample existe');
    assert.equal(s.movie.target, 1, 'top de filmes é o denominador');
    assert.equal(s.series.target, 1, 'top de séries é o denominador');
    assert.equal(s.targetWorks, 2);
    assert.equal(s.movie.indexed, 1);
    assert.equal(s.movie.withBr, 1);
    assert.equal(s.movie.cached, 1, 'ledger hit conta ⚡');
    assert.equal(s.series.withBr, 1);
    assert.equal(s.series.cached, 0);
    assert.equal(s.series.unknown, 1, 'sem miss e sem hit, série fica unknown');
    assert.equal(s.worksCached, 1);

    // Levellers atuais (nível, não delta) no status e nos gauges.
    const st = brCoverage.status();
    assert.equal(st.popularCoverage, 0.5);
    assert.equal(st.brWarmRate, 0.5);
    assert.equal(st.discoveryRate, 1);
    assert.ok(st.baselineAt > 0);
    assert.equal(st.samples, 1);
    const g = metrics.snapshot().gauges;
    assert.equal(g['f3.br.popular.target'], 2);
    assert.equal(g['f3.br.popular.cached'], 1);
    assert.ok(g['f3.br.popular.popularCoverage'] === 0.5, 'gauge da razão publica nível');
  } finally {
    restoreConfig(saved);
    resetAll();
  }
});

test('3.1: série com idx obra/temporada/episódio conta UMA obra e releases dedupe por hash', async () => {
  const saved = saveConfig();
  try {
    ledgerOnly();
    await seedCohort([], ['tt3000110']);
    const hA = '1'.repeat(40);
    const hB = '2'.repeat(40);
    const hC = '3'.repeat(40);
    // Mesma obra, gravada em três chaves (obra, temporada, episódio).
    releaseIndex.record('tt3000110', {}, [brItem(hA, 'Serie (2020) 1080p DUBLADO')]);
    releaseIndex.record('tt3000110', { season: 1 }, [brItem(hB, 'Serie (2020) S01 1080p DUBLADO')]);
    releaseIndex.record('tt3000110', { season: 1, episode: 3 }, [brItem(hC, 'Serie (2020) S01E03 1080p DUBLADO')]);
    // Duplica o hash A sob uma quarta chave (season 2): não pode contar de novo.
    releaseIndex.record('tt3000110', { season: 2 }, [brItem(hA, 'Serie (2020) S02 1080p DUBLADO')]);

    const s = brCoverage.sample();
    assert.ok(s);
    assert.equal(s.indexedWorks, 1, 'a série é UMA obra agregando obra/temporada/episódio');
    assert.equal(s.worksWithBr, 1);
    assert.equal(s.releasesWithBr, 3, '3 hashes distintos; o hash A duplicado foi dedupe');
  } finally {
    restoreConfig(saved);
    resetAll();
  }
});

test('3.1: release lied (post prometeu PT, arquivo é EN) NÃO é candidata ao ⚡', async () => {
  const saved = saveConfig();
  try {
    ledgerOnly();
    await seedCohort(['tt3000120'], []);
    const h = '4'.repeat(40);
    releaseIndex.record('tt3000120', {}, [brItem(h, 'Filme (2020) 1080p DUBLADO')]);
    releaseIndex.markLied('tt3000120', {}, h); // os arquivos provaram release EN
    rdLedger.noteHit([h]);

    const s = brCoverage.sample();
    assert.equal(s?.worksWithBr, 0, 'lied é ruído, não BR tocável');
    assert.equal(s?.releasesWithBr, 0);
    assert.equal(s?.worksCached, 0);
  } finally {
    restoreConfig(saved);
    resetAll();
  }
});

test('3.1: ledger hit, davail=1 e magnetdb alive contam ⚡ (três fontes)', async () => {
  const saved = saveConfig();
  try {
    config.debrid.allowEnvKey = true;
    config.debrid.service = 'realdebrid';
    config.debrid.apiKey = 'ops-key';
    config.seed.apiKey = 'seed-key';
    config.seed.enabled = true;
    await seedCohort(['tt3000131', 'tt3000132', 'tt3000133'], []);
    const hL = '1'.repeat(40);
    const hD = '2'.repeat(40);
    const hM = '3'.repeat(40);
    releaseIndex.record('tt3000131', {}, [brItem(hL, 'Filme L (2020) 1080p DUBLADO')]);
    releaseIndex.record('tt3000132', {}, [brItem(hD, 'Filme D (2020) 1080p DUBLADO')]);
    releaseIndex.record('tt3000133', {}, [brItem(hM, 'Filme M (2020) 1080p DUBLADO')]);
    rdLedger.noteHit([hL]);
    // davail positivo da conta do operador (mesma chave que o módulo lê).
    cache.set(`${prefix('davail')}realdebrid:${accountScope('ops-key')}:${hD}`, 1, 3600);
    magnetdb.markAlive('realdebrid', 'ops-key', [hM]);

    const s = brCoverage.sample();
    assert.equal(s?.worksCached, 3, 'ledger, davail e magnetdb.alive confirmam ⚡');
    assert.equal(s?.releasesCached, 3);
  } finally {
    restoreConfig(saved);
    resetAll();
  }
});

test('3.1: miss explícito vira knownMiss; sem prova vira unknown', async () => {
  const saved = saveConfig();
  try {
    ledgerOnly();
    await seedCohort(['tt3000141', 'tt3000142'], []);
    const hM = '4'.repeat(40);
    const hU = '5'.repeat(40);
    releaseIndex.record('tt3000141', {}, [brItem(hM, 'Filme M (2020) 1080p DUBLADO')]);
    releaseIndex.record('tt3000142', {}, [brItem(hU, 'Filme U (2020) 1080p DUBLADO')]);
    rdLedger.noteMiss(hM);

    const s = brCoverage.sample();
    assert.equal(s?.worksKnownMiss, 1);
    assert.equal(s?.worksUnknown, 1);
    assert.equal(s?.worksCached, 0);
  } finally {
    restoreConfig(saved);
    resetAll();
  }
});

test('3.1: blocked NÃO é ressuscitado por alive/davail', async () => {
  const saved = saveConfig();
  try {
    config.debrid.allowEnvKey = true;
    config.debrid.service = 'realdebrid';
    config.debrid.apiKey = 'ops-key';
    config.seed.apiKey = 'seed-key';
    config.seed.enabled = true;
    await seedCohort(['tt3000151'], []);
    const h = '6'.repeat(40);
    releaseIndex.record('tt3000151', {}, [brItem(h, 'Filme B (2020) 1080p DUBLADO')]);
    rdLedger.noteBlocked(h); // 451 legal: recusa permanente
    // Evidência da conta como se tivesse tocado — NÃO pode ressuscitar 451.
    magnetdb.markAlive('realdebrid', 'ops-key', [h]);
    cache.set(`${prefix('davail')}realdebrid:${accountScope('ops-key')}:${h}`, 1, 3600);

    const s = brCoverage.sample();
    assert.equal(s?.worksCached, 0, 'recusa legal não pode ser apagada por evidência da conta');
    assert.equal(s?.worksKnownMiss, 1, 'blocked segue miss, mesmo com alive/davail por baixo');
  } finally {
    restoreConfig(saved);
    resetAll();
  }
});

test('3.1: conta que não é Real-Debrid não colore cobertura RD com davail/alive', async () => {
  const saved = saveConfig();
  try {
    config.debrid.allowEnvKey = true;
    config.debrid.service = 'premiumize';
    config.debrid.apiKey = 'pm-key';
    config.seed.apiKey = 'seed-key';
    config.seed.enabled = true;
    await seedCohort(['tt3000152'], []);
    const h = '7'.repeat(40);
    releaseIndex.record('tt3000152', {}, [brItem(h, 'Filme P (2020) 1080p DUBLADO')]);
    magnetdb.markAlive('premiumize', 'pm-key', [h]);
    cache.set(`${prefix('davail')}premiumize:${accountScope('pm-key')}:${h}`, 1, 3600);

    const s = brCoverage.sample();
    assert.equal(s?.worksCached, 0);
    assert.equal(s?.worksUnknown, 1, 'histórico de outro serviço não afirma cache no RD');
  } finally {
    restoreConfig(saved);
    resetAll();
  }
});

test('3.1: fetch stub lança durante o sample — zero rede e zero escrita', async () => {
  const saved = saveConfig();
  try {
    ledgerOnly();
    await seedCohort(['tt3000161'], []);
    const h = '8'.repeat(40);
    releaseIndex.record('tt3000161', {}, [brItem(h, 'Filme (2020) 1080p DUBLADO')]);
    const stub = stubFetch(() => {
      throw new Error('nao pode haver rede no sample');
    });
    let s: any = null;
    try {
      s = brCoverage.sample();
    } finally {
      stub.restore();
    }
    assert.ok(s);
    assert.equal(s.worksWithBr, 1);
    assert.equal(stub.calls.length, 0, 'baseline nunca chama a rede');
  } finally {
    restoreConfig(saved);
    resetAll();
  }
});
