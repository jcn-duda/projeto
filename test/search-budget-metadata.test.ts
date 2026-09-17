import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import * as cache from '../src/utils/cache.js';
import config from '../src/config.js';
import * as metrics from '../src/utils/metrics.js';
import * as runtime from '../src/runtime.js';
import { findStreams } from '../src/providers/index.js';
import { collectRaw } from '../src/providers/search-orchestrator.js';
import jackett from '../src/providers/jackett.js';
import { computeCollectionBudget, computePriorityGrace } from '../src/providers/collection-budget.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForBackground(ms = 600) {
  // `findStreams` devolve no deadline, mas deixa a busca completar para aquecer
  // o cache. Não restaure o fetch antes desse rabo terminar — e não deixe o
  // rabo de um cenário escrever cache DEPOIS do `cache.clear()` do próximo,
  // senão o cenário seguinte responde do cache e nunca estoura o prazo. A
  // espera cobre a cascata inteira do indexer BR (primária + degraus), não só
  // a primeira consulta.
  await sleep(ms);
}

async function withDeadlineScenario(
  { metadataDelay, providerDelay }: { metadataDelay: number; providerDelay: number },
  fn: () => Promise<void>,
) {
  const realFetch = globalThis.fetch;
  const saved = {
    replyDeadline: config.replyDeadline,
    debridReserve: config.debridReserve,
    cinemetaTimeout: config.cinemeta.timeout,
    tmdbTimeout: config.tmdb.timeout,
    tmdbKey: config.tmdb.apiKey,
    jackettUrl: config.jackett.url,
    jackettApiKey: config.jackett.apiKey,
  };
  config.replyDeadline = 120;
  config.debridReserve = 80;
  config.cinemeta.timeout = 1000;
  config.tmdb.timeout = 1000;
  config.tmdb.apiKey = 'fake-tmdb-key';
  config.jackett.url = 'http://jackett.test';
  config.jackett.apiKey = 'fake-jackett-key';
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('cinemeta')) {
      await sleep(metadataDelay);
      return new Response(JSON.stringify({ meta: { name: 'Big Buck Bunny', year: '2008', type: 'movie' } }), { status: 200 });
    }
    if (url.includes('themoviedb.org')) {
      await sleep(metadataDelay);
      return new Response(JSON.stringify({ movie_results: [] }), { status: 404 });
    }
    if (url.includes('jackett.test')) {
      await sleep(providerDelay);
      return new Response(JSON.stringify({ Results: [] }), { status: 200 });
    }
    return new Response('', { status: 404 });
  }) as typeof globalThis.fetch;

  const testOpts = { ...runtime.normalize(null), providers: ['jackett'], jackettIndexers: [], debridService: '', debridApiKey: '' };
  try {
    await runtime.run({ opts: testOpts, encoded: `deadline-${metadataDelay}-${providerDelay}` }, fn);
    await waitForBackground();
  } finally {
    globalThis.fetch = realFetch;
    config.replyDeadline = saved.replyDeadline;
    config.debridReserve = saved.debridReserve;
    config.cinemeta.timeout = saved.cinemetaTimeout;
    config.tmdb.timeout = saved.tmdbTimeout;
    config.tmdb.apiKey = saved.tmdbKey;
    config.jackett.url = saved.jackettUrl;
    config.jackett.apiKey = saved.jackettApiKey;
    cache.clear();
  }
}

test('4.2: deadline após metadata consumir a janela de providers é atribuído a metadata', async () => {
  cache.clear();
  metrics.reset();
  try {
    await withDeadlineScenario({ metadataDelay: 90, providerDelay: 140 }, async () => {
      const result = await findStreams({ type: 'movie', id: 'tt1254207' });
      assert.equal(result.partial, true);
    });
    const snapshot = metrics.snapshot();
    assert.equal(snapshot.counters['search.deadline'], 1);
    assert.equal(snapshot.counters['search.deadline.metadata'], 1);
    assert.equal(snapshot.counters['search.deadline.providers'] ?? 0, 0, 'o provider lento não leva culpa quando metadata já consumiu sua janela');
    assert.equal(snapshot.timers['search.metadata']?.count, 1, 'a duração de metadata entra no diagnóstico');
  } finally {
    metrics.reset();
  }
});

test('4.2: deadline com metadata dentro da janela é atribuído aos providers', async () => {
  cache.clear();
  metrics.reset();
  try {
    await withDeadlineScenario({ metadataDelay: 1, providerDelay: 180 }, async () => {
      const result = await findStreams({ type: 'movie', id: 'tt1254207' });
      assert.equal(result.partial, true);
    });
    const snapshot = metrics.snapshot();
    assert.equal(snapshot.counters['search.deadline'], 1);
    assert.equal(snapshot.counters['search.deadline.providers'], 1);
    assert.equal(snapshot.counters['search.deadline.metadata'] ?? 0, 0);
  } finally {
    metrics.reset();
  }
});

test('B3: Cinemeta lento (2500ms) + TMDB miss (5000ms) devolve resposta parcial dentro do prazo sem acionar search.deadline', async () => {
  cache.clear();
  metrics.reset();

  const realFetch = globalThis.fetch;
  const originalReplyDeadline = config.replyDeadline;
  const originalDebridReserve = config.debridReserve;
  const originalCinemetaTimeout = config.cinemeta.timeout;
  const originalTmdbTimeout = config.tmdb.timeout;
  const originalTmdbKey = config.tmdb.apiKey;

  // replyDeadline de 8000ms, Cinemeta demora 2500ms e TMDB demora 5000ms
  config.replyDeadline = 8000;
  config.debridReserve = 1500;
  config.cinemeta.timeout = 3000;
  config.tmdb.timeout = 6000;
  config.tmdb.apiKey = 'fake-tmdb-key';

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('cinemeta')) {
      await sleep(2500);
      return new Response(
        JSON.stringify({
          meta: {
            name: 'Big Buck Bunny',
            year: '2008',
            type: 'movie',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.includes('themoviedb.org')) {
      await sleep(5000);
      return new Response(
        JSON.stringify({ movie_results: [] }),
        { status: 404, statusText: 'Not Found' },
      );
    }
    return new Response('', { status: 404 });
  }) as unknown as typeof globalThis.fetch;

  const testOpts = {
    ...runtime.normalize(null),
    providers: ['demo'],
    debridService: '',
    debridApiKey: '',
  };

  try {
    const started = Date.now();
    const result = await runtime.run({ opts: testOpts, encoded: 'budget-test' }, async () => {
      return await findStreams({ type: 'movie', id: 'tt1254207' });
    });
    const elapsed = Date.now() - started;

    // Asserções:
    // 1. Respondeu antes do replyDeadline (8000ms)
    assert.ok(
      elapsed < config.replyDeadline,
      `resposta deve sair antes do deadline de ${config.replyDeadline}ms (levou ${elapsed}ms)`,
    );
    assert.ok(elapsed >= 5000, `deve esperar os 5000ms dos metadados (levou ${elapsed}ms)`);

    // 2. Não acionou o fallback de deadline 'search.deadline'
    const deadlineHits = metrics.snapshot().counters['search.deadline'] || 0;
    assert.equal(
      deadlineHits,
      0,
      'orquestrador dinâmico de budget não deve estourar o deadline nem disparar search.deadline',
    );

    // 3. Devolveu resultado real do provider demo em vez do notice stream genérico
    assert.ok(result?.streams?.length > 0, 'deve retornar streams encontrados');
    const noticeStream = result.streams.find((s: any) => s.notice === true);
    assert.equal(
      noticeStream,
      undefined,
      'não deve retornar o notice de deadline "Procurando fontes — reabra em instantes"',
    );

    // 4. Primeiro stream é tocável do demo
    assert.match(result.streams[0].title || result.streams[0].name || '', /Big Buck Bunny/i);

    // 5. A decomposição da primeira resposta é comitada no mesmo denominador.
    // Demo ocupa a faixa global; sem fonte BR o timer BR fica ausente.
    const first = metrics.snapshot();
    assert.equal(first.counters['search.first.responses'], 1);
    assert.equal(first.timers['search.first.metadata']?.count, 1);
    assert.ok((first.timers['search.first.metadata']?.maxMs ?? 0) >= 4900);
    assert.equal(first.timers['search.first.collect.global']?.count, 1);
    assert.equal(first.timers['search.first.collect.br'], undefined);
    assert.equal(first.timers['search.first.debrid']?.count, 1);
    assert.equal(first.timers['search.first.total']?.count, 1);
  } finally {
    globalThis.fetch = realFetch;
    config.replyDeadline = originalReplyDeadline;
    config.debridReserve = originalDebridReserve;
    config.cinemeta.timeout = originalCinemetaTimeout;
    config.tmdb.timeout = originalTmdbTimeout;
    config.tmdb.apiKey = originalTmdbKey;
    cache.clear();
    metrics.reset();
  }
});

// -----------------------------------------------------------------------------
// Integração da graça BR: prova que collectRaw LIGA os números calculados por
// `collection-budget.ts` (budget de resposta + janela extra) ao `collectWithinWindow`
// de verdade. Não é a aritmética pura (coberta em collection-window.test.ts):
// aqui uma fonte BR chega DEPOIS do orçamento, e só a graça — quando > 0 — a
// encaixa na primeira resposta. Três cenários variam só o piso do debrid
// (que zera a graça) e o instante em que o BR chega, isolando budget e janela.
// -----------------------------------------------------------------------------
function brRelease() {
  return [{
    title: 'Zumbilândia 2009 720p DUBLADO',
    infoHash: '0'.repeat(40),
    seeders: 5,
    tracker: 'brtest',
    indexer: 'brtest',
    isBr: true,
  }];
}

/** Libera a fonte BR `releaseOffset` ms depois do orçamento real (negativo =
 *  antes dele) e devolve se ela entrou na primeira resposta, junto dos números
 *  vindos das FUNÇÕES reais (nada de cópia da fórmula aqui). O release é um
 *  timer relativo ao `budget` calculado, então a ordem “BR depois do orçamento”
 *  não depende de sorte do event loop. */
async function collectWithLateBr({ debridCheckFloor, releaseOffset }: { debridCheckFloor: number; releaseOffset: number }) {
  const saved = {
    ptBrIndexers: config.jackett.ptBrIndexers,
    bludvEnabled: config.bludv.enabled,
    inventorySource: config.debrid.inventorySource,
    debridReserve: config.debridReserve,
    debridCheckFloor: config.debridCheckFloor,
    brPartialGrace: config.brPartialGrace,
    search: jackett.search,
  };
  // Fonte única controlada: só jackett (um indexer pt-BR → task de prioridade).
  config.jackett.ptBrIndexers = ['brtest'];
  config.bludv.enabled = false;
  config.debrid.inventorySource = false;
  // Budget no piso de 500ms (reserve 4600 com deadline a 5000ms).
  config.debridReserve = 4600;
  config.debridCheckFloor = debridCheckFloor;
  config.brPartialGrace = 1000;
  let releaseBr: (v: unknown[]) => void = () => {};
  const brPromise = new Promise<unknown[]>((done) => { releaseBr = done; });
  jackett.search = () => brPromise;
  const requestOpts = {
    ...runtime.normalize(null),
    providers: ['jackett'],
    jackettIndexers: ['brtest'],
    debridService: '',
    debridApiKey: '',
  };
  try {
    metrics.reset();
    const deadlineAt = Date.now() + 5000;
    const budget = computeCollectionBudget(deadlineAt);
    const grace = computePriorityGrace();
    const running = runtime.run({ opts: requestOpts, encoded: `grace-${debridCheckFloor}` }, () =>
      collectRaw(
        'Zombieland 2009',
        'movie',
        'tt1156398',
        'Zumbilândia 2009',
        { names: ['Zombieland', 'Zumbilândia'], year: 2009, isSeries: false, season: null, episode: null },
        null,
        null,
        deadlineAt,
        undefined,
        null,
      ));
    const releaseTimer = setTimeout(() => releaseBr(brRelease()), Math.max(0, budget + releaseOffset));
    const result = await running;
    // `items` é a MESMA referência do balde que o `completion` ainda enriquece:
    // congela a leitura no instante do retorno (antes do `await completion`),
    // senão o caso-controle veria o BR tarde demais e morreria em silêncio.
    const bucket = [...result.items];
    await result.completion;
    return { hasBr: bucket.some((i) => i.isBr), budget, grace };
  } finally {
    config.jackett.ptBrIndexers = saved.ptBrIndexers;
    config.bludv.enabled = saved.bludvEnabled;
    config.debrid.inventorySource = saved.inventorySource;
    config.debridReserve = saved.debridReserve;
    config.debridCheckFloor = saved.debridCheckFloor;
    config.brPartialGrace = saved.brPartialGrace;
    jackett.search = saved.search;
    metrics.reset();
    cache.clear();
  }
}

test('graça BR: budgetMs calculado chega ao collectWithinWindow (BR dentro do orçamento entra)', async () => {
  // graça 0 (floor == reserve) + BR liberado ANTES do orçamento → entra. Se o
  // budgetMs for zerado/trocado, a janela fecha na hora e ele fica de fora.
  const { hasBr, budget, grace } = await collectWithLateBr({ debridCheckFloor: 4600, releaseOffset: -300 });
  assert.ok(budget > 0, 'orçamento calculado deve ser positivo');
  assert.equal(grace, 0, 'reserve == floor zera a graça (isolamos só o budget aqui)');
  assert.ok(hasBr, 'a fonte que chega dentro do orçamento deve entrar na primeira resposta');
});

test('graça BR: fonte que perde o orçamento entra na primeira resposta quando a janela é > 0', async () => {
  // floor 400 → graça = min(1000, 4600-400) = 1000ms. BR liberado 200ms após o
  // orçamento (dentro da graça) → encaixa.
  const { hasBr, grace } = await collectWithLateBr({ debridCheckFloor: 400, releaseOffset: 200 });
  assert.ok(grace > 0, 'a graça calculada deve ser positiva');
  assert.ok(hasBr, 'a graça deve trazer a fonte BR atrasada para a primeira resposta');
});

test('graça BR: sem janela (reserve == floor) a fonte BR atrasada fica fora da primeira resposta', async () => {
  // Mesmo instante do caso anterior (orçamento + 200ms), mas graça 0 → não há
  // janela para esperar; o mesmo BR que entraria agora fica de fora.
  const { hasBr, grace } = await collectWithLateBr({ debridCheckFloor: 4600, releaseOffset: 200 });
  assert.equal(grace, 0, 'reserve == floor zera a graça');
  assert.ok(!hasBr, 'sem graça, a fonte BR que chega depois do orçamento não entra na resposta');
});
