import { test } from 'node:test';
import assert from 'node:assert';

import * as indexerStatus from '../src/providers/indexer-status.js';

test('status classifica online, lento, degradado e offline', () => {
  assert.equal(indexerStatus.stateFor({ ok: true, ms: 1000, budgetMs: 4000 }), 'online');
  assert.equal(indexerStatus.stateFor({ ok: true, ms: 5000, budgetMs: 4000 }), 'slow');
  assert.equal(indexerStatus.stateFor({ ok: false, results: 2 }), 'degraded');
  assert.equal(indexerStatus.stateFor({ ok: false, results: 0 }), 'offline');
});

test('catálogo recebe cópia do status recente sem mutar a origem', () => {
  indexerStatus.clear();
  indexerStatus.record('bludv-cardigann', { ok: true, ms: 1200, budgetMs: 20000 });
  const source = [{ id: 'bludv-cardigann', label: 'BLUDV' }];
  const [decorated] = indexerStatus.decorate(source);
  assert.equal(decorated.status.state, 'online');
  assert.equal(decorated.status.ms, 1200);
  assert.equal('status' in source[0], false);
});

test('status expirado deixa de ser anunciado no catálogo', () => {
  indexerStatus.clear();
  const current = indexerStatus.record('nerdfilmes', { ok: true, ms: 800, budgetMs: 20000 });
  const staleAt = Date.parse(current!.checkedAt) + indexerStatus.TTL_MS + 1;
  assert.equal(indexerStatus.get('nerdfilmes', staleAt), null);
});

test('falha sem duração não inventa latência zero', () => {
  indexerStatus.clear();
  const recorded = indexerStatus.record('nerdfilmes', { ok: false, ms: null, budgetMs: 20000 });
  assert.equal(recorded!.state, 'offline');
  assert.equal(recorded!.ms, null);
});

test('latência numérica serializada continua sendo exibida', () => {
  indexerStatus.clear();
  const recorded = indexerStatus.record('nerdfilmes', { ok: true, ms: '1250', budgetMs: 20000 });
  assert.equal(recorded!.state, 'online');
  assert.equal(recorded!.ms, 1250);
});

// O status só é medido durante busca real. Sem disco, todo restart do container
// devolvia a página para "desconhecido" mesmo com o indexador no ar.
test('status sobrevive ao restart lendo do cache em disco', () => {
  indexerStatus.clear();
  indexerStatus.record('yts', { ok: true, ms: 900, budgetMs: 4000 });

  // Simula o processo novo: a memória zera, o disco continua lá.
  indexerStatus.dropMemory();
  const recovered = indexerStatus.get('yts');
  assert.equal(recovered.state, 'online');
  assert.equal(recovered.ms, 900);
});

test('restart não ressuscita status já expirado', () => {
  indexerStatus.clear();
  const current = indexerStatus.record('yts', { ok: true, ms: 900, budgetMs: 4000 });
  indexerStatus.dropMemory();
  const staleAt = Date.parse(current!.checkedAt) + indexerStatus.TTL_MS + 1;
  assert.equal(indexerStatus.get('yts', staleAt), null);
});

test('status permanece válido exatamente no limite do TTL', () => {
  indexerStatus.clear();
  const current = indexerStatus.record('nerdfilmes', { ok: true, ms: 800, budgetMs: 20000 });
  const boundary = Date.parse(current!.checkedAt) + indexerStatus.TTL_MS;
  assert.equal(indexerStatus.get('nerdfilmes', boundary).state, 'online');
});

test('failStreak acumula falhas duras seguidas e zera com sucesso', () => {
  indexerStatus.clear();
  indexerStatus.record('idx-a', { ok: false, ms: null, budgetMs: 4000 });
  indexerStatus.record('idx-a', { ok: false, ms: null, budgetMs: 4000 });
  assert.equal(indexerStatus.get('idx-a').failStreak, 2);
  indexerStatus.record('idx-a', { ok: true, ms: 900, budgetMs: 4000, results: 3 });
  assert.equal(indexerStatus.get('idx-a').failStreak, 0);
});

test('slow e degraded não acumulam failStreak', () => {
  indexerStatus.clear();
  assert.equal(indexerStatus.record('idx-b', { ok: true, ms: 9000, budgetMs: 4000 })!.failStreak, 0);
  assert.equal(indexerStatus.record('idx-b', { ok: false, results: 5 })!.failStreak, 0);
});

test('restart não perde o failStreak (vem do disco)', () => {
  indexerStatus.clear();
  const LIMIAR = 3;
  for (let i = 0; i < LIMIAR; i += 1) {
    indexerStatus.record('idx-d', { ok: false, ms: null, budgetMs: 4000 });
  }
  indexerStatus.dropMemory();
  assert.equal(indexerStatus.get('idx-d').failStreak, LIMIAR);
  // E a próxima amostra dura continua o streak de onde parou.
  indexerStatus.record('idx-d', { ok: false, ms: null, budgetMs: 4000 });
  assert.equal(indexerStatus.get('idx-d').failStreak, LIMIAR + 1);
});
