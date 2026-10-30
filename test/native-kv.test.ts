// Ponte Node → KV nativo (`NativeKv` do `.node`, tabela `cache` do `cache.db`).
//
// O store é do Rust (T2-L2): aqui provamos só o contrato da ponte — leitura do
// JSON, miss como `null`, varredura por prefixo sem vazar namespace alheio,
// TTL vencido sumindo na leitura e a poda das vencidas por prefixo. A regra em
// si é testada no Rust (`cargo test -p adom-index kv::`).
process.env.CACHE_PERSIST = 'false';

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  kvKeys,
  kvPeek,
  kvPruneExpired,
  kvSetForTest,
  resetNativeKvForTest,
} from '../src/utils/native-kv.js';

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

test('kvPruneExpired apaga só as vencidas do prefixo (permanentes ficam)', () => {
  kvSetForTest('prune:a:vencida', 1, 1); // vence ~1s após a gravação
  kvSetForTest('prune:a:viva', 2, 60);
  kvSetForTest('prune:a:permanente', 3); // ttl <= 0 = permanente
  kvSetForTest('prune:b:vencida', 4, 1); // outro prefixo: intocado pela poda
  const agora = Date.now() + 5_000; // relógio já depois de todas as vencidas

  assert.equal(kvPruneExpired('prune:a:', agora), 1);
  assert.equal(kvPruneExpired('prune:a:', agora), 0, 'idempotente');
  assert.equal(kvPeek('prune:a:vencida', agora), null);
  // O relógio no PASSADO prova que as outras linhas seguem no banco (a leitura
  // com `agora` apagaria a vencida do outro prefixo por conta própria).
  assert.equal(kvPeek('prune:a:viva', agora), 2);
  assert.equal(kvPeek('prune:a:permanente', agora), 3);
  assert.equal(kvPeek('prune:b:vencida', agora - 10_000), 4);
});
