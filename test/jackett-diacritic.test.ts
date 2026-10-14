// --- Diacrítico na query: contrato ponta a ponta ---
//
// O buscador WordPress dos sites BR devolve 0 para QUALQUER query acentuada
// (medido: "Extermínio" → 0 contra 8–16 de "Exterminio" em 5 títulos × 5
// indexers BR). A URL final que sai para o Jackett leva a query sem acento no
// indexer BR — e COM acento no global, que casa bem e ainda recebe a
// varredura pt-BR.
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

test('URL final sai sem acento no indexer BR e com acento no global', async () => {
  const fetchImpl = makeFetch();
  fetchImpl.handler = () => fakeResponse({ Results: [] });

  await withJackett(fetchImpl, async () => {
    await jackett.search('Extermínio', 'movie', ['comandotorrents'], { skipResolve: true });
    await jackett.search('Extermínio', 'movie', ['therarbg'], { skipResolve: true });
    assert.deepEqual(fetchImpl.searchCalls(), ['Exterminio', 'Extermínio']);
  });
});
