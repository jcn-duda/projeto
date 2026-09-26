// --- Cache do resultado bruto (Fase 1 do PLANO_CACHE) ---
// A memoização cobre SÓ a camada de rede (fetchQuery): cascata de fallback e
// resolução de magnets continuam rodando por busca. Com fetch falso dá pra
// contar exatamente quantas consultas Torznab saíram.
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

test('raw cache: segunda busca da mesma query reusa o bruto sem novo fetch', async () => {
  const fetchImpl = makeFetch();
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) {
      return fakeResponse({ Results: [
        { Title: 'Predador (1987) 1080p DUBLADO', Seeders: 3, MagnetUri: MAGNET },
      ] });
    }
    return fakeResponse(null, { status: 404 });
  };

  await withJackett(fetchImpl, async () => {
    const run = () => jackett.search('Predador 1987', 'movie', ['comandotorrents'], {
      matchContext: { names: ['Predador', 'Predator'], year: 1987, isSeries: false, season: null, episode: null },
    });
    const first = await run();
    assert.equal(first.length, 1);
    const second = await run();
    assert.equal(second.length, 1);
    // A raspagem Torznab aconteceu UMA vez; a segunda busca vive do raw.
    assert.deepEqual(fetchImpl.searchCalls(), ['Predador 1987']);
  });
});

test('raw cache: E01 e E02 da mesma temporada compartilham a entrada em indexer BR', async () => {
  // shapeSearchQuery remove SxxEyy nos indexers BR: a chave é por temporada,
  // e é isso que faz a busca tardia de pack ("Nome S01") pagar uma varredura
  // só por temporada em vez de uma por episódio.
  const fetchImpl = makeFetch();
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) {
      return fakeResponse({ Results: [
        { Title: 'Fallout 1ª Temporada (2024) WEB-DL [1080p DUBLADO]', Seeders: 1, MagnetUri: MAGNET },
      ] });
    }
    return fakeResponse(null, { status: 404 });
  };

  await withJackett(fetchImpl, async () => {
    const ctx = { names: ['Fallout'], year: 2024, isSeries: true, season: 1 };
    const e1 = await jackett.search('Fallout S01E01', 'series', ['bludv-cardigann'], {
      matchContext: { ...ctx, episode: 1 },
    });
    const e2 = await jackett.search('Fallout S01E02', 'series', ['bludv-cardigann'], {
      matchContext: { ...ctx, episode: 2 },
    });
    assert.equal(e1.length, 1);
    assert.equal(e2.length, 1);
    // As duas queries moldam para "Fallout": UMA consulta Torznab só.
    assert.deepEqual(fetchImpl.searchCalls(), ['Fallout']);
  });
});

test('raw cache: resultado acima do teto de itens não é cacheado', async () => {
  const fetchImpl = makeFetch();
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) {
      return fakeResponse({ Results: [
        { Title: 'Predador A 1080p DUBLADO', Seeders: 3, MagnetUri: MAGNET },
        { Title: 'Predador B 720p DUBLADO', Seeders: 2, MagnetUri: MAGNET },
      ] });
    }
    return fakeResponse(null, { status: 404 });
  };
  const saved = config.rawCache.maxItems;
  // Teto forçado pra baixo: 2 itens estouram sem precisar de 121 resultados.
  config.rawCache.maxItems = 1;
  try {
    await withJackett(fetchImpl, async () => {
      const run = () => jackett.search('Predador 1987', 'movie', ['comandotorrents'], {
        matchContext: { names: ['Predador', 'Predator'], year: 1987, isSeries: false, season: null, episode: null },
      });
      await run();
      await run();
      // Acima do teto o bruto não entra no cache: cada busca paga o fetch.
      assert.equal(fetchImpl.searchCalls().length, 2);
    });
  } finally {
    config.rawCache.maxItems = saved;
  }
});

test('raw cache: vazio é cacheado e a segunda busca não abre fetch', async () => {
  // 200 com zero itens entra com o TTL curto (RAW_CACHE_EMPTY_TTL), não o
  // cheio; aqui o comportamento: o vazio não paga raspagem repetida.
  const fetchImpl = makeFetch();
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) return fakeResponse({ Results: [] });
    return fakeResponse(null, { status: 404 });
  };

  await withJackett(fetchImpl, async () => {
    const run = () => jackett.search('Titulo Inexistente 1901', 'movie', ['thepiratebay']);
    assert.deepEqual(await run(), []);
    assert.deepEqual(await run(), []);
    assert.equal(fetchImpl.searchCalls().length, 1, 'o vazio da primeira busca é servido do cache');
  });
});

test('raw cache: hit não registra indexer-status (a medição não aconteceu)', async () => {
  // Regressão da correção 4 do PLANO_CACHE: hit gravando ok:true com ms~0
  // deixaria um indexer caído verde no card pelo TTL inteiro.
  const fetchImpl = makeFetch();
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) {
      return fakeResponse({ Results: [
        { Title: 'Jornada Nas Estrelas 1979 Dublado 1080p', Seeders: 3, MagnetUri: MAGNET },
      ] });
    }
    return fakeResponse(null, { status: 404 });
  };
  try {
    await withJackett(fetchImpl, async () => {
      const run = () => jackett.search('Jornada nas Estrelas 1979', 'movie', ['thepiratebay']);
      await run();
      const before = indexerStatus.get('thepiratebay');
      assert.ok(before, 'a busca ao vivo registra o status');
      // Relógio distinto: checkedAt tem precisão de milissegundo.
      await new Promise((resolve) => setTimeout(resolve, 10));
      await run(); // hit do raw: nenhuma consulta Torznab saiu
      const after = indexerStatus.get('thepiratebay');
      assert.equal(after.checkedAt, before.checkedAt, 'o hit não pode inventar medição');
    });
  } finally {
    indexerStatus.clear();
  }
});
