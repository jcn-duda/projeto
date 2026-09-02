// --- Cascata de queries BR: variante numérica e degrau sem ano ---
//
// Sites BR indexam por título em português, e o algarismo importa: o pt-BR
// romano ("Jornada nas Estrelas II") não casa com a release publicada com
// algarismo arábico ("Jornada nas Estrelas 2"). A cascata tenta primária →
// variante numérica → título sem ano → fallback original, com dedupe pós-shape
// e orçamento de tempo respeitado.
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

// Contexto do caso de recall BR (tt0084726): pt-BR romano é o que o addon
// busca de verdade; a release BR "numerada" usa o algarismo arábico.
const TREK_CTX = {
  names: ['Jornada nas Estrelas II: A Ira de Khan', 'Star Trek II: The Wrath of Khan'],
  year: 1982,
  isSeries: false,
  season: null,
  episode: null,
};
const TREK_PT = 'Jornada nas Estrelas II: A Ira de Khan 1982';
const TREK_VARIANT = 'Jornada nas Estrelas 2: A Ira de Khan 1982';
const TREK_BARE = 'Jornada nas Estrelas II: A Ira de Khan';

test('tt0084726: variante numérica recupera release BR publicada com algarismo arábico', async () => {
  const fetchImpl = makeFetch();
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) {
      const query = new URL(call.url).searchParams.get('Query');
      // Query primária em romano: WP devolve 0 (posts de outro filme não casam
      // "Ii" com "2"); só a variante arábica traz a release dublada.
      if (query === TREK_PT) return fakeResponse({ Results: [] });
      if (query === TREK_VARIANT) {
        return fakeResponse({ Results: [
          { Title: 'Jornada nas Estrelas 2 A Ira de Khan 1982 DUBLADO 720p', Seeders: 2, MagnetUri: MAGNET },
        ] });
      }
      return fakeResponse({ Results: [] });
    }
    return fakeResponse(null, { status: 404 });
  };

  await withJackett(fetchImpl, async () => {
    const items = await jackett.search(TREK_PT, 'movie', ['bludv-cardigann'], {
      variantQuery: TREK_VARIANT,
      matchContext: TREK_CTX,
    });
    assert.ok(['Jornada nas Estrelas II: A Ira de Khan 1982', TREK_VARIANT].every(
      (q) => fetchImpl.searchCalls().includes(q),
    ), `cadeia deveria seguir primary -> variante, viu ${fetchImpl.searchCalls()}`);
    assert.equal(items.length, 1);
    assert.equal(items[0].title, 'Jornada nas Estrelas 2 A Ira de Khan 1982 DUBLADO 720p');
  });
});

test('primary relevante NÃO abre variante numérica nem fallback original', async () => {
  const fetchImpl = makeFetch();
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) {
      return fakeResponse({ Results: [
        { Title: 'Jornada nas Estrelas II A Ira de Khan 1982 Dublado 1080p', Seeders: 5, MagnetUri: MAGNET },
      ] });
    }
    return fakeResponse(null, { status: 404 });
  };

  await withJackett(fetchImpl, async () => {
    const items = await jackett.search(TREK_PT, 'movie', ['bludv-cardigann'], {
      variantQuery: TREK_VARIANT,
      fallbackQuery: 'Star Trek II: The Wrath of Khan 1982',
      matchContext: TREK_CTX,
    });
    assert.deepEqual(fetchImpl.searchCalls(), [TREK_PT]);
    assert.equal(items.length, 1);
  });
});

test('variante numérica vazia segue para o fallback original', async () => {
  const fetchImpl = makeFetch();
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) {
      const query = new URL(call.url).searchParams.get('Query');
      if (query === TREK_PT) return fakeResponse({ Results: [] });
      if (query === TREK_VARIANT) return fakeResponse({ Results: [] });
      if (query === TREK_BARE) return fakeResponse({ Results: [] });
      return fakeResponse({ Results: [
        { Title: 'Star Trek II: The Wrath of Khan 1982 DUBLADO 1080p', Seeders: 4, MagnetUri: MAGNET },
      ] });
    }
    return fakeResponse(null, { status: 404 });
  };

  await withJackett(fetchImpl, async () => {
    const items = await jackett.search(TREK_PT, 'movie', ['bludv-cardigann'], {
      variantQuery: TREK_VARIANT,
      fallbackQuery: 'Star Trek II: The Wrath of Khan 1982',
      matchContext: TREK_CTX,
    });
    assert.deepEqual(fetchImpl.searchCalls(), [TREK_PT, TREK_VARIANT, TREK_BARE, 'Star Trek II: The Wrath of Khan 1982']);
    assert.equal(items.length, 1);
  });
});

test('título pt-BR com ano zerado cai no degrau sem ano e acha o dublado', async () => {
  // tt1465522 ao vivo: "Tucker e Dale Contra o Mal 2010" devolve 0 no
  // comandotorrents e no torrentdosfilmesv2 (o post BR é de 2012), e o mesmo
  // título sem o ano devolve 1 em cada um.
  const fetchImpl = makeFetch();
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) {
      const query = new URL(call.url).searchParams.get('Query');
      if (query === TREK_BARE) {
        return fakeResponse({ Results: [
          { Title: 'Jornada nas Estrelas II: A Ira de Khan 1982 DUBLADO 1080p', Seeders: 4, MagnetUri: MAGNET },
        ] });
      }
      return fakeResponse({ Results: [] });
    }
    return fakeResponse(null, { status: 404 });
  };

  await withJackett(fetchImpl, async () => {
    const items = await jackett.search(TREK_PT, 'movie', ['comandotorrents'], {
      matchContext: TREK_CTX,
    });
    assert.deepEqual(fetchImpl.searchCalls(), [TREK_PT, TREK_BARE]);
    assert.equal(items.length, 1);
  });
});

test('prazo esgotado impede a variante numérica (sem chamada extra)', async () => {
  const fetchImpl = makeFetch();
  const savedTimeout = config.jackett.brIndexerTimeout;
  config.jackett.brIndexerTimeout = 1; // orçamento exaurido ainda na primária
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) return fakeResponse({ Results: [] });
    return fakeResponse(null, { status: 404 });
  };
  try {
    await withJackett(fetchImpl, async () => {
      const items = await jackett.search(TREK_PT, 'movie', ['bludv-cardigann'], {
        variantQuery: TREK_VARIANT,
        fallbackQuery: 'Star Trek II: The Wrath of Khan 1982',
        matchContext: TREK_CTX,
      });
      // Sem orçamento sobrando, a cadeia para na primária: nem variante, nem fallback.
      assert.deepEqual(items, []);
    });
    assert.deepEqual(fetchImpl.searchCalls(), [TREK_PT]);
  } finally {
    config.jackett.brIndexerTimeout = savedTimeout;
  }
});

test('dedupe pós-shape: variante que moldagem reduz ao primário não abre chamada', async () => {
  // Com um bare-title, "batTitleIndexers" não está em jogo aqui; simulamos duas
  // queries que moldam para o MESMO texto: a plain primary e uma variante igual.
  const fetchImpl = makeFetch();
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) return fakeResponse({ Results: [] });
    return fakeResponse(null, { status: 404 });
  };
  await withJackett(fetchImpl, async () => {
    const items = await jackett.search(TREK_PT, 'movie', ['bludv-cardigann'], {
      // Variante é literalmente igual à query já enviada: shapedSeen dedup.
      variantQuery: TREK_PT,
      matchContext: TREK_CTX,
    });
    // A variante some no dedup; sobra o degrau do título sem ano.
    assert.deepEqual(fetchImpl.searchCalls(), [TREK_PT, TREK_BARE]);
    assert.deepEqual(items, []);
  });
});

test('falha HTTP na variante opcional não derruba a primária nem impede fallback original', async () => {
  const fetchImpl = makeFetch();
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) {
      const query = new URL(call.url).searchParams.get('Query');
      if (query === TREK_PT) return fakeResponse({ Results: [] });
      if (query === TREK_VARIANT) return fakeResponse(null, { status: 503 });
      if (query === TREK_BARE) return fakeResponse({ Results: [] });
      return fakeResponse({ Results: [
        { Title: 'Star Trek II: The Wrath of Khan 1982 DUBLADO 1080p', Seeders: 4, MagnetUri: MAGNET },
      ] });
    }
    return fakeResponse(null, { status: 404 });
  };

  await withJackett(fetchImpl, async () => {
    const items = await jackett.search(TREK_PT, 'movie', ['bludv-cardigann'], {
      variantQuery: TREK_VARIANT,
      fallbackQuery: 'Star Trek II: The Wrath of Khan 1982',
      matchContext: TREK_CTX,
    });
    assert.deepEqual(fetchImpl.searchCalls(), [TREK_PT, TREK_VARIANT, TREK_BARE, 'Star Trek II: The Wrath of Khan 1982']);
    assert.equal(items.length, 1);
  });
});
