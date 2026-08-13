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
