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
  assert.equal(shapeSearchQuery('bludv-cardigann', 'A Casa do Dragão S01E01', true), 'A Casa do Dragão');
  assert.equal(shapeSearchQuery('hdrtorrent', 'A Casa do Dragão S01E01', true), 'A Casa do Dragão');
  assert.equal(shapeSearchQuery('therarbg', 'House of the Dragon S01E01', false), 'House of the Dragon S01E01');
  // Pack de temporada idem.
  assert.equal(shapeSearchQuery('comandotorrents', 'Fallout S01', true), 'Fallout');
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

test('planJackettQueries acrescenta sweep apenas aos globais', () => {
  assert.deepEqual(
    planJackettQueries('Star Trek', 'Jornada nas Estrelas', ['thepiratebay', 'bludv-cardigann'], ['bludv-cardigann'], [], 'Jornada nas Estrelas'),
    [
      { query: 'Star Trek', indexers: ['thepiratebay'] },
      { query: 'Jornada nas Estrelas', indexers: ['thepiratebay'] },
      { query: 'Jornada nas Estrelas', indexers: ['bludv-cardigann'], fallback: 'Star Trek' },
    ],
  );
  assert.deepEqual(
    planJackettQueries('Jornada nas Estrelas', 'Jornada nas Estrelas', ['thepiratebay'], [], [], 'Jornada nas Estrelas'),
    [{ query: 'Jornada nas Estrelas', indexers: ['thepiratebay'] }],
  );
});

// 6.1 — A varredura INLINE (caminho crítico) é uma task extra no plano da
// coleta, anexada aos globais do caminho crítico (`grouped`): os BR já recebem
// o título localizado na própria task isolada, e os lentos isolados não cabem
// no orçamento. Sem `variant`/`fallback` — a cascata BR de `queryIndexer` nem
// existe para globais — e a falha da consulta não pode gravar status no
// indexer (o tail usa `recordStatus:false` pelo mesmo motivo; a task inline
// deve seguir).
test('planJackettQueries: sweepQuery vira UMA task extra dos globais, sem variant/fallback', () => {
  const plan = planJackettQueries(
    'Joker 2019',
    'Coringa 2019',
    ['thepiratebay', '1337x', 'bludv-cardigann'],
    ['bludv-cardigann'],
    [],
    'Coringa',
  );

  assert.deepEqual(plan, [
    { query: 'Joker 2019', indexers: ['thepiratebay', '1337x'] },
    { query: 'Coringa', indexers: ['thepiratebay', '1337x'] },
    { query: 'Coringa 2019', fallback: 'Joker 2019', indexers: ['bludv-cardigann'] },
  ]);

  const sweeps = plan.filter((task) => task.query === 'Coringa');
  assert.equal(sweeps.length, 1, 'exatamente UMA task da varredura');
  assert.deepEqual(sweeps[0].indexers, ['thepiratebay', '1337x']);
  assert.equal('variant' in sweeps[0], false, 'task de globais não carrega variante');
  assert.equal('fallback' in sweeps[0], false, 'task de globais não carrega fallback');
  // A task principal e as isoladas BR ficam intactas.
  assert.equal(plan[0].query, 'Joker 2019');
  const br = plan.find((t) => t.indexers.includes('bludv-cardigann')) as PlanTask;
  assert.equal(br.query, 'Coringa 2019');
  assert.equal(br.fallback, 'Joker 2019');
});

test('planJackettQueries: sweepQuery igual à query principal não duplica task', () => {
  // Guarda `sweepQuery !== query`: sem ela, o caso raro de a varredura
  // coincidir com a principal criaria duas tasks idênticas de globais.
  assert.deepEqual(
    planJackettQueries(
      'Jornada nas Estrelas',
      'Jornada nas Estrelas',
      ['thepiratebay', '1337x'],
      [],
      [],
      'Jornada nas Estrelas',
    ),
    [{ query: 'Jornada nas Estrelas', indexers: ['thepiratebay', '1337x'] }],
  );
});

test('planJackettQueries: grouped vazio (tudo BR/lento selecionado) não cria varredura', () => {
  const plan = planJackettQueries(
    'Joker 2019',
    'Coringa 2019',
    ['bludv-cardigann', 'redetorrent'],
    ['bludv-cardigann'],
    ['redetorrent', 'bludv-cardigann'],
    'Coringa',
  );
  assert.deepEqual(plan, [
    { query: 'Coringa 2019', fallback: 'Joker 2019', indexers: ['bludv-cardigann'] },
    { query: 'Joker 2019', indexers: ['redetorrent'] },
  ]);
  assert.ok(plan.every((task) => task.query !== 'Coringa'));
});

test('planJackettQueries: sweepQuery ausente (5 args) preserva o plano antigo', () => {
  // Forma antiga: sem o 6º parâmetro o deepEqual dos testes existentes tem que
  // continuar valendo — a task extra só existe quando sweepQuery chega.
  assert.deepEqual(
    planJackettQueries('Joker 2019', 'Coringa 2019', ['thepiratebay'], []),
    [{ query: 'Joker 2019', indexers: ['thepiratebay'] }],
  );
  const comSweep = planJackettQueries('Joker 2019', 'Coringa 2019', ['thepiratebay'], [], [], 'Coringa');
  const semSweep = planJackettQueries('Joker 2019', 'Coringa 2019', ['thepiratebay'], []);
  assert.equal(comSweep.length, semSweep.length + 1);
});

test('ptSweepIndexers devolve só os globais selecionados', () => {
  assert.deepEqual(
    ptSweepIndexers(
      ['thepiratebay', '1337x', 'bludv-cardigann', 'nerdfilmes'],
      ['bludv-cardigann', 'nerdfilmes', 'comandotorrents'],
    ),
    ['thepiratebay', '1337x'],
  );
});

test('ptSweepIndexers devolve vazio quando tudo selecionado é BR', () => {
  assert.deepEqual(
    ptSweepIndexers(['bludv-cardigann', 'nerdfilmes'], ['bludv-cardigann', 'nerdfilmes']),
    [],
  );
});

// Query da varredura: tracker global casa por palavras do título, e
// "Jornada nas Estrelas: O Filme" devolvia 1 resultado num único indexer
// quando "Jornada nas Estrelas" devolvia 13 em três. A precisão continua
// garantida pelo matchContext, que roda depois. A função nunca anexa o ano
// (responsabilidade de quem chama) e devolve '' sem título pt.

test('ptSweepQuery corta subtítulo com prefixo de 2+ palavras', () => {
  assert.equal(ptSweepQuery('Jornada nas Estrelas: O Filme'), 'Jornada nas Estrelas');
  assert.equal(ptSweepQuery('Alice no País das Maravilhas – O Filme'), 'Alice no País das Maravilhas');
  // En-dash, em-dash E dois-pontos caem na mesma regra.
  assert.equal(ptSweepQuery('O Senhor dos Anéis — A Sociedade do Anel'), 'O Senhor dos Anéis');
});

test('ptSweepQuery preserva subtítulo com prefixo de 1 palavra', () => {
  // Cortar abriria "Missão: Impossível" em "Missão", e a release real some do
  // resultado: o tracker casa o nome inteiro, não o prefixo.
  assert.equal(ptSweepQuery('Missão: Impossível'), 'Missão: Impossível');
  assert.equal(ptSweepQuery('Operação:idão Final'), 'Operação:idão Final');
});

test('ptSweepQuery devolve o título sem ano', () => {
  // A função só lida com o título; o ano é responsabilidade de quem chama
  // (na varredura, é propositalmente omitido para não derrubar o recall).
  assert.equal(ptSweepQuery('Coringa'), 'Coringa');
  assert.equal(ptSweepQuery('Jornada nas Estrelas'), 'Jornada nas Estrelas');
});

test('ptSweepQuery devolve string vazia sem título pt', () => {
  // A varredura já é pulada nesse caso (`activePtQuery` vinha null), mas a
  // função precisa ser defensiva para o caller novo que filtrarei aqui.
  assert.equal(ptSweepQuery(''), '');
  assert.equal(ptSweepQuery(null), '');
  assert.equal(ptSweepQuery(undefined), '');
  assert.equal(ptSweepQuery('   '), '');
});

// 6.2 — Seleção da query da varredura: a função só olha `titles`. O gate "pt
// difere do original" impede a varredura em obras sem localização (Joker,
// Missão: Impossível…), que dispararia uma segunda rodada inútil contra os
// globais. Série e filme usam a MESMA raiz pt, sem SxxEyy: medido, "Jornada
// nas Estrelas S01E04" devolve 0 no thepiratebay e o título puro devolve 6
// (incluindo o "T01 E004 … Dub PT-BR"); o corte por episódio é do
// matchContext, que roda depois.

test('ptSweepQueryFor filme com pt localizado devolve o título base', () => {
  const titles = { pt: 'Jornada nas Estrelas: O Filme', original: 'Star Trek: The Motion Picture' };
  assert.equal(ptSweepQueryFor({ titles }), 'Jornada nas Estrelas');
});

test('ptSweepQueryFor filme sem pt localizado (pt === original) devolve null', () => {
  // Caso "Joker": titles.pt === titles.original, a busca GLOBAL principal já
  // cobriu o título — varrer de novo é fan-out inútil contra os indexers.
  const titles = { pt: 'Joker', original: 'Joker' };
  assert.equal(ptSweepQueryFor({ titles }), null);
});

test('ptSweepQueryFor filme sem pt algum devolve null', () => {
  const titles = { pt: null, original: 'Joker' };
  assert.equal(ptSweepQueryFor({ titles }), null);
  // Sem titles, fim da cadeia — defensivo.
  assert.equal(ptSweepQueryFor({ titles: null }), null);
});

test('ptSweepQueryFor série usa a raiz do título pt, sem SxxEyy', () => {
  // Série: mesma raiz do filme. O subtítulo sai no strip de `:`; o tracker
  // global casa o nome puro ("Jornada nas Estrelas"), que é onde o dublado
  // "T01 E004 … Dub PT-BR" mora — com "S01E04" na query o mesmo tracker
  // devolve 0.
  const titles = { pt: 'Jornada nas Estrelas: A Nova Geração', original: 'Star Trek: The Next Generation' };
  assert.equal(ptSweepQueryFor({ titles }), 'Jornada nas Estrelas');
  assert.equal(ptSweepQueryFor({ titles: { pt: 'Queda', original: 'Fallout' } }), 'Queda');
});

test('ptSweepQueryFor série sem pt localizado devolve null (pt === original)', () => {
  const titles = { pt: 'The Office', original: 'The Office' };
  assert.equal(ptSweepQueryFor({ titles }), null);
});

test('ptSweepQuery corta marcador de sequência para achar a coleção da franquia', () => {
  // O caso real: o dublado da continuação só existe dentro do pack
  // "Jornada Nas Estrelas (Todos os filmes 1979-2016)". Medido nos globais:
  // "Jornada nas Estrelas II" devolve 0 resultados, "Jornada nas Estrelas" 14.
  assert.equal(ptSweepQuery('Jornada nas Estrelas II: A Ira de Khan'), 'Jornada nas Estrelas');
  assert.equal(ptSweepQuery('De Volta para o Futuro 2'), 'De Volta para o Futuro');
  assert.equal(ptSweepQuery('O Poderoso Chefão Parte II'), 'O Poderoso Chefão');
  assert.equal(ptSweepQuery('O Senhor dos Anéis III: O Retorno do Rei'), 'O Senhor dos Anéis');
});

test('ptSweepQuery preserva número que é o nome da obra', () => {
  // Mesma trava de 2+ palavras do subtítulo: cortar deixaria "Distrito", que
  // não é o título de nada. O número aqui não marca sequência.
  assert.equal(ptSweepQuery('Distrito 9'), 'Distrito 9');
  assert.equal(ptSweepQuery('Onze Homens e um Segredo'), 'Onze Homens e um Segredo');
  // Ano de 4 dígitos não é marcador de sequência.
  assert.equal(ptSweepQuery('Blade Runner 2049'), 'Blade Runner 2049');
});

// --- Causa C: index-only ficam fora do caminho da resposta ----------------
//
// Lat�ncia medida de 8-31s nos tr�s BR stock contra or�amento total de 20s:
// falha -> failStreak -> breaker -> indexer fora do ar na PR�XIMA busca, e o
// retry PT->t�tulo original consumia o mesmo or�amento. Quem mant�m as
// releases deles frescas agora � o colhedor; a busca ao vivo serve do �ndice.

test('liveIndexers tira os index-only do plano ao vivo e preserva os demais', () => {
  assert.deepEqual(
    liveIndexers(
      ['thepiratebay', 'redetorrent', 'apachetorrent', 'hdrtorrent', 'bludv-cardigann'],
      ['redetorrent', 'apachetorrent', 'hdrtorrent'],
    ),
    ['thepiratebay', 'bludv-cardigann'],
  );
});

test('liveIndexers com lista vazia (default antigo) n�o filtra nada', () => {
  const todos = ['thepiratebay', 'redetorrent'];
  assert.deepEqual(liveIndexers(todos), todos);
  assert.deepEqual(liveIndexers(todos, []), todos);
});

test('liveIndexers pode esvaziar a sele��o inteira (sem fallback /all)', () => {
  // O caller precisa distinguir "usu�rio n�o selecionou nada" (fallback /all
  // vale) de "operador tirou todos os selecionados da resposta" (nenhuma
  // consulta Jackett no caminho cr�tico).
  assert.deepEqual(
    liveIndexers(['redetorrent', 'hdrtorrent'], ['redetorrent', 'hdrtorrent']),
    [],
  );
});
