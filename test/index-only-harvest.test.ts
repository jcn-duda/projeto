// O colhedor consulta os index-only individualmente, com orçamento TOTAL
// dedicado (busca + resolução /dl): o override só vale para quem está na
// JACKETT_INDEX_ONLY_INDEXERS — indexer comum continua no budgetFor de
// sempre — e a varredura pt-BR do colhedor NÃO consulta index-only (o laço
// individual abaixo dela continua cobrindo os BR index-only).
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import * as cache from '../src/utils/cache.js';
import config from '../src/config.js';
import jackett from '../src/providers/jackett.js';
import * as harvestWorker from '../src/providers/harvest-worker.js';
import { stubFetch } from './helpers/stub.js';

const soEmpty = () => stubFetch(() => ({ ok: false, status: 404, json: async () => ({}) }));

const tmdbOk = () => ({
  ok: true,
  status: 200,
  json: async () => ({
    movie_results: [
      {
        title: 'Star Wars: O Ataque dos Clones',
        original_title: 'Star Wars: Episode II - Attack of the Clones',
        release_date: '2002-05-16',
      },
    ],
  }),
});

function saveConfig() {
  return {
    indexers: config.jackett.indexers,
    indexOnly: config.jackett.indexOnlyIndexers,
    ptBrIndexers: config.jackett.ptBrIndexers,
    ptSweepGlobal: config.jackett.ptSweepGlobal,
    apiKey: config.jackett.apiKey,
    tmdbApiKey: config.tmdb.apiKey,
    maxPerHour: config.harvest.maxPerHour,
    idleWindowMs: config.harvest.idleWindowMs,
    indexerDelayMs: config.harvest.indexerDelayMs,
    harvestTimeout: config.jackett.indexOnlyHarvestTimeout,
    bludvEnabled: config.bludv.enabled,
    rdWarmEnabled: config.debrid.rdWarm.enabled,
  };
}

function restoreConfig(s: ReturnType<typeof saveConfig>) {
  config.jackett.indexers = s.indexers;
  config.jackett.indexOnlyIndexers = s.indexOnly;
  config.jackett.ptBrIndexers = s.ptBrIndexers;
  config.jackett.ptSweepGlobal = s.ptSweepGlobal;
  config.jackett.apiKey = s.apiKey;
  config.tmdb.apiKey = s.tmdbApiKey;
  config.harvest.maxPerHour = s.maxPerHour;
  config.harvest.idleWindowMs = s.idleWindowMs;
  config.harvest.indexerDelayMs = s.indexerDelayMs;
  config.jackett.indexOnlyHarvestTimeout = s.harvestTimeout;
  config.bludv.enabled = s.bludvEnabled;
  config.debrid.rdWarm.enabled = s.rdWarmEnabled;
}

type Chamada = { indexer: string; opts: any };
function espiarBusca() {
  const chamadas: Chamada[] = [];
  const original = jackett.search;
  jackett.search = (async (_q: string, _t: string, indexers: string[] | null, opts: any = {}) => {
    for (const indexer of indexers || []) chamadas.push({ indexer, opts });
    return [];
  }) as typeof jackett.search;
  return { chamadas, restore: () => { jackett.search = original; } };
}

test('colhedor passa o orçamento dedicado SÓ ao index-only; comum fica sem override', async () => {
  const saved = saveConfig();
  cache.clear();
  const stub = soEmpty();
  const spy = espiarBusca();
  try {
    config.jackett.indexers = ['idxonly-fake', 'glob-comum'];
    config.jackett.indexOnlyIndexers = ['idxonly-fake'];
    config.jackett.ptBrIndexers = [];
    config.jackett.ptSweepGlobal = false;
    config.jackett.apiKey = 'fake-key';
    config.jackett.indexOnlyHarvestTimeout = 4321;
    config.harvest.maxPerHour = 50;
    config.harvest.idleWindowMs = 0;
    config.harvest.indexerDelayMs = 0;
    config.bludv.enabled = false;
    config.debrid.rdWarm.enabled = false;
    cache.set('meta:movie:tt9500071', { name: 'Obra do Teste', year: '2024', type: 'movie' }, 3600);
    const r = await harvestWorker.harvestOne({
      imdbId: 'tt9500071',
      type: 'movie',
      season: null,
      episode: null,
      reason: `idxonly-timeout-${Date.now()}`,
    } as any);

    assert.equal(r.ok, true, 'colheita executou');
    const doIdxOnly = spy.chamadas.find((c) => c.indexer === 'idxonly-fake');
    const doComum = spy.chamadas.find((c) => c.indexer === 'glob-comum');
    assert.ok(doIdxOnly, 'index-only foi consultado individualmente');
    assert.equal(doIdxOnly.opts.timeoutMs, 4321, 'orçamento TOTAL dedicado no index-only');
    assert.equal(doIdxOnly.opts.background, true, 'consulta é de fundo (colhedor)');
    assert.ok(doComum, 'indexer comum também foi consultado');
    assert.equal(doComum.opts.timeoutMs, undefined, 'indexer comum NUNCA recebe o override');
  } finally {
    stub.restore();
    spy.restore();
    cache.clear();
    restoreConfig(saved);
  }
});

test('varredura pt do colhedor exclui index-only; o laço individual os mantém', async () => {
  const saved = saveConfig();
  cache.clear();
  const stub = stubFetch((url: string) => {
    if (url.includes('api.themoviedb.org')) return tmdbOk();
    return { ok: false, status: 404, json: async () => ({}) };
  });
  const spy = espiarBusca();
  try {
    config.jackett.indexers = ['glob-sweep', 'idxonly-sweep'];
    config.jackett.indexOnlyIndexers = ['idxonly-sweep'];
    config.jackett.ptBrIndexers = [];
    config.jackett.ptSweepGlobal = true;
    config.jackett.apiKey = 'fake-key';
    config.tmdb.apiKey = 'fake-key';
    config.jackett.indexOnlyHarvestTimeout = 4321;
    config.harvest.maxPerHour = 50;
    config.harvest.idleWindowMs = 0;
    config.harvest.indexerDelayMs = 0;
    config.bludv.enabled = false;
    config.debrid.rdWarm.enabled = false;
    cache.set('meta:movie:tt9500072', { name: 'Obra do Teste', year: '2002', type: 'movie' }, 3600);

    await harvestWorker.harvestOne({
      imdbId: 'tt9500072',
      type: 'movie',
      season: null,
      episode: null,
      reason: `idxonly-sweep-${Date.now()}`,
    } as any);

    // A varredura (mesma query raiz pt nas duas chamadas por indexer) só pode
    // tocar o global elegível; o index-only aparece UMA vez, no laço
    // individual, com o override dedicado.
    const doIdxOnly = spy.chamadas.filter((c) => c.indexer === 'idxonly-sweep');
    assert.equal(doIdxOnly.length, 1, 'index-only sai da varredura e só entra no laço individual');
    assert.equal(doIdxOnly[0].opts.timeoutMs, 4321);
    const doGlobal = spy.chamadas.filter((c) => c.indexer === 'glob-sweep');
    assert.equal(doGlobal.length, 2, 'global elegível entra na varredura E no laço');
    assert.equal(doGlobal[0].opts.timeoutMs, undefined, 'varredura em indexer comum não carrega override');
  } finally {
    spy.restore();
    cache.clear();
    restoreConfig(saved);
  }
});
