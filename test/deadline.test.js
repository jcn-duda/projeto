const { test } = require('node:test');
const assert = require('node:assert');

// raceWithDeadline disputa uma tarefa com um prazo sem cancelar o trabalho
// tardio: quem vence devolve o próprio retorno, e o timer do lado perdedor é
// sempre cancelado no finally. Os três casos abaixo são o contrato que o
// findStreams (providers/index.js) usa pra devolver lista parcial antes do
// timeout do cliente Stremio sem derrubar a busca que segue em background.
const { raceWithDeadline, remainingCheckBudget } = require('../src/utils/deadline');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('tarefa vence e onDeadline não dispara depois', async () => {
  let deadlineFired = false;
  const result = await raceWithDeadline(
    // Margem larga entre tarefa (10ms) e prazo (300ms): mesmo com event loop
    // carregado, quem vence é a tarefa — de forma determinística.
    sleep(10).then(() => 'pronto'),
    300,
    () => {
      deadlineFired = true;
      return { partial: true };
    },
  );

  assert.equal(result, 'pronto');
  // Folga além do prazo: se o timer não fosse cancelado no finally, já teria
  // disparado muito antes deste ponto.
  await sleep(400);
  assert.equal(deadlineFired, false);
});

test('prazo vence com o valor esperado e a tarefa segue em background', async () => {
  let taskDone = false;
  const task = (async () => {
    await sleep(600);
    taskDone = true;
    return 'tardio';
  })();

  const started = Date.now();
  const result = await raceWithDeadline(task, 100, () => ({ streams: [], partial: true }));

  // O valor do prazo é o retorno de onDeadline — o formato que o findStreams usa.
  assert.deepEqual(result, { streams: [], partial: true });
  // No instante em que o prazo venceu, a tarefa ainda estava trabalhando.
  assert.equal(taskDone, false);
  assert.ok(Date.now() - started < 400, 'prazo tem que vencer bem antes da tarefa');

  // ...e continua em background até terminar por conta própria.
  assert.equal(await task, 'tardio');
  assert.equal(taskDone, true);
});

test('rejeição da tarefa propaga e não deixa o onDeadline disparar', async () => {
  let deadlineFired = false;
  const task = (async () => {
    await sleep(10);
    throw new Error('falha do provider');
  })();

  await assert.rejects(
    raceWithDeadline(task, 300, () => {
      deadlineFired = true;
      return { partial: true };
    }),
    /falha do provider/,
  );

  // Mesmo com a rejeição, o timer do prazo é cancelado: nada dispara depois.
  await sleep(400);
  assert.equal(deadlineFired, false);
});

test('passe tardio não recebe teto dinâmico de checagem', () => {
  assert.equal(remainingCheckBudget(null, 6000, 500), null);
  assert.equal(remainingCheckBudget(undefined, 6000, 500), null);
});

test('orçamento da checagem desconta o tempo consumido e a margem final', () => {
  assert.equal(remainingCheckBudget(10000, 6000, 500), 3500);
  assert.equal(remainingCheckBudget(10000, 6000), 4000);
});

test('orçamento esgotado nunca fica negativo', () => {
  assert.equal(remainingCheckBudget(10000, 9500, 500), 0);
  assert.equal(remainingCheckBudget(10000, 9800, 500), 0);
});
