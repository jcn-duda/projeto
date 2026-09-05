import { test } from 'node:test';
import assert from 'node:assert';

import { planJackettQueries, ptSweepIndexers, ptSweepQuery, ptSweepQueryFor, liveIndexers } from '../src/providers/search-plan.js';
import jackett from '../src/providers/jackett.js';
const { shapeSearchQuery } = jackett;

// `plan.find` devolve o elemento ou undefined; os testes garantem a
// presenca por construcao — o cast documenta a invariante.
type PlanTask = ReturnType<typeof planJackettQueries>[number];

test('indexers BR viram tarefas independentes para entrar no balde assim que terminam', () => {
  const plan = planJackettQueries(
    'Joker 2019',
    'Coringa 2019',
    ['thepiratebay', 'bludv-cardigann', 'nerdfilmes'],
    ['bludv-cardigann', 'nerdfilmes'],
  );

  assert.deepEqual(plan, [
    { query: 'Joker 2019', indexers: ['thepiratebay'] },
    { query: 'Coringa 2019', fallback: 'Joker 2019', indexers: ['bludv-cardigann'] },
    { query: 'Coringa 2019', fallback: 'Joker 2019', indexers: ['nerdfilmes'] },
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
    { query: 'Coringa 2019', fallback: 'Joker 2019', indexers: ['bludv-cardigann'] },
  ]);
});

// A query que o Jackett recebe é moldada por indexer: BR perde o SxxEyy (os
// resolvers locais já fazem isso no servidor; definição stock como o
// redetorrent zerava com ele) e bare-title perde também o ano do fim.
test('shapeSearchQuery remove SxxEyy para indexer BR e preserva para global', () => {
  assert.equal(shapeSearchQuery('bludv-cardigann', 'A Casa do Dragão S01E01', true), 'A Casa do Dragao');
  assert.equal(shapeSearchQuery('hdrtorrent', 'A Casa do Dragão S01E01', true), 'A Casa do Dragao');
  assert.equal(shapeSearchQuery('therarbg', 'House of the Dragon S01E01', false), 'House of the Dragon S01E01');
  // Pack de temporada idem.
  assert.equal(shapeSearchQuery('comandotorrents', 'Fallout S01', true), 'Fallout');
});

// O acento zera a busca nos 7 indexers BR (cards locais E stock): o problema
// é do buscador WordPress dos sites, não da definição Cardigann — por isso a
// condição é isBr. Os globais lidam bem com acento (TPB achou 6 para
// "Extermínio") e a varredura pt-BR roda neles — não podem ser tocados.
test('shapeSearchQuery tira o acento da query BR e preserva no global', () => {
  assert.equal(shapeSearchQuery('comandotorrents', 'Extermínio 2002', true), 'Exterminio 2002');
  assert.equal(shapeSearchQuery('therarbg', 'Extermínio', false), 'Extermínio');
});

test('shapeSearchQuery tira só o diacrítico: caixa e pontuação ficam', () => {
  // Se fosse normalizeTitle (lowercase + não-alfanumérico → espaço) a query
  // viraria "o poderoso chefao parte ii" — a prova de que não é.
  assert.equal(shapeSearchQuery('comandotorrents', 'O Poderoso Chefão: Parte II', true), 'O Poderoso Chefao: Parte II');
  // Cobertura dos diacríticos do pt-BR: ã á â à é ê í ó ô õ ú ç.
  assert.equal(
    shapeSearchQuery('nerdfilmes', 'Ação Órfã Pânico Círculo Coração', true),
    'Acao Orfa Panico Circulo Coracao',
  );
});

test('shapeSearchQuery: strip de acento combina com os strips existentes', () => {
  // bare-title tira também o ano do fim; o acento sai junto, na passada BR.
  assert.equal(shapeSearchQuery('hdrtorrent', 'Extermínio 2002', true), 'Exterminio');
});

test('shapeSearchQuery nunca devolve string vazia', () => {
  // Query que a moldagem esvazia cai no fallback `|| query`: o Jackett nunca
  // recebe consulta em branco.
  assert.equal(shapeSearchQuery('comandotorrents', 'S01E01', true), 'S01E01');
  assert.equal(shapeSearchQuery('redetorrent', '  ', true), '  ');
});

test('shapeSearchQuery tira o ano do fim só nos bare-title', () => {
  assert.equal(shapeSearchQuery('redetorrent', 'Coringa 2019', true), 'Coringa');
  assert.equal(shapeSearchQuery('hdrtorrent', 'Coringa 2019', true), 'Coringa');
  assert.equal(shapeSearchQuery('apachetorrent', 'Coringa 2019', true), 'Coringa');
  // Nos resolvers locais o ano ajuda a relevância e FICA.
  assert.equal(shapeSearchQuery('bludv-cardigann', 'Coringa 2019', true), 'Coringa 2019');
  // Título que É um ano não pode sumir da própria query.
  assert.equal(shapeSearchQuery('redetorrent', '1917 2019', true), '1917');
  assert.equal(shapeSearchQuery('hdrtorrent', '1917 2019', true), '1917');
  assert.equal(shapeSearchQuery('redetorrent', '2012', true), '2012');
  assert.equal(shapeSearchQuery('hdrtorrent', '2012', true), '2012');
});

// Plano futuro: o indexador BR tem DUAS queries — a primary em pt-BR e, só
// para ele, um fallback para o título original. O site BR indexa pelo nome em
// português, mas o Wordpress devolve 0 para o título pt-BR às vezes; nesse
// caso a MESMA tentativa pergunta pelo original em vez de desistir.
// O fallback é exclusivo de BR com título diferente: global nunca o carrega
// (ele já recebe o original como primary), e BR com título igual não tem o
// que procurar além do que já pediu.
test('BR com título diferente carrega primary PT e fallback original', () => {
  const plan = planJackettQueries(
    'Joker 2019',
    'Coringa 2019',
    ['thepiratebay', 'bludv-cardigann', 'nerdfilmes'],
    ['bludv-cardigann', 'nerdfilmes'],
  );

  assert.deepEqual(plan, [
    { query: 'Joker 2019', indexers: ['thepiratebay'] },
    { query: 'Coringa 2019', fallback: 'Joker 2019', indexers: ['bludv-cardigann'] },
    { query: 'Coringa 2019', fallback: 'Joker 2019', indexers: ['nerdfilmes'] },
  ]);
});

test('BR com título igual (sem ptQuery) não carrega fallback', () => {
  assert.deepEqual(
    planJackettQueries('Prometheus 2012', null, ['bludv-cardigann'], ['bludv-cardigann']),
    [{ query: 'Prometheus 2012', indexers: ['bludv-cardigann'] }],
  );
});

test('global nunca carrega fallback nem a query pt-BR', () => {
  const plan = planJackettQueries(
    'Joker 2019',
    'Coringa 2019',
    ['thepiratebay', 'redetorrent', 'bludv-cardigann'],
    ['bludv-cardigann'],
    ['redetorrent', 'bludv-cardigann'],
  );

  const globais = plan.filter((tarefa) =>
    tarefa.indexers.every((indexer) => indexer !== 'bludv-cardigann'),
  );
  assert.ok(globais.length > 0, 'plano tem tarefa sem BR');
  assert.ok(globais.every((tarefa) => tarefa.query === 'Joker 2019' && !('fallback' in tarefa)));
  const br = plan.find((tarefa) => tarefa.indexers.includes('bludv-cardigann')) as PlanTask;
  assert.equal(br.query, 'Coringa 2019');
  assert.equal(br.fallback, 'Joker 2019');
});

// Variante numérica: só tarefa BR recebe, derivada da query que ele REALMENTE
// busca (pt-BR, ou a original quando não há ptQuery). Globais ficam na forma
// antiga. Preserva o fallback original EN do lado.
test('BR com pt-BR em romano carrega variante numérica E fallback original', () => {
  const plan = planJackettQueries(
    'Jornada nas Estrelas II: A Ira de Khan 1982',
    null,
    ['thepiratebay', 'bludv-cardigann'],
    ['bludv-cardigann'],
  );
  const br = plan.find((t) => t.indexers.includes('bludv-cardigann')) as PlanTask;
  assert.equal(br.query, 'Jornada nas Estrelas II: A Ira de Khan 1982');
  // ptQuery é null: sem títulos diferentes não há fallback original, mas o
  // numeral romano da própria query original já gera a variante arábica.
  assert.equal(br.variant, 'Jornada nas Estrelas 2: A Ira de Khan 1982');
  assert.equal('fallback' in br, false);
  const global = plan.find((t) => t.indexers.includes('thepiratebay')) as PlanTask;
  assert.equal('variant' in global, false);
  assert.equal('fallback' in global, false);
  assert.equal(global.query, 'Jornada nas Estrelas II: A Ira de Khan 1982');
});

test('BR com pt-BR numerado diferente do original carrega variante + fallback EN', () => {
  const plan = planJackettQueries(
    'Star Trek II: The Wrath of Khan 1982',
    'Jornada nas Estrelas II: A Ira de Khan 1982',
    ['bludv-cardigann'],
    ['bludv-cardigann'],
  );
  const br = plan[0];
  assert.equal(br.query, 'Jornada nas Estrelas II: A Ira de Khan 1982');
  assert.equal(br.variant, 'Jornada nas Estrelas 2: A Ira de Khan 1982');
  // Fallback original EN preservado ao lado da variante numérica.
  assert.equal(br.fallback, 'Star Trek II: The Wrath of Khan 1982');
});

test('BR com título sem romano NÃO carrega variante (forma antiga preservada)', () => {
  assert.deepEqual(
    planJackettQueries('Apollo 13 1995', null, ['bludv-cardigann'], ['bludv-cardigann']),
    [{ query: 'Apollo 13 1995', indexers: ['bludv-cardigann'] }],
  );
});

// A varredura pt-BR tardia consulta os indexers GLOBAIS com o título
// localizado. Os BR já recebem a query pt-BR na busca principal — repeti-los
// na varredura seria consultar duas vezes o mesmo site pela mesma coisa.
