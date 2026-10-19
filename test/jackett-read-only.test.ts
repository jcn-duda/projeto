// Sombra de fonte (F2.1): o caminho read-only do Jackett no Node é
// REFERÊNCIA, não produção. Prova que ele não grava status/circuit breaker,
// não lê/grava o cache bruto, não captura no banco de magnets e não é
// bloqueado pelo breaker global. Sem rede real: `fetch` é dublê.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import config from '../src/config.js';
import * as cache from '../src/utils/cache.js';
import * as bank from '../src/utils/magnet-bank.js';
import { worksForObraMany } from '../src/utils/magnet-bank-query.js';
import * as indexerStatus from '../src/providers/indexer-status.js';
import jackett from '../src/providers/jackett.js';
import * as runtime from '../src/runtime.js';
import debrid from '../src/debrid/index.js';
import { collectRaw } from '../src/providers/collect-orchestrator.js';
import { patch, stubFetch, testOpts } from './helpers/stub.js';

const CTL = 'ro-ctl';
const RO = 'ro-shadow';
const IMDB = 'tt0100001';
const HASH = 'a'.repeat(40);

function setup() {
  const saved: any = {};
  for (const key of ['url', 'apiKey', 'indexers', 'ptBrIndexers', 'slowIndexers', 'indexOnlyIndexers', 'breakerFailures'] as const) {
    saved[key] = (config.jackett as any)[key];
  }
  saved.magnetBank = config.magnetBank.enabled;
  config.jackett.url = 'http://jackett.local';
  config.jackett.apiKey = 'fake-key';
  config.jackett.indexers = [CTL, RO];
  config.jackett.ptBrIndexers = [];
  config.jackett.slowIndexers = [];
  config.jackett.indexOnlyIndexers = [];
  config.jackett.breakerFailures = 1;
  config.magnetBank.enabled = true;
  bank.resetForTests();
  bank.open(undefined, { forceMemory: true });
  cache.clear();
  indexerStatus.clear();
  return saved;
}

function restore(saved: any) {
  for (const key of ['url', 'apiKey', 'indexers', 'ptBrIndexers', 'slowIndexers', 'indexOnlyIndexers', 'breakerFailures'] as const) {
    (config.jackett as any)[key] = saved[key];
  }
  config.magnetBank.enabled = saved.magnetBank;
  bank.resetForTests();
  cache.clear();
  indexerStatus.clear();
}

function okHandler(title = 'Movie 2024 1080p') {
  return stubFetch(() => ({
    ok: true,
    status: 200,
    json: async () => ({
      Results: [{
        Title: title,
        MagnetUri: `magnet:?xt=urn:btih:${HASH}&dn=${encodeURIComponent(title)}`,
        InfoHash: HASH,
        Seeders: 5,
        Size: 1234,
        Tracker: 'yts',
        TrackerId: 'yts',
        Category: [2000],
      }],
      Indexers: [{ Status: 2, Error: null }],
    }),
  }));
}

const ctx = { imdbId: IMDB, season: null, episode: null, year: 2024 };

test('read-only: sem status, cache, captura ou breaker', async () => {
  const saved = setup();
  // Controle: o caminho normal grava status/cache/banco.
  const ctl = okHandler('Controle 2024 1080p');
  try {
    await jackett.search('q-arm', 'movie', [CTL], {
      ...ctx,
      resetPassedFilter: true,
      matchContext: { names: ['Movie'], year: 2024, isSeries: false, season: null, episode: null },
    });
    assert.ok(indexerStatus.get(CTL), 'status normal é gravado');
    assert.ok(cache.get(jackett.rawKeysFor([CTL], 'q-arm', 'movie')[0]), 'raw normal é gravado');
  } finally {
    ctl.restore();
  }
  bank.flushBarrier();
  assert.ok(
    worksForObraMany(IMDB, [{ season: null, episode: null }], 10).length > 0,
    'controle captura a obra',
  );

  // Sombra: indexer ARMADO, cache com sentinela e banco limpo.
  bank.resetForTests();
  bank.open(undefined, { forceMemory: true });
  cache.clear();
  indexerStatus.clear();
  indexerStatus.record(RO, { ok: false });
  assert.equal(jackett.breakerTripped(RO), true);

  const rawKey = jackett.rawKeysFor([RO], 'q-shadow', 'movie')[0];
  cache.set(rawKey, { items: [{ title: 'SENTINELA' }] }, 60);
  const net = okHandler('Rede 2024 1080p');
  let items: any[] = [];
  try {
    items = await jackett.search('q-shadow', 'movie', [RO], {
      readOnly: true,
      imdbId: IMDB,
      season: null,
      episode: null,
      year: 2024,
      resetPassedFilter: true,
      matchContext: { names: ['Movie'], year: 2024, isSeries: false, season: null, episode: null },
    });
    assert.equal(net.calls.length, 1, 'breaker é IGNORADO na referência');
    assert.equal(items[0]?.title, 'Rede 2024 1080p', 'cache bruto não é lido');
  } finally {
    net.restore();
  }
  assert.deepEqual(cache.get(rawKey), { items: [{ title: 'SENTINELA' }] }, 'cache bruto não é sobrescrito');
  assert.equal(indexerStatus.get(RO)?.state, 'offline', 'status não é regravado');
  bank.flushBarrier();
  assert.equal(
    worksForObraMany(IMDB, [{ season: null, episode: null }], 10).length,
    0,
    'read-only não captura no banco',
  );
  restore(saved);
});

test('read-only: override de indexers ignora o ji do encoded', async () => {
  const saved = setup();
  const seen: any[][] = [];
  const patchSearch = patch(jackett, 'search', (async (...args: any[]) => {
    seen.push(args);
    return [];
  }) as typeof jackett.search);
  try {
    await runtime.run({
      opts: testOpts({ providers: ['jackett'], jackettIndexers: ['encoded-idx'] }),
      encoded: 'src-shadow',
    }, () => collectRaw(
      'Movie 2024', 'movie', IMDB, null,
      { names: ['Movie'], year: 2024, isSeries: false, season: null, episode: null },
      null, null, Date.now() + 2000, 'all',
      null, null, null, null, new Set<string>(),
      true,
      ['process-idx'],
    ));
    assert.ok(seen.length > 0, 'houve consulta Jackett');
    for (const args of seen) {
      assert.deepEqual(args[2], ['process-idx'], 'usa o override do processo');
      assert.notDeepEqual(args[2], ['encoded-idx'], 'ignora o ji customizado');
    }
  } finally {
    patchSearch();
    restore(saved);
  }
});

test('read-only: conta do debrid nem é lida (collectRaw)', async () => {
  const saved = setup();
  const savedInventory = config.debrid.inventorySource;
  const savedProvider = config.provider;
  const savedMico = config.mico.enabled;
  const savedBludv = config.bludv.enabled;
  config.debrid.inventorySource = true;
  config.provider = 'jackett';
  config.mico.enabled = false;
  config.bludv.enabled = false;
  let inventoryCalls = 0;
  const patches = [
    patch(jackett, 'search', (async () => []) as typeof jackett.search),
    patch(debrid, 'current', (() => ({ label: 'fake' })) as typeof debrid.current),
    patch(debrid, 'inventory', (async () => {
      inventoryCalls += 1;
      return [];
    }) as typeof debrid.inventory),
  ];
  const run = (readOnly: boolean) => runtime.run({
    opts: testOpts({ providers: ['jackett'], jackettIndexers: [RO] }),
    encoded: 'src-shadow',
  }, () => collectRaw(
    'Movie 2024', 'movie', IMDB, null,
    { names: ['Movie'], year: 2024, isSeries: false, season: null, episode: null },
    null, null, Date.now() + 2000, 'all',
    null, null, null, null, new Set<string>(), readOnly,
  ));
  try {
    await run(true);
    assert.equal(inventoryCalls, 0, 'read-only não agenda a conta');
    await run(false);
    assert.equal(inventoryCalls, 1, 'controle lê a conta uma vez');
  } finally {
    for (const undo of patches) undo();
    config.debrid.inventorySource = savedInventory;
    config.provider = savedProvider;
    config.mico.enabled = savedMico;
    config.bludv.enabled = savedBludv;
    restore(saved);
  }
});
