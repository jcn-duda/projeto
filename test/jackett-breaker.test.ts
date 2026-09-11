// --- Circuit breaker e a varredura pt-BR ---
//
// A varredura pt-BR é a única coisa que consulta um indexer com circuit
// breaker aberto: roda fora do orçamento da resposta, e o dublado raro mora
// justamente no indexer recém-derrubado. O breaker é um atalho de busca AO
// VIVO — a varredura o ignora de propósito. `recordStatus:false` continua
// valendo: a falha dela não pode poluir o card de status.
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

test('search normal pula indexer com breaker aberto', async () => {
  const fetchImpl = makeFetch();
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) {
      return fakeResponse({ Results: [
        { Title: 'Jornada Nas Estrelas 1979 Dublado 1080p', Seeders: 3, MagnetUri: MAGNET },
      ] });
    }
    return fakeResponse(null, { status: 404 });
  };
  // 3 falhas seguidas abrem o circuito (default breakerFailures=3).
  for (let i = 0; i < config.jackett.breakerFailures; i += 1) {
    indexerStatus.record('thepiratebay', { ok: false, results: 0, ms: 100, budgetMs: 4000 });
  }
  try {
    await withJackett(fetchImpl, async () => {
      await jackett.search('Jornada nas Estrelas 1979', 'movie', ['thepiratebay']);
      // Pula o indexer com breaker aberto: zero chamadas de busca.
      assert.deepEqual(fetchImpl.searchCalls(), []);
    });
  } finally {
    indexerStatus.clear();
  }
});

test('search com ignoreBreaker:true consulta indexer com breaker aberto', async () => {
  const fetchImpl = makeFetch();
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) {
      return fakeResponse({ Results: [
        { Title: 'Jornada Nas Estrelas 1979 Dublado 1080p', Seeders: 3, MagnetUri: MAGNET },
      ] });
    }
    return fakeResponse(null, { status: 404 });
  };
  for (let i = 0; i < config.jackett.breakerFailures; i += 1) {
    indexerStatus.record('thepiratebay', { ok: false, results: 0, ms: 100, budgetMs: 4000 });
  }
  try {
    await withJackett(fetchImpl, async () => {
      const items = await jackett.search('Jornada nas Estrelas 1979', 'movie', ['thepiratebay'], {
        ignoreBreaker: true,
        recordStatus: false,
      });
      // Mesmo com breaker aberto, a varredura consulta — foi o que o caso
      // Star Trek I mostrou: kickasstorrents-to (único que respondia à
      // query longa) tinha acabado de ser tirado do ar pela busca anterior.
      assert.deepEqual(fetchImpl.searchCalls(), ['Jornada nas Estrelas 1979']);
      assert.equal(items.length, 1);
    });
  } finally {
    indexerStatus.clear();
  }
});

test('search com ignoreBreaker:true e recordStatus:false não atualiza o card', async () => {
  const fetchImpl = makeFetch();
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) {
      return fakeResponse({ Results: [
        { Title: 'Jornada Nas Estrelas 1979 Dublado 1080p', Seeders: 3, MagnetUri: MAGNET },
      ] });
    }
    return fakeResponse(null, { status: 404 });
  };
  // Estado inicial conhecido: 1 falha (não abre o circuito).
  indexerStatus.record('thepiratebay', { ok: false, results: 0, ms: 100, budgetMs: 4000 });
  const before = indexerStatus.get('thepiratebay');
  try {
    await withJackett(fetchImpl, async () => {
      await jackett.search('Jornada nas Estrelas 1979', 'movie', ['thepiratebay'], {
        ignoreBreaker: true,
        recordStatus: false,
      });
      const after = indexerStatus.get('thepiratebay');
      // recordStatus:false impede que o sucesso da varredura limpe o
      // failStreak: o card de status continua refletindo a busca ao vivo.
      assert.equal(after.failStreak, before.failStreak);
    });
  } finally {
    indexerStatus.clear();
  }
});

test('não medido → breaker.state naomedido (sem status / enabled:false)', () => {
  indexerStatus.clear();
  const saved = config.jackett.breakerEnabled;
  try {
    config.jackett.breakerEnabled = true;
    const semStatus = jackett.breakerSnapshot('indexer-nunca-visto');
    assert.equal(semStatus.state, 'naomedido');
    assert.equal(semStatus.tripped, false);

    config.jackett.breakerEnabled = false;
    indexerStatus.record('thepiratebay', { ok: true, results: 1, ms: 50, budgetMs: 4000 });
    const desligado = jackett.breakerSnapshot('thepiratebay');
    assert.equal(desligado.state, 'naomedido', 'enabled:false não reporta fechado');
    assert.equal(desligado.tripped, false);
  } finally {
    config.jackett.breakerEnabled = saved;
    indexerStatus.clear();
  }
});

test('breaker.state aberto/fechado com status válido', () => {
  indexerStatus.clear();
  const saved = config.jackett.breakerEnabled;
  try {
    config.jackett.breakerEnabled = true;
    indexerStatus.record('thepiratebay', { ok: true, results: 2, ms: 80, budgetMs: 4000 });
    assert.equal(jackett.breakerSnapshot('thepiratebay').state, 'fechado');

    for (let i = 0; i < config.jackett.breakerFailures; i += 1) {
      indexerStatus.record('thepiratebay', { ok: false, results: 0, ms: 100, budgetMs: 4000 });
    }
    const aberto = jackett.breakerSnapshot('thepiratebay');
    assert.equal(aberto.state, 'aberto');
    assert.equal(aberto.tripped, true);
  } finally {
    config.jackett.breakerEnabled = saved;
    indexerStatus.clear();
  }
});
