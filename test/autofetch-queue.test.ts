import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import * as autofetch from '../src/providers/autofetch.js';
import { drainNext } from '../src/providers/autofetch-runner.js';
import * as cache from '../src/utils/cache.js';
import * as held from '../src/debrid/protected.js';
import debrid from '../src/debrid/index.js';
import * as runtime from '../src/runtime.js';
import config from '../src/config.js';
import { canAutoFetchBr } from '../src/utils/format.js';
import { prefix } from '../src/utils/cache-keys.js';
import { accountScope } from '../src/utils/request-key.js';
import type { DebridAdapter, AccountStatus } from '../types/domain.js';

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

test('gate de ocupação: fail-open, memo, trava anti-duplicação e flag 0', async () => {
  const originalPauseAt = config.debrid.autoFetchPauseAt;
  const originalRefreshMs = config.debrid.autoFetchPauseRefreshMs;
  const apiKey = 'chave-gate-unit';
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const mkAdapter = (id: string, status?: (key: string) => Promise<AccountStatus>): DebridAdapter => ({
    id,
    label: id,
    short: id.slice(0, 2).toUpperCase(),
    cacheCheck: true,
    keyUrl: '',
    checkCached: async () => ({ cached: new Set(), known: true }),
    resolveLink: async () => null,
    accountStatus: status,
  });

  try {
    config.debrid.autoFetchPauseAt = 5;
    config.debrid.autoFetchPauseRefreshMs = 900_000;

    // Adaptador sem accountStatus nunca bloqueia: sem medição não há evidência.
    assert.equal(autofetch.accountGateBlocked(mkAdapter('alldebrid'), apiKey), false);

    // Memo frio: fail-open; o refresh em background grava a contagem e a
    // chamada em voo não dispara um segundo refresh (trava anti-duplicação).
    let calls = 0;
    const busy = mkAdapter('alldebrid', async () => { calls += 1; return { magnets: 42 }; });
    autofetch.resetAccountGate();
    assert.equal(autofetch.accountGateBlocked(busy, apiKey), false, 'primeira chamada não bloqueia');
    assert.equal(autofetch.accountGateBlocked(busy, apiKey), false, 'refresh em voo também não bloqueia');
    await sleep(20);
    assert.equal(calls, 1, 'um único refresh por memo vencido');
    assert.equal(autofetch.accountGateBlocked(busy, apiKey), true, 'memo quente acima do limiar bloqueia');

    // Contagem abaixo do limiar mantém o gate aberto.
    const calm = mkAdapter('alldebrid', async () => ({ magnets: 2 }));
    autofetch.resetAccountGate();
    assert.equal(autofetch.accountGateBlocked(calm, apiKey), false);
    await sleep(20);
    assert.equal(autofetch.accountGateBlocked(calm, apiKey), false, 'abaixo do limiar segue aberto');

    // Status sem contagem numérica (ex.: Premiumize, só fair-use) nunca grava
    // memo: o serviço continua fail-open.
    const noCount = mkAdapter('alldebrid', async () => ({ limitUsed: 0.99 }));
    autofetch.resetAccountGate();
    assert.equal(autofetch.accountGateBlocked(noCount, apiKey), false);
    await sleep(20);
    assert.equal(autofetch.accountGateBlocked(noCount, apiKey), false, 'sem contagem total não há bloqueio');

    // Flag 0 desliga o gate mesmo com memo quente.
    autofetch.resetAccountGate();
    assert.equal(autofetch.accountGateBlocked(busy, apiKey), false);
    await sleep(20);
    assert.equal(autofetch.accountGateBlocked(busy, apiKey), true);
    config.debrid.autoFetchPauseAt = 0;
    assert.equal(autofetch.accountGateBlocked(busy, apiKey), false, 'flag 0 desliga');
  } finally {
    config.debrid.autoFetchPauseAt = originalPauseAt;
    config.debrid.autoFetchPauseRefreshMs = originalRefreshMs;
    autofetch.resetAccountGate();
  }
});

test('gate de ocupação usa o inventário memoizado (sem rede) quando existe', async () => {
  const originalPauseAt = config.debrid.autoFetchPauseAt;
  const apiKey = 'chave-gate-inv';
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  let statusCalls = 0;
  const adapter: DebridAdapter = {
    id: 'torbox',
    label: 'TorBox',
    short: 'TB',
    cacheCheck: true,
    keyUrl: '',
    checkCached: async () => ({ cached: new Set(), known: true }),
    resolveLink: async () => null,
    accountStatus: async () => { statusCalls += 1; return { magnets: 0 }; },
  };
  const invKey = `${prefix('dinv')}torbox:${accountScope(apiKey)}`;

  try {
    config.debrid.autoFetchPauseAt = 2;
    autofetch.resetAccountGate();
    // Inventário acima do limiar bloqueia na hora, sem passar pelo accountStatus.
    cache.set(invKey, [
      { title: 'Filme Um', infoHash: '1'.repeat(40), size: 1 },
      { title: 'Filme Dois', infoHash: '2'.repeat(40), size: 1 },
    ], 60);
    assert.equal(autofetch.accountGateBlocked(adapter, apiKey), true, 'inventário cheio bloqueia sem rede');
    assert.equal(statusCalls, 0, 'acima do limiar o peek bloqueia sem chamar accountStatus');
    // Abaixo do limiar o peek NÃO decide: o dinv guarda só PRONTOS e a
    // ocupação que derruba a conta é o total — a decisão segue para o
    // memo/accountStatus (que vê 0 magnets e mantém aberto).
    cache.set(invKey, [{ title: 'Filme Um', infoHash: '1'.repeat(40), size: 1 }], 60);
    assert.equal(autofetch.accountGateBlocked(adapter, apiKey), false, 'abaixo do limiar o peek não bloqueia');
    await sleep(20);
    assert.equal(statusCalls, 1, 'abaixo do limiar a decisão segue para o memo/accountStatus');
    assert.equal(autofetch.accountGateBlocked(adapter, apiKey), false, 'memo quente abaixo do limiar segue aberto');
  } finally {
    cache.forget(invKey);
    config.debrid.autoFetchPauseAt = originalPauseAt;
    autofetch.resetAccountGate();
  }
});

test('gate de ocupação bloqueia o drainNext: cabeça permanece na fila intacta', async () => {
  // Memo quente acima do limiar + fila não vazia: a drenagem para ANTES de
  // tocar na fila — a cabeça fica intacta e nenhum debrid.enqueue acontece.
  const originalPauseAt = config.debrid.autoFetchPauseAt;
  const apiKey = 'chave-gate-drain';
  const searchKey = 'streams:v6:movie:ttGateDrain';
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const originalStatus = pmAdapter.accountStatus;
  let enqueues = 0;

  try {
    config.debrid.autoFetchPauseAt = 2;
    autofetch.resetAccountGate();
    autofetch.dropQueue(searchKey);
    cache.forget(`${prefix('dinv')}premiumize:${accountScope(apiKey)}`);

    // Memo quente acima do limiar (900 >= 2).
    pmAdapter.accountStatus = async () => ({ magnets: 900 });
    pmAdapter.enqueue = async () => { enqueues += 1; return true; };
    assert.equal(autofetch.accountGateBlocked(pmAdapter, apiKey), false, 'memo frio é fail-open');
    await sleep(20);
    assert.equal(autofetch.accountGateBlocked(pmAdapter, apiKey), true, 'memo quente bloqueia');

    autofetch.writeQueue(searchKey, [
      { infoHash: H1, title: 'Cabeça da fila', quality: '1080p' },
      { infoHash: H2, title: 'Segundo da fila', quality: '720p' },
    ], 3600);
    const antes = autofetch.readQueue(searchKey);
    assert.equal(antes.length, 2);

    await runtime.run(
      { opts: { ...runtime.defaults(), debridService: 'premiumize', debridApiKey: apiKey }, encoded: 'cfg-gate-drain' },
      async () => { drainNext(searchKey, { refusals: 0 }); },
    );
    await sleep(10);

    assert.deepEqual(autofetch.readQueue(searchKey), antes, 'a fila permanece intacta (readQueue inalterada)');
    assert.equal(enqueues, 0, 'nenhum debrid.enqueue ocorre');
  } finally {
    pmAdapter.enqueue = originalEnqueue;
    pmAdapter.accountStatus = originalStatus;
    config.debrid.autoFetchPauseAt = originalPauseAt;
    autofetch.resetAccountGate();
    autofetch.dropQueue(searchKey);
  }
});
