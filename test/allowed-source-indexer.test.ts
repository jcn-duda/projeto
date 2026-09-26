// Filtro de origem compartilhada (idx / magnet-bank) pela config do pedido:
// torrentio/`ji`, tracker preservado no índice, e exclusão em instant/fallback.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import config from '../src/config.js';
import * as runtime from '../src/runtime.js';
import * as bank from '../src/utils/magnet-bank.js';
import * as cache from '../src/utils/cache.js';
import * as releaseIndex from '../src/utils/release-index.js';
import * as harvestQueue from '../src/providers/harvest-queue.js';
import debrid from '../src/debrid/index.js';
import { allowedSourceIndexer } from '../src/providers/allowed-source-indexer.js';
import { attemptIndexFastPath } from '../src/providers/search-index-path.js';
import { collectInstantItems } from '../src/providers/magnet-bank-instant.js';
import { collectFallbackItems } from '../src/providers/magnet-bank-fallback.js';
import { idxReleasesToRaw } from '../src/providers/search-pool-coverage.js';
import { patch, testOpts, stubFetch } from './helpers/stub.js';

const hex = (c: string) => c.repeat(40);
const magnet = (h: string) => `magnet:?xt=urn:btih:${h}`;
const movieCtx = (imdb: string) => ({ imdbId: imdb, season: null, episode: null });

const tempDirs: string[] = [];
const saved = {
  releaseIndex: config.releaseIndex.enabled,
  jackettApiKey: config.jackett.apiKey,
  instantEnabled: config.magnetBank.instantEnabled,
  fallbackEnabled: config.magnetBank.fallbackEnabled,
};

function withOpts<T>(over: Record<string, unknown>, fn: () => T): T {
  return runtime.run({ opts: testOpts(over), encoded: 'src-filter' }, fn);
}

function seedBank(hash: string, indexer: string, imdb: string, title = 'Filme Teste 2024 1080p Dublado') {
  bank.captureItems([{ title, infoHash: hash, magnet: magnet(hash), seeders: 5, isBr: true }], indexer, movieCtx(imdb));
  bank.markFilterResult([hash], [hash], movieCtx(imdb));
  bank.flushNow();
}

beforeEach(() => {
  bank.resetForTests();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'src-filter-'));
  tempDirs.push(dir);
  bank.open(dir);
  cache.clear();
  harvestQueue.clearQueue();
  config.releaseIndex.enabled = true;
  config.magnetBank.enabled = true;
  config.magnetBank.instantEnabled = true;
  config.magnetBank.fallbackEnabled = true;
  config.jackett.apiKey = 'fake-key';
});

after(() => {
  bank.resetForTests();
  harvestQueue.clearQueue();
  config.releaseIndex.enabled = saved.releaseIndex;
  config.magnetBank.instantEnabled = saved.instantEnabled;
  config.magnetBank.fallbackEnabled = saved.fallbackEnabled;
  config.jackett.apiKey = saved.jackettApiKey;
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('helper: torrentio só com provider torrentio/both', () => {
  withOpts({ providers: ['jackett'], jackettIndexers: [] }, () => {
    assert.equal(allowedSourceIndexer('torrentio'), false);
  });
  withOpts({ providers: ['jackett', 'torrentio'], jackettIndexers: [] }, () => {
    assert.equal(allowedSourceIndexer('torrentio'), true);
  });
  withOpts({ providers: ['both'], jackettIndexers: [] }, () => {
    assert.equal(allowedSourceIndexer('torrentio'), true);
  });
});

test('helper: ji explícito filtra Jackett; lista vazia passa tudo; origem não-indexer passa', () => {
  withOpts({ providers: ['jackett'], jackettIndexers: ['kickasstorrents-to'] }, () => {
    assert.equal(allowedSourceIndexer('kickasstorrents-to'), true);
    assert.equal(allowedSourceIndexer('thepiratebay'), false);
    assert.equal(allowedSourceIndexer('bludv'), true, 'scraper bludv não é ji');
    assert.equal(allowedSourceIndexer('autofetch'), true);
    assert.equal(allowedSourceIndexer('!!!nao-indexer!!!'), true);
  });
  withOpts({ providers: ['jackett'], jackettIndexers: [] }, () => {
    assert.equal(allowedSourceIndexer('thepiratebay'), true);
    assert.equal(allowedSourceIndexer('kickasstorrents-to'), true);
  });
});

test('helper: index-only passa mesmo fora do ji (só chega pelo idx/banco)', () => {
  // VPS 2026-09-18: `.env` com `apachetorrent` (id inexistente) e a /configure
  // desmarcando `apachetorrent-cardigann` — o filtro cortava a fonte de todos.
  const savedIndexOnly = config.jackett.indexOnlyIndexers;
  config.jackett.indexOnlyIndexers = ['apachetorrent-cardigann'];
  try {
    withOpts({ providers: ['jackett'], jackettIndexers: ['kickasstorrents-to'] }, () => {
      assert.equal(allowedSourceIndexer('apachetorrent-cardigann'), true);
      assert.equal(allowedSourceIndexer('Apachetorrent-Cardigann'), true);
      assert.equal(allowedSourceIndexer('thepiratebay'), false, 'indexer comum segue o ji');
    });
  } finally {
    config.jackett.indexOnlyIndexers = savedIndexOnly;
  }
});

test('idxReleasesToRaw preserva tracker gravado (fallback para indexer)', () => {
  const withTracker = [{
    hash: hex('1'), title: 'Filme 1080p', seeders: 3, size: 1,
    indexer: 'torrentio', tracker: 'ThePirateBay', isBr: false, dubbed: false, quality: '1080p',
  }];
  assert.equal(idxReleasesToRaw(withTracker)[0].tracker, 'ThePirateBay');
  assert.equal(idxReleasesToRaw(withTracker)[0].indexer, 'torrentio');
  const legacy = [{
    hash: hex('2'), title: 'Filme 720p', seeders: 1, size: null,
    indexer: 'kickasstorrents-to', isBr: true, dubbed: true, quality: '720p',
  }];
  assert.equal(idxReleasesToRaw(legacy)[0].tracker, 'kickasstorrents-to');
});

test('record preserva tracker sem rebaixar para vazio', () => {
  const imdb = 'tt9100001';
  const hash = hex('a');
  releaseIndex.record(imdb, {}, [{
    title: 'Filme Teste 2024 1080p Dublado',
    infoHash: hash,
    seeders: 5,
    indexer: 'torrentio',
    tracker: 'ThePirateBay',
    isBr: true,
  }]);
  assert.equal(releaseIndex.lookup(imdb)[0].tracker, 'ThePirateBay');
  releaseIndex.record(imdb, {}, [{
    title: 'Filme Teste 2024 1080p Dublado',
    infoHash: hash,
    seeders: 6,
    indexer: 'torrentio',
    tracker: '',
    isBr: true,
  }]);
  assert.equal(releaseIndex.lookup(imdb)[0].tracker, 'ThePirateBay', 'vazio não apaga prior');
  assert.equal(idxReleasesToRaw(releaseIndex.lookup(imdb))[0].tracker, 'ThePirateBay');
});

test('attemptIndexFastPath: p=jackett não devolve torrentio nem conta na cobertura', async () => {
  const imdb = 'tt9100002';
  const torrentioHash = hex('b');
  const kickassHash = hex('c');
  // Só torrentio cobriria sozinho; kickass também cobre — filtra torrentio e mantém kickass.
  releaseIndex.record(imdb, {}, [
    {
      title: 'Filme Teste 2024 1080p Dublado',
      infoHash: torrentioHash,
      seeders: 50,
      indexer: 'torrentio',
      tracker: 'ThePirateBay',
      isBr: true,
    },
    {
      title: 'Filme Teste 2024 1080p Dublado',
      infoHash: kickassHash,
      seeders: 40,
      indexer: 'kickasstorrents-to',
      isBr: true,
    },
  ]);
  config.magnetBank.instantEnabled = false;
  const restoreInventory = patch(debrid as any, 'inventory', async () => []);
  const stub = stubFetch((url) => {
    if (url.includes('/api/v2.0/indexers/')) {
      return { ok: true, status: 200, json: async () => ({ Results: [] }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
  try {
    const out = await withOpts(
      { providers: ['jackett'], jackettIndexers: ['kickasstorrents-to', 'thepiratebay'] },
      () => attemptIndexFastPath({
        query: 'Filme Teste 2024',
        type: 'movie',
        id: imdb,
        imdbId: imdb,
        season: null,
        episode: null,
        ptQuery: null,
        matchContext: { names: ['Filme Teste'], year: 2024, isSeries: false, season: null, episode: null },
        sweepQuery: null,
        deadlineAt: Date.now() + 8000,
        isDemo: false,
      } as any),
    );
    assert.equal(out.servedFromIndex, true);
    const hashes = (out.raw?.items || []).map((i: any) => String(i.infoHash || '').toLowerCase());
    assert.ok(hashes.includes(kickassHash), 'kickass do índice entra');
    assert.equal(hashes.includes(torrentioHash), false, 'torrentio filtrado com p=jackett');
    const indexers = (out.raw?.items || []).map((i: any) => i.indexer);
    assert.equal(indexers.includes('torrentio'), false);
  } finally {
    restoreInventory();
    stub.restore();
    config.magnetBank.instantEnabled = saved.instantEnabled;
  }
});

test('attemptIndexFastPath: só torrentio no idx com p=jackett não cobre', async () => {
  const imdb = 'tt9100003';
  releaseIndex.record(imdb, {}, [{
    title: 'Filme Teste 2024 1080p Dublado',
    infoHash: hex('d'),
    seeders: 50,
    indexer: 'torrentio',
    isBr: true,
  }]);
  config.magnetBank.instantEnabled = false;
  const restoreInventory = patch(debrid as any, 'inventory', async () => []);
  const stub = stubFetch(() => ({ ok: true, status: 200, json: async () => ({ Results: [] }) }));
  try {
    const out = await withOpts(
      { providers: ['jackett'], jackettIndexers: ['kickasstorrents-to'] },
      () => attemptIndexFastPath({
        query: 'Filme Teste 2024',
        type: 'movie',
        id: imdb,
        imdbId: imdb,
        season: null,
        episode: null,
        ptQuery: null,
        matchContext: { names: ['Filme Teste'], year: 2024, isSeries: false, season: null, episode: null },
        sweepQuery: null,
        deadlineAt: Date.now() + 8000,
        isDemo: false,
      } as any),
    );
    assert.equal(out.servedFromIndex, false, 'torrentio filtrado → cobertura some');
    assert.equal(out.raw, null);
  } finally {
    restoreInventory();
    stub.restore();
    config.magnetBank.instantEnabled = saved.instantEnabled;
  }
});

test('collectInstantItems: fonte fora do ji é ignorada', () => {
  const imdb = 'tt9100004';
  seedBank(hex('e'), 'thepiratebay', imdb);
  seedBank(hex('f'), 'kickasstorrents-to', imdb);
  const blocked = withOpts(
    { providers: ['jackett'], jackettIndexers: ['kickasstorrents-to'] },
    () => collectInstantItems({ type: 'movie', imdbId: imdb, season: null, episode: null, preferDubbed: false }),
  );
  assert.equal(blocked.eligible, true);
  assert.equal(blocked.items.length, 1);
  assert.equal(blocked.items[0].indexer, 'kickasstorrents-to');
  assert.equal(blocked.items[0].infoHash, hex('f'));
});

test('collectFallbackItems: fonte fora do ji é ignorada', () => {
  const imdb = 'tt9100005';
  seedBank(hex('1'), 'thepiratebay', imdb);
  seedBank(hex('2'), 'kickasstorrents-to', imdb);
  const fb = withOpts(
    { providers: ['jackett'], jackettIndexers: ['kickasstorrents-to'] },
    () => collectFallbackItems({
      type: 'movie',
      imdbId: imdb,
      season: null,
      episode: null,
      liveHashes: new Set(),
      failedIndexers: new Set(['thepiratebay', 'kickasstorrents-to']),
      allFailed: false,
    }),
  );
  assert.equal(fb.injected, 1);
  assert.equal(fb.items[0].indexer, 'kickasstorrents-to');
});
