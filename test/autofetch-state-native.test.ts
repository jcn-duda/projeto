// Estado do Chupim no KV nativo (T3-L5): o MARKER (`autofetch:v3:m:`) e a
// BLACKLIST de mortos (`autofetch:v3:dead:`) saíram do cache do Node e agora
// são RUST_OWNED — `cache.get`/`cache.set` nessas chaves devolvem null/no-op.
// A prova usa SÓ a API pública do autofetch mais `kvSet`/`kvPeek`/`kvKeys`
// para olhar o disco; nenhum Map interno é acessado.
//   1. setMarker grava a chave nativa e markerTransferId/markerObra leem de
//      volta as três formas (`1`, `{id}`, `{id,meta}`); o L1 não é fonte;
//   2. TTL do marker vence no relógio real; forgetMarker apaga na hora;
//   3. markerIdIndex reconstrói id->hash de vários markers, no escopo da conta;
//   4. blacklist grava `dead:*` (`kvPeek === 1`), isDead/isDeadQuiet valem só
//      no escopo adapter:conta e somem no TTL;
//   5. reindexDead repovoa knownDead a partir do KV (plantado com kvSet) e o
//      snapshot().deadBlacklistCount acompanha;
//   6. writeQueue continua descartando o hash morto.
process.env.CACHE_PERSIST = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as autofetch from '../src/providers/autofetch.js';
import {
  markerIdIndex, markerKey, markerObra, markerTransferId, markerValue,
} from '../src/providers/autofetch-marker.js';
import * as cache from '../src/utils/cache.js';
import { kvForget, kvKeys, kvPeek, kvSet } from '../src/utils/native-kv.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const ADAPTER = 'premiumize';
const H1 = '1'.repeat(40);
const H2 = '2'.repeat(40);
const H3 = '3'.repeat(40);
const H4 = '4'.repeat(40);
// Hash com letras: prova a normalização para minúscula na chave (contrato antigo).
const LETTERS = 'ab'.repeat(20);
const DIGEST = 'd'.repeat(64);

test('setMarker grava em autofetch:v3:m:... e as três formas leem de volta', () => {
  const account = 'acc_native_marker';
  const legacyKey = markerKey(ADAPTER, account, H1);
  const idKey = markerKey(ADAPTER, account, H2);
  const metaKey = markerKey(ADAPTER, account, H3);
  try {
    assert.equal(legacyKey, `autofetch:v3:m:${ADAPTER}:${account}:${H1}`, 'formato da chave preservado');

    // (a) forma histórica `1`: só a presença importava.
    assert.equal(autofetch.setMarker(ADAPTER, account, H1, 1, 3600), true, 'setMarker confirma a escrita');
    assert.equal(kvPeek(legacyKey), 1, 'o 1 está no KV nativo');
    assert.equal(markerTransferId(ADAPTER, account, H1), null, 'sem id no marker `1`');
    assert.equal(markerObra(ADAPTER, account, H1), null, 'sem obra no marker `1`');
    // O L1 do Node não é (nem espelha) a fonte do marker.
    assert.equal(cache.get(legacyKey), null, 'cache.get do marker não é a fonte');
    assert.equal(cache.peek(legacyKey), null, 'cache.peek também não');

    // (b) `{id}`: aceite de adapter que devolve o id, ainda sem meta.
    const idOnly = markerValue('tr-42');
    assert.deepEqual(idOnly, { id: 'tr-42' }, 'markerValue sem meta preserva a forma {id}');
    assert.equal(autofetch.setMarker(ADAPTER, account, H2, idOnly, 3600), true);
    assert.deepEqual(kvPeek(idKey), { id: 'tr-42' }, 'a forma {id} sobrevive ao round-trip');
    assert.equal(markerTransferId(ADAPTER, account, H2), 'tr-42');

    // (c) `{id, meta}`: marker novo da Fase 6 (pool/obra/acceptedAt/título/áudio).
    const acceptedAt = 1_760_000_000_000;
    const meta = markerValue('tr-99', {
      pool: 'seeds', obra: DIGEST, acceptedAt,
      title: 'Filme 2024 1080p DUBLADO', br: true, dubbed: true,
    });
    assert.equal(autofetch.setMarker(ADAPTER, account, H3, meta, 3600), true);
    assert.deepEqual(kvPeek(metaKey), meta, 'a meta inteira sobrevive ao round-trip');
    assert.equal(markerTransferId(ADAPTER, account, H3), 'tr-99');
    assert.equal(markerObra(ADAPTER, account, H3), DIGEST, 'markerObra devolve o digest gravado');

    // A chave normaliza o hash para minúsculas, como antes.
    assert.equal(autofetch.setMarker(ADAPTER, account, LETTERS.toUpperCase(), 1, 3600), true);
    assert.equal(kvPeek(markerKey(ADAPTER, account, LETTERS)), 1, 'hash maiúsculo cai na chave minúscula');
  } finally {
    for (const h of [H1, H2, H3, LETTERS]) autofetch.forgetMarker(ADAPTER, account, h);
  }
});

test('TTL do marker vence e some do KV; forgetMarker apaga na hora', async () => {
  const account = 'acc_native_marker_ttl';
  const key = markerKey(ADAPTER, account, H1);
  try {
    assert.equal(autofetch.setMarker(ADAPTER, account, H1, markerValue('tr-ttl'), 1), true);
    assert.ok(kvPeek(key), 'vivo antes de vencer');
    assert.equal(markerTransferId(ADAPTER, account, H1), 'tr-ttl');
    assert.equal(autofetch.markerActive(ADAPTER, account, H1), true);

    await sleep(1_100);

    assert.equal(kvPeek(key), null, 'a chave vencida some do KV');
    assert.equal(markerTransferId(ADAPTER, account, H1), null, 'o leitor do marker vê o vencimento');
    assert.equal(autofetch.markerActive(ADAPTER, account, H1), false, 'marker vencido não é mais aceite');

    // forgetMarker é o caminho de apagar sem esperar o TTL (settle/evict).
    autofetch.setMarker(ADAPTER, account, H1, 1, 3600);
    assert.equal(autofetch.forgetMarker(ADAPTER, account, H1), true, 'havia o que esquecer');
    assert.equal(kvPeek(key), null, 'a chave sai do KV na hora');
    assert.equal(autofetch.forgetMarker(ADAPTER, account, H1), false, 'segunda chamada é idempotente');
  } finally {
    autofetch.forgetMarker(ADAPTER, account, H1);
  }
});

test('markerIdIndex reconstrói id->hash de vários markers no escopo da conta', () => {
  const account = 'acc_native_marker_idx';
  try {
    autofetch.setMarker(ADAPTER, account, H1, markerValue('tr-a'), 3600);
    autofetch.setMarker(ADAPTER, account, H2, markerValue('tr-b'), 3600);
    // Marker legado sem id não tem como entrar no mapa reverso.
    autofetch.setMarker(ADAPTER, account, H3, 1, 3600);
    // Outra conta: mesmo adapter, marker fora do escopo.
    autofetch.setMarker(ADAPTER, 'outra_conta', H4, markerValue('tr-x'), 3600);

    const index = markerIdIndex(ADAPTER, account);
    assert.equal(index.size, 2, 'só os markers com id da conta entram');
    assert.equal(index.get('tr-a'), H1);
    assert.equal(index.get('tr-b'), H2);
    assert.equal(index.has('tr-x'), false, 'marker de outra conta não vaza');

    // A varredura é do KV nativo: os três markers da conta estão no disco.
    const keys = kvKeys(`autofetch:v3:m:${ADAPTER}:${account}:`);
    assert.equal(keys.length, 3, 'três markers vivos da conta no KV');
  } finally {
    for (const h of [H1, H2, H3]) autofetch.forgetMarker(ADAPTER, account, h);
    autofetch.forgetMarker(ADAPTER, 'outra_conta', H4);
  }
});

test('blacklist grava autofetch:v3:dead:* com o 1 histórico, só no escopo adapter:conta', () => {
  const account = 'acc_native_dead';
  const key = autofetch.deadKey(ADAPTER, account, H1);
  const before = autofetch.snapshot().deadBlacklistCount; // snapshot poda órfãos antes da medida
  try {
    autofetch.blacklist(ADAPTER, account, H1, 3600);

    assert.equal(kvPeek(key), 1, 'o KV nativo guarda o 1 que o isDead testa');
    assert.equal(autofetch.isDead(ADAPTER, account, H1), true, 'morre no escopo gravado');
    assert.equal(autofetch.isDeadQuiet(ADAPTER, account, H1), true, 'isDeadQuiet lê a mesma marca');
    assert.equal(autofetch.isDead(ADAPTER, 'outra_conta', H1), false, 'o morto é por conta');
    assert.equal(autofetch.isDead('torbox', account, H1), false, 'o morto é por adapter');
    assert.equal(kvPeek(autofetch.deadKey(ADAPTER, 'outra_conta', H1)), null, 'nada é gravado fora do escopo');
    assert.equal(autofetch.snapshot().deadBlacklistCount, before + 1, 'knownDead acompanha a gravação');
  } finally {
    kvForget(key);
  }
});

test('blacklist com TTL curto some do KV e isDead volta a false', async () => {
  const account = 'acc_native_dead_ttl';
  const key = autofetch.deadKey(ADAPTER, account, H2);
  const before = autofetch.snapshot().deadBlacklistCount;
  try {
    autofetch.blacklist(ADAPTER, account, H2, 1);
    assert.equal(autofetch.isDead(ADAPTER, account, H2), true, 'viva antes de vencer');
    assert.equal(kvPeek(key), 1, 'a chave existe no KV');

    await sleep(1_100);

    assert.equal(autofetch.isDead(ADAPTER, account, H2), false, 'vencida não condena');
    assert.equal(autofetch.isDeadQuiet(ADAPTER, account, H2), false);
    assert.equal(kvPeek(key), null, 'a chave vencida some do KV');
    assert.equal(autofetch.snapshot().deadBlacklistCount, before, 'o snapshot poda o morto vencido');
  } finally {
    kvForget(key);
  }
});

test('reindexDead repovoa knownDead a partir do KV nativo', () => {
  const account = 'acc_native_dead_reindex';
  const key = autofetch.deadKey(ADAPTER, account, H1);
  try {
    kvForget(key);
    autofetch.snapshot(); // pruna órfãos: o knownDead começa sem a nossa chave
    const before = autofetch.snapshot().deadBlacklistCount;

    // Plantado DIRETO no KV, sem passar pela blacklist: só a varredura do
    // disco pode descobrir este morto (é o caso do boot depois do restart).
    kvSet(key, 1, 3600);

    const added = autofetch.reindexDead();
    assert.ok(added >= 1, 'o reindex descobriu o dead plantado no KV');
    const after = autofetch.snapshot().deadBlacklistCount;
    assert.equal(after, before + added, 'snapshot.deadBlacklistCount sobe pelo retorno do reindex');
    assert.equal(autofetch.isDead(ADAPTER, account, H1), true, 'o morto plantado passa a condenar');

    // Sumiu do disco, o snapshot poda o índice de processo.
    kvForget(key);
    assert.equal(autofetch.snapshot().deadBlacklistCount, after - 1, 'forget + snapshot remove o reindexado');
  } finally {
    kvForget(key);
  }
});

test('writeQueue continua descartando hash morto (blacklist + fila)', () => {
  const account = 'acc_native_dead_queue';
  const searchKey = 'streams:v6:movie:ttNativeStateDead';
  try {
    autofetch.dropQueue(searchKey);
    autofetch.blacklist(ADAPTER, account, H2, 3600);
    autofetch.writeQueue(searchKey, [
      { infoHash: H1, title: 'vivo' },
      { infoHash: H2, title: 'morto' },
    ], 3600, ADAPTER, account);

    assert.deepEqual(autofetch.readQueue(searchKey).map((c) => c.infoHash), [H1], 'o hash morto não entra');
    assert.equal((kvPeek(autofetch.queueKey(searchKey)) as unknown[]).length, 1, 'o KV não guarda o morto');

    // A fila é por busca, o morto é por conta: outra conta aceita o mesmo hash.
    autofetch.dropQueue(searchKey);
    autofetch.writeQueue(searchKey, [{ infoHash: H2, title: 'vivo na outra conta' }], 3600, ADAPTER, 'outra_conta');
    assert.equal(autofetch.readQueue(searchKey).length, 1, 'o escopo da blacklist segue por conta');
  } finally {
    autofetch.dropQueue(searchKey);
    kvForget(autofetch.deadKey(ADAPTER, account, H2));
  }
});
