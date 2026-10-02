// --- Exceção de download do próprio Jackett (isJackettDownloadLink) ---
//
// O `<link>` Torznab é input de TERCEIRO: o Cardigann aponta o download para o
// PRÓPRIO Jackett (`/dl/<indexer>/...`, loopback no container único) e a
// exceção existe para não derrubar esses magnets. Mas a exceção é pelo SHAPE,
// não pela origem sozinha — same-origin fora de `/dl/` é admin local e segue
// bloqueado (com warn), e origem diferente não herda a exceção.
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

test('link /dl/ do próprio Jackett resolve magnet (caminho feliz da exceção)', async () => {
  const fetchImpl = makeFetch();
  const dlLink = 'http://jackett.test/dl/bludv-cardigann/?jackett_apikey=test-key&path=Release.torrent';
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) {
      return fakeResponse({ Results: [
        { Title: 'Predador (1987) 1080p DUBLADO', Seeders: 3, Link: dlLink },
      ] });
    }
    return fakeResponse(null, { location: MAGNET });
  };

  await withJackett(fetchImpl, async () => {
    const items = await jackett.search('Predador 1987', 'movie', ['comandotorrents'], {
      matchContext: { names: ['Predador', 'Predator'], year: 1987, isSeries: false, season: null, episode: null },
    });
    assert.equal(items.length, 1);
    assert.equal(items[0].magnet, MAGNET);
    // O download foi buscado na origem do Jackett (não é protetor externo).
    assert.equal(fetchImpl.protectorCalls().includes(dlLink), true);
  });
});

// Caso real The Rejuvenator (1988): limetorrents e 1337x entregam o Link como
// `/dl/<indexer>/...` do próprio Jackett, SEM infoHash, e o endpoint responde
// 302 direto para o magnet (medido localmente). Estes dois globais entram no
// DEFAULT de JACKETT_RESOLVE_DOWNLOAD_INDEXERS — um salto barato, sem
// protetor de link. Operador que define a env substitui o default inteiro.
test('limetorrents e 1337x resolvem /dl → magnet no default (The Rejuvenator 1988)', async () => {
  const fetchImpl = makeFetch();
  const dlLimetorrents = 'http://jackett.test/dl/limetorrents/?jackett_apikey=test-key&path=The.Rejuvenator.1988.torrent';
  const dl1337x = 'http://jackett.test/dl/1337x/?jackett_apikey=test-key&path=The.Rejuvenator.1988.torrent';
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) {
      return fakeResponse({ Results: [
        { Title: 'The Rejuvenator (1988 Rejuvenatrix) DVDrip', Seeders: 4, Link: dlLimetorrents },
        { Title: 'The Rejuvenator (1988 Rejuvenatrix) DVDRip', Seeders: 3, Link: dl1337x },
      ] });
    }
    return fakeResponse(null, { location: MAGNET });
  };

  await withJackett(fetchImpl, async () => {
    // Os dois IDs JÁ fazem parte do default do config (suíte hermética: sem
    // .env do operador). Se um dia sair do default, este teste acusa.
    assert.equal(config.jackett.resolveDownloadIndexers.includes('limetorrents'), true);
    assert.equal(config.jackett.resolveDownloadIndexers.includes('1337x'), true);
    const items = await jackett.search('The Rejuvenator 1988', 'movie', ['limetorrents', '1337x'], {
      matchContext: { names: ['The Rejuvenator'], year: 1988, isSeries: false, season: null, episode: null },
    });
    // O dublê devolve os 2 resultados para CADA indexer: 4 itens, todos
    // resolvidos para o MESMO magnet (302 dos dois endpoints).
    assert.equal(items.length, 4);
    assert.deepEqual([...new Set(items.map((i: any) => i.magnet))], [MAGNET]);
    assert.equal(fetchImpl.protectorCalls().includes(dlLimetorrents), true);
    assert.equal(fetchImpl.protectorCalls().includes(dl1337x), true);
  });
});

test('indexer global FORA da lista não paga resolução (opt-in por indexer)', async () => {
  const fetchImpl = makeFetch();
  const dlLink = 'http://jackett.test/dl/therarbg/?jackett_apikey=test-key&path=Release.torrent';
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) {
      return fakeResponse({ Results: [
        { Title: 'The Rejuvenator (1988 Rejuvenatrix) DVDrip', Seeders: 4, Link: dlLink },
      ] });
    }
    return fakeResponse(null, { location: MAGNET });
  };

  await withJackett(fetchImpl, async () => {
    assert.equal(config.jackett.resolveDownloadIndexers.includes('therarbg'), false);
    const items = await jackett.search('The Rejuvenator 1988', 'movie', ['therarbg'], {
      matchContext: { names: ['The Rejuvenator'], year: 1988, isSeries: false, season: null, episode: null },
    });
    // Sem resolução: item sem infoHash sobrevive ao provider, mas o download
    // NUNCA foi buscado — o corte por falta de hash acontece depois.
    assert.equal(items.length, 1);
    assert.equal(items[0].magnet, undefined);
    assert.equal(fetchImpl.protectorCalls().includes(dlLink), false);
  });
});

test('lista efetiva vazia desliga a resolução', async () => {
  const fetchImpl = makeFetch();
  const dlLink = 'http://jackett.test/dl/limetorrents/?jackett_apikey=test-key&path=The.Rejuvenator.1988.torrent';
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) {
      return fakeResponse({ Results: [
        { Title: 'The Rejuvenator (1988 Rejuvenatrix) DVDrip', Seeders: 4, Link: dlLink },
      ] });
    }
    return fakeResponse(null, { location: MAGNET });
  };
  const saved = config.jackett.resolveDownloadIndexers;
  config.jackett.resolveDownloadIndexers = [];
  try {
    await withJackett(fetchImpl, async () => {
      const items = await jackett.search('The Rejuvenator 1988', 'movie', ['limetorrents'], {
        matchContext: { names: ['The Rejuvenator'], year: 1988, isSeries: false, season: null, episode: null },
      });
      assert.equal(items.length, 1);
      assert.equal(items[0].magnet, undefined);
      assert.equal(fetchImpl.protectorCalls().includes(dlLink), false);
    });
  } finally {
    config.jackett.resolveDownloadIndexers = saved;
  }
});

test('link same-origin FORA de /dl/ é bloqueado (admin local não é download)', async () => {
  const fetchImpl = makeFetch();
  // Base do Jackett em loopback, como no container único: same-origin com o
  // link abaixo, e o IP privado garante que SÓ a exceção nova poderia deixá-lo
  // passar (o isSafeDownloadUrl rejeita por si só qualquer outro host).
  const adminLink = 'http://127.0.0.1:9117/api/v2.0/server/config?apikey=x';
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) {
      return fakeResponse({ Results: [
        { Title: 'Predador (1987) 1080p DUBLADO', Seeders: 3, Link: adminLink },
      ] });
    }
    return fakeResponse(null, { location: MAGNET });
  };
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };

  try {
    await withJackett(fetchImpl, async () => {
      config.jackett.url = 'http://127.0.0.1:9117';
      const items = await jackett.search('Predador 1987', 'movie', ['comandotorrents'], {
        matchContext: { names: ['Predador', 'Predator'], year: 1987, isSeries: false, season: null, episode: null },
      });
      // Bloqueado antes do fetch: sem magnet, sem chamada de download.
      assert.equal(items.length, 1);
      assert.equal(items[0].magnet, undefined);
      assert.equal(fetchImpl.protectorCalls().includes(adminLink), false);
      assert.ok(warnings.some((w) => w.includes('[jackett] URL de download bloqueada por segurança')), warnings.join('\n'));
    });
  } finally {
    console.warn = realWarn;
  }
});

test('exceção não vaza: /dl/ em origem PRIVADA diferente do Jackett segue no guard', async () => {
  const fetchImpl = makeFetch();
  // Porta diferente = origem diferente; isSafeDownloadUrl derruba o IP privado
  // literal e o shape /dl/ NÃO autoriza fora da origem do próprio serviço.
  const foreignLink = 'http://127.0.0.1:9999/dl/bludv-cardigann/?path=Release.torrent';
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) {
      return fakeResponse({ Results: [
        { Title: 'Predador (1987) 1080p DUBLADO', Seeders: 3, Link: foreignLink },
      ] });
    }
    return fakeResponse(null, { location: MAGNET });
  };
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };

  try {
    await withJackett(fetchImpl, async () => {
      const items = await jackett.search('Predador 1987', 'movie', ['comandotorrents'], {
        matchContext: { names: ['Predador', 'Predator'], year: 1987, isSeries: false, season: null, episode: null },
      });
      assert.equal(items.length, 1);
      assert.equal(items[0].magnet, undefined);
      assert.equal(fetchImpl.protectorCalls().includes(foreignLink), false);
      assert.ok(warnings.some((w) => w.includes('[jackett] URL de download bloqueada por segurança')));
    });
  } finally {
    console.warn = realWarn;
  }
});
