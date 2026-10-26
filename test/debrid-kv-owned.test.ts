// Posse do KV de debrid (T2-L6): `adsub:v1` (posse do que o addon subiu) e
// `adprot:v1` (retenção BR durável) passaram a ser do núcleo Rust — o mesmo
// `cache.db`, pelo `NativeKv` do `adom-index`. O Node só fala pela ponte
// (`native-kv.ts`).
//
// Por que o dono importa: as duas chaves decidem o que a limpeza da conta pode
// apagar. Segundo escritor no L1 faria um `forget`/prune do Node derrubar a
// linha fresca do núcleo, e o `adom-debrid` lê o MESMO arquivo por
// `DurablePeek` — o resultado seria limpar magnet do usuário.
//
// Invariantes: `cache.set/forget` recusam as duas; `cache.get/peek` devolvem
// `null` (nada de valor velho no L1); a ponte faz roundtrip com TTL e
// `clearNamespace`/prefixo apagam o namespace inteiro.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cache from '../src/utils/cache.js';
import { RUST_OWNED, isForeignKey, isRustOwned, prefix } from '../src/utils/cache-keys.js';
import { kvClearPrefix, kvForget, kvKeys, kvPeek, kvRemaining, kvSet } from '../src/utils/native-kv.js';

const HASH = 'a'.repeat(40);
const OUTRO = 'b'.repeat(40);
const conta = 'conta-t2-l6';
const subKey = `${prefix('adsub')}${conta}:${HASH}`;
const protKey = `${prefix('adprot')}alldebrid:${conta}:${HASH}`;

test('adsub e adprot são dono único do núcleo por namespace e por prefixo', () => {
  for (const ns of ['adsub', 'adprot'] as const) {
    assert.equal(isRustOwned(ns), true, `${ns} é RUST_OWNED`);
    assert.ok(RUST_OWNED.includes(ns), `${ns} está na lista do dono`);
    assert.equal(isForeignKey(`${prefix(ns)}alldebrid:${conta}:${HASH}`), true, `${ns} bloqueia o L1`);
  }
});

test('a ponte grava, lê com TTL e remove (idempotente)', () => {
  try {
    assert.equal(kvSet(subKey, { at: 7 }, 600), true, 'escrita pela ponte vale');
    assert.equal(kvSet(protKey, { acceptedAt: 9, readyAt: null }, 600), true);
    assert.deepEqual(kvPeek(subKey), { at: 7 }, 'leitura devolve o MESMO JSON');
    assert.deepEqual(kvPeek(protKey), { acceptedAt: 9, readyAt: null });
    assert.equal((kvRemaining(subKey) ?? 0) > 0, true, 'TTL restante sai da ponte');
    assert.deepEqual(kvKeys(`${prefix('adprot')}alldebrid:${conta}:`), [protKey], 'enumeração por prefixo');

    assert.equal(kvForget(subKey), true, 'remove a linha');
    assert.equal(kvForget(subKey), false, 'idempotente');
    assert.equal(kvPeek(subKey), null, 'depois do forget não há leitura');
  } finally {
    kvClearPrefix(prefix('adsub'));
    kvClearPrefix(prefix('adprot'));
  }
});

test('cache do Node não escreve nem lê adsub/adprot (sem valor velho no L1)', () => {
  try {
    cache.set(subKey, { at: 1 }, 600);
    cache.set(protKey, { acceptedAt: 1, readyAt: null }, 600);
    assert.equal(cache.has(subKey), false, 'set do Node recusa adsub');
    assert.equal(cache.has(protKey), false, 'set do Node recusa adprot');

    assert.equal(kvSet(subKey, { at: 2 }, 600), true, 'semeia pela ponte');
    assert.equal(cache.get(subKey), null, 'get do Node não inventa valor para adsub');
    assert.equal(cache.peek(protKey), null, 'peek do Node não inventa valor para adprot');

    cache.forget(subKey);
    assert.deepEqual(kvPeek(subKey), { at: 2 }, 'forget do Node não apaga a linha do núcleo');
  } finally {
    kvClearPrefix(prefix('adsub'));
    kvClearPrefix(prefix('adprot'));
  }
});

test('clearNamespace limpa o namespace nativo e devolve quantas linhas saíram', () => {
  const outra = `${prefix('adprot')}alldebrid:${conta}:${OUTRO}`;
  try {
    kvSet(protKey, { acceptedAt: 1, readyAt: null }, 600);
    kvSet(outra, { acceptedAt: 2, readyAt: null }, 600);
    kvSet(subKey, { at: 3 }, 600);
    assert.equal(cache.clearNamespace('adprot'), 2, 'as duas linhas de adprot saíram');
    assert.equal(kvPeek(protKey), null);
    assert.equal(kvPeek(outra), null);
    assert.deepEqual(kvPeek(subKey), { at: 3 }, 'adsub é outro namespace e fica');
  } finally {
    kvClearPrefix(prefix('adsub'));
    kvClearPrefix(prefix('adprot'));
  }
});
