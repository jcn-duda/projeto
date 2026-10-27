// Fallback do banco (Etapa 4) — supressão de consumidores: pools/cobertura do
// Chupim/warmer. Um item de reserva NÃO pode virar candidato de download nem
// contar como cobertura cached BR que suprime o download. Sem rede.
//
// O consumidor `dub-audit` saiu deste arquivo na T3-L7a: a seleção de quem o
// tail interroga passou para o núcleo Rust (`adom_search::list_builder::effects`,
// teste `audita_so_o_dublado_em_cache_fora_da_reserva`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brDubbedPool, anyDubbedPool, topSeededPool } from '../src/utils/autofetch-pools.js';
import {
  hasCachedBrDubbed,
  cachedBrDubbedTargetQualities,
  pickBrDubbedCandidates,
  pickBrDubbedByTargetQualities,
} from '../src/utils/autofetch-picks.js';
import type { Stream } from '../types/domain.js';

const cacheHash = 'aa'.repeat(20);

const fbStream = {
  infoHash: cacheHash,
  name: 'BR Dublado 1080p',
  title: 'BR Dublado 1080p',
  _br: true,
  _dubbed: true,
  _quality: '1080p',
  _seeders: 9,
  _fromFallback: true,
} as unknown as Stream;

test('pools/warmer/cobertura: fallback não é candidato NEM cobertura cached', () => {
  const cached = new Set([cacheHash]);
  assert.equal(brDubbedPool([fbStream]).length, 0, 'pool BR não seleciona reserva');
  assert.equal(anyDubbedPool([fbStream]).length, 0, 'pool global não seleciona reserva');
  assert.equal(topSeededPool([fbStream], { minSeeders: 1 }).length, 0, 'pool seeds não seleciona reserva');
  assert.equal(pickBrDubbedCandidates([fbStream], new Set(), 10).length, 0, 'pick do Chupim vazio');
  assert.equal(pickBrDubbedByTargetQualities([fbStream], new Set(), 3).length, 0, 'pick por faixa vazio');
  assert.equal(hasCachedBrDubbed([fbStream], cached), false, 'não conta como cobertura cached');
  assert.equal(cachedBrDubbedTargetQualities([fbStream], cached).size, 0, 'não cobre faixa-alvo');
  // Controle: item vivo é candidato e cobre.
  const normal = { ...fbStream, _fromFallback: undefined } as unknown as Stream;
  assert.equal(brDubbedPool([normal]).length, 1);
  assert.equal(pickBrDubbedCandidates([normal], new Set(), 10).length, 1);
  assert.equal(hasCachedBrDubbed([normal], cached), true);
  assert.equal(cachedBrDubbedTargetQualities([normal], cached).has('1080p'), true);
});
