// Posse do KV de debrid (T2-L6) e anti-reenchimento (T2-L7): `adsub:v1`
// (posse do que o addon subiu), `adprot:v1` (retenção BR durável) e `adrm:v1`
// (hash apagado de propósito) passaram a ser do núcleo Rust — o mesmo
// `cache.db`, pelo `NativeKv` do `adom-index`. O Node só fala pela ponte
// (`native-kv.ts`). `adhold:v1` (hold curto do Chupim) segue o mesmo desenho
// por paridade: leitura e escrita vivas são da ponte (`protected.ts`) e o
// PREFIXO é o que torna `cache.get`/`peek` estrangeiros silenciosos — sem ele,
// a leitura contaria `cache.miss` no metricSnapshot.
//
// Por que o dono importa: as chaves decidem o que a limpeza da conta pode
// apagar e o que volta ao `/magnet/upload`. Segundo escritor no L1 faria um
// `forget`/prune do Node derrubar a linha fresca do núcleo, e o `adom-debrid`
// lê o MESMO arquivo por `DurablePeek` — no `adrm` com um agravante: o
// `cache.set` do Node só despeja no SQLite no próximo tick, e a marca
// recém-gravada podia não barrar o upload que o gateway fazia em seguida.
//
// Invariantes: `cache.set/forget` recusam os quatro; `cache.get/peek` devolvem
// `null` (nada de valor velho no L1); a ponte faz roundtrip com TTL e
// `clearNamespace`/prefixo apagam o namespace inteiro.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cache from '../src/utils/cache.js';
import * as metrics from '../src/utils/metrics.js';
import { RUST_OWNED, isForeignKey, isRustOwned, prefix } from '../src/utils/cache-keys.js';
import { kvClearPrefix, kvForget, kvKeys, kvPeek, kvRemaining, kvSet } from '../src/utils/native-kv.js';

const HASH = 'a'.repeat(40);
const OUTRO = 'b'.repeat(40);
const conta = 'conta-t2-l6';
const subKey = `${prefix('adsub')}${conta}:${HASH}`;
const protKey = `${prefix('adprot')}alldebrid:${conta}:${HASH}`;
const rmKey = `${prefix('adrm')}${conta}:${HASH}`;

test('adsub, adprot, adrm e adhold são dono único do núcleo por namespace e por prefixo', () => {
  for (const ns of ['adsub', 'adprot', 'adrm', 'adhold'] as const) {
    assert.equal(isRustOwned(ns), true, `${ns} é RUST_OWNED`);
    assert.ok(RUST_OWNED.includes(ns), `${ns} está na lista do dono`);
    assert.equal(isForeignKey(`${prefix(ns)}alldebrid:${conta}:${HASH}`), true, `${ns} bloqueia o L1`);
  }
});

// Paridade do adhold: `isRustOwned` já recusava a escrita/forget do Node; o
// PREFIXO é o que silencia a LEITURA (`get`/`peek` sem `cache.miss`). O hold
// real é lido e gravado pela ponte (`kvPeek`/`kvSet` em `debrid/protected.ts`),
// que não passa pelo cache do Node — o forget dele não pode derrubar a linha.
test('adhold é estrangeiro silencioso: get não conta miss e a ponte segue intacta', () => {
  const holdKey = `${prefix('adhold')}${conta}:${HASH}`;
  try {
    cache.set(holdKey, { at: 1 }, 600);
    assert.equal(cache.has(holdKey), false, 'set do Node recusa adhold');

    assert.equal(kvSet(holdKey, { at: 2 }, 600), true, 'semeia o hold pela ponte');
    const missAntes = metrics.snapshot().counters['cache.miss'] ?? 0;
    assert.equal(cache.get(holdKey), null, 'get do Node não inventa valor');
    assert.equal(cache.peek(holdKey), null, 'peek do Node também não');
    const countersDepois = metrics.snapshot().counters;
    assert.equal(countersDepois['cache.miss'] ?? 0, missAntes, 'leitura de chave estrangeira não conta cache.miss');
    assert.equal(countersDepois['cache.miss.adhold'], undefined, 'nem o balde do namespace');

    cache.forget(holdKey);
    assert.deepEqual(kvPeek(holdKey), { at: 2 }, 'forget do Node não apaga a linha da ponte');
  } finally {
    kvForget(holdKey);
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

test('adrm é do núcleo: a ponte grava, o L1 do Node não vê e o forget do Node não apaga', () => {
  try {
    cache.set(rmKey, { at: 1 }, 600);
    assert.equal(cache.has(rmKey), false, 'set do Node recusa adrm');

    assert.equal(kvSet(rmKey, { at: 2, name: 'Foreign.Movie.2019.1080p' }, 600), true);
    assert.deepEqual(kvPeek(rmKey), { at: 2, name: 'Foreign.Movie.2019.1080p' }, 'a marca sai da ponte');
    assert.equal(cache.peek(rmKey), null, 'peek do Node não inventa marca');

    cache.forget(rmKey);
    assert.notEqual(kvPeek(rmKey), null, 'forget do Node não apaga a marca do núcleo');
  } finally {
    kvForget(rmKey);
  }
});

test('clearNamespace(adrm) apaga as marcas e deixa os vizinhos', () => {
  const vizinho = `${prefix('adrm')}${conta}:${OUTRO}`;
  try {
    kvSet(rmKey, { at: 1 }, 600);
    kvSet(vizinho, { at: 2 }, 600);
    kvSet(subKey, { at: 3 }, 600);
    assert.equal(cache.clearNamespace('adrm'), 2, 'as duas marcas saíram');
    assert.equal(kvPeek(rmKey), null);
    assert.equal(kvPeek(vizinho), null);
    assert.deepEqual(kvPeek(subKey), { at: 3 }, 'adsub é outro namespace e fica');
  } finally {
    kvForget(rmKey);
    kvForget(vizinho);
    kvForget(subKey);
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
