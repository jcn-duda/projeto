// P5 Fase 1 — rota /stream-trace.json: leitura OFFLINE do ledger, mesmo
// padrão do app-routes.test.ts (createTestServer, gate, token no header).
// Zero rede: o payload veio da gravação do `finish`, o endpoint só lê cache.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Persistência desligada ANTES dos requires (mesma regra do app-routes):
// o app real abre o módulo de cache e o data/cache.db do repo não pode ser
// tocado pelos testes.
process.env.CACHE_PERSIST = 'false';

import { createApp } from '../src/app.js';
import config from '../src/config.js';
import * as runtime from '../src/runtime.js';
import * as cache from '../src/utils/cache.js';
import { streamsCacheKey } from '../src/utils/request-key.js';
import jackett from '../src/providers/jackett.js';
import { createTestServer, withMockFetch, createMockFetch, encodeConfig } from './e2e/e2e-harness.js';

const HASH = 'd'.repeat(40);

let server: any;
const saved: Record<string, unknown> = {};

before(async () => {
  // O token de diagnóstico efetivo vem do .env do operador; os testes decidem
  // tudo por ele, então o ambiente precisa nascer neutro (e voltar no after).
  saved.testToken = config.jackett.testToken;
  config.jackett.testToken = '';
  server = await createTestServer(createApp().app);
});

after(async () => {
  await server.close();
  config.jackett.testToken = saved.testToken as string;
});

/** Chave que a busca SEM segmento derivaria (opts = defaults do runtime). */
function chaveGlobal(type: string, id: string) {
  return streamsCacheKey(type, id, {
    ...runtime.opts(),
    resolveUncached: config.debrid.resolveUncached,
  });
}

/** Chave que a busca COM o segmento derivaria (opts decodificados). */
function chaveDoSegmento(type: string, id: string, segment: string) {
  const opts = runtime.decode(segment) || {};
  return streamsCacheKey(type, id, {
    ...opts,
    resolveUncached: config.debrid.resolveUncached,
  });
}

/** Entrada realista de cache com trace, no formato que o finish grava. */
function entrada(parcial = false) {
  return {
    streams: [{ name: 'Filme Qualquer\n1080p ⚡', url: `https://x/resolve/${HASH}?sig=1` }],
    partial: parcial,
    debridKnown: true,
    trace: {
      startedAt: Date.now() - 500,
      finishedAt: Date.now(),
      stages: { raw: 4, afterSort: 3, final: 1 },
      items: [
        { id: 's1', reason: 'title-filter', label: 'Outro Filme 2023', br: false },
        { id: 's2', reason: 'min-seeders', label: 'Release Sem Pares', br: true, dubbed: true, quality: 'unknown' },
        { id: 's3', reason: 'cached-only', label: 'Fora do Cache 2024', br: false },
      ],
    },
  };
}

test('/stream-trace.json: 503 sem token, 401 com token errado, 404 sem entrada, 200 com trace', async () => {
  await withMockFetch([], async () => {
    const semToken = await server.request('GET', '/stream-trace.json?type=movie&id=tt111');
    assert.equal(semToken.status, 503);

    config.jackett.testToken = 'tok-trace';
    try {
      const errado = await server.request('GET', '/stream-trace.json?type=movie&id=tt111', {
        headers: { 'X-Indexer-Test-Token': 'tok-errado' },
      });
      assert.equal(errado.status, 401);

      // Chave desconhecida: 404 com found:false, NUNCA 500. Com o knob de
      // recompute LIGADO, o bloco recompute é `attempted:true/no-material`.
      cache.clear();
      const semEntrada = await server.request('GET', '/stream-trace.json?type=movie&id=tt111', {
        headers: { 'X-Indexer-Test-Token': 'tok-trace' },
      });
      assert.equal(semEntrada.status, 404);
      assert.equal(semEntrada.json.ok, true);
      assert.equal(semEntrada.json.found, false);
      assert.equal(semEntrada.json.recompute?.attempted, true);
      assert.equal(semEntrada.json.recompute?.note, 'no-material');

      // N2 — com o recompute DESLIGADO, o 404 diz `attempted:false/disabled`
      // (nunca finge que tentou).
      const savedRecompute = config.search.streamTraceRecompute;
      config.search.streamTraceRecompute = false;
      try {
        const semEntradaOff = await server.request('GET', '/stream-trace.json?type=movie&id=tt111', {
          headers: { 'X-Indexer-Test-Token': 'tok-trace' },
        });
        assert.equal(semEntradaOff.status, 404);
        assert.equal(semEntradaOff.json.recompute?.attempted, false);
        assert.equal(semEntradaOff.json.recompute?.note, 'disabled');
      } finally {
        config.search.streamTraceRecompute = savedRecompute;
      }

      // Com entrada: 200 e o trace inteiro, SEM streams nem chave crua.
      cache.set(chaveGlobal('movie', 'tt111'), entrada(false), 900);
      const ok = await server.request('GET', '/stream-trace.json?type=movie&id=tt111', {
        headers: { 'X-Indexer-Test-Token': 'tok-trace' },
      });
      assert.equal(ok.status, 200);
      assert.equal(ok.json.ok, true);
      assert.equal(ok.json.found, true);
      assert.equal(ok.json.type, 'movie');
      assert.equal(ok.json.id, 'tt111');
      assert.equal(ok.json.cache.partial, false);
      assert.equal(ok.json.cache.debridKnown, true);
      assert.equal(ok.json.cache.stale, false);
      assert.ok(ok.json.cache.remainingS >= 0);
      assert.equal(ok.json.trace.items.length, 3);
      assert.equal(ok.json.trace.stages.raw, 4);
      assert.equal(ok.json.trace.items[2].reason, 'cached-only');
      // O corpo NUNCA leva a lista, a chave nem o hash do magnet: o trace é
      // o que há para ler — diagnóstico, não inventário.
      const corpo = ok.text;
      assert.ok(!corpo.includes(HASH), 'não pode vazar hash de magnet');
      assert.ok(!corpo.includes('Filme Qualquer'), 'payload não inclui os streams');
      assert.ok(!corpo.includes('streams:v10:'), 'payload não inclui a chave do cache');
      assert.ok(!corpo.includes('account:'), 'payload não inclui o escopo da chave');
    } finally {
      config.jackett.testToken = '';
      cache.clear();
    }
  });
});

test('/stream-trace.json: 400 para type e id inválidos', async () => {
  config.jackett.testToken = 'tok-trace';
  try {
    const semType = await server.request('GET', '/stream-trace.json?id=tt111', {
      headers: { 'X-Indexer-Test-Token': 'tok-trace' },
    });
    assert.equal(semType.status, 400);

    const typeRuim = await server.request('GET', '/stream-trace.json?type=anime&id=tt111', {
      headers: { 'X-Indexer-Test-Token': 'tok-trace' },
    });
    assert.equal(typeRuim.status, 400);

    const semId = await server.request('GET', '/stream-trace.json?type=movie', {
      headers: { 'X-Indexer-Test-Token': 'tok-trace' },
    });
    assert.equal(semId.status, 400);

    const idRuim = await server.request('GET', '/stream-trace.json?type=movie&id=12345', {
      headers: { 'X-Indexer-Test-Token': 'tok-trace' },
    });
    assert.equal(idRuim.status, 400);

    // Série COM episódio é aceita (mesma forma do id do stream request);
    // quatro segmentos não são.
    const serieOk = await server.request('GET', '/stream-trace.json?type=series&id=tt111%3A1%3A2', {
      headers: { 'X-Indexer-Test-Token': 'tok-trace' },
    });
    assert.equal(serieOk.status, 404); // id válido, entrada inexistente
    const serieRuim = await server.request('GET', '/stream-trace.json?type=series&id=tt111%3A1%3A2%3A3', {
      headers: { 'X-Indexer-Test-Token': 'tok-trace' },
    });
    assert.equal(serieRuim.status, 400);
  } finally {
    config.jackett.testToken = '';
    cache.clear();
  }
});

test('/stream-trace.json: entrada stale dentro da graça é servida (getWithStale, nunca peek)', async () => {
  await withMockFetch([], async () => {
    config.jackett.testToken = 'tok-trace';
    try {
      const id = 'tt222';
      const key = chaveGlobal('movie', id);
      // TTL de 50ms: em 120ms a entrada está expirada, mas DENTRO da janela
      // de graça (config.streamStaleGrace, 300s) — é exatamente o estado que
      // o SWR serve, e o endpoint tem que enxergar o mesmo.
      cache.set(key, entrada(true), 0.05);
      await new Promise((resolve) => setTimeout(resolve, 120));
      const res = await server.request('GET', `/stream-trace.json?type=movie&id=${id}`, {
        headers: { 'X-Indexer-Test-Token': 'tok-trace' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.cache.stale, true, 'entrada expirada na graça continua visível');
      assert.equal(res.json.cache.partial, true);
      assert.ok(res.json.trace);
    } finally {
      config.jackett.testToken = '';
      cache.clear();
    }
  });
});

test('/:userConfig/stream-trace.json deriva a MESMA chave que a busca do install', async () => {
  await withMockFetch([], async () => {
    config.jackett.testToken = 'tok-trace';
    try {
      // O segmento com m:3 muda as opts, e com elas a chave — gravar na chave
      // do segmento e ler pelo endpoint prova que a derivação bate.
      const segment = encodeConfig({ m: 3 });
      const id = 'tt333';
      const key = chaveDoSegmento('movie', id, segment);
      cache.set(key, entrada(false), 900);

      // A chave GLOBAL (sem segmento) é outra: sem o overlay, o endpoint não
      // pode encontrar a mesma entrada.
      const pelaGlobal = await server.request('GET', '/stream-trace.json?type=movie&id=' + id, {
        headers: { 'X-Indexer-Test-Token': 'tok-trace' },
      });
      assert.equal(pelaGlobal.status, 404, 'a chave global é outra entrada');

      const res = await server.request('GET', `/${segment}/stream-trace.json?type=movie&id=${id}`, {
        headers: { 'X-Indexer-Test-Token': 'tok-trace' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.found, true);
      assert.equal(res.json.trace.items.length, 3);
      // O segmento válido encontrou a MESMA entrada gravada por streamsCacheKey.
    } finally {
      config.jackett.testToken = '';
      cache.clear();
    }
  });
});

test('/stream-trace.json não faz chamada de rede nenhuma', async () => {
  config.jackett.testToken = 'tok-trace';
  try {
    const id = 'tt444';
    cache.set(chaveGlobal('movie', id), entrada(false), 900);
    const mock = createMockFetch([]);
    const originalFetch = global.fetch;
    global.fetch = mock as unknown as typeof globalThis.fetch;
    try {
      const res = await server.request('GET', '/stream-trace.json?type=movie&id=' + id, {
        headers: { 'X-Indexer-Test-Token': 'tok-trace' },
      });
      assert.equal(res.status, 200);
      assert.equal(mock.calls.length, 0, 'o endpoint lê o cache, não a rede');
    } finally {
      global.fetch = originalFetch;
    }
  } finally {
    config.jackett.testToken = '';
    cache.clear();
  }
});

test('/stream-trace.json: trace:null para entrada antiga sem o campo e com kill-switch desligado', async () => {
  await withMockFetch([], async () => {
    config.jackett.testToken = 'tok-trace';
    try {
      const id = 'tt555';
      // Entrada gravada antes do campo existir (deploy anterior).
      cache.set(chaveGlobal('movie', id), {
        streams: [{ name: 'Antiga\n1080p', infoHash: HASH }],
        partial: false,
        debridKnown: true,
      }, 900);
      const res = await server.request('GET', '/stream-trace.json?type=movie&id=' + id, {
        headers: { 'X-Indexer-Test-Token': 'tok-trace' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.trace, null, 'sem trace gravado, o endpoint devolve null');
    } finally {
      config.jackett.testToken = '';
      cache.clear();
    }
  });
});

test('/stream-trace.json: recompute sanitiza/trunca label antes de responder', async () => {
  await withMockFetch([], async () => {
    const savedIndexers = config.jackett.indexers;
    config.jackett.testToken = 'tok-trace';
    config.jackett.indexers = ['torrentleech'];
    try {
      const hash = 'a'.repeat(40);
      const sujo = `Filme 2020 ${hash} magnet:?xt=urn:btih:${hash}&dn=Filme [${hash}] ${'X'.repeat(200)}`;
      const rawKey = jackett.rawKeysFor(['torrentleech'], 'Filme 2020', 'movie')[0];
      cache.set(rawKey, [{ title: sujo, infoHash: 'f'.repeat(40), seeders: 4, indexer: 'x' }], 900);
      cache.set(chaveGlobal('movie', 'tt333'), {
        streams: [], partial: false, debridKnown: true,
        searchMeta: { names: ['Filme'], year: 2020 },
      }, 900);
      const res = await server.request('GET', '/stream-trace.json?type=movie&id=tt333', {
        headers: { 'X-Indexer-Test-Token': 'tok-trace' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.origin, 'recompute');
      const label = String(res.json.recompute?.items?.[0]?.label || '');
      assert.ok(label.length <= 60, `label passou do teto: ${label.length}`);
      const body = JSON.stringify(res.json);
      assert.doesNotMatch(body, /magnet:/i);
      assert.doesNotMatch(body, /[a-f0-9]{40}/i);
      assert.match(label, /<hash>/);
      assert.match(label, /<magnet>/);
    } finally {
      config.jackett.indexers = savedIndexers;
      config.jackett.testToken = '';
      cache.clear();
    }
  });
});
