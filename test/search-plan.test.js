const { test } = require('node:test');
const assert = require('node:assert');

const { planJackettQueries } = require('../src/providers/search-plan');

test('indexers BR viram tarefas independentes para entrar no balde assim que terminam', () => {
  const plan = planJackettQueries(
    'Joker 2019',
    'Coringa 2019',
    ['thepiratebay', 'bludv-cardigann', 'nerdfilmes'],
    ['bludv-cardigann', 'nerdfilmes'],
  );

  assert.deepEqual(plan, [
    { query: 'Joker 2019', indexers: ['thepiratebay'] },
    { query: 'Coringa 2019', indexers: ['bludv-cardigann'] },
    { query: 'Coringa 2019', indexers: ['nerdfilmes'] },
  ]);
});

test('título igual reutiliza a query original nos indexers BR', () => {
  assert.deepEqual(
    planJackettQueries('Prometheus 2012', null, ['bludv-cardigann'], ['bludv-cardigann']),
    [{ query: 'Prometheus 2012', indexers: ['bludv-cardigann'] }],
  );
});
