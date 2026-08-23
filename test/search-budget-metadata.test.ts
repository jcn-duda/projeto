import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import * as cache from '../src/utils/cache.js';
import config from '../src/config.js';
import * as metrics from '../src/utils/metrics.js';
import * as runtime from '../src/runtime.js';
import { findStreams } from '../src/providers/index.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
