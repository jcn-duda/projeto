// Ponte do status dos indexadores medido pelo GATEWAY (`GET /indexers/status`)
// para o `indexer-status` do Node. Sem ela o painel mostrava todo indexador
// "desconhecido" desde a Fase 5 (o `jackett.ts`, que gravava, saiu).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as indexerStatus from '../src/providers/indexer-status.js';
import {
  breakerFor,
  ingestNativeIndexerStatus,
  refreshNativeIndexerStatus,
  resetIndexerStatusBridgeForTests,
} from '../src/providers/indexer-status-native.js';
import { stubFetch } from './helpers/stub.js';

beforeEach(() => {
  indexerStatus.clear();
  resetIndexerStatusBridgeForTests();
});

const sample = (id: string, extra: Record<string, unknown> = {}) => ({
  id, ok: true, ms: 300, results: 10, budgetMs: 8000, at: Date.now() - 1000, ...extra,
});

test('amostra do gateway vira o estado de sempre (online/lento/offline/degradado)', () => {
  const n = ingestNativeIndexerStatus([
    { id: 'eztv', sample: sample('eztv') },
    { id: 'yts', sample: sample('yts', { ms: 9000 }) },
    { id: 'bludv-cardigann', sample: sample('bludv-cardigann', { ok: false, ms: 20000, results: 0 }) },
    { id: 'nyaasi', sample: sample('nyaasi', { ok: false, results: 3 }) },
  ]);
  assert.equal(n, 4);
  assert.equal(indexerStatus.get('eztv')?.state, 'online');
  assert.equal(indexerStatus.get('eztv')?.ms, 300);
  assert.equal(indexerStatus.get('yts')?.state, 'slow', 'acima do orçamento do indexer');
  assert.equal(indexerStatus.get('bludv-cardigann')?.state, 'offline');
  assert.equal(indexerStatus.get('nyaasi')?.state, 'degraded');
});

test('a mesma consulta não conta duas vezes; amostra velha não sobrescreve nova', () => {
  const at = Date.now() - 500;
  assert.equal(ingestNativeIndexerStatus([{ id: 'eztv', sample: sample('eztv', { at, ok: false, results: 0 }) }]), 1);
  assert.equal(ingestNativeIndexerStatus([{ id: 'eztv', sample: sample('eztv', { at, ok: false, results: 0 }) }]), 0);
  assert.equal(indexerStatus.get('eztv')?.failStreak, 1, 'o poll repetido não infla a sequência de falhas');
  assert.equal(ingestNativeIndexerStatus([{ id: 'eztv', sample: sample('eztv', { at: at - 10_000 }) }]), 0);
  assert.equal(indexerStatus.get('eztv')?.state, 'offline');
});

test('o TTL conta da medição no gateway, não da ingestão', () => {
  const old = Date.now() - (indexerStatus.TTL_MS + 60_000);
  ingestNativeIndexerStatus([{ id: 'eztv', sample: sample('eztv', { at: old }) }]);
  assert.equal(indexerStatus.get('eztv'), null, 'amostra vencida não aparece como medida');
});

test('breaker vem do gateway; sem foto é null (o painel mostra "não medido")', () => {
  ingestNativeIndexerStatus([
    { id: 'bludv-cardigann', breaker: { tripped: true, state: 'aberto', failStreak: 3, cooldownRemainingMs: 60000 } },
  ]);
  assert.equal(breakerFor('BLUDV-cardigann')?.tripped, true);
  assert.equal(indexerStatus.get('bludv-cardigann'), null, 'breaker aberto não inventa consulta');
  assert.equal(breakerFor('eztv'), null);
});

test('refresh lê a admin do gateway; ponte fora devolve false sem lançar', async () => {
  const ok = stubFetch((url) => {
    assert.match(url, /\/indexers\/status$/);
    return { ok: true, status: 200, json: async () => ({ ok: true, indexers: [{ id: 'eztv', sample: sample('eztv') }] }) };
  });
  try {
    assert.equal(await refreshNativeIndexerStatus(), true);
    assert.equal(indexerStatus.get('eztv')?.state, 'online');
  } finally {
    ok.restore();
  }
  const down = stubFetch(() => { throw new Error('ECONNREFUSED'); });
  try {
    assert.equal(await refreshNativeIndexerStatus(), false);
    assert.equal(indexerStatus.get('eztv')?.state, 'online', 'o que já estava medido continua');
  } finally {
    down.restore();
  }
});
