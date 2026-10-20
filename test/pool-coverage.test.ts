// Cobertura de pool (`poolCovered`/`idxPoolCovered`): a régua que decide se o
// acervo "cobre" a obra para fins de fast-path e de cobertura de dublado.
// Os testes de ponta que abriam `/stream` para medir o fast-path do Node saíram
// no F4.4 (o corte é do gateway nativo; a decisão equivalente é
// `pool_covered`/`idx_pool_covered` no núcleo). O que sobra aqui é a régua pura.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { idxPoolCovered, poolCovered } from '../src/providers/index.js';

test('poolCovered: valida requireDubbed e swarms', () => {
  const legendadoFraco = [{
    hash: '77'.repeat(20),
    title: 'Test Title 2024 1080p LEGENDADO',
    seeders: 1,
    quality: '1080p',
    isBr: true,
  }];
  assert.equal(poolCovered(legendadoFraco as any, { requireDubbed: false }), false, 'sem seeders suficientes não cobre swarm');
  assert.equal(poolCovered(legendadoFraco as any, { requireDubbed: true }), false, 'legendado não cobre com requireDubbed');

  const legendadoForte = [{
    hash: '78'.repeat(20),
    title: 'Test Title 2024 1080p EN',
    seeders: 100,
    quality: '1080p',
  }];
  assert.equal(poolCovered(legendadoForte as any, { requireDubbed: false }), true, 'swarm forte cobre se requireDubbed=false');
  assert.equal(poolCovered(legendadoForte as any, { requireDubbed: true }), false, 'swarm forte NÃO cobre se requireDubbed=true');

  const brDublado = [{
    hash: '88'.repeat(20),
    title: 'Test Title 2024 1080p DUBLADO',
    seeders: 4,
    quality: '1080p',
    isBr: true,
  }];
  assert.equal(poolCovered(brDublado as any, { requireDubbed: true }), true, 'BR dublado cobre com requireDubbed');
  assert.equal(idxPoolCovered(brDublado as any), true, 'idxPoolCovered cobre BR dublado');
});
