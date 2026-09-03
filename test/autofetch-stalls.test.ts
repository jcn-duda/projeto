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
import { flush, brDubCandidate, autofetchUserOpts } from './helpers/autofetch-fixtures.js';

test('parado (stalled) por N rechecks: colapsa no limiar próprio com blacklist+remoção+dreno', async () => {
  const testMock = mock;
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const originalStall = config.debrid.autoFetchStallStreak;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const originalTorrentStatus = pmAdapter.torrentStatus;
  const originalRemoveTorrent = pmAdapter.removeTorrent;
  const account = accountScope('chave-stalled');
  const h = '3'.repeat(40);
  const searchKey = 'busca-stalled';
  const brDub = brDubCandidate(h);
  const userOpts = autofetchUserOpts('chave-stalled');
  const stalledBefore = metrics.snapshot().counters['autofetch.stalled'] || 0;
  let removals = 0;

  try {
    config.debrid.publicUrl = 'http://addon.test';
    config.debrid.autoFetchStallStreak = 2;
    pmAdapter.enqueue = async () => true;
    pmAdapter.torrentStatus = async () => ({ [h]: { state: 'downloading', stalled: true, id: 99 } });
    pmAdapter.removeTorrent = async () => { removals += 1; return true; };
    debrid.checkCached = async () => ({ cached: new Set(), known: true });
    cache.set(searchKey, { streams: [], partial: false }, 900);

    testMock.timers.enable({ apis: ['setTimeout'] });
    await runtime.run({ opts: userOpts, encoded: 'cfg-stall' }, () =>
      applyDebrid([brDub], { searchKey } as any),
    );
    await flush();

    testMock.timers.tick(120_000);
    await flush();
    assert.equal(autofetch.isDead('premiumize', account, h), false, '1ª observação isolada não derruba');
    assert.equal(removals, 0);

    testMock.timers.tick(120_000);
    await flush();
    assert.equal(autofetch.isDead('premiumize', account, h), true, 'no limiar vira blacklist');
    assert.equal(held.isHeld(h, account), false, 'parado colapsado libera o hold');
    assert.equal(removals, 1, 'remoção dispara no colapso');
    assert.equal(
      (metrics.snapshot().counters['autofetch.stalled'] || 0) - stalledBefore,
      1,
      'métrica autofetch.stalled contada no colapso',
    );

    testMock.timers.tick(600_000);
    await flush();
    assert.equal(removals, 1, 'sem recheck depois do colapso');
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

test('movimento zera a contagem de stall: só observações CONSECUTIVAS derrubam', async () => {
  const testMock = mock;
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const originalStall = config.debrid.autoFetchStallStreak;
  const originalRecheckMax = config.debrid.autoFetchRecheckMax;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const originalTorrentStatus = pmAdapter.torrentStatus;
  const originalRemoveTorrent = pmAdapter.removeTorrent;
  const account = accountScope('chave-stall-move');
  const h = '4'.repeat(40);
  const searchKey = 'busca-stall-move';
  const brDub = brDubCandidate(h);
  const userOpts = autofetchUserOpts('chave-stall-move');
  let removals = 0;
  let stallMode = true;

  try {
    config.debrid.publicUrl = 'http://addon.test';
    config.debrid.autoFetchStallStreak = 2;
    config.debrid.autoFetchRecheckMax = 20;
    pmAdapter.enqueue = async () => true;
    pmAdapter.torrentStatus = async () => ({ [h]: { state: 'downloading', stalled: stallMode, id: 99 } });
    pmAdapter.removeTorrent = async () => { removals += 1; return true; };
    debrid.checkCached = async () => ({ cached: new Set(), known: true });
    cache.set(searchKey, { streams: [], partial: false }, 900);

    testMock.timers.enable({ apis: ['setTimeout'] });
    await runtime.run({ opts: userOpts, encoded: 'cfg-stall-move' }, () =>
      applyDebrid([brDub], { searchKey } as any),
    );
    await flush();

    testMock.timers.tick(120_000);
    await flush();

    stallMode = false;
    testMock.timers.tick(120_000);
    await flush();
    assert.equal(autofetch.isDead('premiumize', account, h), false, 'movimento não derruba');
    assert.equal(removals, 0);

    stallMode = true;
    testMock.timers.tick(120_000);
    await flush();
    assert.equal(removals, 0, 'depois do movimento, um stall isolado não reinicia o limiar mais rápido');
    assert.equal(autofetch.isDead('premiumize', account, h), false);

    testMock.timers.tick(120_000);
    await flush();
    assert.equal(autofetch.isDead('premiumize', account, h), true, 'stalls consecutivos após o reset derrubam');
    assert.equal(removals, 1);
  } finally {
    testMock.timers.reset();
    config.debrid.autoFetchStallStreak = originalStall;
    config.debrid.autoFetchRecheckMax = originalRecheckMax;
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

test('stall prévio não adianta o colapso do dead: contadores são independentes', async () => {
  const testMock = mock;
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const originalStall = config.debrid.autoFetchStallStreak;
  const originalRecheckMax = config.debrid.autoFetchRecheckMax;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const originalTorrentStatus = pmAdapter.torrentStatus;
  const originalRemoveTorrent = pmAdapter.removeTorrent;
  const account = accountScope('chave-stall-dead');
  const h = '5'.repeat(40);
  const searchKey = 'busca-stall-dead';
  const brDub = brDubCandidate(h);
  const userOpts = autofetchUserOpts('chave-stall-dead');
  let removals = 0;
  let mode: 'stall' | 'dead' | 'moving' = 'stall';

  try {
    config.debrid.publicUrl = 'http://addon.test';
    config.debrid.autoFetchStallStreak = 3;
    config.debrid.autoFetchRecheckMax = 20;
    pmAdapter.enqueue = async () => true;
    pmAdapter.torrentStatus = async () => mode === 'stall'
      ? { [h]: { state: 'downloading', stalled: true, id: 99 } }
      : mode === 'dead'
        ? { [h]: { state: 'dead', id: 99 } }
        : { [h]: { state: 'downloading', id: 99 } };
    pmAdapter.removeTorrent = async () => { removals += 1; return true; };
    debrid.checkCached = async () => ({ cached: new Set(), known: true });
    cache.set(searchKey, { streams: [], partial: false }, 900);

    testMock.timers.enable({ apis: ['setTimeout'] });
    await runtime.run({ opts: userOpts, encoded: 'cfg-stall-dead' }, () =>
      applyDebrid([brDub], { searchKey } as any),
    );
    await flush();

    testMock.timers.tick(120_000);
    await flush();

    mode = 'dead';
    testMock.timers.tick(120_000);
    await flush();
    assert.equal(autofetch.isDead('premiumize', account, h), false, '1º dead após stall não colapsa');
    assert.equal(removals, 0);

    testMock.timers.tick(120_000);
    await flush();
    assert.equal(autofetch.isDead('premiumize', account, h), true, '2º dead consecutivo colapsa');
    assert.equal(removals, 1);
  } finally {
    testMock.timers.reset();
    config.debrid.autoFetchStallStreak = originalStall;
    config.debrid.autoFetchRecheckMax = originalRecheckMax;
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

test('falha de torrentStatus não zera streak de stall: colapso só no 3º recheck', async () => {
  const testMock = mock;
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const originalStall = config.debrid.autoFetchStallStreak;
  const originalRecheckMax = config.debrid.autoFetchRecheckMax;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const originalTorrentStatus = pmAdapter.torrentStatus;
  const originalRemoveTorrent = pmAdapter.removeTorrent;
  const account = accountScope('chave-stall-status-fail');
  const h = '6'.repeat(40);
  const searchKey = 'busca-stall-status-fail';
  const brDub = brDubCandidate(h);
  const userOpts = autofetchUserOpts('chave-stall-status-fail');
  const stalledBefore = metrics.snapshot().counters['autofetch.stalled'] || 0;
  let removals = 0;
  let statusCalls = 0;

  try {
    config.debrid.publicUrl = 'http://addon.test';
    config.debrid.autoFetchStallStreak = 2;
    config.debrid.autoFetchRecheckMax = 20;
    pmAdapter.enqueue = async () => true;
    pmAdapter.torrentStatus = async () => {
      statusCalls += 1;
      if (statusCalls === 2) throw new Error('torrentStatus offline');
      return { [h]: { state: 'downloading', stalled: true, id: 99 } };
    };
    pmAdapter.removeTorrent = async () => { removals += 1; return true; };
    debrid.checkCached = async () => ({ cached: new Set(), known: true });
    cache.set(searchKey, { streams: [], partial: false }, 900);

    testMock.timers.enable({ apis: ['setTimeout'] });
    await runtime.run({ opts: userOpts, encoded: 'cfg-stall-status-fail' }, () =>
      applyDebrid([brDub], { searchKey } as any),
    );
    await flush();

    testMock.timers.tick(120_000);
    await flush();
    assert.equal(autofetch.isDead('premiumize', account, h), false, '1º stalled não colapsa');
    assert.equal(removals, 0);

    testMock.timers.tick(120_000);
    await flush();
    assert.equal(autofetch.isDead('premiumize', account, h), false, 'falha de status é neutra — streak preservada');
    assert.equal(removals, 0);
    assert.equal(statusCalls, 2, '2º recheck chegou a chamar torrentStatus (e throw)');

    testMock.timers.tick(120_000);
    await flush();
    assert.equal(statusCalls, 3, '3º recheck consultou status de novo após o throw');
    assert.equal(autofetch.isDead('premiumize', account, h), true, '2 stalls com neutro no meio colapsam no limiar');
    assert.equal(removals, 1, 'removeTorrent no colapso');
    assert.equal(
      (metrics.snapshot().counters['autofetch.stalled'] || 0) - stalledBefore,
      1,
      'métrica autofetch.stalled no colapso',
    );
  } finally {
    testMock.timers.reset();
    config.debrid.autoFetchStallStreak = originalStall;
    config.debrid.autoFetchRecheckMax = originalRecheckMax;
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

test('pack "Temporada Completa" sem número não dispara season fill', async () => {
  const testMock = mock;
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const originalSeasonFill = config.debrid.autoFetchSeasonFill;
  const originalSeasonIndexMax = config.debrid.autoFetchSeasonIndexMax;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const originalTorrentStatus = pmAdapter.torrentStatus;
  const apiKey = 'chave-season-fill-sem-numero';
  const account = accountScope(apiKey);
  const imdbId = 'tt7654321';
  const ids = [`${imdbId}:1:1`, `${imdbId}:1:2`];
  const userOpts = autofetchUserOpts(apiKey);
  const keys = ids.map((id) => streamsCacheKey('series', id, { ...userOpts, resolveUncached: config.debrid.resolveUncached }));
  const h = '8'.repeat(40);
  const pack = {
    ...brDubCandidate(h, 'Show Temporada Completa Dublado'),
    title: 'Show Temporada Completa Dublado',
  };
  const davailBefore = cache.snapshot().namespaces.davail?.entries || 0;
  const fillBefore = metrics.snapshot().counters['autofetch.season-fill'] || 0;
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

    await runtime.run({ opts: userOpts, encoded: 'cfg-fill-sem-numero' }, async () => {
      for (const id of ids) await findStreams({ type: 'series', id });
    });

    testMock.timers.enable({ apis: ['setTimeout'] });
    await runtime.run({ opts: userOpts, encoded: 'cfg-fill-sem-numero' }, () =>
      applyDebrid([pack], { searchKey: keys[0], imdbId, season: 1 } as any),
    );
    await flush();
    testMock.timers.tick(120_000);
    await flush();

    assert.equal(cache.get(keys[1]) != null, true, 'episódio vizinho não é invalidado sem prova de temporada');
    assert.equal(
      cache.snapshot().namespaces.davail?.entries || 0,
      davailBefore + 1,
      'hash pronto é semeado no cache de disponibilidade mesmo sem prova de temporada',
    );
    assert.equal(
      (metrics.snapshot().counters['autofetch.season-fill'] || 0) - fillBefore,
      0,
      'métrica de fill não conta',
    );
  } finally {
    testMock.timers.reset();
    config.debrid.autoFetchSeasonFill = originalSeasonFill;
    config.debrid.autoFetchSeasonIndexMax = originalSeasonIndexMax;
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    pmAdapter.enqueue = originalEnqueue;
    pmAdapter.torrentStatus = originalTorrentStatus;
    for (const key of keys) cache.forget(key);
    cache.forget(autofetch.markerKey('premiumize', account, h));
    held.release(h, account);
  }
});
