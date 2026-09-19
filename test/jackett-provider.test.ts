// Rodada 2: checagem ligada; o caminho search() do jackett é testado com fetch falso.
// Tema deste arquivo: a cascata de fallback original (primária sem relevância,
// erro HTTP sem segunda tentativa, sequência com orçamento, pré-filtro de
// spin-off). Os demais temas foram extraídos para os irmãos jackett-*.test.ts,
// todos com os mesmos dublês abaixo.
import { test } from 'node:test';
import assert from 'node:assert';

import config from '../src/config.js';
import jackett from '../src/providers/jackett.js';
import * as cache from '../src/utils/cache.js';

// jackett.search(query, type, indexers, { fallbackQuery, matchContext }) é o
// caminho real da busca, testado com fetch falso: config e fetch global são
// trocados e restaurados em finally. Sem rede, sem servidor.

const HASH = 'a'.repeat(40);
const MAGNET = 'magnet:?xt=urn:btih:' + HASH + '&dn=Release';

function fakeResponse(body: unknown, { status = 200, location = null }: { status?: number; location?: string | null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: any) => (String(name).toLowerCase() === 'location' ? location : null) },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

type FakeResponse = ReturnType<typeof fakeResponse>;

interface FetchCall {
  url: string;
  init: any;
  started: number;
  finished?: number;
  promise?: Promise<FakeResponse>;
}

// O dublê é função E acumula estado: chamadas capturadas, o `handler` que cada
// teste instala e os filtros que contam só as buscas Torznab (/results).
interface JackettFetch {
  (url: unknown, init?: any): Promise<FakeResponse>;
  calls: FetchCall[];
  handler?: (call: FetchCall) => FakeResponse | Promise<FakeResponse>;
  searchCalls(): (string | null)[];
  protectorCalls(): string[];
}

function makeFetch(): JackettFetch {
  const calls: FetchCall[] = [];
  const fetchImpl: JackettFetch = (url, init = {}) => {
    const call: FetchCall = { url: String(url), init, started: Date.now() };
    calls.push(call);
    const promise = (async () => {
      try {
        return fetchImpl.handler ? await fetchImpl.handler(call) : fakeResponse({ Results: [] });
      } finally {
        call.finished = Date.now();
      }
    })();
    call.promise = promise;
    return promise;
  };
  fetchImpl.calls = calls;
  // Só as chamadas de busca Torznab (/results) contam como tentativas de query;
  // o resto são saltos de protetor de link.
  fetchImpl.searchCalls = () =>
    calls.filter((c) => c.url.includes('/results')).map((c) => new URL(c.url).searchParams.get('Query'));
  fetchImpl.protectorCalls = () => calls.filter((c) => !c.url.includes('/results')).map((c) => c.url);
  return fetchImpl;
}

async function withJackett(fetchImpl: any, fn: any) {
  const realFetch = globalThis.fetch;
  const saved = { url: config.jackett.url, apiKey: config.jackett.apiKey };
  config.jackett.url = 'http://jackett.test';
  config.jackett.apiKey = 'test-key';
  globalThis.fetch = fetchImpl as unknown as typeof globalThis.fetch;
  cache.clear();
  try {
    return await fn();
  } finally {
    cache.clear();
    globalThis.fetch = realFetch;
    config.jackett.url = saved.url;
    config.jackett.apiKey = saved.apiKey;
  }
}

const SERIES_CTX = {
  names: ['Joker', 'Coringa'],
  year: 2019,
  isSeries: true,
  season: 1,
  episode: 1,
};

test('primary PT 200 com zero relevante dispara fallback original e entrega a fonte certa', async () => {
  const fetchImpl = makeFetch();
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) {
      const query = new URL(call.url).searchParams.get('Query');
      if (query === 'Coringa') {
        // 200 válido, mas tudo lixo: o filtro estrito descarta e o fallback corre.
        return fakeResponse({ Results: [
          { Title: 'Missão: Impossível – Efeito Coringa 1080p', Seeders: 1, Link: 'http://protector.test/lixo' },
        ] });
      }
      return fakeResponse({ Results: [
        { Title: 'Joker 2019 1080p WEB-DL', Seeders: 10, MagnetUri: MAGNET },
      ] });
    }
    return fakeResponse(null, { status: 404 });
  };

  await withJackett(fetchImpl, async () => {
    const items = await jackett.search('Coringa S01E01', 'series', ['bludv-cardigann'], {
      fallbackQuery: 'Joker S01E01',
      matchContext: SERIES_CTX,
    });
    assert.deepEqual(fetchImpl.searchCalls(), ['Coringa', 'Joker']);
    assert.equal(items.length, 1);
    assert.equal(items[0].title, 'Joker 2019 1080p WEB-DL');
    // O lixo da primária nem chegou a pagar protetor de link.
    assert.equal(fetchImpl.protectorCalls().includes('http://protector.test/lixo'), false);
  });
});

test('HTTP erro na primary NÃO dispara o fallback', async () => {
  const fetchImpl = makeFetch();
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) return fakeResponse(null, { status: 500 });
    return fakeResponse(null, { status: 404 });
  };

  await withJackett(fetchImpl, async () => {
    const items = await jackett.search('Coringa S01E01', 'series', ['bludv-cardigann'], {
      fallbackQuery: 'Joker S01E01',
      matchContext: SERIES_CTX,
    });
    // Erro de servidor sobe como falha do indexer; nada de segunda tentativa.
    assert.deepEqual(fetchImpl.searchCalls(), ['Coringa']);
    assert.deepEqual(items, []);
  });
});

test('fallback é sequencial e cabe no orçamento restante, sem duas tentativas no ar', async () => {
  const fetchImpl = makeFetch();
  const seen: Array<string | null> = [];
  let releasePrimary: any;
  const primaryGate = new Promise((resolve) => { releasePrimary = resolve; });
  const originalTimeout = AbortSignal.timeout;
  const timeouts: number[] = [];
  AbortSignal.timeout = (ms) => { timeouts.push(ms); return originalTimeout(ms); };

  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) {
      const query = new URL(call.url).searchParams.get('Query');
      seen.push(query);
      if (query === 'Coringa') return primaryGate.then(() => fakeResponse({ Results: [] }));
      return fakeResponse({ Results: [{ Title: 'Joker 2019 1080p', Seeders: 5, MagnetUri: MAGNET }] });
    }
    return fakeResponse(null, { status: 404 });
  };

  try {
    await withJackett(fetchImpl, async () => {
      const search = jackett.search('Coringa S01E01', 'series', ['bludv-cardigann'], {
        fallbackQuery: 'Joker S01E01',
        matchContext: SERIES_CTX,
      });
      // Primary ainda em voo: o fallback não pode ter começado (nada de Promise
      // paralela dentro do deadline).
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.deepEqual(seen, ['Coringa']);
      releasePrimary();
      const items = await search;
      assert.deepEqual(seen, ['Coringa', 'Joker']);
      assert.equal(items.length, 1);
    });
  } finally {
    AbortSignal.timeout = originalTimeout;
  }

  // O fallback é a ÚNICA segunda chamada de busca, e recebe menos tempo que a
  // primary: o deadline é absoluto e o que sobrou é o que ele usa.
  assert.equal(timeouts.length, 2);
  assert.ok(timeouts[1] < timeouts[0], 'fallback usa só o orçamento restante');
});

test('pré-filtro com matchContext rejeita a spin-off antes de pagar o protetor', async () => {
  const fetchImpl = makeFetch();
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) {
      return fakeResponse({ Results: [
        { Title: 'Rick And Morty The Anime S01E02 1080p', Seeders: 1, Link: 'http://protector.test/anime' },
      ] });
    }
    return fakeResponse(null, { status: 404 });
  };

  await withJackett(fetchImpl, async () => {
    const items = await jackett.search('Rick and Morty S01E02', 'series', ['bludv-cardigann'], {
      matchContext: {
        names: ['Rick and Morty', 'Rick e Morty'],
        year: 2024,
        isSeries: true,
        season: 1,
        episode: 2,
      },
    });
    assert.equal(fetchImpl.protectorCalls().includes('http://protector.test/anime'), false);
    assert.deepEqual(items, []);
  });
});
