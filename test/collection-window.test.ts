import { test } from 'node:test';
import assert from 'node:assert';

import { collectWithinWindow } from '../src/providers/collection-window.js';
import config from '../src/config.js';
import { computeCollectionBudget, computePriorityGrace } from '../src/providers/collection-budget.js';

function deferred() {
  let resolve: (value?: any) => void = () => {};
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
  const seen: { batch: string[]; total: number }[] = [];
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

test('stopWhen resolve a resposta na hora e as tarefas restantes continuam', async () => {
  const slow = deferred();
  const running = collectWithinWindow([
    { promise: Promise.resolve([{ title: 'Conta A' }, { title: 'Conta B' }]), source: 'account' },
    { promise: slow.promise, priority: true },
  ], {
    budgetMs: 10_000,
    delay: (ms) => new Promise((done) => { setTimeout(done, ms).unref(); }),
    stopWhen: (batch, _items, meta) => meta?.source === 'account' && batch.length >= 2,
  });
  const result = await running;
  assert.equal(result.stoppedEarly, true, 'parou antes do orçamento');
  assert.equal(result.done, false, 'a coleta não fechou — resposta parcial de propósito');
  assert.deepEqual(result.items.map((item) => item.title), ['Conta A', 'Conta B']);
  // A tarefa que ficou para trás continua e o completion dela vive.
  slow.resolve([{ title: 'Tardio', isBr: true }]);
  await result.completion;
});

test('stopWhen que nunca dispara não muda nada', async () => {
  const running = collectWithinWindow([
    { promise: Promise.resolve([{ title: 'A' }]), source: 'jackett' },
  ], {
    budgetMs: 5,
    delay: (ms) => new Promise((done) => { setTimeout(done, ms).unref(); }),
    stopWhen: (batch, _items, meta) => meta?.source === 'account',
  });
  const result = await running;
  assert.equal(result.stoppedEarly, false);
  assert.deepEqual(result.items.map((item) => item.title), ['A']);
});

// -----------------------------------------------------------------------------
// T5 (Tarefa 3.3): Testes da Fórmula da Graça Brasileira e Orçamento Dinâmico
// -----------------------------------------------------------------------------
type BudgetCfg = { replyDeadline: number; debridReserve: number; debridCheckFloor: number; brPartialGrace: number };

/** Salva/restaura os números de config que a fórmula lê e devolve um `set`
 *  parcial. Os testes exercitam computePriorityGrace/computeCollectionBudget DA
 *  PRODUÇÃO — se a fórmula mudar, eles mudam junto; é o que mata o falso-verde
 *  de manter uma cópia local da fórmula aqui dentro. */
function budgetSandbox(base: BudgetCfg) {
  const saved = {
    replyDeadline: config.replyDeadline,
    debridReserve: config.debridReserve,
    debridCheckFloor: config.debridCheckFloor,
    brPartialGrace: config.brPartialGrace,
  };
  const set = (c: Partial<BudgetCfg>) => {
    if (c.replyDeadline !== undefined) config.replyDeadline = c.replyDeadline;
    if (c.debridReserve !== undefined) config.debridReserve = c.debridReserve;
    if (c.debridCheckFloor !== undefined) config.debridCheckFloor = c.debridCheckFloor;
    if (c.brPartialGrace !== undefined) config.brPartialGrace = c.brPartialGrace;
  };
  set(base);
  return { set, restore: () => Object.assign(config, saved) };
}

test('T5: fórmula matemática da graça BR — min(brPartialGrace, max(0, reserve - floor))', () => {
  const { set, restore } = budgetSandbox({ replyDeadline: 8000, debridReserve: 1500, debridCheckFloor: 500, brPartialGrace: 2000 });
  try {
    // 1. Caso padrão: reserva 1500, floor 500, graça 2000 -> 1000ms de graça
    assert.equal(computePriorityGrace(), 1000, 'reserva 1500 - floor 500 deixa 1000ms para a graça');
    // 2. Reserva menor ou igual ao piso do debrid -> graça 0 (nunca invade o piso)
    set({ debridReserve: 400 });
    assert.equal(computePriorityGrace(), 0, 'reserva < floor não gera graça negativa nem invade o piso');
    set({ debridReserve: 500 });
    assert.equal(computePriorityGrace(), 0, 'reserva == floor resulta em graça 0');
    // 3. Piso zero -> graça consome até o teto da reserva
    set({ debridReserve: 1500, debridCheckFloor: 0 });
    assert.equal(computePriorityGrace(), 1500, 'floor zero permite usar toda a reserva');
    // 4. Reserva ampla -> limitada pelo teto de brPartialGrace
    set({ debridReserve: 4000, debridCheckFloor: 500, brPartialGrace: 1000 });
    assert.equal(computePriorityGrace(), 1000, 'clamped em brPartialGrace quando a reserva exceder');
    // 5. brPartialGrace desativada (0)
    set({ debridReserve: 2000, debridCheckFloor: 500, brPartialGrace: 0 });
    assert.equal(computePriorityGrace(), 0, 'graça 0 desativa a janela');
  } finally {
    restore();
  }
});

test('T5: orçamento dinâmico com metadados lentos respeita o piso e o deadline', () => {
  const { restore } = budgetSandbox({ replyDeadline: 8000, debridReserve: 1500, debridCheckFloor: 500, brPartialGrace: 1000 });
  try {
    const startTime = 100_000;
    const deadlineAt = startTime + 8000; // 108_000
    // 1. Busca rápida de metadados (500ms decorridos)
    assert.equal(computeCollectionBudget(deadlineAt, startTime + 500), 6000, '8000 - 500 - 1500 = 6000ms');
    // 2. Metadados lentos (5000ms decorridos)
    assert.equal(computeCollectionBudget(deadlineAt, startTime + 5000), 1500, '8000 - 5000 - 1500 = 1500ms para coleta');
    // 3. Metadados extremamente lentos (7500ms decorridos, quase no deadline)
    assert.equal(computeCollectionBudget(deadlineAt, startTime + 7500), 500, 'piso mínimo de coleta é 500ms');
    // 4. Sem deadline (fallback offline/teste)
    assert.equal(computeCollectionBudget(null), 6500, '8000 - 1500 = 6500ms');
  } finally {
    restore();
  }
});

test('T5: collectWithinWindow executa com budget dinâmico e priorityGrace calculados pela fórmula real', async () => {
  const { restore } = budgetSandbox({ replyDeadline: 8000, debridReserve: 1500, debridCheckFloor: 500, brPartialGrace: 1000 });
  try {
    const agora = Date.now();
    const deadlineAt = agora + 8000;
    const dynamicBudget = computeCollectionBudget(deadlineAt, agora + 4000); // 2500ms
    const dynamicGrace = computePriorityGrace(); // 1000ms

    assert.equal(dynamicBudget, 2500);
    assert.equal(dynamicGrace, 1000);

    const budget = deferred();
    const grace = deferred();
    const fastBr = deferred();

    const running = collectWithinWindow([
      { promise: Promise.resolve([{ title: 'Global 1' }]), priority: false },
      { promise: fastBr.promise, priority: true },
    ], {
      budgetMs: dynamicBudget,
      priorityGraceMs: dynamicGrace,
      delay: (ms) => (ms === dynamicBudget ? budget.promise : grace.promise),
    });

    await Promise.resolve();
    budget.resolve();
    await Promise.resolve();
    fastBr.resolve([{ title: 'BR Dublado', isBr: true }]);

    const result = await running;
    assert.equal(result.prioritySeen, true);
    assert.deepEqual(result.items.map((i) => i.title), ['Global 1', 'BR Dublado']);
  } finally {
    restore();
  }
});

