// P5 Fase 1 — rota /stream-trace.json: leitura OFFLINE do ledger, mesmo
// padrão do app-routes.test.ts (createTestServer, gate, token no header).
//
// Desde o F4.2(c) o namespace `streams` é Rust-owned: NADA é gravado no L1 do
// Node, então o payload vem da PONTE administrativa do `streams.db`. O helper
// `createStreamsBridge` dubla exatamente as rotas que a produção usa
// (`/streams/trace`, `/streams/invalidate`, `/streams/clear`): o teste
// exercita o caminho real (ponte → fallback), não uma entrada inventada.
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
import { createTestServer, encodeConfig } from './e2e/e2e-harness.js';
import { createStreamsBridge, type BridgeEntry, type StreamsBridge } from './helpers/streams-bridge.js';

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

/** Entrada realista do `streams.db` com trace, no formato que o Rust grava. */
function entrada(parcial = false): Omit<BridgeEntry, 'type' | 'id'> {
  return {
    cache: { remainingS: 900, partial: parcial, debridKnown: true, stale: false },
    streams: [{ name: 'Filme Qualquer\n1080p ⚡', url: `https://x/resolve/${HASH}?sig=1` }],
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
  const semToken = await server.request('GET', '/stream-trace.json?type=movie&id=tt111');
  assert.equal(semToken.status, 503);

  const bridge = createStreamsBridge({ entries: [{ type: 'movie', id: 'tt111', ...entrada(false) }] });
  try {
    const errado = await server.request('GET', '/stream-trace.json?type=movie&id=tt111', {
      headers: { 'X-Indexer-Test-Token': 'tok-errado' },
    });
    assert.equal(errado.status, 401);

    // Obra ausente NOS DOIS lados: 404 com found:false, NUNCA 500. Com o knob
    // de recompute LIGADO, o bloco recompute é `attempted:true/no-material`.
    const semEntrada = await server.request('GET', '/stream-trace.json?type=movie&id=tt999', {
      headers: { 'X-Indexer-Test-Token': bridge.token },
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
      const semEntradaOff = await server.request('GET', '/stream-trace.json?type=movie&id=tt999', {
        headers: { 'X-Indexer-Test-Token': bridge.token },
      });
      assert.equal(semEntradaOff.status, 404);
      assert.equal(semEntradaOff.json.recompute?.attempted, false);
      assert.equal(semEntradaOff.json.recompute?.note, 'disabled');
    } finally {
      config.search.streamTraceRecompute = savedRecompute;
    }

    // Com entrada no store nativo: 200 e o trace inteiro, SEM streams nem chave.
    const ok = await server.request('GET', '/stream-trace.json?type=movie&id=tt111', {
      headers: { 'X-Indexer-Test-Token': bridge.token },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ok, true);
    assert.equal(ok.json.found, true);
    assert.equal(ok.json.origin, 'cached');
    assert.equal(ok.json.source, 'rust');
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
    assert.ok(!corpo.includes('streams:v21:'), 'payload não inclui a chave do cache');
    assert.ok(!corpo.includes('account:'), 'payload não inclui o escopo da chave');
  } finally {
    bridge.restore();
    cache.clear();
  }
});

test('/stream-trace.json: 400 para type e id inválidos', async () => {
  const bridge = createStreamsBridge();
  try {
    const semType = await server.request('GET', '/stream-trace.json?id=tt111', {
      headers: { 'X-Indexer-Test-Token': bridge.token },
    });
    assert.equal(semType.status, 400);

    const typeRuim = await server.request('GET', '/stream-trace.json?type=anime&id=tt111', {
      headers: { 'X-Indexer-Test-Token': bridge.token },
    });
    assert.equal(typeRuim.status, 400);

    const semId = await server.request('GET', '/stream-trace.json?type=movie', {
      headers: { 'X-Indexer-Test-Token': bridge.token },
    });
    assert.equal(semId.status, 400);

    const idRuim = await server.request('GET', '/stream-trace.json?type=movie&id=12345', {
      headers: { 'X-Indexer-Test-Token': bridge.token },
    });
    assert.equal(idRuim.status, 400);

    // Série COM episódio é aceita (mesma forma do id do stream request);
    // quatro segmentos não são.
    const serieOk = await server.request('GET', '/stream-trace.json?type=series&id=tt111%3A1%3A2', {
      headers: { 'X-Indexer-Test-Token': bridge.token },
    });
    assert.equal(serieOk.status, 404); // id válido, entrada inexistente
    const serieRuim = await server.request('GET', '/stream-trace.json?type=series&id=tt111%3A1%3A2%3A3', {
      headers: { 'X-Indexer-Test-Token': bridge.token },
    });
    assert.equal(serieRuim.status, 400);
  } finally {
    bridge.restore();
    cache.clear();
  }
});

test('/stream-trace.json: entrada stale dentro da graça é servida pelo estado do store nativo', async () => {
  const bridge = createStreamsBridge({
    entries: [
      { type: 'movie', id: 'tt222', ...entrada(true), cache: { remainingS: 12, partial: true, debridKnown: true, stale: true } },
    ],
  });
  try {
    const res = await server.request('GET', '/stream-trace.json?type=movie&id=tt222', {
      headers: { 'X-Indexer-Test-Token': bridge.token },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.cache.stale, true, 'expirada na graça continua visível');
    assert.equal(res.json.cache.partial, true);
    assert.ok(res.json.trace);
  } finally {
    bridge.restore();
    cache.clear();
  }
});

test('/:userConfig/stream-trace.json deriva a MESMA chave que a busca do install', async () => {
  // O segmento com m:3 muda as opts, e com elas a chave: gravar a entrada com
  // a chave EXATA do segmento prova que a derivação da rota bate com a da busca.
  const segment = encodeConfig({ m: 3 });
  const id = 'tt333';
  const key = chaveDoSegmento('movie', id, segment);
  const bridge = createStreamsBridge({
    entries: [{ type: 'movie', id, key, ...entrada(false) }],
  });
  try {
    // A rota GLOBAL é a visão do operador: sem conhecer o segmento selado, o
    // fallback por obra do Rust encontra a build mais recente em qualquer escopo.
    const pelaGlobal = await server.request('GET', '/stream-trace.json?type=movie&id=' + id, {
      headers: { 'X-Indexer-Test-Token': bridge.token },
    });
    assert.equal(pelaGlobal.status, 200);
    assert.equal(pelaGlobal.json.found, true);
    assert.equal(pelaGlobal.json.trace.items.length, 3);

    const res = await server.request('GET', `/${segment}/stream-trace.json?type=movie&id=${id}`, {
      headers: { 'X-Indexer-Test-Token': bridge.token },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.found, true);
    assert.equal(res.json.trace.items.length, 3);
    // As duas leituras foram à ponte; a segunda acertou a chave exata.
    assert.equal(bridge.count('/streams/trace'), 2);
  } finally {
    bridge.restore();
    cache.clear();
  }
});

test('/stream-trace.json sem segmento escolhe o escopo mais recente da obra', async () => {
  const id = 'tt334';
  const antigo = entrada(false);
  antigo.trace = { ...(antigo.trace as object), finishedAt: Date.now() - 10_000, stages: { raw: 4, afterSort: 3, final: 1 } };
  const novo = entrada(false);
  novo.trace = { ...(novo.trace as object), finishedAt: Date.now(), stages: { raw: 9, afterSort: 8, final: 7 } };
  const bridge = createStreamsBridge({
    entries: [
      { type: 'movie', id, key: chaveDoSegmento('movie', id, encodeConfig({ m: 3 })), ...antigo },
      { type: 'movie', id, key: chaveDoSegmento('movie', id, encodeConfig({ m: 7 })), ...novo },
    ],
  });
  try {
    const res = await server.request('GET', `/stream-trace.json?type=movie&id=${id}`, {
      headers: { 'X-Indexer-Test-Token': bridge.token },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.trace.stages.final, 7);
  } finally {
    bridge.restore();
    cache.clear();
  }
});

test('/stream-trace.json só fala com a ponte administrativa (nenhum provedor)', async () => {
  const bridge = createStreamsBridge({
    entries: [{ type: 'movie', id: 'tt444', key: chaveGlobal('movie', 'tt444'), ...entrada(false) }],
  });
  try {
    const res = await server.request('GET', '/stream-trace.json?type=movie&id=tt444', {
      headers: { 'X-Indexer-Test-Token': bridge.token },
    });
    assert.equal(res.status, 200);
    // Qualquer URL fora da ponte estoura dentro do dublê: se a rota tocasse um
    // provedor, o teste falharia aqui em vez de "passar" com corpo fake.
    assert.equal(bridge.calls.length, 1, 'a rota lê o store nativo, não a rede de provedores');
    assert.equal(bridge.count('/streams/trace'), 1);
  } finally {
    bridge.restore();
    cache.clear();
  }
});

test('/stream-trace.json: trace:null na entrada sem o campo, sem recompute sem searchMeta', async () => {
  const bridge = createStreamsBridge({
    entries: [{
      type: 'movie',
      id: 'tt555',
      cache: { partial: false, debridKnown: true },
      streams: [{ name: 'Antiga\n1080p', infoHash: HASH }],
    }],
  });
  try {
    const res = await server.request('GET', '/stream-trace.json?type=movie&id=tt555', {
      headers: { 'X-Indexer-Test-Token': bridge.token },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.trace, null, 'sem trace gravado, o endpoint devolve null');
    // Sem searchMeta não há nomes/ano: o recompute não tem o que dizer.
    assert.equal(res.json.origin, 'cached');
    assert.equal(res.json.recompute, null);
  } finally {
    bridge.restore();
    cache.clear();
  }
});

test('/stream-trace.json: resumo do Chupim (Fase 7) sai no payload e é compatível com entrada antiga', async () => {
  const comChupim = entrada(false);
  (comChupim.trace as any).chupim = 'pool=seeds; seeds=blocked:dubbed-only; probe=pending';
  const bridge = createStreamsBridge({
    entries: [
      { type: 'movie', id: 'tt777', ...comChupim },
      { type: 'movie', id: 'tt778', ...entrada(false) },
    ],
  });
  try {
    const res = await server.request('GET', '/stream-trace.json?type=movie&id=tt777', {
      headers: { 'X-Indexer-Test-Token': bridge.token },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.trace.chupim, 'pool=seeds; seeds=blocked:dubbed-only; probe=pending');
    assert.equal(res.text.includes('dubbed-only'), true);
    assert.doesNotMatch(res.text, /[a-f0-9]{40}/i, 'resumo não vaza hash');

    // Entrada gravada antes do campo existir: segue servindo e sem chupim.
    const res2 = await server.request('GET', '/stream-trace.json?type=movie&id=tt778', {
      headers: { 'X-Indexer-Test-Token': bridge.token },
    });
    assert.equal(res2.status, 200);
    assert.equal('chupim' in (res2.json.trace || {}), false, 'compat: campo ausente na antiga');

    // Kill-switch desligado: o trace inteiro (e o chupim) não sai.
    const saved = config.search.streamTrace;
    config.search.streamTrace = false;
    try {
      const res3 = await server.request('GET', '/stream-trace.json?type=movie&id=tt777', {
        headers: { 'X-Indexer-Test-Token': bridge.token },
      });
      assert.equal(res3.status, 200);
      assert.equal(res3.json.trace, null);
    } finally {
      config.search.streamTrace = saved;
    }
  } finally {
    bridge.restore();
    cache.clear();
  }
});

test('/stream-trace.json: ramo NATIVO sem trace repassa o recompute do gateway', async () => {
  // 4.2(b): o recompute offline é NATIVO — o gateway recomputa found-sem-ledger
  // a partir da matéria quente DELE (instalação extraída da própria chave) e
  // devolve o outcome pronto. Os CAMPOS do outcome (label sanitizada com
  // `<hash>`/`<magnet>`, basis, teto de 300, estados) são provados pelos
  // testes Rust do `trace_recompute`; aqui a rota prova o REPASSE fiel.
  const bridge = createStreamsBridge({
    entries: [{
      type: 'movie',
      id: 'tt333',
      cache: { partial: false, debridKnown: true },
      searchMeta: { names: ['Filme'], year: 2020 },
      trace: null,
      recompute: {
        attempted: true,
        basis: ['raw'],
        built: true,
        builtAt: 1_700_000_000_000,
        note: null,
        items: [{ id: 'r1', label: '<hash> Filme <magnet>', br: true, now: { state: 'tocável' } }],
      },
      streams: [],
    }],
  });
  try {
    const res = await server.request('GET', '/stream-trace.json?type=movie&id=tt333', {
      headers: { 'X-Indexer-Test-Token': bridge.token },
    });
    assert.equal(res.status, 200);
    // O ledger continua null; o origin aponta o recompute (repasse fiel).
    assert.equal(res.json.origin, 'recompute');
    assert.equal(res.json.trace, null);
    assert.equal(res.json.recompute?.built, true);
    assert.deepEqual(res.json.recompute?.basis, ['raw']);
    const label = String(res.json.recompute?.items?.[0]?.label || '');
    assert.ok(label.length <= 60, `label passou do teto: ${label.length}`);
    const body = JSON.stringify(res.json);
    assert.doesNotMatch(body, /magnet:/i);
    assert.doesNotMatch(body, /[a-f0-9]{40}/i);
    assert.match(label, /<hash>/);
    assert.match(label, /<magnet>/);
  } finally {
    bridge.restore();
    cache.clear();
  }
});
