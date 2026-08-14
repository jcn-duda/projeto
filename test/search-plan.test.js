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

test('indexer lento não-BR vira tarefa sozinha e mantém a query em inglês', () => {
  const plan = planJackettQueries(
    'Joker 2019',
    'Coringa 2019',
    ['thepiratebay', 'redetorrent', 'bludv-cardigann'],
    ['bludv-cardigann'],
    ['redetorrent', 'bludv-cardigann'],
  );

  assert.deepEqual(plan, [
    { query: 'Joker 2019', indexers: ['thepiratebay'] },
    { query: 'Joker 2019', indexers: ['redetorrent'] },
    { query: 'Coringa 2019', indexers: ['bludv-cardigann'] },
  ]);
});

// A query que o Jackett recebe é moldada por indexer: BR perde o SxxEyy (os
// resolvers locais já fazem isso no servidor; definição stock como o
// redetorrent zerava com ele) e bare-title perde também o ano do fim.
const { shapeSearchQuery } = require('../src/providers/jackett');

test('shapeSearchQuery remove SxxEyy para indexer BR e preserva para global', () => {
  assert.equal(shapeSearchQuery('bludv-cardigann', 'A Casa do Dragão S01E01', true), 'A Casa do Dragão');
  assert.equal(shapeSearchQuery('therarbg', 'House of the Dragon S01E01', false), 'House of the Dragon S01E01');
  // Pack de temporada idem.
  assert.equal(shapeSearchQuery('comandotorrents', 'Fallout S01', true), 'Fallout');
});

test('shapeSearchQuery tira o ano do fim só nos bare-title', () => {
  assert.equal(shapeSearchQuery('redetorrent', 'Coringa 2019', true), 'Coringa');
  // Nos resolvers locais o ano ajuda a relevância e FICA.
  assert.equal(shapeSearchQuery('bludv-cardigann', 'Coringa 2019', true), 'Coringa 2019');
  // Título que É um ano não pode sumir da própria query.
  assert.equal(shapeSearchQuery('redetorrent', '1917 2019', true), '1917');
  assert.equal(shapeSearchQuery('redetorrent', '2012', true), '2012');
});
