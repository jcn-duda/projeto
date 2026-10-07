// Diagnóstico do card Mico (`mico-diag.ts` via `jackett.test` -> rota
// `/test-indexer.json`): o alvo pedido é o alvo consultado. `query` aqui é
// IMDb (`tt…` filme, `tt…:S:E` episódio), entrada inválida não consulta nem
// repara o circuito, e o coringa sem query fica intacto (compat "testar
// todos"). Inclui as métricas mínimas do Mico e o contrato da rota protegida.
// Nada aqui toca rede real.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import config from '../src/config.js';
config.seed.enabled = false;
import * as mico from '../src/providers/mico.js';
import * as micoDiag from '../src/providers/mico-diag.js';
import jackett from '../src/providers/jackett.js';
import { resetCatalogCache } from '../src/providers/jackett-catalog.js';
import { createApp } from '../src/app.js';
import { createTestServer } from './e2e/e2e-harness.js';
import * as metrics from '../src/utils/metrics.js';
import { stubFetch } from './helpers/stub.js';

const H1 = 'a'.repeat(40);
const ok = (streams: unknown[]) => ({ ok: true, status: 200, json: async () => ({ streams }) });
const http = (status: number) => ({ ok: false, status, json: async () => ({}) });

async function withMico<T>(fn: () => Promise<T>): Promise<T> {
  const saved = { enabled: config.mico.enabled };
  config.mico.enabled = true;
  mico._resetBreaker();
  try {
    return await fn();
  } finally {
    config.mico.enabled = saved.enabled;
    mico._resetBreaker();
  }
}

test('diagnóstico: consulta explícita respeita o IMDb do filme e o S:E da série', async () => {
  await withMico(async () => {
    const stub = stubFetch((url) => {
      if (url.includes('/stream/movie/tt0133093.json')) {
        return ok([
          { title: 'Matrix 1999 1080p Dublado 👥 4', infoHash: H1 },
          { title: 'Harley Quinn S01E01 1080p 👥 9', infoHash: 'b'.repeat(40) },
        ]);
      }
      if (url.includes('/stream/series/tt0944947:2:3.json')) return ok([]);
      return http(404);
    });
    try {
      const filme: any = await jackett.test('mico', 'tt0133093', 'movie');
      assert.equal(filme.ok, true);
      assert.equal(filme.query, 'tt0133093', 'o payload reporta o alvo exato');
      assert.equal(filme.type, 'movie');
      assert.equal(filme.results, 2, 'results é o BRUTO da fonte (lixo de outra obra incluído)');
      const serie: any = await jackett.test('mico', 'tt0944947:2:3', 'series');
      assert.equal(serie.ok, false);
      assert.equal(serie.error, undefined, 'vazio válido é SEM MAGNET, não erro');
      assert.equal(serie.query, 'tt0944947:2:3');
      assert.equal(serie.type, 'series');
      assert.equal(stub.calls.length, 2);
    } finally {
      stub.restore();
    }
  });
});

test('diagnóstico: entrada inválida devolve erro claro, não consulta e não repara o circuito', async () => {
  await withMico(async () => {
    let fail = true;
    const stub = stubFetch(() => (fail ? http(500) : ok([])));
    try {
      // Circuito aberto: o erro de entrada não pode ser confundido com reparo.
      for (let i = 0; i < config.mico.breakerFailures; i += 1) {
        await mico.search({ type: 'movie', imdbId: 'tt0000003' });
      }
      const calls = stub.calls.length;
      const casos: Array<[string, string, RegExp]> = [
        ['matrix', 'movie', /tt…/],
        ['nope:1:2:3', 'series', /tt…/],
        ['tt0944947', 'series', /tt…:S:E/],
        ['tt0944947:2', 'series', /tt…:S:E/],
        ['tt0944947:2:0', 'series', /positivo/],
        ['tt0944947:2:3', 'movie', /type=series/],
      ];
      for (const [q, type, re] of casos) {
        const diag: any = await micoDiag.test(q, type);
        assert.equal(diag.ok, false, q);
        assert.match(diag.error, re);
        assert.equal(diag.results, 0);
      }
      assert.equal(stub.calls.length, calls, 'entrada inválida não faz fetch');
      assert.deepEqual(await mico.search({ type: 'movie', imdbId: 'tt0000003' }), []);
      assert.equal(stub.calls.length, calls, 'erro de entrada não reparou o circuito aberto');
      fail = false;
      const bom: any = await jackett.test('mico', 'tt0944947:2:3', 'series');
      assert.equal(bom.error, undefined, 'consulta válida volta a medir');
    } finally {
      stub.restore();
    }
  });
});

test('diagnóstico: sem query mantém o coringa de filme (compat testar-todos e card)', async () => {
  await withMico(async () => {
    const stub = stubFetch((url) => {
      assert.match(url, /\/stream\/movie\/tt7286456\.json$/);
      return ok([{ title: 'Coringa 2019 1080p Dublado 👥 3', infoHash: H1 }]);
    });
    try {
      const direto: any = await micoDiag.test();
      assert.equal(direto.ok, true);
      assert.equal(direto.query, 'tt7286456');
      assert.equal(direto.type, 'movie');
      const viaJackett: any = await jackett.test('mico', '', 'movie');
      assert.equal(viaJackett.ok, true);
      assert.equal(viaJackett.query, 'tt7286456');
      // Sem alvo, o coringa é de filme MESMO com type=series — e o payload
      // reporta o tipo que REALMENTE foi consultado, não o pedido.
      const semAlvoSerie: any = await jackett.test('mico', '', 'series');
      assert.equal(semAlvoSerie.query, 'tt7286456');
      assert.equal(semAlvoSerie.type, 'movie');
      assert.equal(stub.calls.length, 3);
    } finally {
      stub.restore();
    }
  });
});

test('métricas: consulta/latência/itens sempre; relevante/descartado só com obra', async () => {
  await withMico(async () => {
    metrics.reset();
    const stub = stubFetch(() => ok([
      { title: 'Coringa 2019 1080p Dublado 👥 3', infoHash: H1 },
      { title: 'Harley Quinn S01E01 1080p 👥 9', infoHash: 'b'.repeat(40) },
    ]));
    const matchContext = { names: ['Joker', 'Coringa'], year: 2019, isSeries: false, season: null, episode: null } as any;
    try {
      await mico.search({ type: 'movie', imdbId: 'tt7286456' }, { matchContext });
      let snap = metrics.snapshot();
      assert.equal(snap.counters['mico.query'], 1);
      assert.equal(snap.counters['mico.items'], 2);
      assert.equal(snap.counters['mico.relevant'], 1);
      assert.equal(snap.counters['mico.discarded'], 1);
      assert.equal(snap.timers['mico.ms']?.count, 1);
      await mico.search({ type: 'movie', imdbId: 'tt7286456' });
      snap = metrics.snapshot();
      assert.equal(snap.counters['mico.query'], 2);
      assert.equal(snap.counters['mico.relevant'], 1, 'sem obra não mede relevância');
      assert.equal(snap.counters['mico.discarded'], 1);
    } finally {
      stub.restore();
      metrics.reset();
    }
  });
});

test('diagnóstico: S0:E1 (especiais) é consulta válida', async () => {
  await withMico(async () => {
    const stub = stubFetch((url) => {
      assert.match(url, /\/stream\/series\/tt0944947:0:1\.json$/);
      return ok([]);
    });
    try {
      const especiais: any = await jackett.test('mico', 'tt0944947:0:1', 'series');
      assert.equal(especiais.ok, false);
      assert.equal(especiais.error, undefined, 'S0 é temporada legítima, não entrada inválida');
      assert.equal(especiais.query, 'tt0944947:0:1');
      assert.equal(especiais.type, 'series');
      assert.equal(stub.calls.length, 1);
    } finally {
      stub.restore();
    }
  });
});

test('diagnóstico: falha da fonte (429/5xx/rede/timeout) é ERRO; 200 vazio é SEM MAGNET', async () => {
  await withMico(async () => {
    const seq: Array<() => any> = [];
    const stub = stubFetch(() => (seq.shift()?.() ?? ok([])));
    try {
      seq.push(() => http(500));
      const falha500: any = await jackett.test('mico', 'tt0133093', 'movie');
      assert.equal(falha500.ok, false);
      assert.match(falha500.error, /fonte do Mico falhou/);
      seq.push(() => http(429));
      const falha429: any = await jackett.test('mico', 'tt0133093', 'movie');
      assert.equal(falha429.ok, false);
      assert.match(falha429.error, /fonte do Mico falhou/);
      seq.push(() => { throw new Error('boom de rede'); });
      const rede: any = await jackett.test('mico', 'tt0133093', 'movie');
      assert.equal(rede.ok, false);
      assert.match(rede.error, /fonte do Mico falhou/);
      assert.doesNotMatch(rede.error, /boom/, 'erro sanitizado: texto cru de terceiro não vaza');
      // Timeout/abort: o dublê de fetch não honra `init.signal`, então simulamos
      // a rejeição que o AbortSignal.timeout produz no fetch real — o caminho
      // sob teste é o mesmo (rejeição no catch da busca → fail-open).
      seq.push(() => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')));
      const lenta: any = await jackett.test('mico', 'tt0133093', 'movie');
      assert.equal(lenta.ok, false);
      assert.match(lenta.error, /fonte do Mico falhou/);
      // 200 vazio: resposta válida sem magnet — SEM erro (estado 'empty' no painel).
      const vazio: any = await jackett.test('mico', 'tt0133093', 'movie');
      assert.equal(vazio.ok, false);
      assert.equal(vazio.error, undefined);
      assert.equal(stub.calls.length, 5, 'cada veredito veio de UMA medição real');
    } finally {
      stub.restore();
    }
  });
});

test('diagnóstico: fonte desativada é veredito explícito, sem fetch', async () => {
  const saved = config.mico.enabled;
  config.mico.enabled = false;
  const stub = stubFetch(() => ok([]));
  try {
    const comAlvo: any = await jackett.test('mico', 'tt0133093', 'movie');
    assert.equal(comAlvo.ok, false);
    assert.match(comAlvo.error, /desativada/);
    const semAlvo: any = await jackett.test('mico', '', 'movie');
    assert.match(semAlvo.error, /desativada/);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
    config.mico.enabled = saved;
  }
});

test('rota /test-indexer.json: id=mico respeita q/type (provider -> jackett -> rota)', async () => {
  await withMico(async () => {
    const savedToken = config.jackett.testToken;
    const savedKey = config.jackett.apiKey;
    config.jackett.testToken = 'tok-teste-mico';
    // Sem chave do Jackett o catálogo cai no fallback do .env e o card virtual
    // do Mico entra — é o caminho da rota sem rede ao Jackett.
    config.jackett.apiKey = '';
    resetCatalogCache();
    const { app } = createApp();
    const server = await createTestServer(app);
    const stub = stubFetch((url) => {
      if (url.includes('/stream/series/tt0944947:2:3.json')) {
        return ok([{ title: 'A Casa do Dragão S02E03 Dublado 👥 2', infoHash: H1 }]);
      }
      return http(404);
    });
    const headers = { 'X-Indexer-Test-Token': 'tok-teste-mico' };
    try {
      const serie = await server.request('GET', '/test-indexer.json?id=mico&q=tt0944947%3A2%3A3&type=series', { headers });
      assert.equal(serie.status, 200);
      assert.equal(serie.json.ok, true);
      assert.equal(serie.json.query, 'tt0944947:2:3');
      assert.equal(serie.json.type, 'series');

      const invalida = await server.request('GET', '/test-indexer.json?id=mico&q=matrix&type=movie', { headers });
      assert.equal(invalida.status, 200);
      assert.equal(invalida.json.ok, false);
      assert.match(invalida.json.error, /tt…/);

      const compat = await server.request('GET', '/test-indexer.json?id=mico&type=movie', { headers });
      assert.equal(compat.status, 200);
      assert.equal(compat.json.query, 'tt7286456');
      assert.equal(compat.json.type, 'movie');
      assert.equal(stub.calls.length, 2, 'entrada inválida não chegou à fonte');
    } finally {
      stub.restore();
      await server.close();
      config.jackett.testToken = savedToken;
      config.jackett.apiKey = savedKey;
      resetCatalogCache();
    }
  });
});
