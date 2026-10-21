// Identidade ESTRUTURAL da varredura pt-BR inline.
//
// A marca de varredura é o campo `sweep` do plano, nunca a igualdade de texto
// (`ptQuery === sweepQuery`): a BR isolada com a mesma query da varredura
// continua principal e não vira varredura.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planJackettQueries } from '../src/providers/search-plan.js';

test('plano: BR isolada com ptQuery === sweepQuery NÃO é marcada como sweep', () => {
  const plan = planJackettQueries(
    'The Crow',
    'O Corvo',
    ['thepiratebay', 'bludv-cardigann'],
    ['bludv-cardigann'],
    [],
    'O Corvo',
  );

  const br = plan.find((t) => t.indexers.includes('bludv-cardigann'));
  const sweep = plan.find((t) => t.sweep === true);
  assert.ok(br, 'a BR isolada existe no plano');
  assert.ok(sweep, 'a varredura agrupada existe e é rotulada');
  assert.equal(br.query, 'O Corvo');
  assert.equal(sweep.query, 'O Corvo', 'as duas pedem a MESMA query — o texto não distingue');
  assert.equal('sweep' in br, false, 'a BR isolada NÃO carrega a marca de varredura');
  assert.deepEqual(sweep.indexers, ['thepiratebay'], 'a varredura é só dos globais agrupados');
});

// Grouped vazio (tudo BR/isolado): não existe task AGRUPADA para anexar a
// varredura. Nenhuma task pode carregar a marca — e a BR continua principal.
test('plano: grouped vazio (todas as selecionadas BR) não cria varredura', () => {
  const plan = planJackettQueries(
    'The Crow',
    'O Corvo',
    ['bludv-cardigann', 'nerdfilmes'],
    ['bludv-cardigann', 'nerdfilmes'],
    [],
    'O Corvo',
  );
  assert.equal(plan.length, 2, 'só as duas isoladas');
  assert.equal(plan.some((t) => t.sweep === true), false, 'sem globais não há varredura agrupada');
  assert.ok(plan.every((t) => t.indexers.length === 1 && !('sweep' in t)), 'nenhuma isolada é varredura');
  assert.ok(plan.every((t) => t.query === 'O Corvo'));
});
