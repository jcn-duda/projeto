import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import config from '../src/config.js';
import * as autofetch from '../src/providers/autofetch.js';
import * as cache from '../src/utils/cache.js';
import * as held from '../src/debrid/protected.js';
import * as metrics from '../src/utils/metrics.js';
import * as runtime from '../src/runtime.js';
import debrid from '../src/debrid/index.js';
import { applyDebrid } from '../src/providers/index.js';
import { pmAdapter, account, brDub, userOpts } from './helpers/autofetch-skip-common.js';

test('H2: settle expirado apaga o marcador junto do torrent (sem esperar o TTL)', async () => {
  // Discrimina mantendo o marker (6h) vivo além do horizonte do settle.
  const h = '3'.repeat(40);
  const searchKey = 'busca-settle-expira';
  const originalEnqueue = pmAdapter.enqueue;
  const originalTorrentStatus = pmAdapter.torrentStatus;
  const originalRemoveTorrent = pmAdapter.removeTorrent;
  const originalCheck = debrid.checkCached;
  const originalTtl = config.debrid.autoFetchTtl;
  const originalRecheckMs = config.debrid.autoFetchRecheckMs;
  const originalRecheckMax = config.debrid.autoFetchRecheckMax;
  const originalSettleMs = config.debrid.autoFetchSettleMs;
  const originalStall = config.debrid.autoFetchStallStreak;
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  try {
    config.debrid.autoFetchRecheckMs = 1000;
    config.debrid.autoFetchRecheckMax = 1;
    config.debrid.autoFetchSettleMs = 1000;
    config.debrid.autoFetchStallStreak = 0;
    pmAdapter.enqueue = async () => true;
    pmAdapter.torrentStatus = async () => ({ [h]: { state: 'downloading', id: 99 } });
    pmAdapter.removeTorrent = async () => true;
    debrid.checkCached = async () => ({ cached: new Set(), known: true });

    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    // O settle encolhe só depois do marker nascer com TTL 6h.
    config.debrid.autoFetchTtl = 3600;
    await runtime.run({ opts: userOpts(), encoded: 'cfg-settle' }, () =>
      applyDebrid([brDub(h) as any], { searchKey } as any),
    );
    await flush();
    const markerKey = autofetch.markerKey('premiumize', account, h);
    assert.equal(cache.get(markerKey), 1, 'enqueue aceito grava o marcador');

    config.debrid.autoFetchTtl = 2;
    // 1º recheck (vira settle) + 1º settle com idade >= TTL*1000.
    mock.timers.tick(1000);
    await flush();
    mock.timers.tick(1000);
    await flush();

    assert.equal(cache.get(markerKey), null, 'H2: marcador apagado no settle expirado');
    assert.equal(held.isHeld(h, account), false, 'hold liberado no settle expirado');
    assert.ok((metrics.snapshot().counters['autofetch.expired-unready'] || 0) >= 1);
  } finally {
    mock.timers.reset();
    config.debrid.autoFetchTtl = originalTtl;
    config.debrid.autoFetchRecheckMs = originalRecheckMs;
    config.debrid.autoFetchRecheckMax = originalRecheckMax;
    config.debrid.autoFetchSettleMs = originalSettleMs;
    config.debrid.autoFetchStallStreak = originalStall;
    debrid.checkCached = originalCheck;
    pmAdapter.enqueue = originalEnqueue;
    pmAdapter.torrentStatus = originalTorrentStatus;
    pmAdapter.removeTorrent = originalRemoveTorrent;
    cache.forget(autofetch.markerKey('premiumize', account, h));
    held.release(h, account);
    cache.forget(searchKey);
  }
});
