import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import * as held from '../src/debrid/protected.js';
import * as autofetch from '../src/providers/autofetch.js';
import debrid from '../src/debrid/index.js';
import * as runtime from '../src/runtime.js';
import config from '../src/config.js';
import autofetchLive from '../src/utils/autofetch-live.js';
import * as metrics from '../src/utils/metrics.js';
import { accountScope, streamsCacheKey } from '../src/utils/request-key.js';
import * as cache from '../src/utils/cache.js';
import { applyDebrid, findStreams } from '../src/providers/index.js';
import type { DebridAdapter } from '../types/domain.js';
import { flush, brDubCandidate, autofetchUserOpts } from './helpers/autofetch-fixtures.js';

function clearDead(adapterId: string, account: string, hashes: string[]) {
  for (const h of hashes) cache.forget(autofetch.deadKey(adapterId, account, h));
}

test('pack "Temporada Completa" sem número não dispara season fill', async () => {
  autofetchLive.reset();
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
  const h = 'sf00000000000000000000000000000000000001';
  const pack = {
    ...brDubCandidate(h, 'Show Temporada Completa Dublado'),
    title: 'Show Temporada Completa Dublado',
  };
  const davailBefore = cache.snapshot().namespaces.davail?.entries || 0;
  const fillBefore = metrics.snapshot().counters['autofetch.season-fill'] || 0;
  let checks = 0;

  try {
    clearDead('premiumize', account, [h]);
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