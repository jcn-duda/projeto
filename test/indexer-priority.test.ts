import { test } from 'node:test';
import assert from 'node:assert';

import { priorityMap, compareIndexerPriority } from '../src/utils/indexer-priority.js';

test('prioridade respeita a ordem escolhida e deixa desconhecidos por último', () => {
  const ranks = priorityMap(['NerdFilmes', 'comandotorrents', 'nerdfilmes'] as never[]);
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
