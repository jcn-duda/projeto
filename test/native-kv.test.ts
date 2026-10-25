// Ponte Node → KV nativo (`NativeKv` do `.node`, tabela `cache` do `cache.db`).
//
// O store é do Rust (T2-L2): aqui provamos só o contrato da ponte — leitura do
// JSON, miss como `null`, varredura por prefixo sem vazar namespace alheio e
// TTL vencido sumindo na leitura. A regra em si é testada no Rust
// (`cargo test -p adom-index kv::`).
process.env.CACHE_PERSIST = 'false';

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { kvKeys, kvPeek, kvSetForTest, resetNativeKvForTest } from '../src/utils/native-kv.js';

beforeEach(() => {
  resetNativeKvForTest();
});

test('kvPeek devolve o JSON gravado e null no miss', () => {
  kvSetForTest('autofetch:obra:tt1', { a: 1, b: ['x'] });
  assert.deepEqual(kvPeek('autofetch:obra:tt1'), { a: 1, b: ['x'] });
  assert.equal(kvPeek('autofetch:obra:tt9'), null);
});

test('kvKeys lista só o prefixo pedido', () => {
  kvSetForTest('autofetch:obra:tt1', 1);
  kvSetForTest('autofetch:suppressed:tt2', 2);
  kvSetForTest('rdq:hash', 3);
  assert.deepEqual(kvKeys('autofetch:'), ['autofetch:obra:tt1', 'autofetch:suppressed:tt2']);
});

test('chave vencida some na leitura (TTL em segundos)', () => {
  const agora = Date.now();
  kvSetForTest('adprot:tt4', { ok: true }, 1);
  assert.deepEqual(kvPeek('adprot:tt4', agora), { ok: true });
  assert.equal(kvPeek('adprot:tt4', agora + 5_000), null);
});
