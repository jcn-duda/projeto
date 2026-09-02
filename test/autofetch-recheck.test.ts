import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import * as held from '../src/debrid/protected.js';
import * as autofetch from '../src/providers/autofetch.js';
import debrid from '../src/debrid/index.js';
import * as runtime from '../src/runtime.js';
import config from '../src/config.js';
import * as metrics from '../src/utils/metrics.js';
import { accountScope, streamsCacheKey } from '../src/utils/request-key.js';
import * as cache from '../src/utils/cache.js';
import { applyDebrid, findStreams } from '../src/providers/index.js';
import type { DebridAdapter } from '../types/domain.js';

test('recheck pós-enfileiramento esquece a busca quando o download fica pronto', async () => {
  const testMock = mock;
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const originalTorrentStatus = pmAdapter.torrentStatus;
  const account = accountScope('chave-recheck');
  const h = '1'.repeat(40);
  const searchKey = 'busca-recheck';
  const brDub = { infoHash: h, name: 'Coringa Dublado', _br: true, _dubbed: true, _quality: '1080p', _seeders: 1 };
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-recheck',
    debridCachedOnly: true,
    autoFetchBr: true,
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  let checks = 0;
  let serviceInsideRecheck;

  try {
    config.debrid.publicUrl = 'http://addon.test';
    pmAdapter.enqueue = async () => true;
    pmAdapter.torrentStatus = async () => ({});
    // 1ª checagem é a da busca; a 2ª (recheck) ainda vazia; a 3ª pronta.
    debrid.checkCached = async () => {
      checks += 1;
      serviceInsideRecheck = debrid.current()?.id;
      return checks <= 2
        ? { cached: new Set(), known: true }
        : { cached: new Set([h]), known: true };
    };
    // A busca já está cacheada, como o passe tardio deixa.
    cache.set(searchKey, { streams: [], partial: false }, 900);

    testMock.timers.enable({ apis: ['setTimeout'] });
    await runtime.run({ opts: userOpts, encoded: 'cfg-r' }, () =>
      applyDebrid([brDub], { searchKey } as any),
    );
    await flush();
    assert.equal(checks, 1, 'só a checagem da busca rodou até aqui');
    assert.notEqual(cache.get(searchKey), null, 'busca segue cacheada enquanto o download corre');

    // 1º recheck: ainda vazio — reagendado.
    testMock.timers.tick(120_000);
    await flush();
    assert.equal(checks, 2, 'primeiro recheck consultou o debrid');
    // O timer roda FORA do AsyncLocalStorage do request: o contexto capturado
    // precisa estar restaurado, senão a checagem iria sem a conta do usuário.
    assert.equal(serviceInsideRecheck, 'premiumize', 'recheck roda com o contexto da requisição');
    assert.notEqual(cache.get(searchKey), null, 'download não pronto não esquece a busca');

    // 2º recheck: pronto — a busca é esquecida para o cliente reconstruir ⚡.
    testMock.timers.tick(120_000);
    await flush();
    assert.equal(checks, 3, 'segundo recheck consultou o debrid');
    assert.equal(cache.get(searchKey), null, 'busca esquecida quando o download fica pronto');

    // Pronto = lote encerrado: nenhum recheck a mais.
    testMock.timers.tick(600_000);
    await flush();
    assert.equal(checks, 3, 'sem recheck depois de pronto');
  } finally {
    testMock.timers.reset();
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    pmAdapter.enqueue = originalEnqueue;
    pmAdapter.torrentStatus = originalTorrentStatus;
    autofetch.releaseSearch(searchKey);
    cache.forget(searchKey);
    cache.forget(autofetch.markerKey('premiumize', account, h));
    held.release(h, account);
  }
});

test('pack de temporada pronto invalida episódios indexados e semeia davail', async () => {
  const testMock = mock;
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const originalSeasonFill = config.debrid.autoFetchSeasonFill;
  const originalSeasonIndexMax = config.debrid.autoFetchSeasonIndexMax;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const originalTorrentStatus = pmAdapter.torrentStatus;
  const apiKey = 'chave-season-fill';
  const account = accountScope(apiKey);
  const imdbId = 'tt1234567';
  const ids = [`${imdbId}:1:1`, `${imdbId}:1:2`];
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: apiKey,
    debridCachedOnly: true,
    autoFetchBr: true,
  };
  const keys = ids.map((id) => streamsCacheKey('series', id, { ...userOpts, resolveUncached: config.debrid.resolveUncached }));
  const h = '7'.repeat(40);
  const pack = {
    infoHash: h,
    name: 'Show S01 Dublado',
    title: 'Show S01 Dublado',
    _br: true,
    _dubbed: true,
    _quality: '1080p',
    _seeders: 1,
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const davailBefore = cache.snapshot().namespaces.davail?.entries || 0;
  let checks = 0;

  try {
    config.debrid.publicUrl = 'http://addon.test';
    config.debrid.autoFetchSeasonFill = true;
    config.debrid.autoFetchSeasonIndexMax = 10;
    pmAdapter.enqueue = async () => true;
    pmAdapter.torrentStatus = async () => ({});
    debrid.checkCached = async () => {
      checks += 1;
      return checks === 1 ? { cached: new Set(), known: true } : { cached: new Set([h]), known: true };
    };
    for (const key of keys) cache.set(key, [{ infoHash: h }], 900);

    // O registro fica no início do findStreams e funciona inclusive em hit.
    await runtime.run({ opts: userOpts, encoded: 'cfg-season-fill' }, async () => {
      for (const id of ids) await findStreams({ type: 'series', id });
    });

    testMock.timers.enable({ apis: ['setTimeout'] });
    await runtime.run({ opts: userOpts, encoded: 'cfg-season-fill' }, () =>
      applyDebrid([pack], { searchKey: keys[0], imdbId, season: 1 } as any),
    );
    await flush();
    testMock.timers.tick(120_000);
    await flush();

    assert.equal(cache.get(keys[0]), null, 'a busca que enfileirou o pack é invalidada');
    assert.equal(cache.get(keys[1]), null, 'outro episódio da mesma temporada é invalidado');
    assert.equal(
      cache.snapshot().namespaces.davail?.entries || 0,
      davailBefore + 1,
      'o hash pronto é semeado no cache de disponibilidade',
    );
  } finally {
    testMock.timers.reset();
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    config.debrid.autoFetchSeasonFill = originalSeasonFill;
    config.debrid.autoFetchSeasonIndexMax = originalSeasonIndexMax;
    pmAdapter.enqueue = originalEnqueue;
    pmAdapter.torrentStatus = originalTorrentStatus;
    for (const key of keys) cache.forget(key);
    cache.forget(autofetch.markerKey('premiumize', account, h));
    held.release(h, account);
  }
});

test('episódio avulso pronto não invalida as outras chaves da temporada', async () => {
  const testMock = mock;
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const originalTorrentStatus = pmAdapter.torrentStatus;
  const account = accountScope('chave-episodio-avulso');
  const h = '6'.repeat(40);
  const searchKey = 'episodio-avulso-um';
  const otherKey = 'episodio-avulso-dois';
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-episodio-avulso',
    debridCachedOnly: true,
    autoFetchBr: true,
  };
  const episode = {
    infoHash: h, name: 'Show S01E01 Dublado', title: 'Show S01E01 Dublado',
    _br: true, _dubbed: true, _quality: '1080p', _seeders: 1,
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  let checks = 0;

  try {
    config.debrid.publicUrl = 'http://addon.test';
    pmAdapter.enqueue = async () => true;
    pmAdapter.torrentStatus = async () => ({});
    debrid.checkCached = async () => {
      checks += 1;
      return checks === 1 ? { cached: new Set(), known: true } : { cached: new Set([h]), known: true };
    };
    cache.set(searchKey, { streams: [] }, 900);
    cache.set(otherKey, { streams: [] }, 900);

    testMock.timers.enable({ apis: ['setTimeout'] });
    await runtime.run({ opts: userOpts, encoded: 'cfg-episodio-avulso' }, () =>
      applyDebrid([episode], { searchKey, imdbId: 'tt7654321', season: 1, episode: 1 } as any),
    );
    await flush();
    testMock.timers.tick(120_000);
    await flush();

    assert.equal(cache.get(searchKey), null, 'a busca do próprio episódio é invalidada');
    assert.notEqual(cache.get(otherKey), null, 'episódio avulso não invalida a temporada toda');
  } finally {
    testMock.timers.reset();
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    pmAdapter.enqueue = originalEnqueue;
    pmAdapter.torrentStatus = originalTorrentStatus;
    cache.forget(searchKey);
    cache.forget(otherKey);
    cache.forget(autofetch.markerKey('premiumize', account, h));
    held.release(h, account);
  }
});

test('LRU do índice descarta a temporada mais antiga sem invalidar suas chaves', async () => {
  const testMock = mock;
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const originalSeasonFill = config.debrid.autoFetchSeasonFill;
  const originalSeasonIndexMax = config.debrid.autoFetchSeasonIndexMax;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const originalTorrentStatus = pmAdapter.torrentStatus;
  const apiKey = 'chave-season-lru';
  const imdbId = 'tt7777777';
  const userOpts = {
    ...runtime.defaults(), debridService: 'premiumize', debridApiKey: apiKey, debridCachedOnly: true, autoFetchBr: true,
  };
  const ids = [`${imdbId}:1:1`, `${imdbId}:1:2`, `${imdbId}:2:1`];
  const keys = ids.map((id) => streamsCacheKey('series', id, { ...userOpts, resolveUncached: config.debrid.resolveUncached }));
  const h = '5'.repeat(40);
  const pack = {
    infoHash: h, name: 'Show S01 Dublado', title: 'Show S01 Dublado',
    _br: true, _dubbed: true, _quality: '1080p', _seeders: 1,
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  let checks = 0;

  try {
    config.debrid.publicUrl = 'http://addon.test';
    config.debrid.autoFetchSeasonFill = true;
    config.debrid.autoFetchSeasonIndexMax = 1;
    pmAdapter.enqueue = async () => true;
    pmAdapter.torrentStatus = async () => ({});
    debrid.checkCached = async () => {
      checks += 1;
      return checks === 1 ? { cached: new Set(), known: true } : { cached: new Set([h]), known: true };
    };
    for (const key of keys) cache.set(key, [{ infoHash: h }], 900);
    await runtime.run({ opts: userOpts, encoded: 'cfg-season-lru' }, async () => {
      for (const id of ids) await findStreams({ type: 'series', id });
    });

    testMock.timers.enable({ apis: ['setTimeout'] });
    await runtime.run({ opts: userOpts, encoded: 'cfg-season-lru' }, () =>
      applyDebrid([pack], { searchKey: keys[0], imdbId, season: 1 } as any),
    );
    await flush();
    testMock.timers.tick(120_000);
    await flush();

    assert.notEqual(cache.get(keys[1]), null, 'S01 foi despejada quando S02 ocupou a única vaga LRU');
  } finally {
    testMock.timers.reset();
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    config.debrid.autoFetchSeasonFill = originalSeasonFill;
    config.debrid.autoFetchSeasonIndexMax = originalSeasonIndexMax;
    pmAdapter.enqueue = originalEnqueue;
    pmAdapter.torrentStatus = originalTorrentStatus;
    for (const key of keys) cache.forget(key);
    cache.forget(autofetch.markerKey('premiumize', accountScope(apiKey), h));
    held.release(h, accountScope(apiKey));
  }
});

test('recheck esgota as tentativas sem esquecer a busca quando nada fica pronto', async () => {
  const testMock = mock;
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const originalTorrentStatus = pmAdapter.torrentStatus;
  const account = accountScope('chave-recheck-max');
  const h = '9'.repeat(40);
  const searchKey = 'busca-recheck-max';
  const brDub = { infoHash: h, name: 'Coringa Dublado', _br: true, _dubbed: true, _quality: '1080p', _seeders: 1 };
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-recheck-max',
    debridCachedOnly: true,
    autoFetchBr: true,
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  let checks = 0;

  try {
    config.debrid.publicUrl = 'http://addon.test';
    pmAdapter.enqueue = async () => true;
    pmAdapter.torrentStatus = async () => ({});
    debrid.checkCached = async () => {
      checks += 1;
      return { cached: new Set(), known: true };
    };
    cache.set(searchKey, { streams: [], partial: false }, 900);

    testMock.timers.enable({ apis: ['setTimeout'] });
    await runtime.run({ opts: userOpts, encoded: 'cfg-rmax' }, () =>
      applyDebrid([brDub], { searchKey } as any),
    );
    await flush();
    assert.equal(checks, 1, 'checagem inicial da busca');

    for (let i = 0; i < 3; i++) {
      testMock.timers.tick(120_000);
      await flush();
    }
    assert.equal(checks, 4, 'três rechecks e nenhum a mais');
    assert.notEqual(cache.get(searchKey), null, 'sem download pronto a busca segue valendo');

    testMock.timers.tick(600_000);
    await flush();
    assert.equal(checks, 4, 'lote esgotado não agenda mais nada');
  } finally {
    testMock.timers.reset();
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    pmAdapter.enqueue = originalEnqueue;
    pmAdapter.torrentStatus = originalTorrentStatus;
    autofetch.releaseSearch(searchKey);
    cache.forget(searchKey);
    cache.forget(autofetch.markerKey('premiumize', account, h));
    held.release(h, account);
  }
});
