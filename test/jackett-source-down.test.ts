// Rodada 2: checagem ligada; o caminho search() do jackett com fetch falso.
// Tema deste arquivo: FONTE fora dentro de um HTTP 200. O Jackett não propaga
// o erro do indexer no código HTTP — devolve 200 com `Results: []` e a falha
// em `Indexers[].Status`/`Error`. Medido ao vivo no nerdfilmes (site migrado
// para um domínio sem DNS, resolver embutido devolvendo 502): o card ficava
// verde, o failStreak nunca subia e o alerta de indexer BR nunca disparava.
import { test } from 'node:test';
import assert from 'node:assert';

import config from '../src/config.js';
import jackett from '../src/providers/jackett.js';
import * as cache from '../src/utils/cache.js';
import * as indexerStatus from '../src/providers/indexer-status.js';

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

const CTX = { names: ['Batman'], year: 2008, isSeries: false, season: null, episode: null };

// A resposta exata que o Jackett devolve com o resolver embutido fora do ar:
// HTTP 200, zero resultado, e o estrago descrito só no envelope.
function fonteFora(indexer: string) {
  return fakeResponse({
    Results: [],
    Indexers: [{
      ID: indexer,
      Name: indexer,
      Status: 1,
      Results: 0,
      Error: `Jackett.Common.IndexerException: Exception (${indexer}): Request to `
        + 'http://127.0.0.1:8702/search?q=Batman failed (Error BadGateway) - The tracker seems '
        + 'to be down.\n ---> System.Exception: stack trace .NET que não cabe em card nenhum',
    }],
  });
}

function fonteViva(indexer: string, results: any[] = []) {
  return fakeResponse({
    Results: results,
    Indexers: [{ ID: indexer, Name: indexer, Status: 2, Results: results.length, Error: null }],
  });
}

test('fonte fora dentro de HTTP 200 marca o indexer offline, não online', async () => {
  const fetchImpl = makeFetch();
  fetchImpl.handler = () => fonteFora('nerdfilmes');
  await withJackett(fetchImpl, async () => {
    indexerStatus.clear();
    await jackett.search('Batman', 'movie', ['nerdfilmes'], { matchContext: CTX });
    const st = indexerStatus.get('nerdfilmes');
    // O bug: `ok: true` fixo lia só o transporte e gravava 'online'.
    assert.equal(st?.state, 'offline');
    // Sem failStreak o circuit breaker nunca abre e a fonte morta segue
    // queimando orçamento de busca em toda consulta.
    assert.equal(st?.failStreak, 1);
    indexerStatus.clear();
  });
});

test('200 legítimo com zero resultado continua online — vazio não é falha', async () => {
  const fetchImpl = makeFetch();
  fetchImpl.handler = () => fonteViva('bludv-cardigann');
  await withJackett(fetchImpl, async () => {
    indexerStatus.clear();
    await jackett.search('Batman', 'movie', ['bludv-cardigann'], { matchContext: CTX });
    assert.equal(indexerStatus.get('bludv-cardigann')?.state, 'online');
    indexerStatus.clear();
  });
});

test('resposta sem o envelope Indexers não inventa falha', async () => {
  const fetchImpl = makeFetch();
  // Formato antigo/dublê: só `Results`. Ausência de prova não é prova de falha.
  fetchImpl.handler = () => fakeResponse({ Results: [] });
  await withJackett(fetchImpl, async () => {
    indexerStatus.clear();
    await jackett.search('Batman', 'movie', ['thepiratebay'], { matchContext: CTX });
    assert.equal(indexerStatus.get('thepiratebay')?.state, 'online');
    indexerStatus.clear();
  });
});

test('item entregue prova vida: falha num degrau tardio da cascata não condena o indexer', async () => {
  const fetchImpl = makeFetch();
  fetchImpl.handler = (call) => {
    const query = new URL(call.url).searchParams.get('Query');
    // A primária entrega; um degrau posterior tropeça. Quem já provou vida não
    // pode ser reclassificado como fonte morta.
    if (query === 'Batman') {
      return fonteViva('comandotorrents', [
        { Title: 'Batman (2008) 1080p Dublado', Seeders: 9, MagnetUri: MAGNET },
      ]);
    }
    return fonteFora('comandotorrents');
  };
  await withJackett(fetchImpl, async () => {
    indexerStatus.clear();
    await jackett.search('Batman', 'movie', ['comandotorrents'], {
      matchContext: CTX,
      fallbackQuery: 'Batman Original',
    });
    assert.equal(indexerStatus.get('comandotorrents')?.state, 'online');
    indexerStatus.clear();
  });
});

test('vazio POR FALHA não entra no cache bruto: fonte que volta responde na hora', async () => {
  const fetchImpl = makeFetch();
  let fora = true;
  fetchImpl.handler = () => (fora
    ? fonteFora('nerdfilmes')
    : fonteViva('nerdfilmes', [{ Title: 'Batman (2008) 1080p Dublado', Seeders: 3, MagnetUri: MAGNET }]));
  await withJackett(fetchImpl, async () => {
    indexerStatus.clear();
    const primeira = await jackett.search('Batman', 'movie', ['nerdfilmes'], { matchContext: CTX });
    assert.equal(primeira.length, 0);
    // Se o vazio da falha tivesse virado entrada de cache, a segunda busca
    // seria servida do disco e o indexer ficaria mudo pelo TTL inteiro mesmo
    // depois de a fonte voltar.
    fora = false;
    const segunda = await jackett.search('Batman', 'movie', ['nerdfilmes'], { matchContext: CTX });
    assert.equal(segunda.length, 1);
    assert.equal(indexerStatus.get('nerdfilmes')?.state, 'online');
    indexerStatus.clear();
  });
});
