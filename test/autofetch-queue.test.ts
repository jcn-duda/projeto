// Contrato do Node com a fila v3 do Chupim: as PORTAS que o worker nativo do
// gateway consome (chave, escrita, leitura, drop, takeNext) mais a blacklist, o
// orçamento e o gate de ocupação. O dreno (`drainNext`), a derivação de parada e
// o índice da obra saíram do TS na leva B4 — quem os prova é o `cargo test` de
// `adom-autofetch` e do worker (`adom-server/src/autofetch`), não este arquivo.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import * as autofetch from '../src/providers/autofetch.js';
import * as cache from '../src/utils/cache.js';
import { kvForget, kvPeek, kvSet } from '../src/utils/native-kv.js';
import * as held from '../src/debrid/protected.js';
import config from '../src/config.js';
import { canAutoFetchBr } from '../src/utils/format.js';
import { H1, H2, H3, H4, sleep, mkAdapter, dinvKeyFor } from './helpers/autofetch-fixtures.js';

test('reindexQueues reconstrói knownQueues a partir do KV nativo (bypass writeQueue)', () => {
  const searchKey = 'streams:v7:movie:ttReindexBoot';
  const key = autofetch.queueKey(searchKey);
  autofetch.dropQueue(key);

  const cand: autofetch.QueueCandidate[] = [
    { infoHash: H1, title: 'Reindex candidate' },
  ];
  // Sem writeQueue: knownQueues só vê a fila após reindex. O plantio vai DIRETO
  // ao KV nativo — o valor da fila não mora mais no cache do Node.
  const before = autofetch.snapshot().queues.count;
  kvSet(key, cand, 3600);
  const added = autofetch.reindexQueues();
  // Outras filas órfãs (sujeira paralela) também entram — basta subir o count.
  assert.ok(added >= 1, 'reindex descobriu ao menos a fila plantada');
  const after = autofetch.snapshot().queues.count;
  assert.equal(after, before + added, 'snapshot.count sobe pelo retorno do reindex');
  assert.equal(autofetch.readQueue(searchKey).length, 1, 'fila plantada legível após reindex');
  autofetch.dropQueue(key);
  assert.equal(
    autofetch.snapshot().queues.count,
    after - 1,
    'dropQueue remove a fila reindexada do knownQueues',
  );
});

test('fila persistente: writeQueue, readQueue, dropQueue e takeNext', () => {
  const searchKey = 'streams:v5:series:tt0903747:1:1';
  autofetch.dropQueue(searchKey);

  const candidates: autofetch.QueueCandidate[] = [
    { infoHash: H1, title: 'Breaking Bad S01E01 1080p DUB', quality: '1080p', lied: true },
    { infoHash: H2, title: 'Breaking Bad S01E01 720p DUB', quality: '720p' },
    { infoHash: H1, title: 'Breaking Bad S01E01 Duplicate' },
  ];

  autofetch.writeQueue(searchKey, candidates, 3600);
  const read = autofetch.readQueue(searchKey);
  assert.equal(read.length, 2, 'deduplica hashes na gravacao da fila');
  assert.equal(read[0].infoHash, H1);
  assert.equal(read[0].lied, true, 'a fila preserva a condenação de áudio até o dreno');
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
  kvForget(autofetch.deadKey(adapterId, account, H1));
  assert.equal(autofetch.isDead(adapterId, account, H1), false);

  autofetch.blacklist(adapterId, account, H1, 86400);
  assert.equal(autofetch.isDead(adapterId, account, H1), true);
  assert.equal(autofetch.isDead('other_adapter', account, H1), false);
  assert.equal(autofetch.isDead(adapterId, 'other_acc', H1), false);
});

test('takeNext purga obsoletos (dead/marker) e ADIA held sem purgá-lo', () => {
  const adapterId = 'torbox';
  const account = 'acc_skip_test';

  autofetch.blacklist(adapterId, account, H1, 86400);
  autofetch.setMarker(adapterId, account, H2, 1, 3600);
  held.hold(H3, 3600, account);

  const { next, remaining } = autofetch.takeNext(
    [{ infoHash: H1 }, { infoHash: H2 }, { infoHash: H3 }, { infoHash: H4 }],
    (cand) => autofetch.isDead(adapterId, account, cand.infoHash) ||
      Boolean(kvPeek(autofetch.markerKey(adapterId, account, cand.infoHash))),
    (cand) => held.isHeld(cand.infoHash, account),
  );

  assert.equal(next?.infoHash, H4, 'pula H1 (dead), H2 (marker) e H3 (held)');
  assert.deepEqual(remaining.map((c) => c.infoHash), [H3], 'adiado (held) não é purgado');
  held.release(H3, account);
  kvForget(autofetch.markerKey(adapterId, account, H2));
  kvForget(autofetch.deadKey(adapterId, account, H1));
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

  assert.equal(autofetch.checkAndRecordBudget(adapterId, 'other_user', limit), true);
  autofetch.resetBudget();
});

test('canAutoFetchBr aceita tanto cacheCheck quanto autofetchSource (RD/DL)', () => {
  const mockAllDebrid = mkAdapter('alldebrid', undefined, { label: 'AllDebrid', short: 'AD' });
  const mockRealDebrid = mkAdapter('realdebrid', undefined, {
    label: 'Real-Debrid', short: 'RD', cacheCheck: false, autofetchSource: true,
  });
  const mockGenericNoSource = mkAdapter('generic', undefined, {
    label: 'Generic', short: 'GE', cacheCheck: false,
  });

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

  try {
    config.debrid.autoFetchPauseAt = 5;
    config.debrid.autoFetchPauseRefreshMs = 900_000;

    // Sem accountStatus nunca bloqueia: sem medição não há evidência.
    assert.equal(autofetch.accountGateBlocked(mkAdapter('alldebrid'), apiKey), false);

    // Memo frio fail-open; refresh em voo não dispara segundo refresh.
    let calls = 0;
    const busy = mkAdapter('alldebrid', async () => { calls += 1; return { magnets: 42 }; });
    autofetch.resetAccountGate();
    assert.equal(autofetch.accountGateBlocked(busy, apiKey), false, 'primeira chamada não bloqueia');
    assert.equal(autofetch.accountGateBlocked(busy, apiKey), false, 'refresh em voo também não bloqueia');
    await sleep(20);
    assert.equal(calls, 1, 'um único refresh por memo vencido');
    assert.equal(autofetch.accountGateBlocked(busy, apiKey), true, 'memo quente acima do limiar bloqueia');

    const calm = mkAdapter('alldebrid', async () => ({ magnets: 2 }));
    autofetch.resetAccountGate();
    assert.equal(autofetch.accountGateBlocked(calm, apiKey), false);
    await sleep(20);
    assert.equal(autofetch.accountGateBlocked(calm, apiKey), false, 'abaixo do limiar segue aberto');

    // Sem contagem numérica (ex.: só fair-use) nunca grava memo.
    const noCount = mkAdapter('alldebrid', async () => ({ limitUsed: 0.99 }));
    autofetch.resetAccountGate();
    assert.equal(autofetch.accountGateBlocked(noCount, apiKey), false);
    await sleep(20);
    assert.equal(autofetch.accountGateBlocked(noCount, apiKey), false, 'sem contagem total não há bloqueio');

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
  let statusCalls = 0;
  const adapter = mkAdapter('torbox', async () => { statusCalls += 1; return { magnets: 0 }; });
  const invKey = dinvKeyFor('torbox', apiKey);

  try {
    config.debrid.autoFetchPauseAt = 2;
    autofetch.resetAccountGate();
    cache.set(invKey, [
      { title: 'Filme Um', infoHash: '1'.repeat(40), size: 1 },
      { title: 'Filme Dois', infoHash: '2'.repeat(40), size: 1 },
    ], 60);
    assert.equal(autofetch.accountGateBlocked(adapter, apiKey), true, 'inventário cheio bloqueia sem rede');
    assert.equal(statusCalls, 0, 'acima do limiar o peek bloqueia sem chamar accountStatus');
    // Abaixo do limiar o peek não decide (dinv = só prontos); segue memo/status.
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
