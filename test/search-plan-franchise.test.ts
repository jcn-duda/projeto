// --- Degrau de raiz de franquia no plano BR (cascata) ---
//
// O WordPress BR nao acha o post da colecao com o marcador no fim: em
// tt1411697, "Se Beber, Não Case! Parte II 2011" devolve 0 onde "Se Beber,
// Não Case!" acha a Trilogia (o pack que contem o dublado da continuacao). O
// plano ganha o degrau `franchise` — a raiz da franquia SEM sequencia e SEM
// ano, so quando o corte veio de marcador de sequencia no fim ("Parte II",
// "2") e a raiz tem 2+ palavras.
//
// O ano sai ANTES do corte porque o marcador ancora no fim e "Parte II 2011"
// nunca casaria; o subtitulo no meio (": O Devoto") e o filme sem sequencia
// ("Coringa") ficam SEM degrau; o global nunca recebe a raiz (ele ja nao leva
// nem a query pt nem a variante). O degrau e SEQUENCIAL dentro da mesma
// tarefa — quem executa paga so quando o degrau anterior nao trouxe candidato
// relevante. A regra reusa `franchiseRoot` (format.js), a mesma raiz que a
// varredura pt-BR e a excecao de franquia do inventario usam.
import { test } from 'node:test';
import assert from 'node:assert';

import { planJackettQueries } from '../src/providers/search-plan.js';

// `plan.find` devolve o elemento ou undefined; os testes garantem a presenca
// por construcao — o cast documenta a invariante.
type PlanTask = ReturnType<typeof planJackettQueries>[number];

test('tt1411697: BR bludv recebe primaria pt + variante arabica + raiz da franquia + fallback EN', () => {
  const plan = planJackettQueries(
    'The Hangover Part II 2011',
    'Se Beber, Não Case! Parte II 2011',
    ['thepiratebay', 'bludv-cardigann'],
    ['bludv-cardigann'],
  );

  assert.deepEqual(plan, [
    { query: 'The Hangover Part II 2011', indexers: ['thepiratebay'] },
    {
      query: 'Se Beber, Não Case! Parte II 2011',
      variant: 'Se Beber, Não Case! Parte 2 2011',
      franchise: 'Se Beber, Não Case!',
      fallback: 'The Hangover Part II 2011',
      indexers: ['bludv-cardigann'],
    },
  ]);
});

test('tt1411697: tarefa dos globais nunca carrega variant nem franchise', () => {
  const plan = planJackettQueries(
    'The Hangover Part II 2011',
    'Se Beber, Não Case! Parte II 2011',
    ['thepiratebay', '1337x', 'bludv-cardigann'],
    ['bludv-cardigann'],
  );

  const global = plan.find((t) => t.indexers.includes('thepiratebay')) as PlanTask;
  assert.equal(global.query, 'The Hangover Part II 2011');
  assert.equal('variant' in global, false);
  assert.equal('franchise' in global, false);
  assert.equal('fallback' in global, false);
});

test('filme sem sequencia (Coringa) nao recebe degrau de franquia', () => {
  assert.deepEqual(
    planJackettQueries('Joker 2019', 'Coringa 2019', ['bludv-cardigann'], ['bludv-cardigann']),
    [{ query: 'Coringa 2019', fallback: 'Joker 2019', indexers: ['bludv-cardigann'] }],
  );
});

test('romano no fim sem ptQuery gera variante E raiz da franquia (sem fallback)', () => {
  // Sem ptQuery nao ha fallback original (o BR busca o proprio original); o
  // numeral romano no FIM da query gera os dois degraus restantes — variante
  // arabica e raiz da franquia. Sequencia seguida de subtitulo NAO conta: o
  // gate SEQUENCE_TAIL exige o marcador no fim (ver o caso do Devoto).
  assert.deepEqual(
    planJackettQueries(
      'The Hangover Part II 2011',
      null,
      ['bludv-cardigann'],
      ['bludv-cardigann'],
    ),
    [
      {
        query: 'The Hangover Part II 2011',
        variant: 'The Hangover Part 2 2011',
        franchise: 'The Hangover Part',
        indexers: ['bludv-cardigann'],
      },
    ],
  );
});

test('corte so por subtitulo (": O Devoto") nao cria degrau de franquia', () => {
  // O Exorcista: O Devoto e a continuacao, mas o corte do franchiseRoot vem do
  // SUBTITULO no meio — o gate SEQUENCE_TAIL (marcador no fim) e o que separa
  // os dois casos, e aqui nao dispara.
  assert.deepEqual(
    planJackettQueries(
      'The Exorcist: Believer 2023',
      'O Exorcista: O Devoto 2023',
      ['bludv-cardigann'],
      ['bludv-cardigann'],
    ),
    [
      {
        query: 'O Exorcista: O Devoto 2023',
        fallback: 'The Exorcist: Believer 2023',
        indexers: ['bludv-cardigann'],
      },
    ],
  );
});

test('numero que e o nome da obra (Distrito 9) nao vira marcador de sequencia', () => {
  // A trava de 2+ palavras do franchiseRoot devolve a propria entrada quando a
  // raiz seria curta demais ("Distrito"), entao nao ha degrau — igual a regra
  // da varredura pt-BR.
  assert.deepEqual(
    planJackettQueries('District 9', 'Distrito 9', ['bludv-cardigann'], ['bludv-cardigann']),
    [{ query: 'Distrito 9', fallback: 'District 9', indexers: ['bludv-cardigann'] }],
  );
});

test('degrau de franquia coexiste com a varredura pt-BR dos globais sem colidir', () => {
  // A varredura (`sweepQuery`) e uma task EXTRA dos globais; o degrau de
  // franquia vive na tarefa BR isolada. Os dois podem pedir a mesma raiz
  // ("Se Beber, Não Case") — sao destinos diferentes (global x BR) e nao se
  // anulam.
  const plan = planJackettQueries(
    'The Hangover Part II 2011',
    'Se Beber, Não Case! Parte II 2011',
    ['thepiratebay', 'bludv-cardigann'],
    ['bludv-cardigann'],
    [],
    'Se Beber, Não Case',
  );

  assert.deepEqual(plan, [
    { query: 'The Hangover Part II 2011', indexers: ['thepiratebay'] },
    { query: 'Se Beber, Não Case', indexers: ['thepiratebay'] },
    {
      query: 'Se Beber, Não Case! Parte II 2011',
      variant: 'Se Beber, Não Case! Parte 2 2011',
      franchise: 'Se Beber, Não Case!',
      fallback: 'The Hangover Part II 2011',
      indexers: ['bludv-cardigann'],
    },
  ]);
});