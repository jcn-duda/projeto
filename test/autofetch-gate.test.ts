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

test('hash NÃO-pack pronto no recheck semeia davail', async () => {
  const testMock = mock;
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const originalTorrentStatus = pmAdapter.torrentStatus;
  const apiKey = 'chave-davail-nao-pack';
  const account = accountScope(apiKey);
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: apiKey,
    debridCachedOnly: true,
    autoFetchBr: true,
  };
  const searchKey = streamsCacheKey('movie', 'tt5555555', { ...userOpts, resolveUncached: config.debrid.resolveUncached });
  const h = 'f'.repeat(40);
  const filme = {
    infoHash: h,
    name: 'Filme Qualquer Dublado',
    title: 'Filme Qualquer Dublado',
    _br: true,
    _dubbed: true,
    _quality: '1080p',
    _seeders: 1,
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const davailBefore = cache.snapshot().namespaces.davail?.entries || 0;
  const readyNoteBefore = metrics.snapshot().counters['autofetch.ready-note'] || 0;
  let checks = 0;

  try {
    config.debrid.publicUrl = 'http://addon.test';
    pmAdapter.enqueue = async () => true;
    pmAdapter.torrentStatus = async () => ({});
    debrid.checkCached = async () => {
      checks += 1;
      return checks === 1 ? { cached: new Set(), known: true } : { cached: new Set([h]), known: true };
    };

    testMock.timers.enable({ apis: ['setTimeout'] });
    await runtime.run({ opts: userOpts, encoded: 'cfg-davail-nao-pack' }, () =>
      applyDebrid([filme], { searchKey } as any),
    );
    await flush();
    testMock.timers.tick(120_000);
    await flush();

    assert.equal(checks >= 2, true, 'o recheck consultou o debrid depois do aceite');
    assert.equal(cache.get(searchKey), null, 'a busca que enfileirou é invalidada quando o download fica pronto');
    assert.equal(
      cache.snapshot().namespaces.davail?.entries || 0,
      davailBefore + 1,
      'hash NÃO-pack pronto é semeado no cache de disponibilidade',
    );
    assert.equal(
      (metrics.snapshot().counters['autofetch.ready-note'] || 0) - readyNoteBefore,
      1,
      'o ready que semeia o davail conta em autofetch.ready-note',
    );
  } finally {
    testMock.timers.reset();
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    pmAdapter.enqueue = originalEnqueue;
    pmAdapter.torrentStatus = originalTorrentStatus;
    cache.forget(searchKey);
    cache.forget(autofetch.markerKey('premiumize', account, h));
    held.release(h, account);
  }
});

test('T4a: adaptador sem cacheCheck (Real-Debrid/Debrid-Link) não semeia davail nem conta season-fill', async () => {
  const testMock = mock;
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const originalSeasonFill = config.debrid.autoFetchSeasonFill;
  const originalSeasonIndexMax = config.debrid.autoFetchSeasonIndexMax;
  const rdAdapter = debrid.BY_ID.get('realdebrid') as DebridAdapter;
  const originalLedger = config.debrid.rdLedger.enabled;
  const originalOracle = config.debrid.rdOracle.enabled;
  const originalEnqueue = rdAdapter.enqueue;
  const originalTorrentStatus = rdAdapter.torrentStatus;
  const apiKey = 'chave-season-fill-rd';
  const account = accountScope(apiKey);
  const imdbId = 'tt8888888';
  const ids = [`${imdbId}:1:1`, `${imdbId}:1:2`];
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'realdebrid',
    debridApiKey: apiKey,
    debridCachedOnly: false,
    autoFetchBr: true,
  };
  const keys = ids.map((id) => streamsCacheKey('series', id, { ...userOpts, resolveUncached: config.debrid.resolveUncached }));
  const h = '8'.repeat(40);
  const pack = {
    infoHash: h,
    name: 'Show RD S01 Dublado',
    title: 'Show RD S01 Dublado',
    _br: true,
    _dubbed: true,
    _quality: '1080p',
    _seeders: 1,
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const davailBefore = cache.snapshot().namespaces.davail?.entries || 0;
  const fillBefore = metrics.snapshot().counters['autofetch.season-fill'] || 0;

  try {
    config.debrid.publicUrl = 'http://addon.test';
    config.debrid.autoFetchSeasonFill = true;
    config.debrid.autoFetchSeasonIndexMax = 10;
    config.debrid.rdLedger.enabled = false;
    config.debrid.rdOracle.enabled = false;
    rdAdapter.enqueue = async () => true;
    rdAdapter.torrentStatus = async () => ({ [h]: { state: 'ready', id: 'rd-1' } });
    debrid.checkCached = async () => ({ cached: new Set(), known: true });

    for (const key of keys) cache.set(key, [{ infoHash: h }], 900);

    await runtime.run({ opts: userOpts, encoded: 'cfg-sf-rd' }, async () => {
      for (const id of ids) await findStreams({ type: 'series', id });
    });

    testMock.timers.enable({ apis: ['setTimeout'] });
    await runtime.run({ opts: userOpts, encoded: 'cfg-sf-rd' }, () =>
      applyDebrid([pack], { searchKey: keys[0], imdbId, season: 1 } as any),
    );
    await flush();
    testMock.timers.tick(120_000);
    await flush();

    assert.equal(
      cache.snapshot().namespaces.davail?.entries || 0,
      davailBefore,
      'adaptador com cacheCheck: false não semeia davail',
    );
    assert.equal(
      (metrics.snapshot().counters['autofetch.season-fill'] || 0) - fillBefore,
      0,
      'adaptador com cacheCheck: false não incrementa autofetch.season-fill',
    );
  } finally {
    testMock.timers.reset();
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    config.debrid.autoFetchSeasonFill = originalSeasonFill;
    config.debrid.autoFetchSeasonIndexMax = originalSeasonIndexMax;
    config.debrid.rdLedger.enabled = originalLedger;
    config.debrid.rdOracle.enabled = originalOracle;
    rdAdapter.enqueue = originalEnqueue;
    rdAdapter.torrentStatus = originalTorrentStatus;
    for (const key of keys) cache.forget(key);
    cache.forget(autofetch.markerKey('realdebrid', account, h));
    held.release(h, account);
  }
});

test('T4b: autoFetchStallStreak = 0 não colapsa nem remove torrent stalled (parado nunca derruba)', async () => {
  const testMock = mock;
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const originalStall = config.debrid.autoFetchStallStreak;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const originalTorrentStatus = pmAdapter.torrentStatus;
  const originalRemoveTorrent = pmAdapter.removeTorrent;
  const account = accountScope('chave-stall-zero');
  const h = '9'.repeat(40);
  const searchKey = 'busca-stall-zero';
  const brDub = { infoHash: h, name: 'Filme Stall Zero Dublado', _br: true, _dubbed: true, _quality: '1080p', _seeders: 1 };
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-stall-zero',
    debridCachedOnly: false,
    autoFetchBr: true,
  };
  let removals = 0;
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const stalledBefore = metrics.snapshot().counters['autofetch.stalled'] || 0;

  try {
    config.debrid.autoFetchStallStreak = 0;
    config.debrid.publicUrl = 'http://addon.test';
    pmAdapter.enqueue = async () => true;
    pmAdapter.torrentStatus = async () => ({ [h]: { state: 'downloading', stalled: true, id: 99 } });
    pmAdapter.removeTorrent = async () => { removals += 1; return true; };
    debrid.checkCached = async () => ({ cached: new Set(), known: true });

    testMock.timers.enable({ apis: ['setTimeout'] });
    await runtime.run({ opts: userOpts, encoded: 'cfg-stall-zero' }, () =>
      applyDebrid([brDub], { searchKey } as any),
    );
    await flush();

    for (let i = 0; i < 5; i++) {
      testMock.timers.tick(120_000);
      await flush();
    }

    assert.equal(removals, 0, 'com autoFetchStallStreak=0 removeTorrent nunca é chamado');
    assert.equal(
      autofetch.isDead('premiumize', account, h),
      false,
      'torrent stalled não entra em blacklist quando stallStreak é 0',
    );
    assert.equal(
      (metrics.snapshot().counters['autofetch.stalled'] || 0) - stalledBefore,
      0,
      'métrica autofetch.stalled não é incrementada',
    );
  } finally {
    testMock.timers.reset();
    config.debrid.autoFetchStallStreak = originalStall;
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    pmAdapter.enqueue = originalEnqueue;
    pmAdapter.torrentStatus = originalTorrentStatus;
    pmAdapter.removeTorrent = originalRemoveTorrent;
    autofetch.releaseSearch(searchKey);
    cache.forget(searchKey);
    cache.forget(autofetch.markerKey('premiumize', account, h));
    held.release(h, account);
  }
});

test('gate de ocupação: memo frio é fail-open e memo quente acima do limiar bloqueia o enqueue', async () => {
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const originalPauseAt = config.debrid.autoFetchPauseAt;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const originalStatus = pmAdapter.accountStatus;
  const account = accountScope('chave-gate-cheia');
  const sleep = (ms: any) => new Promise((resolve) => setTimeout(resolve, ms));
  const brDub = (hash: any) => ({
    infoHash: hash, name: 'Filme Conta Cheia Dublado', _br: true, _dubbed: true, _quality: '1080p', _seeders: 1,
  });
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-gate-cheia',
    debridCachedOnly: true,
    autoFetchBr: true,
  };
  const run = (h: any, searchKey: any) => runtime.run({ opts: userOpts, encoded: 'cfg-gate' }, () =>
    applyDebrid([brDub(h)], { searchKey } as any),
  );
  const hCold = 'e'.repeat(40);
  const hHot = 'f'.repeat(40);
  let enqueues = 0;
  const gatedBefore = metrics.snapshot().counters['autofetch.account-gated'] || 0;

  try {
    config.debrid.publicUrl = 'http://addon.test';
    config.debrid.autoFetchPauseAt = 5;
    pmAdapter.enqueue = async () => { enqueues += 1; return true; };
    pmAdapter.accountStatus = async () => ({ magnets: 900 });
    debrid.checkCached = async () => ({ cached: new Set(), known: true });
    autofetch.resetAccountGate();

    assert.equal(autofetch.accountGateBlocked(pmAdapter, 'chave-gate-cheia'), false, 'memo frio não bloqueia');
    await sleep(20);
    assert.equal(autofetch.accountGateBlocked(pmAdapter, 'chave-gate-cheia'), true, 'memo quente acima do limiar bloqueia');

    await run(hHot, 'gate-cheio');
    await sleep(20);
    assert.equal(enqueues, 0, 'conta cheia impede o debrid.enqueue');
    assert.equal(held.isHeld(hHot, account), false, 'bloqueio libera o hold do candidato');
    assert.equal(cache.get(autofetch.markerKey('premiumize', account, hHot)), null, 'bloqueio não grava marker');
    assert.equal(
      (metrics.snapshot().counters['autofetch.account-gated'] || 0) - gatedBefore,
      1,
      'bloqueio contado uma vez em autofetch.account-gated',
    );

    autofetch.resetAccountGate();
    await run(hCold, 'gate-frio');
    await sleep(20);
    assert.equal(enqueues, 1, 'primeira chamada com memo frio enfileira normalmente');
    assert.equal(held.isHeld(hCold, account), true, 'aceite mantém o hold');

    assert.equal(autofetch.accountGateBlocked(pmAdapter, 'chave-gate-cheia'), true, 'refresh da busca fria reaqueceu o memo');
    config.debrid.autoFetchPauseAt = 0;
    assert.equal(autofetch.accountGateBlocked(pmAdapter, 'chave-gate-cheia'), false, 'flag 0 desliga o gate');
  } finally {
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    config.debrid.autoFetchPauseAt = originalPauseAt;
    pmAdapter.enqueue = originalEnqueue;
    pmAdapter.accountStatus = originalStatus;
    autofetch.resetAccountGate();
    autofetch.releaseSearch('gate-frio');
    autofetch.releaseSearch('gate-cheio');
    for (const h of [hCold, hHot]) {
      cache.forget(autofetch.markerKey('premiumize', account, h));
      held.release(h, account);
    }
  }
});
