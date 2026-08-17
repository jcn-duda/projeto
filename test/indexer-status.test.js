const { test } = require('node:test');
const assert = require('node:assert');

const status = require('../src/providers/indexer-status');
const jackett = require('../src/providers/jackett');
const config = require('../src/config');

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

test('failStreak acumula falhas duras seguidas e zera com sucesso', () => {
  status.clear();
  status.record('idx-a', { ok: false, ms: null, budgetMs: 4000 });
  status.record('idx-a', { ok: false, ms: null, budgetMs: 4000 });
  assert.equal(status.get('idx-a').failStreak, 2);
  status.record('idx-a', { ok: true, ms: 900, budgetMs: 4000, results: 3 });
  assert.equal(status.get('idx-a').failStreak, 0);
});

test('slow e degraded não quebram o circuito', () => {
  status.clear();
  assert.equal(status.record('idx-b', { ok: true, ms: 9000, budgetMs: 4000 }).failStreak, 0);
  assert.equal(status.record('idx-b', { ok: false, results: 5 }).failStreak, 0);
  assert.equal(jackett.breakerTripped('idx-b'), false);
});

test('circuit breaker pula indexer no limiar e meia-abre após o cooldown', () => {
  status.clear();
  for (let i = 0; i < config.jackett.breakerFailures - 1; i += 1) {
    status.record('idx-c', { ok: false, ms: null, budgetMs: 4000 });
  }
  assert.equal(jackett.breakerTripped('idx-c'), false, 'abaixo do limiar o indexer segue na busca');
  status.record('idx-c', { ok: false, ms: null, budgetMs: 4000 }); // atinge o limiar
  assert.equal(jackett.breakerTripped('idx-c'), true);

  // Cooldown vencido: meia-abertura deixa a busca tentar de novo.
  const last = status.get('idx-c');
  const afterCooldown = Date.parse(last.checkedAt) + config.jackett.breakerCooldown + 1;
  assert.equal(jackett.breakerTripped('idx-c', afterCooldown), false);

  // Sucesso na meia-abertura fecha o circuito de vez.
  status.record('idx-c', { ok: true, ms: 1200, budgetMs: 4000, results: 1 });
  assert.equal(jackett.breakerTripped('idx-c'), false);
});

test('restart não perde o circuito aberto (failStreak vem do disco)', () => {
  status.clear();
  for (let i = 0; i < config.jackett.breakerFailures; i += 1) {
    status.record('idx-d', { ok: false, ms: null, budgetMs: 4000 });
  }
  status.dropMemory();
  assert.equal(status.get('idx-d').failStreak, config.jackett.breakerFailures);
  assert.equal(jackett.breakerTripped('idx-d'), true);
  // E a próxima amostra dura continua o streak de onde parou.
  status.record('idx-d', { ok: false, ms: null, budgetMs: 4000 });
  assert.equal(status.get('idx-d').failStreak, config.jackett.breakerFailures + 1);
});
