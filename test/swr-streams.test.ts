// @ts-nocheck — rodada 1: checagem suspensa para fechar o portão do src;
// remover arquivo a arquivo na rodada 2.
import { test } from 'node:test';
import assert from 'node:assert';

// Sem SQLite: esta suíte exercita a decisão do SWR no L1 em memória. Tem que
// ser definido ANTES de o módulo de cache ser carregado pela primeira vez.
// Em ESM os imports estáticos são hoisted (o cache abre o banco no load),
// então os módulos entram por import dinâmico depois desta linha.
process.env.CACHE_PERSIST = 'false';

const cache = await import('../src/utils/cache.js');
const config = (await import('../src/config.js')).default;
const metrics = await import('../src/utils/metrics.js');
const runtime = await import('../src/runtime.js');
const { streamsCacheKey } = await import('../src/utils/request-key.js');
const { findStreams } = await import('../src/providers/index.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Toda rede externa passa por um 404 com atraso curto. O atraso garante que o
// refresh de fundo ainda está em voo quando a segunda leitura stale chega —
// sem ele o teste de dedupe viraria corrida. Nenhum teste desta suíte pode
// tocar a internet de verdade.
const FETCH_DELAY_MS = 200;
const realFetch = global.fetch;
function installFetchStub() {
  global.fetch = async () => {
    await sleep(FETCH_DELAY_MS);
    return new Response('', { status: 404, statusText: 'Not Found' });
  };
}

/**
 * Contexto de requisição determinístico: provider demo (sem Jackett), sem
 * debrid (applyDebrid não toca conta nenhuma). Os defaults do .env do operador
 * não podem vazar para o teste — a chave do cache é derivada destas opts.
 */
function inRequest(fn) {
  const testOpts = {
    ...runtime.normalize(null),
    providers: ['demo'],
    debridService: '',
    debridApiKey: '',
  };
  return runtime.run({ opts: testOpts, encoded: 'swrtest' }, fn);
}

function cacheKeyFor(type, id) {
  return streamsCacheKey(type, id, {
    ...runtime.opts(),
    resolveUncached: config.debrid.resolveUncached,
  });
}

// TTL de 50 ms: expira rápido e entra na janela de graça (300 s) sem a suíte
// pagar espera longa.
const SHORT_TTL_S = 0.05;

test('lista completa na graça: responde na hora e agenda UM refresh de fundo', async () => {
  cache.clear();
  metrics.reset();
  installFetchStub();
  try {
    await inRequest(async () => {
      const entry = {
        streams: [{ name: 'Filme X\n1080p ⚡', url: 'https://play/1' }],
        partial: false,
        debridKnown: true,
      };
      const key = cacheKeyFor('movie', 'tt9000001');
      cache.set(key, entry, SHORT_TTL_S);
      await sleep(120);

      const started = Date.now();
      const first = await findStreams({ type: 'movie', id: 'tt9000001' });
      const second = await findStreams({ type: 'movie', id: 'tt9000001' });
      const elapsed = Date.now() - started;

      assert.deepEqual(first.streams, entry.streams, 'a primeira leitura serve a lista stale');
      assert.equal(first.partial, false);
      assert.deepEqual(second.streams, entry.streams, 'a segunda também, sem busca síncrona');
      assert.ok(elapsed < 500, `resposta stale não pode pagar busca (levou ${elapsed}ms)`);

      const counters = metrics.snapshot().counters;
      assert.equal(counters['search.swr.served'], 2, 'cada leitura stale conta um serve');
      assert.equal(counters['search.swr.scheduled'], 1, 'duas leituras agendam UM refresh');
    });
    // Deixa o refresh de fundo terminar (e reescrever o cache) antes de limpar.
    await sleep(FETCH_DELAY_MS * 8);
  } finally {
    global.fetch = realFetch;
    cache.clear();
    metrics.reset();
  }
});

test('lista só com aviso NÃO entra no caminho stale', async () => {
  cache.clear();
  metrics.reset();
  installFetchStub();
  try {
    await inRequest(async () => {
      // partial:false + debridKnown:true de propósito: o que condena a entrada
      // é a falta de stream tocável (aviso carrega só name + externalUrl).
      const entry = {
        streams: [{ name: 'Nenhuma fonte pronta — 3 resultado(s) fora do cache', externalUrl: 'http://local/configure' }],
        partial: false,
        debridKnown: true,
      };
      const key = cacheKeyFor('movie', 'tt9000002');
      cache.set(key, entry, SHORT_TTL_S);
      await sleep(120);

      const result = await findStreams({ type: 'movie', id: 'tt9000002' });

      // Não serviu a entrada velha: pagou a busca síncrona (demo devolve nada
      // para id que não é o Big Buck Bunny).
      assert.notDeepEqual(result.streams, entry.streams, 'o aviso não pode ser servido como stale');
      const counters = metrics.snapshot().counters;
      assert.ok(!counters['search.swr.served'], 'nenhum serve stale aconteceu');
      assert.ok(!counters['search.swr.scheduled'], 'nenhum refresh foi agendado');
    });
  } finally {
    global.fetch = realFetch;
    cache.clear();
    metrics.reset();
  }
});

test('lista parcial NÃO entra no caminho stale', async () => {
  cache.clear();
  metrics.reset();
  installFetchStub();
  try {
    await inRequest(async () => {
      // Tem stream tocável mas a coleta não terminou: servir o parcial stale
      // congelaria a lista sem as fontes BR pelo TTL + graça.
      const entry = {
        streams: [{ name: 'Filme Y\n720p', url: 'https://play/2' }],
        partial: true,
        debridKnown: true,
      };
      const key = cacheKeyFor('movie', 'tt9000003');
      cache.set(key, entry, SHORT_TTL_S);
      await sleep(120);

      const result = await findStreams({ type: 'movie', id: 'tt9000003' });

      assert.notDeepEqual(result.streams, entry.streams, 'a parcial não pode ser servida como stale');
      const counters = metrics.snapshot().counters;
      assert.ok(!counters['search.swr.served'], 'nenhum serve stale aconteceu');
      assert.ok(!counters['search.swr.scheduled'], 'nenhum refresh foi agendado');
    });
  } finally {
    global.fetch = realFetch;
    cache.clear();
    metrics.reset();
  }
});

test('graça zero restaura a semântica dura: expirado paga busca síncrona', async () => {
  cache.clear();
  metrics.reset();
  installFetchStub();
  const originalGrace = config.streamStaleGrace;
  try {
    config.streamStaleGrace = 0;
    await inRequest(async () => {
      const entry = {
        streams: [{ name: 'Filme Z\n1080p ⚡', url: 'https://play/3' }],
        partial: false,
        debridKnown: true,
      };
      const key = cacheKeyFor('movie', 'tt9000004');
      cache.set(key, entry, SHORT_TTL_S);
      await sleep(120);

      const result = await findStreams({ type: 'movie', id: 'tt9000004' });

      // Kill-switch: mesmo completa e tocável, expirou = busca nova.
      assert.notDeepEqual(result.streams, entry.streams, 'graça 0 não serve stale');
      const counters = metrics.snapshot().counters;
      assert.ok(!counters['search.swr.served'], 'nenhum serve stale aconteceu');
      assert.ok(!counters['search.swr.scheduled'], 'nenhum refresh foi agendado');
    });
  } finally {
    config.streamStaleGrace = originalGrace;
    global.fetch = realFetch;
    cache.clear();
    metrics.reset();
  }
});
