// Fallback do banco (Etapa 4) — supressão de consumidores: dub-audit e
// pools/cobertura do Chupim/warmer. Um item de reserva NÃO pode virar
// candidato de download nem contar como cobertura cached BR que suprime o
// download. Sem rede.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import debrid from '../src/debrid/index.js';
import { collectAuditCandidates, queueDubAudit, runDubAudit } from '../src/providers/dub-audit.js';
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

test('dub-audit: fallback cacheado+dublado não vira candidato nem toca resolveLink', async () => {
  const cached = new Set([cacheHash]);
  const ctx = { season: 1, episode: 1, imdbId: 'tt900' };
  assert.equal(collectAuditCandidates([fbStream], cached, ctx).length, 0, 'fallback fora da auditoria');
  const normal = { ...fbStream, _fromFallback: undefined } as unknown as Stream;
  assert.equal(collectAuditCandidates([normal], cached, ctx).length, 1, 'controle: item vivo entra');
  const originalResolve = debrid.resolveLink;
  const originalEnabled = config.audioAudit.enabled;
  const originalMax = config.debrid.dubAuditTailMax;
  let called = 0;
  debrid.resolveLink = (async () => { called += 1; return null; }) as any;
  config.audioAudit.enabled = true;
  config.debrid.dubAuditTailMax = 5;
  try {
    queueDubAudit('premiumize', 'chave-audit', collectAuditCandidates([fbStream], cached, ctx), 'lista-audit');
    await runDubAudit();
    assert.equal(called, 0, 'resolveLink/markLie/idx não acionados pela reserva');
  } finally {
    debrid.resolveLink = originalResolve;
    config.audioAudit.enabled = originalEnabled;
    config.debrid.dubAuditTailMax = originalMax;
  }
});

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
