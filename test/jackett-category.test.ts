// --- Categoria na URL: o TPB some com ela, os outros não ---
//
// "Star Trek Beyond" com Category[]=2000 devolve 0 no thepiratebay e 100 sem
// categoria; a mesma query COM ano devolve 19 dos dois jeitos. Quem paga é a
// varredura pt-BR e o bare title, que saem sem ano. A consulta do TPB passa a
// sair sem categoria e o filtro de tipo roda sobre o `Category` da resposta.
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

const BEYOND_CTX = {
  names: ['Beyond Re-Animator'],
  year: 2003,
  isSeries: false,
  season: null,
  episode: null,
};

const SERIES_CTX = {
  names: ['Joker', 'Coringa'],
  year: 2019,
  isSeries: true,
  season: 1,
  episode: 1,
};

function categoryParams(fetchImpl: JackettFetch) {
  return fetchImpl.calls
    .filter((c) => c.url.includes('/results'))
    .map((c) => new URL(c.url).searchParams.getAll('Category[]'));
}

test('thepiratebay consulta SEM Category[] e filtra o tipo na resposta', async () => {
  const fetchImpl = makeFetch();
  fetchImpl.handler = () => fakeResponse({ Results: [
    { Title: 'Beyond Re-Animator 2003 1080p BluRay', Seeders: 9, MagnetUri: MAGNET, Category: [2040, 100207] },
    { Title: 'Beyond Re-Animator 2003 720p WEB', Seeders: 5, MagnetUri: MAGNET, Category: [2000, 100201] },
    // TV/Other no meio da resposta: é o que o Category[] filtrava no servidor.
    { Title: 'Beyond Re-Animator 2003 TV Rip', Seeders: 3, MagnetUri: MAGNET, Category: [5050, 100206] },
    // Sem categoria nenhuma passa: metadado ausente não pode custar release.
    { Title: 'Beyond Re-Animator 2003 DVDRip', Seeders: 1, MagnetUri: MAGNET },
  ] });

  await withJackett(fetchImpl, async () => {
    const items = await jackett.search('Beyond Re-Animator', 'movie', ['thepiratebay'], {
      matchContext: BEYOND_CTX,
    });
    assert.deepEqual(categoryParams(fetchImpl), [[]]);
    assert.deepEqual(items.map((i: any) => i.title).sort(), [
      'Beyond Re-Animator 2003 1080p BluRay',
      'Beyond Re-Animator 2003 720p WEB',
      'Beyond Re-Animator 2003 DVDRip',
    ]);
  });
});

test('indexer normal continua mandando Category[] na URL', async () => {
  const fetchImpl = makeFetch();
  fetchImpl.handler = () => fakeResponse({ Results: [
    // Categoria de TV chegando de um indexer que já filtrou no servidor: sem
    // isenção não há filtro local, e o item continua entrando como antes.
    { Title: 'Beyond Re-Animator 2003 1080p BluRay', Seeders: 9, MagnetUri: MAGNET, Category: [5050] },
  ] });

  await withJackett(fetchImpl, async () => {
    const items = await jackett.search('Beyond Re-Animator', 'movie', ['therarbg'], {
      matchContext: BEYOND_CTX,
    });
    assert.deepEqual(categoryParams(fetchImpl), [['2000']]);
    assert.equal(items.length, 1);
  });
});

test('série no thepiratebay filtra pelo balde 5000', async () => {
  const fetchImpl = makeFetch();
  fetchImpl.handler = () => fakeResponse({ Results: [
    { Title: 'Joker S01E01 1080p WEB-DL', Seeders: 9, MagnetUri: MAGNET, Category: [5040] },
    { Title: 'Joker 2019 1080p BluRay', Seeders: 9, MagnetUri: MAGNET, Category: [2040] },
  ] });

  await withJackett(fetchImpl, async () => {
    const items = await jackett.search('Joker S01E01', 'series', ['thepiratebay'], {
      matchContext: SERIES_CTX,
    });
    assert.deepEqual(categoryParams(fetchImpl), [[]]);
    assert.deepEqual(items.map((i: any) => i.title), ['Joker S01E01 1080p WEB-DL']);
  });
});
