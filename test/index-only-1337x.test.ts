// 1337x vira index-only: fora do caminho da resposta (mesmo selecionado na
// config do usuário), fora das varreduras pt-BR, com a resolução /dl
// preservada e orçamento TOTAL dedicado no colhedor. Medição que motivou:
// busca fria de 12,2–19s (Cloudflare re-resolvido) e redirect /dl/ de
// 1,8–6,5s contra orçamento de 4s por indexer.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import config from '../src/config.js';
import { liveIndexers, ptSweepIndexers } from '../src/providers/search-plan.js';
import * as metrics from '../src/utils/metrics.js';
import * as cache from '../src/utils/cache.js';
import * as runtime from '../src/runtime.js';
import { findStreams } from '../src/providers/index.js';

test('default JACKETT_INDEX_ONLY_INDEXERS inclui 1337x', () => {
  assert.ok(config.jackett.indexOnlyIndexers.includes('1337x'), '1337x é index-only por default');
});

test('a resolução /dl do 1337x permanece em JACKETT_RESOLVE_DOWNLOAD_INDEXERS', () => {
  assert.ok(
    config.jackett.resolveDownloadIndexers.includes('1337x'),
    'o magnet do 1337x continua resolvendo no play/colhedor',
  );
});

test('default do orçamento dedicado do colhedor é 35000ms', () => {
  assert.equal(config.jackett.indexOnlyHarvestTimeout, 35000);
});

test('liveIndexers remove o 1337x do plano ao vivo mesmo quando o usuário o seleciona', () => {
  const selecionados = ['thepiratebay', '1337x', 'bludv-cardigann'];
  const vivos = liveIndexers(selecionados, config.jackett.indexOnlyIndexers);
  assert.ok(!vivos.includes('1337x'), '1337x fica fora da resposta');
  assert.deepEqual(vivos, ['thepiratebay', 'bludv-cardigann'], 'os demais seguem no plano');
  // Todos index-only: nenhum indexer vivo — e o caller NÃO reabre o /all.
  assert.deepEqual(liveIndexers(['1337x'], config.jackett.indexOnlyIndexers), []);
});

test('ptSweepIndexers exclui index-only (mesmo filtro da varredura tardia e do colhedor)', () => {
  const alvos = ptSweepIndexers(
    ['thepiratebay', '1337x', 'bludv-cardigann'],
    ['bludv-cardigann'],
    config.jackett.indexOnlyIndexers,
  );
  assert.deepEqual(alvos, ['thepiratebay'], 'só o global elegível resta');
  // Chamada antiga (sem o 3º parâmetro) preservada.
  assert.deepEqual(
    ptSweepIndexers(['thepiratebay', '1337x'], ['bludv-cardigann']),
    ['thepiratebay', '1337x'],
  );
});

// Integração: busca com o usuário selecionando APENAS o 1337x não reabre o
// agregado /all do Jackett — cair no /all reabriria a porta que o filtro
// index-only acabou de fechar (e o /all responde no ritmo do indexer mais
// lento, exatamente o que se quer isolar).
test('todos index-only selecionados: nenhuma consulta Jackett, sem fallback /all', async () => {
  cache.clear();
  metrics.reset();
  const realFetch = globalThis.fetch;
  const chamadas: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    chamadas.push(url);
    if (url.includes('cinemeta')) {
      return new Response(JSON.stringify({ meta: { name: 'Big Buck Bunny', year: '2008', type: 'movie' } }), { status: 200 });
    }
    if (url.includes('themoviedb.org')) {
      return new Response(JSON.stringify({ movie_results: [] }), { status: 404 });
    }
    return new Response('', { status: 404 });
  }) as typeof globalThis.fetch;
  try {
    await runtime.run(
      {
        opts: { ...runtime.normalize(null), providers: ['jackett'], jackettIndexers: ['1337x'] },
        encoded: 'idxonly-1337x-all',
      },
      () => findStreams({ type: 'movie', id: 'tt1254207' }),
    );
    const jackettCalls = chamadas.filter((u) => u.includes('/api/v2.0/indexers/'));
    assert.equal(jackettCalls.length, 0, 'nenhuma consulta Jackett na busca ao vivo');
    const counter = metrics.snapshot().counters['search.indexonly.all'] || 0;
    assert.equal(counter, 1, 'a obra segue para o colhedor pelo caminho de sempre');
  } finally {
    globalThis.fetch = realFetch;
    cache.clear();
    metrics.reset();
  }
});
