const { test } = require('node:test');
const assert = require('node:assert');

const status = require('../src/providers/indexer-status');

test('status classifica online, lento, degradado e offline', () => {
  assert.equal(status.stateFor({ ok: true, ms: 1000, budgetMs: 4000 }), 'online');
  assert.equal(status.stateFor({ ok: true, ms: 5000, budgetMs: 4000 }), 'slow');
  assert.equal(status.stateFor({ ok: false, results: 2 }), 'degraded');
  assert.equal(status.stateFor({ ok: false, results: 0 }), 'offline');
});

test('catálogo recebe cópia do status recente sem mutar a origem', () => {
  status.clear();
  status.record('bludv-cardigann', { ok: true, ms: 1200, budgetMs: 20000 });
  const source = [{ id: 'bludv-cardigann', label: 'BLUDV' }];
  const [decorated] = status.decorate(source);
  assert.equal(decorated.status.state, 'online');
  assert.equal(decorated.status.ms, 1200);
  assert.equal('status' in source[0], false);
});

test('status expirado deixa de ser anunciado no catálogo', () => {
  status.clear();
  const current = status.record('nerdfilmes', { ok: true, ms: 800, budgetMs: 20000 });
  const staleAt = Date.parse(current.checkedAt) + status.TTL_MS + 1;
  assert.equal(status.get('nerdfilmes', staleAt), null);
});

test('falha sem duração não inventa latência zero', () => {
  status.clear();
  const recorded = status.record('nerdfilmes', { ok: false, ms: null, budgetMs: 20000 });
  assert.equal(recorded.state, 'offline');
  assert.equal(recorded.ms, null);
});

test('latência numérica serializada continua sendo exibida', () => {
  status.clear();
  const recorded = status.record('nerdfilmes', { ok: true, ms: '1250', budgetMs: 20000 });
  assert.equal(recorded.state, 'online');
  assert.equal(recorded.ms, 1250);
});

// O status só é medido durante busca real. Sem disco, todo restart do container
// devolvia a página para "desconhecido" mesmo com o indexador no ar.
test('status sobrevive ao restart lendo do cache em disco', () => {
  status.clear();
  status.record('yts', { ok: true, ms: 900, budgetMs: 4000 });

  // Simula o processo novo: a memória zera, o disco continua lá.
  status.dropMemory();
  const recovered = status.get('yts');
  assert.equal(recovered.state, 'online');
  assert.equal(recovered.ms, 900);
});

test('restart não ressuscita status já expirado', () => {
  status.clear();
  const current = status.record('yts', { ok: true, ms: 900, budgetMs: 4000 });
  status.dropMemory();
  const staleAt = Date.parse(current.checkedAt) + status.TTL_MS + 1;
  assert.equal(status.get('yts', staleAt), null);
});

test('status permanece válido exatamente no limite do TTL', () => {
  status.clear();
  const current = status.record('nerdfilmes', { ok: true, ms: 800, budgetMs: 20000 });
  const boundary = Date.parse(current.checkedAt) + status.TTL_MS;
  assert.equal(status.get('nerdfilmes', boundary).state, 'online');
});
