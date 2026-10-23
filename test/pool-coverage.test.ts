// Cobertura de pool (`idxPoolCovered`): a régua que decide se o
// acervo "cobre" a obra para fins de fast-path e de cobertura de dublado.
// Os testes de ponta que abriam `/stream` para medir o fast-path do Node saíram
// no F4.4 (o corte é do gateway nativo; a decisão equivalente é
// `pool_covered`/`idx_pool_covered` no núcleo). O `poolCovered` TS saiu sem
// chamador; a régua dele segue medida pelo golden `search-pool-coverage`
// (oráculo no worktree esm). O que sobra aqui é o `idxPoolCovered`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { idxPoolCovered } from '../src/providers/index.js';

test('idxPoolCovered: BR dublado cobre', () => {
  const brDublado = [{
    hash: '88'.repeat(20),
    title: 'Test Title 2024 1080p DUBLADO',
    seeders: 4,
    quality: '1080p',
    isBr: true,
  }];
  assert.equal(idxPoolCovered(brDublado as any), true, 'idxPoolCovered cobre BR dublado');
});
