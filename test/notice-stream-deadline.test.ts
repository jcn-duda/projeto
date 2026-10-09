// Aviso de deadline: busca que estoura o prazo devolve o quarto texto
// ("Procurando fontes") em vez de lista vazia — e o kill-switch restaura
// o fallback. Extraído de test/notice-stream.test.ts (teto 400 linhas).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findStreams } from '../src/providers/index.js';
import * as runtime from '../src/runtime.js';
import config from '../src/config.js';

// --- Aviso de deadline: busca que estoura o prazo devolve o quarto texto ---

const sleep = (ms: any) => new Promise((resolve) => setTimeout(resolve, ms));

// Sem rede de verdade (mesmo padrão do swr-streams): o stub atrasa o bastante
// para o deadline de 1 ms vencer a coleta sempre. Sem ele, o doSearch em
// background tocaria Cinemeta/TMDB reais a cada execução da suíte.
const STUB_DELAY_MS = 200;
const realFetch = global.fetch;
function installFetchStub() {
  global.fetch = async () => {
    await sleep(STUB_DELAY_MS);
    return new Response('', { status: 404, statusText: 'Not Found' });
  };
}

/**
 * Contexto de requisição para teste de deadline: provider demo (sem Jackett),
 * sem debrid, fetch stub que nunca resolve rápido o suficiente para o prazo
 * mínimo. Usa id único para não dividir cacheKey nem inFlight com vizinhos.
 */
function deadlineRequest(fn: () => unknown): Promise<any> {
  const testOpts = {
    ...runtime.defaults(),
    providers: ['demo'],
    debridService: '',
    debridApiKey: '',
  };
  return runtime.run({ opts: testOpts, encoded: 'deadlinetest' }, fn) as Promise<any>;
}

test('série que estoura o prazo devolve aviso "Procurando fontes"', async () => {
  const originalDeadline = config.replyDeadline;
  // 1 ms: o timer dispara antes de qualquer rede responder. O fetch stub do
  // swr-streams serve como referência — aqui basta o prazo mínimo.
  config.replyDeadline = 1;
  const id = `tt${Date.now()}1`;
  installFetchStub();
  try {
    const result = await deadlineRequest(() => findStreams({ type: 'series', id }));
    assert.equal(result.partial, true, 'deve ser parcial');
    assert.equal(result.streams.length, 1, 'deve ter 1 aviso');
    assert.equal(result.streams[0].notice, true);
    assert.match(result.streams[0].name, /Procurando fontes/);
    // O link vem do applyNoticeOrigin na resposta, não do fallback.
    assert.equal(result.streams[0].externalUrl, undefined);
    assert.equal(result.streams[0].url, undefined);
    assert.equal(result.streams[0].infoHash, undefined);
    // Deixa o doSearch em background assentar com o stub ainda no ar.
    await sleep(STUB_DELAY_MS * 2);
  } finally {
    config.replyDeadline = originalDeadline;
    global.fetch = realFetch;
  }
});

test('filme que estoura o prazo também devolve o aviso de deadline', async () => {
  const originalDeadline = config.replyDeadline;
  config.replyDeadline = 1;
  const id = `tt${Date.now()}2`;
  installFetchStub();
  try {
    const result = await deadlineRequest(() => findStreams({ type: 'movie', id }));
    assert.equal(result.partial, true);
    assert.equal(result.streams.length, 1);
    assert.match(result.streams[0].name, /Procurando fontes/);
    assert.equal(result.streams[0].notice, true);
    await sleep(STUB_DELAY_MS * 2);
  } finally {
    config.replyDeadline = originalDeadline;
    global.fetch = realFetch;
  }
});

test('kill-switch SEARCH_NOTICE_STREAM=false restaura fallback vazio no deadline', async () => {
  const originalDeadline = config.replyDeadline;
  const originalNotice = config.search.noticeStream;
  config.replyDeadline = 1;
  config.search.noticeStream = false;
  const id = `tt${Date.now()}3`;
  installFetchStub();
  try {
    const result = await deadlineRequest(() => findStreams({ type: 'series', id }));
    assert.equal(result.partial, true);
    assert.deepEqual(result.streams, [], 'kill-switch deve devolver lista vazia');
    await sleep(STUB_DELAY_MS * 2);
  } finally {
    config.replyDeadline = originalDeadline;
    config.search.noticeStream = originalNotice;
    global.fetch = realFetch;
  }
});
