import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import * as autofetch from '../src/providers/autofetch.js';
import * as cache from '../src/utils/cache.js';
import * as held from '../src/debrid/protected.js';
import config from '../src/config.js';
import { canAutoFetchBr } from '../src/utils/format.js';
import type { DebridAdapter } from '../types/domain.js';

const H1 = '1111111111111111111111111111111111111111';
const H2 = '2222222222222222222222222222222222222222';
const H3 = '3333333333333333333333333333333333333333';
const H4 = '4444444444444444444444444444444444444444';

test('fila persistente: writeQueue, readQueue, dropQueue e takeNext', () => {
  const searchKey = 'streams:v5:series:tt0903747:1:1';
  autofetch.dropQueue(searchKey);

  const candidates: autofetch.QueueCandidate[] = [
    { infoHash: H1, title: 'Breaking Bad S01E01 1080p DUB', quality: '1080p' },
    { infoHash: H2, title: 'Breaking Bad S01E01 720p DUB', quality: '720p' },
    { infoHash: H1, title: 'Breaking Bad S01E01 Duplicate' },
  ];

  autofetch.writeQueue(searchKey, candidates, 3600);
  const read = autofetch.readQueue(searchKey);
  assert.equal(read.length, 2, 'deduplica hashes na gravacao da fila');
  assert.equal(read[0].infoHash, H1);
  assert.equal(read[1].infoHash, H2);

  const { next, remaining } = autofetch.takeNext(read);
  assert.equal(next?.infoHash, H1);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].infoHash, H2);

  autofetch.dropQueue(searchKey);
  assert.deepEqual(autofetch.readQueue(searchKey), []);
});

test('blacklist de torrents mortos: isDead e blacklist com TTL', () => {
  const adapterId = 'alldebrid';
  const account = 'acc_test_dead';
  assert.equal(autofetch.isDead(adapterId, account, H1), false);

  autofetch.blacklist(adapterId, account, H1, 86400);
  assert.equal(autofetch.isDead(adapterId, account, H1), true);
  assert.equal(autofetch.isDead('other_adapter', account, H1), false);
  assert.equal(autofetch.isDead(adapterId, 'other_acc', H1), false);
});

test('takeNext pula hashes mortos, já cacheados ou protegidos', () => {
  const searchKey = 'streams:v5:movie:tt123456';
  const adapterId = 'torbox';
  const account = 'acc_skip_test';

  autofetch.blacklist(adapterId, account, H1, 86400);
  cache.set(autofetch.markerKey(adapterId, account, H2), 1, 3600);
  held.hold(H3, 3600, account);

  const queue: autofetch.QueueCandidate[] = [
    { infoHash: H1, title: 'Dead candidate' },
    { infoHash: H2, title: 'Already marked candidate' },
    { infoHash: H3, title: 'Currently held candidate' },
    { infoHash: H4, title: 'Good candidate' },
  ];

  const { next, remaining } = autofetch.takeNext(queue, (cand) => {
    const h = String(cand.infoHash).toLowerCase();
    return (
      autofetch.isDead(adapterId, account, h) ||
      Boolean(cache.get(autofetch.markerKey(adapterId, account, h))) ||
      held.isHeld(h, account)
    );
  });

  assert.equal(next?.infoHash, H4, 'pula H1 (dead), H2 (marker) e H3 (held)');
  assert.equal(remaining.length, 3);
  held.release(H3, account);
});

test('orçamento deslizante de enqueues/hora por adapter:account', () => {
  const adapterId = 'torbox';
  const account = 'budget_user';
  autofetch.resetBudget(adapterId, account);

  const limit = 3;
  assert.equal(autofetch.checkAndRecordBudget(adapterId, account, limit), true);
  assert.equal(autofetch.checkAndRecordBudget(adapterId, account, limit), true);
  assert.equal(autofetch.checkAndRecordBudget(adapterId, account, limit), true);
  assert.equal(autofetch.checkAndRecordBudget(adapterId, account, limit), false, 'quarto enqueue bloqueado pelo limite');

  // Outra conta não é afetada
  assert.equal(autofetch.checkAndRecordBudget(adapterId, 'other_user', limit), true);
  autofetch.resetBudget();
});

test('canAutoFetchBr aceita tanto cacheCheck quanto autofetchSource (RD/DL)', () => {
  const mockAllDebrid: DebridAdapter = {
    id: 'alldebrid',
    label: 'AllDebrid',
    short: 'AD',
    cacheCheck: true,
    keyUrl: '',
    checkCached: async () => ({ cached: new Set(), known: true }),
    resolveLink: async () => 'http://stream.url',
  };

  const mockRealDebrid: DebridAdapter = {
    id: 'realdebrid',
    label: 'Real-Debrid',
    short: 'RD',
    cacheCheck: false,
    autofetchSource: true,
    keyUrl: '',
    checkCached: async () => ({ cached: new Set(), known: false }),
    resolveLink: async () => 'http://stream.url',
  };

  const mockGenericNoSource: DebridAdapter = {
    id: 'generic',
    label: 'Generic',
    short: 'GE',
    cacheCheck: false,
    keyUrl: '',
    checkCached: async () => ({ cached: new Set(), known: false }),
    resolveLink: async () => 'http://stream.url',
  };

  assert.equal(canAutoFetchBr({ autoFetchBr: true }, mockAllDebrid), true);
  assert.equal(canAutoFetchBr({ autoFetchBr: true }, mockRealDebrid), true);
  assert.equal(canAutoFetchBr({ autoFetchBr: true }, mockGenericNoSource), false);
  assert.equal(canAutoFetchBr({ autoFetchBr: false }, mockRealDebrid), false);
});

test('prefetchKey formata chave única por conta, imdbId, temporada e episódio', () => {
  const k1 = autofetch.prefetchKey('user_acc', 'tt0903747', 1, 2);
  const k2 = autofetch.prefetchKey('user_acc', 'tt0903747', 1, 3);
  assert.equal(k1.startsWith('autofetch:v3:pf:user_acc:tt0903747:1:2'), true);
  assert.notEqual(k1, k2);
});
