import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import * as cache from '../src/utils/cache.js';
import config from '../src/config.js';
import * as metrics from '../src/utils/metrics.js';
import * as runtime from '../src/runtime.js';
import { findStreams } from '../src/providers/index.js';

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
