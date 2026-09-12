// --- Degrau opcional do título ORIGINAL na cascata (caso Farah, tt21874046) ---
//
// Trackers globais como o magnetdownload publicam "Adım Farah"; a query
// mainstream "My Name Is Farah" nunca o encontra. O degrau é SEQUENCIAL e de
// último recurso: só abre quando a primária não trouxe candidato relevante,
// sob o MESMO deadline, com dedupe pós-shape. Resultado do título original
// NUNCA nasce _br/_dubbed por origem da query — origem/áudio continuam sendo
// provados pelo título e pelo flag do provider.
import { test } from 'node:test';
import assert from 'node:assert';

import config from '../src/config.js';
import jackett from '../src/providers/jackett.js';
import * as cache from '../src/utils/cache.js';
import * as indexerStatus from '../src/providers/indexer-status.js';
import * as metrics from '../src/utils/metrics.js';
import { toStremioStream, pickBrDubbedCandidates, pickAnyDubbedCandidates } from '../src/utils/format.js';

const HASH = 'a'.repeat(40);
const MAGNET = 'magnet:?xt=urn:btih:' + HASH + '&dn=Release';

function fakeResponse(body: unknown, { status = 200 }: { status?: number } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

interface JackettFetch {
  (url: unknown, init?: any): Promise<any>;
  handler?: (call: { url: string; init: any }) => any;
  searchCalls(): (string | null)[];
}

function makeFetch(): JackettFetch {
  const calls: { url: string; init: any }[] = [];
  const fetchImpl: JackettFetch = (url, init = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    return (async () => (fetchImpl.handler ? await fetchImpl.handler(call) : fakeResponse({ Results: [] })))();
  };
  fetchImpl.searchCalls = () =>
    calls.filter((c) => c.url.includes('/results')).map((c) => new URL(c.url).searchParams.get('Query'));
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

// Indexer global de verdade do cenário: fora de ptBrIndexers e fora de
// resolveDownloadIndexers (o item traz MagnetUri, não precisa de resolve).
const FARAH_GLOBAL = 'therarbg';
const FARAH_QUERY = 'My Name Is Farah S01E01';
const FARAH_ORIGINAL = 'Adım Farah';
const FARAH_CTX = {
  names: ['My Name Is Farah', 'Meu Nome é Farah', 'Adım Farah'],
  year: 2023,
  isSeries: true,
  season: 1,
  episode: 1,
};

test('tt21874046: primária vazia abre o degrau do título original e o matching aceita a release', async () => {
  const fetchImpl = makeFetch();
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) {
      const query = new URL(call.url).searchParams.get('Query');
      if (query === FARAH_ORIGINAL) {
        return fakeResponse({ Results: [
          { Title: 'Adım Farah S01 1080p WEB-DL TÜRKÇE', Seeders: 6, MagnetUri: MAGNET },
        ] });
      }
      return fakeResponse({ Results: [] });
    }
    return fakeResponse(null, { status: 404 });
  };

  await withJackett(fetchImpl, async () => {
    const items = await jackett.search(FARAH_QUERY, 'series', [FARAH_GLOBAL], {
      originalQuery: FARAH_ORIGINAL,
      matchContext: FARAH_CTX,
    });
    assert.deepEqual(fetchImpl.searchCalls(), [FARAH_QUERY, FARAH_ORIGINAL]);
    assert.equal(items.length, 1);
    assert.equal(items[0].title, 'Adım Farah S01 1080p WEB-DL TÜRKÇE');
    // Origem da query não prova origem do conteúdo: sem flag BR.
    assert.notEqual(items[0].isBr, true);
  });
});

test('primária relevante NÃO abre o degrau do título original (global)', async () => {
  const fetchImpl = makeFetch();
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) {
      return fakeResponse({ Results: [
        { Title: 'My Name Is Farah S01E01 1080p WEB-DL', Seeders: 20, MagnetUri: MAGNET },
      ] });
    }
    return fakeResponse(null, { status: 404 });
  };

  await withJackett(fetchImpl, async () => {
    const items = await jackett.search(FARAH_QUERY, 'series', [FARAH_GLOBAL], {
      originalQuery: FARAH_ORIGINAL,
      matchContext: FARAH_CTX,
    });
    assert.deepEqual(fetchImpl.searchCalls(), [FARAH_QUERY]);
    assert.equal(items.length, 1);
  });
});

test('original equivalente à primária pós-shape vira dedupe, não segunda chamada', async () => {
  const fetchImpl = makeFetch();
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) return fakeResponse({ Results: [] });
    return fakeResponse(null, { status: 404 });
  };

  await withJackett(fetchImpl, async () => {
    const items = await jackett.search(FARAH_ORIGINAL, 'movie', [FARAH_GLOBAL], {
      originalQuery: FARAH_ORIGINAL,
      matchContext: { names: ['Adım Farah'], year: 2023, isSeries: false, season: null, episode: null },
    });
    assert.deepEqual(fetchImpl.searchCalls(), [FARAH_ORIGINAL]);
    assert.deepEqual(items, []);
  });
});

test('BR com fallback pt-BR ativo NÃO executa o degrau original (cascata pt não se alonga)', async () => {
  const fetchImpl = makeFetch();
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) {
      const query = new URL(call.url).searchParams.get('Query');
      if (query === 'Joker') {
        return fakeResponse({ Results: [
          { Title: 'Coringa 2019 DUBLADO 1080p', Seeders: 8, MagnetUri: MAGNET },
        ] });
      }
      return fakeResponse({ Results: [] });
    }
    return fakeResponse(null, { status: 404 });
  };

  await withJackett(fetchImpl, async () => {
    const items = await jackett.search('Coringa S01E01', 'movie', ['bludv-cardigann'], {
      fallbackQuery: 'Joker S01E01',
      originalQuery: FARAH_ORIGINAL,
      matchContext: { names: ['Joker', 'Coringa'], year: 2019, isSeries: false, season: null, episode: null },
    });
    // O fallback original EN rodou; o degrau "Adım Farah" foi portado de fora
    // (erro de uso) e o gate o descarta — BR com pt-BR útil não se alonga.
    assert.deepEqual(fetchImpl.searchCalls(), ['Coringa', 'Joker']);
    assert.equal(items.length, 1);
  });
});

test('BR sem ptQuery útil usa o título original como último degrau', async () => {
  const fetchImpl = makeFetch();
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) {
      const query = new URL(call.url).searchParams.get('Query');
      if (query === FARAH_ORIGINAL) {
        return fakeResponse({ Results: [
          { Title: 'Adım Farah 1ª Temporada DUBLADO 1080p', Seeders: 3, MagnetUri: MAGNET },
        ] });
      }
      return fakeResponse({ Results: [] });
    }
    return fakeResponse(null, { status: 404 });
  };

  await withJackett(fetchImpl, async () => {
    const items = await jackett.search(FARAH_QUERY, 'series', ['bludv-cardigann'], {
      originalQuery: FARAH_ORIGINAL,
      matchContext: FARAH_CTX,
    });
    // A moldagem BR tira o SxxEyy da primária; o original entra como último
    // degrau (stripDiacritics preserva o ı, que não é diacrítico combinável).
    assert.deepEqual(fetchImpl.searchCalls(), ['My Name Is Farah', FARAH_ORIGINAL]);
    assert.equal(items.length, 1);
  });
});

test('prazo quase esgotado impede o degrau original mesmo com a primária RESPONDENDO vazio', async () => {
  // A primária precisa responder (HTTP 200 vazio) DEPOIS de consumir o
  // orçamento — o caminho anterior (primária abortada) era verde à toa, pois
  // a ausência do degrau vinha do abort, não do gate de orçamento. Com
  // orçamento 800ms e resposta em ~600ms, sobram < MIN_RESOLVE_BUDGET (400ms)
  // e o gate impede o degrau sem abortar ninguém.
  const fetchImpl = makeFetch();
  const savedTimeout = config.jackett.indexerTimeout;
  config.jackett.indexerTimeout = 800;
  fetchImpl.handler = async (call) => {
    if (!call.url.includes('/results')) return fakeResponse(null, { status: 404 });
    await new Promise((resolve) => setTimeout(resolve, 600));
    return fakeResponse({ Results: [] });
  };
  try {
    await withJackett(fetchImpl, async () => {
      const items = await jackett.search(FARAH_QUERY, 'series', [FARAH_GLOBAL], {
        originalQuery: FARAH_ORIGINAL,
        matchContext: FARAH_CTX,
      });
      // A primária RESOLVEU (não abortou): lote vazio, busca concluída.
      assert.deepEqual(items, []);
    });
    const calls = fetchImpl.searchCalls();
    assert.deepEqual(calls, [FARAH_QUERY], 'primária respondeu e o degrau original não abriu');
  } finally {
    config.jackett.indexerTimeout = savedTimeout;
  }
});

test('resultado do título original não ganha _br/_dubbed nem entra em pool BR/autofetch', async () => {
  // O item aqui ATRAVESSOU a cascata real (primária vazia → degrau original),
  // não é construção sintética: a fábrica prova origem/áudio pelo TÍTULO e
  // pelo flag do provider — nunca pela query que o encontrou. "TÜRKÇE" é
  // marcador estrangeiro explícito: o item toca (é a única opção que existe
  // para a obra) mas não recebe vaga BR, prioridade dublada nem autofetch.
  const fetchImpl = makeFetch();
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) {
      const query = new URL(call.url).searchParams.get('Query');
      if (query === FARAH_ORIGINAL) {
        return fakeResponse({ Results: [
          { Title: 'Adım Farah S01 1080p WEB-DL TÜRKÇE', Seeders: 50, MagnetUri: MAGNET },
        ] });
      }
      return fakeResponse({ Results: [] });
    }
    return fakeResponse(null, { status: 404 });
  };
  await withJackett(fetchImpl, async () => {
    const items = await jackett.search(FARAH_QUERY, 'series', [FARAH_GLOBAL], {
      originalQuery: FARAH_ORIGINAL,
      matchContext: FARAH_CTX,
    });
    assert.equal(items.length, 1);
    const stream = toStremioStream(items[0]);
    assert.ok(stream, 'release com magnet vira stream');
    assert.equal(stream._br, false);
    assert.equal(stream._dubbed, false);
    assert.deepEqual(pickBrDubbedCandidates([stream as any]), []);
    assert.deepEqual(pickAnyDubbedCandidates([stream as any]), []);
  });
});

test('degrau original morto por dentro (HTTP 200) não reclassifica a primária saudável', async () => {
  // A primária respondeu 200 SAUDÁVEL e vazio; o degrau do original tropeça
  // com o estrago só no envelope (`Indexers[].Error`, não exceção). Quem já
  // respondeu não pode virar offline nem alimentar o breaker por causa de um
  // degrau opcional de último recurso.
  const fetchImpl = makeFetch();
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) {
      const query = new URL(call.url).searchParams.get('Query');
      if (query === FARAH_ORIGINAL) {
        return fakeResponse({
          Results: [],
          Indexers: [{
            ID: FARAH_GLOBAL, Name: FARAH_GLOBAL, Status: 1, Results: 0,
            Error: 'Jackett.Common.IndexerException: Exception (therarbg): The tracker seems to be down.',
          }],
        });
      }
      // Primária saudável (Status 2), vazio para a obra.
      return fakeResponse({
        Results: [],
        Indexers: [{ ID: FARAH_GLOBAL, Name: FARAH_GLOBAL, Status: 2, Results: 0, Error: null }],
      });
    }
    return fakeResponse(null, { status: 404 });
  };
  await withJackett(fetchImpl, async () => {
    indexerStatus.clear();
    await jackett.search(FARAH_QUERY, 'series', [FARAH_GLOBAL], {
      originalQuery: FARAH_ORIGINAL,
      matchContext: FARAH_CTX,
    });
    const st = indexerStatus.get(FARAH_GLOBAL);
    assert.equal(st?.state, 'online', 'falha do degrau opcional não pinta o card');
    assert.equal(st?.failStreak || 0, 0, 'não alimenta o failStreak do breaker');
    indexerStatus.clear();
  });
});

test('jackett.original.step conta a tentativa e workHit só sobrevivente RELEVANTE da obra', async () => {
  const fetchImpl = makeFetch();
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) {
      const query = new URL(call.url).searchParams.get('Query');
      if (query === FARAH_ORIGINAL) {
        // Item bruto que o filtro de título descartaria: NÃO é hit.
        return fakeResponse({ Results: [
          { Title: 'Missão: Impossível – Efeito Farah 1080p', Seeders: 9, MagnetUri: MAGNET },
        ] });
      }
      return fakeResponse({ Results: [] });
    }
    return fakeResponse(null, { status: 404 });
  };
  await withJackett(fetchImpl, async () => {
    indexerStatus.clear();
    const before = metrics.snapshot().counters;
    await jackett.search(FARAH_QUERY, 'series', [FARAH_GLOBAL], {
      originalQuery: FARAH_ORIGINAL,
      matchContext: FARAH_CTX,
    });
    const after = metrics.snapshot().counters;
    assert.equal((after['jackett.original.step'] || 0) - (before['jackett.original.step'] || 0), 1,
      'o degrau foi tentado uma vez');
    assert.equal((after['jackett.original.workHit'] || 0) - (before['jackett.original.workHit'] || 0), 0,
      'item bruto irrelevante não conta workHit');
    indexerStatus.clear();
  });
});

test('BR: fallback pt idêntico à primária não suprime o degrau original', async () => {
  // Edge do colhedor com Cinemeta 404: a query mainstream JÁ É o título pt,
  // então o fallback viraria no-op do dedupe pós-shape — e não pode suprimir
  // o degrau do original. O gate só suppress com fallback pt ÚTIL (presente E
  // diferente da primária pós-shape).
  const fetchImpl = makeFetch();
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) {
      const query = new URL(call.url).searchParams.get('Query');
      if (query === FARAH_ORIGINAL) {
        return fakeResponse({ Results: [
          { Title: 'Adım Farah S01 1080p WEB-DL', Seeders: 4, MagnetUri: MAGNET },
        ] });
      }
      return fakeResponse({ Results: [] });
    }
    return fakeResponse(null, { status: 404 });
  };
  await withJackett(fetchImpl, async () => {
    const items = await jackett.search('Meu Nome é Farah S01E01', 'series', ['bludv-cardigann'], {
      fallbackQuery: 'Meu Nome é Farah S01E01', // igual à primária: pt já é a query
      originalQuery: FARAH_ORIGINAL,
      matchContext: { names: ['Meu Nome é Farah', 'Adım Farah'], year: 2023, isSeries: true, season: 1, episode: 1 },
    });
    // Fallback dedupado (nem vira chamada — a moldagem BR tira o diacrítico e
    // reduz fallback e primária ao mesmo texto); o degrau original roda.
    assert.deepEqual(fetchImpl.searchCalls(), ['Meu Nome e Farah', FARAH_ORIGINAL]);
    assert.equal(items.length, 1);
  });
});
