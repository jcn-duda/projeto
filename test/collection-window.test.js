const { test } = require('node:test');
const assert = require('node:assert');

const { collectWithinWindow } = require('../src/providers/collection-window');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('janela extra inclui a primeira fonte BR que perde o orçamento normal por pouco', async () => {
  const budget = deferred();
  const grace = deferred();
  const br = deferred();
  const slow = deferred();
  const running = collectWithinWindow([
    { promise: Promise.resolve([{ title: 'Global' }]), priority: false },
    { promise: br.promise, priority: true },
    { promise: slow.promise, priority: true },
  ], {
    budgetMs: 15,
    priorityGraceMs: 30,
    delay: (ms) => ms === 15 ? budget.promise : grace.promise,
  });
  await Promise.resolve();
  budget.resolve();
  await Promise.resolve();
  br.resolve([{ title: 'Dia D Dublado', isBr: true }]);
  const result = await running;

  assert.equal(result.done, false);
  assert.equal(result.prioritySeen, true);
  assert.deepEqual(result.items.map((item) => item.title), ['Global', 'Dia D Dublado']);
  slow.resolve([{ title: 'BR muito lento', isBr: true }]);
  await result.completion;
});

test('sem tarefa BR não consome a janela extra', async () => {
  const budget = deferred();
  const slow = deferred();
  let graceRequested = false;
  const running = collectWithinWindow([
    { promise: Promise.resolve([{ title: 'Global' }]), priority: false },
    { promise: slow.promise, priority: false },
  ], {
    budgetMs: 10,
    priorityGraceMs: 15,
    delay: (ms) => {
      if (ms === 15) graceRequested = true;
      return budget.promise;
    },
  });
  await Promise.resolve();
  budget.resolve();
  const result = await running;

  assert.equal(result.done, false);
  assert.equal(result.prioritySeen, false);
  assert.equal(graceRequested, false);
  slow.resolve([]);
  await result.completion;
});

test('graceRequiresItems: balde vazio pula a janela extra (vai pro fallback de pack)', async () => {
  const budget = deferred();
  const slow = deferred();
  let graceRequested = false;
  const running = collectWithinWindow([
    { promise: slow.promise, priority: true },
  ], {
    budgetMs: 10,
    priorityGraceMs: 25,
    graceRequiresItems: true,
    delay: (ms) => {
      if (ms === 25) graceRequested = true;
      return budget.promise;
    },
  });
  await Promise.resolve();
  budget.resolve();
  const result = await running;

  assert.equal(result.done, false);
  assert.equal(graceRequested, false);
  assert.deepEqual(result.items, []);
  slow.resolve([{ title: 'BR atrasado', isBr: true }]);
  await result.completion;
});

test('graceRequiresItems: com itens no balde a janela extra vale para série', async () => {
  const budget = deferred();
  const grace = deferred();
  const br = deferred();
  const running = collectWithinWindow([
    { promise: Promise.resolve([{ title: 'Global' }]), priority: false },
    { promise: br.promise, priority: true },
  ], {
    budgetMs: 10,
    priorityGraceMs: 25,
    graceRequiresItems: true,
    delay: (ms) => (ms === 10 ? budget.promise : grace.promise),
  });
  await Promise.resolve();
  budget.resolve();
  await Promise.resolve();
  br.resolve([{ title: 'E01 Dublado', isBr: true }]);
  const result = await running;

  assert.equal(result.prioritySeen, true);
  assert.deepEqual(result.items.map((item) => item.title), ['Global', 'E01 Dublado']);
  await result.completion;
});

test('fonte BR dentro do orçamento não consome a janela extra', async () => {
  const budget = deferred();
  const slow = deferred();
  let graceRequested = false;
  const running = collectWithinWindow([
    { promise: Promise.resolve([{ title: 'BR', isBr: true }]), priority: true },
    { promise: slow.promise, priority: false },
  ], {
    budgetMs: 10,
    priorityGraceMs: 40,
    delay: (ms) => {
      if (ms === 40) graceRequested = true;
      return budget.promise;
    },
  });
  await Promise.resolve();
  budget.resolve();
  const result = await running;

  assert.equal(result.prioritySeen, true);
  assert.equal(graceRequested, false);
  slow.resolve([]);
  await result.completion;
});

test('onBatch avisa cada lote tardio sem esperar todos os providers', async () => {
  const budget = deferred();
  const first = deferred();
  const last = deferred();
  const seen = [];
  const running = collectWithinWindow([
    { promise: first.promise, priority: true },
    { promise: last.promise, priority: true },
  ], {
    budgetMs: 10,
    priorityGraceMs: 0,
    delay: () => budget.promise,
    onBatch: (batch, all) => seen.push({ batch: batch.map((x) => x.title), total: all.length }),
  });
  await Promise.resolve();
  budget.resolve();
  const result = await running;
  assert.equal(result.done, false);

  first.resolve([{ title: 'BR primeiro', isBr: true }]);
  await Promise.resolve();
  assert.deepEqual(seen, [{ batch: ['BR primeiro'], total: 1 }]);
  last.resolve([{ title: 'BR final', isBr: true }]);
  await result.completion;
  assert.deepEqual(seen[1], { batch: ['BR final'], total: 2 });
});
