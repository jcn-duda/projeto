// Equivalência da fila do Chupim (T3-L5) na migração cache do Node → KV
// nativo (`autofetch:v3:q:<sha256(searchKey)>`). A API pública NÃO mudou e o
// teste usa SÓ ela + `kvSet`/`kvPeek` para inspecionar o KV. O que se prova:
//   1. round-trip fiel, inclusive campos fora da struct e sonda nula;
//   2. a gravação vai para a chave nativa certa e `cache.get` não é a fonte;
//   3. TTL: fila escrita com `ttlSeconds=1` vence e some do KV;
//   4. `autoFetchQueueDepth` corta a profundidade e o snapshot acompanha;
//   5. dedupe por hash (primeiro vence) e hash morto sai na gravação;
//   6. fila vazia esquece a chave;
//   7. `dropQueue` aceita a chave completa E o searchKey;
//   8. `reindexQueues` reconstrói o índice só com o que está no KV nativo;
//   9. `snapshot().queues.items` é a soma das filas vivas.
process.env.CACHE_PERSIST = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import * as autofetch from '../src/providers/autofetch.js';
import autofetchLive from '../src/utils/autofetch-live.js';
import * as cache from '../src/utils/cache.js';
import { kvForget, kvPeek, kvSet } from '../src/utils/native-kv.js';

const H1 = '1'.repeat(40);
const H2 = '2'.repeat(40);
const H3 = '3'.repeat(40);
const H4 = '4'.repeat(40);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Chave esperada da fila: sha256 hex MINÚSCULO do searchKey (contrato). */
function nativeQueueKey(searchKey: string): string {
  return `autofetch:v3:q:${crypto.createHash('sha256').update(searchKey).digest('hex')}`;
}

test('round-trip fiel: campos da struct, extras e sonda nula sobrevivem', () => {
  const searchKey = 'streams:v6:movie:ttNativeRoundtrip';
  try {
    autofetch.dropQueue(searchKey);
    const full: autofetch.QueueCandidate = {
      infoHash: H1,
      name: 'Filme 2024 1080p WEB-DL DUAL',
      title: 'Filme 2024 1080p WEB-DL DUBLADO',
      quality: '1080p',
      size: 7_559_142_447,
      seeders: 9,
      br: true,
      dubbed: true,
      lied: false,
      bankDub: true,
      pool: 'seeds',
      imdbId: 'tt1234567',
      isPack: true,
      rare: true,
      slotLimit: 2,
      season: 1,
      episode: null,
      probeSeason: 1,
      probeEpisode: 8,
      addedAt: 1_769_404_800_000,
    };
    // Campos FORA da struct de propósito: só o spread do writeQueue os preserva.
    const withExtras = { ...full, canal: 'bludv', _legado: 'marca antiga' };
    // Candidato mínimo: sem S/E a sonda sai nula, não ausente.
    const minimal: autofetch.QueueCandidate = { infoHash: H2, title: 'Reindex candidate' };

    autofetch.writeQueue(searchKey, [withExtras, minimal], 3600);

    const read = autofetch.readQueue(searchKey);
    assert.equal(read.length, 2);
    assert.deepEqual(read[0], withExtras, 'todos os campos, inclusive os fora da struct');
    assert.equal(read[1].probeSeason ?? null, null, 'sonda de temporada nula quando ausente');
    assert.equal(read[1].probeEpisode ?? null, null, 'sonda de episódio nula quando ausente');
    assert.equal(read[1].episode ?? null, null, 'episódio nulo quando ausente');
    assert.equal(typeof read[1].addedAt, 'number', 'addedAt nasce na gravação');
    // readQueue entrega o MESMO conteúdo que mora no KV (mesma ordem de hashes):
    // o caminho de leitura é o KV nativo, não o cache do Node.
    const stored = kvPeek(autofetch.queueKey(searchKey)) as autofetch.QueueCandidate[];
    assert.deepEqual(read.map((c) => c.infoHash), stored.map((c) => c.infoHash), 'readQueue lê o KV nativo');
  } finally {
    autofetch.dropQueue(searchKey);
  }
});

test('gravação vai para autofetch:v3:q:<sha256> e cache.get não é a fonte', () => {
  const searchKey = 'streams:v6:movie:ttNativeKey';
  const expected = nativeQueueKey(searchKey);
  try {
    autofetch.dropQueue(searchKey);
    assert.equal(autofetch.queueKey(searchKey), expected, 'queueKey é o sha256 hex da busca');
    assert.ok(expected.startsWith('autofetch:v3:q:'));

    autofetch.writeQueue(searchKey, [{ infoHash: H1, title: 'A' }], 3600);

    const stored = kvPeek(expected) as autofetch.QueueCandidate[];
    assert.ok(Array.isArray(stored), 'o valor está na chave nativa');
    assert.equal(stored.length, 1);
    assert.equal(stored[0].infoHash, H1);
    assert.deepEqual(
      autofetch.readQueue(searchKey).map((c) => c.infoHash),
      stored.map((c) => c.infoHash),
      'readQueue lê o KV nativo',
    );

    // O L1 do Node não é (nem espelha) a fonte da fila.
    assert.equal(cache.get(expected), null, 'cache.get da chave da fila não é a fonte');
    assert.equal(cache.peek(expected), null, 'cache.peek também não');
  } finally {
    autofetch.dropQueue(searchKey);
  }
});

test('TTL: fila com ttlSeconds=1 vence e a leitura devolve vazio', async () => {
  const searchKey = 'streams:v6:movie:ttNativeTtl';
  const key = autofetch.queueKey(searchKey);
  try {
    autofetch.dropQueue(searchKey);
    autofetch.writeQueue(searchKey, [{ infoHash: H1, title: 'efêmera' }], 1);
    assert.equal(autofetch.readQueue(searchKey).length, 1, 'viva antes de vencer');
    assert.ok(Array.isArray(kvPeek(key)), 'a chave existe no KV');

    await sleep(1_100);

    assert.equal(autofetch.readQueue(searchKey).length, 0, 'vencida devolve fila vazia');
    assert.equal(kvPeek(key), null, 'a chave vencida some do KV');
  } finally {
    autofetch.dropQueue(searchKey);
  }
});

test('profundidade: writeQueue corta em autoFetchQueueDepth e o snapshot acompanha', () => {
  const searchKey = 'streams:v6:movie:ttNativeDepth';
  autofetchLive.set({ autoFetchQueueDepth: 2 });
  autofetch.dropQueue(searchKey);
  const baseline = autofetch.snapshot().queues.items;
  try {
    autofetch.writeQueue(searchKey, [
      { infoHash: H1, title: 'A' },
      { infoHash: H2, title: 'B' },
      { infoHash: H3, title: 'C' },
      { infoHash: H4, title: 'D' },
    ], 3600);

    const read = autofetch.readQueue(searchKey);
    assert.deepEqual(read.map((c) => c.infoHash), [H1, H2], 'corta no teto mantendo a ordem da busca');
    assert.equal((kvPeek(autofetch.queueKey(searchKey)) as unknown[]).length, 2, 'o KV também corta');
    assert.equal(autofetch.snapshot().queues.items, baseline + 2, 'os itens do snapshot acompanham o corte');
  } finally {
    autofetchLive.reset();
    autofetch.dropQueue(searchKey);
  }
});

test('dedupe por hash (primeiro vence) e hash morto sai na gravação', () => {
  const searchKey = 'streams:v6:movie:ttNativeDead';
  const otherKey = 'streams:v6:movie:ttNativeDeadOutraConta';
  const adapter = 'alldebrid';
  const account = 'acc_native_dead';
  const deadKey = autofetch.deadKey(adapter, account, H2);
  try {
    autofetch.dropQueue(searchKey);
    autofetch.dropQueue(otherKey);

    // Dedupe: o PRIMEIRO candidato de cada hash vence.
    autofetch.writeQueue(searchKey, [
      { infoHash: H1, title: 'primeiro' },
      { infoHash: H2, title: 'segundo' },
      { infoHash: H1, title: 'duplicado' },
    ], 3600);
    assert.deepEqual(autofetch.readQueue(searchKey).map((c) => c.title), ['primeiro', 'segundo']);

    // Morto: blacklist + writeQueue com o escopo adapter:conta.
    autofetch.blacklist(adapter, account, H2, 3600);
    assert.equal(autofetch.isDead(adapter, account, H2), true, 'blacklist visível ao isDead');
    autofetch.writeQueue(searchKey, [
      { infoHash: H1, title: 'vivo' },
      { infoHash: H2, title: 'morto' },
    ], 3600, adapter, account);
    assert.deepEqual(autofetch.readQueue(searchKey).map((c) => c.infoHash), [H1], 'o hash morto não entra');
    assert.equal((kvPeek(autofetch.queueKey(searchKey)) as unknown[]).length, 1, 'o KV não guarda o morto');

    // A blacklist é por adapter:conta: outra conta ainda aceita o hash.
    autofetch.writeQueue(otherKey, [{ infoHash: H2, title: 'vivo na outra conta' }], 3600, adapter, 'outra_conta');
    assert.equal(autofetch.readQueue(otherKey).length, 1, 'escopo por conta preservado');
  } finally {
    autofetch.dropQueue(searchKey);
    autofetch.dropQueue(otherKey);
    // A marca mora no KV nativo: o cache.forget nem toca no prefixo dead:.
    kvForget(deadKey);
  }
});

test('fila vazia esquece a chave (readQueue → [] e o KV sem a chave)', () => {
  const searchKey = 'streams:v6:movie:ttNativeEmpty';
  const key = autofetch.queueKey(searchKey);
  try {
    autofetch.dropQueue(searchKey);
    autofetch.writeQueue(searchKey, [{ infoHash: H1, title: 'A' }], 3600);
    assert.ok(Array.isArray(kvPeek(key)), 'fila gravada');

    autofetch.writeQueue(searchKey, [], 3600);
    assert.equal(autofetch.readQueue(searchKey).length, 0, 'fila vazia lê vazio');
    assert.equal(kvPeek(key), null, 'a chave foi esquecida');

    // Candidato sem hash também não ressuscita uma chave vazia.
    autofetch.writeQueue(searchKey, [{ infoHash: H1, title: 'A' }], 3600);
    autofetch.writeQueue(searchKey, [{ title: 'sem hash' } as unknown as autofetch.QueueCandidate], 3600);
    assert.equal(autofetch.readQueue(searchKey).length, 0);
    assert.equal(kvPeek(key), null);
  } finally {
    autofetch.dropQueue(searchKey);
  }
});

test('dropQueue aceita a chave completa E o searchKey', () => {
  const byKey = 'streams:v6:movie:ttNativeDropKey';
  const bySearch = 'streams:v6:movie:ttNativeDropSearch';
  try {
    autofetch.dropQueue(byKey);
    autofetch.dropQueue(bySearch);

    autofetch.writeQueue(byKey, [{ infoHash: H1 }], 3600);
    autofetch.dropQueue(autofetch.queueKey(byKey));
    assert.equal(autofetch.readQueue(byKey).length, 0, 'chave completa apaga a fila');
    assert.equal(kvPeek(autofetch.queueKey(byKey)), null, 'e a chave sai do KV');

    autofetch.writeQueue(bySearch, [{ infoHash: H2 }], 3600);
    autofetch.dropQueue(bySearch);
    assert.equal(autofetch.readQueue(bySearch).length, 0, 'searchKey resolve para a chave');
    assert.equal(kvPeek(autofetch.queueKey(bySearch)), null);

    // Idempotente; vazio continua não-op (contrato antigo).
    autofetch.dropQueue(bySearch);
    autofetch.dropQueue('');
  } finally {
    autofetch.dropQueue(byKey);
    autofetch.dropQueue(bySearch);
  }
});

test('reindexQueues reconstrói o índice a partir do KV nativo e o snapshot acompanha', () => {
  const searchKey = 'streams:v6:movie:ttNativeReindex';
  const key = autofetch.queueKey(searchKey);
  try {
    autofetch.dropQueue(key);
    autofetch.snapshot(); // pruna órfãos antes da medida
    const before = autofetch.snapshot().queues.count;

    // Plantado DIRETO no KV nativo (sem writeQueue): o índice de processo só
    // passa a vê-lo depois do reindex.
    kvSet(key, [{ infoHash: H1, title: 'reindex' }], 3600);

    const added = autofetch.reindexQueues();
    assert.ok(added >= 1, 'reindex descobriu a fila plantada no KV');
    const after = autofetch.snapshot().queues.count;
    assert.equal(after, before + added, 'o count sobe pelo retorno do reindex');
    assert.equal(autofetch.readQueue(searchKey).length, 1, 'fila plantada legível pela API pública');

    autofetch.dropQueue(key);
    assert.equal(autofetch.snapshot().queues.count, after - 1, 'dropQueue tira a fila reindexada do índice');
  } finally {
    autofetch.dropQueue(searchKey);
  }
});

test('após writeQueue, snapshot().queues.items reflete a soma das filas', () => {
  const keyA = 'streams:v6:movie:ttNativeSumA';
  const keyB = 'streams:v6:movie:ttNativeSumB';
  autofetch.dropQueue(keyA);
  autofetch.dropQueue(keyB);
  const base = autofetch.snapshot();
  try {
    autofetch.writeQueue(keyA, [{ infoHash: H1 }, { infoHash: H2 }], 3600);
    autofetch.writeQueue(keyB, [{ infoHash: H3 }, { infoHash: H4 }, { infoHash: H1 }], 3600);

    assert.equal(autofetch.readQueue(keyA).length, 2);
    assert.equal(autofetch.readQueue(keyB).length, 3, 'dedupe é POR FILA (H1 repetido entre buscas)');

    const snap = autofetch.snapshot();
    assert.equal(snap.queues.items, base.queues.items + 5, 'soma dos itens das duas filas');
    assert.equal(snap.queues.count, base.queues.count + 2, 'duas filas vivas');
  } finally {
    autofetch.dropQueue(keyA);
    autofetch.dropQueue(keyB);
  }
});
