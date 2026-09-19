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
import * as suppressed from '../src/providers/autofetch-suppressed.js';
import { runRecheck, recheckLots } from '../src/providers/autofetch-recheck.js';
import { accountScope } from '../src/utils/request-key.js';
import { preexisting } from '../src/debrid/alldebrid-inventory.js';
import { applyDebrid } from '../src/providers/index.js';
import { pmAdapter, account, brDub, userOpts } from './helpers/autofetch-skip-common.js';
import { sleep } from './helpers/autofetch-fixtures.js';
import type { DebridAdapter } from '../types/domain.js';

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

// --- expired-unready: o gate de remoção por id vale na expiração ------------

async function expireProbe(via: 'id' | 'hash', removeById: boolean, preparar?: (account: string, hash: string) => void) {
  const originalCheck = debrid.checkCached;
  const originalTtl = config.debrid.autoFetchTtl;
  const originalRemoveById = config.debrid.removeById;
  const ad = debrid.BY_ID.get('alldebrid') as DebridAdapter;
  const originalStatus = ad.torrentStatus;
  const originalRemove = ad.removeTorrent;
  const chave = `chave-exp-ad-${via}`;
  const account = accountScope(chave);
  const searchKey = `busca-exp-ad-${via}`;
  const h = (via === 'id' ? 'e7' : 'e8').repeat(20);
  let removals = 0;
  let result: { removals: number; suppressed: number; discarded: boolean; account: string; hash: string } | null = null;
  try {
    config.debrid.autoFetchTtl = 1;
    config.debrid.removeById = removeById;
    ad.torrentStatus = async () => ({ [h]: { state: 'downloading', id: 555, via } });
    ad.removeTorrent = async () => { removals += 1; return true; };
    debrid.checkCached = async () => ({ cached: new Set(), known: true });
    preparar?.(account, h);
    recheckLots.set(searchKey, {
      hashes: new Set([h]), attempts: 9, timer: null, inFlight: false,
      ctx: { opts: { ...runtime.defaults(), debridService: 'alldebrid', debridApiKey: chave }, encoded: 'cfg-exp-ad' },
      deadStreak: new Map(), stallStreak: new Map(), seasonHints: new Map(),
      createdAt: Date.now() - 5000, isSettle: true, refusals: 0, adapterId: 'alldebrid',
    });
    runRecheck(searchKey);
    await sleep(30);
    result = {
      removals,
      suppressed: suppressed.listSuppressed('alldebrid', account).length,
      discarded: !recheckLots.has(searchKey),
      account,
      hash: h,
    };
  } finally {
    config.debrid.autoFetchTtl = originalTtl;
    config.debrid.removeById = originalRemoveById;
    debrid.checkCached = originalCheck;
    ad.torrentStatus = originalStatus;
    ad.removeTorrent = originalRemove;
    const lote = recheckLots.get(searchKey);
    if (lote?.timer) clearTimeout(lote.timer);
    recheckLots.delete(searchKey);
    autofetch.releaseSearch(searchKey);
    autofetch.dropQueue(searchKey);
    cache.forget(autofetch.markerKey('alldebrid', account, h));
    cache.forget(autofetch.deadKey('alldebrid', account, h));
    held.release(h, account);
    held.unprotect('alldebrid', account, h);
    preexisting.delete(account);
    suppressed.forgetSuppressed('alldebrid', account, h);
  }
  if (!result) throw new Error('probe sem resultado');
  return result;
}

test('expired-unready: AllDebrid via=id sem removeById NÃO remove direto — represa', async () => {
  const r = await expireProbe('id', false);
  assert.equal(r.discarded, true, 'lote expirado é descartado');
  assert.equal(r.removals, 0, 'nada é apagado da conta direto na expiração');
  assert.equal(r.suppressed, 1, 'o hash vai para a fila de represados');
});

test('expired-unready: via=hash remove direto quando a posse é provada (marker + snapshot sem o hash)', async () => {
  const r = await expireProbe('hash', false, (account, h) => {
    // Prova de posse (marker do enqueue) + inventário carregado sem o hash.
    // Sem isso o P1.2 manda para represados — ver autofetch-expired-ownership.
    cache.set(autofetch.markerKey('alldebrid', account, h), 1, 3600);
    preexisting.set(account, { hashes: new Set(), loadedAt: Date.now() });
  });
  assert.equal(r.removals, 1, 'posse provada mantém a remoção direta do via=hash');
  assert.equal(r.suppressed, 0, 'nada represado quando a remoção acontece');
});
