const { test } = require('node:test');
const assert = require('node:assert');

const { priorityMap, compareIndexerPriority } = require('../src/utils/indexer-priority');

test('prioridade respeita a ordem escolhida e deixa desconhecidos por último', () => {
  const ranks = priorityMap(['NerdFilmes', 'comandotorrents', 'nerdfilmes']);
  const streams = [
    { id: 'global', _indexer: 'thepiratebay' },
    { id: 'comando', _indexer: 'comandotorrents' },
    { id: 'nerd', _indexer: 'nerdfilmes' },
  ];
  streams.sort((a, b) => compareIndexerPriority(a, b, ranks));
  assert.deepEqual(streams.map((stream) => stream.id), ['nerd', 'comando', 'global']);
});

test('sem prioridade não altera o desempate existente', () => {
  assert.equal(compareIndexerPriority({ _indexer: 'a' }, { _indexer: 'b' }, priorityMap([])), 0);
});
