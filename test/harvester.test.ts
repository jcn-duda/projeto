// Colhedor (Fase 4): fila persistente de obras, dedupe por obra+razão, teto de
// fila e freio de atividade em janela deslizante. Os dois primeiros testes
// rodam o ciclo de verdade (tick exportado para isso, sem rede); em produção
// quem o chama é o setInterval do start(), nunca o caminho da resposta.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import * as cache from '../src/utils/cache.js';
import config from '../src/config.js';
import { prefix } from '../src/utils/cache-keys.js';
import harvester from '../src/providers/harvester.js';
import * as activity from '../src/providers/activity.js';
import { stubFetch } from './helpers/stub.js';
import { ptSweepQueryFor } from '../src/providers/search-plan.js';

test('teto horário conta as consultas e trava o ciclo seguinte', async () => {
  // Precisa ser o PRIMEIRO do arquivo: o tick consome a fila do módulo, que
  // começa vazia. Sem rede — JACKETT_API_KEY vazia faz cada jackett.search
  // devolver [] na hora e o meta entra pelo cache. O que se cobra é a
  // CONTABILIDADE do teto, não a consulta em si.
  const saved = {
    maxPerHour: config.harvest.maxPerHour,
    idleWindowMs: config.harvest.idleWindowMs,
    indexerDelayMs: config.harvest.indexerDelayMs,
    indexers: config.jackett.indexers,
    apiKey: config.jackett.apiKey,
  };
  try {
    config.harvest.maxPerHour = 2;
    // Janela 0: tráfego notado por outro teste nunca trava este ciclo.
    config.harvest.idleWindowMs = 0;
    config.harvest.indexerDelayMs = 0;
    config.jackett.indexers = ['fake-a', 'fake-b', 'fake-c'];
    config.jackett.apiKey = '';
    cache.set('meta:movie:tt9500009', { name: 'Harvest Cap Movie', year: '2024', type: 'movie' }, 3600);

    harvester.enqueue({ imdbId: 'tt9500009', type: 'movie', reason: 'miss' } as any);
    await harvester.tick();

    // 3 indexers, teto 2: o loop para no terceiro e as 2 consultas ficam
    // anotadas na hora corrente (sem a anotação, queriesThisHour era 0 para
    // sempre e nenhuma hora travava).
    let st: any = harvester.status();
    assert.equal(st.queriesThisHour, 2, 'consultas da obra ficam anotadas na hora');
    // Cortada no meio pelo teto, a obra NÃO é dada por colhida: volta para a
    // fila. Antes ela era descartada com cobertura parcial e o índice ficava
    // com um registro incompleto que já contava como cobertura na busca.
    assert.equal(st.queueDepth, 1, 'obra cortada pelo teto volta para a fila');

    // Ciclo seguinte: teto já alcançado — nenhuma obra sai da fila.
    harvester.enqueue({ imdbId: 'tt9500010', type: 'movie', reason: 'miss' } as any);
    await harvester.tick();
    st = harvester.status();
    assert.equal(st.queueDepth, 2, 'teto atingido segura as obras na fila');
    assert.equal(st.queriesThisHour, 2, 'nenhuma consulta nova além do teto');
  } finally {
    config.harvest.maxPerHour = saved.maxPerHour;
    config.harvest.idleWindowMs = saved.idleWindowMs;
    config.harvest.indexerDelayMs = saved.indexerDelayMs;
    config.jackett.indexers = saved.indexers;
    config.jackett.apiKey = saved.apiKey;
  }
});

test('colhedor roda a varredura pt-BR nos globais, como a busca ao vivo', async () => {
  // O dublado titulado em PT mora em tracker global e a query em inglês não
  // o encontra: o colhedor que só copiasse a query principal alimentaria um
  // índice cego para essas releases. Aqui a varredura é cobrada com a MESMA
  // raiz (franchiseRoot) do caminho ao vivo — e provada fora do indexer BR.
  const saved = {
    maxPerHour: config.harvest.maxPerHour,
    idleWindowMs: config.harvest.idleWindowMs,
    indexerDelayMs: config.harvest.indexerDelayMs,
    indexers: config.jackett.indexers,
    apiKey: config.jackett.apiKey,
    ptBrIndexers: config.jackett.ptBrIndexers,
    tmdbApiKey: config.tmdb.apiKey,
  };
  const stub = stubFetch((url: string) => {
    if (url.includes('api.themoviedb.org')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          movie_results: [
            {
              title: 'Star Wars: O Ataque dos Clones',
              original_title: 'Star Wars: Episode II - Attack of the Clones',
              release_date: '2002-05-16',
            },
          ],
        }),
      };
    }
    if (url.includes('/api/v2.0/indexers/')) return { ok: true, status: 200, json: async () => ({ Results: [] }) };
    // Cinemeta (e qualquer outra rede): erro rápido — obra de drenagem
    // desiste antes de consultar indexer nenhum.
    return { ok: false, status: 404, json: async () => ({}) };
  });
  try {
    config.harvest.maxPerHour = 100;
    config.harvest.idleWindowMs = 0;
    config.harvest.indexerDelayMs = 0;
    config.jackett.indexers = ['glob-a', 'glob-b', 'br-x'];
    config.jackett.ptBrIndexers = ['br-x'];
    config.tmdb.apiKey = 'chave-de-teste';

    // Drena obras deixadas por outros testes SEM rede de Jackett (apiKey
    // vazia devolve [] na hora); o cinemeta 404 do dublê as faz desistir.
    config.jackett.apiKey = '';
    let guard = 0;
    while ((harvester.status() as any).queueDepth > 0 && guard++ < 250) await harvester.tick();

    cache.set(
      'meta:movie:tt9500011',
      { name: 'Star Wars: Episode II - Attack of the Clones', year: '2002', type: 'movie' },
      3600,
    );
    config.jackett.apiKey = 'chave-de-teste';
    harvester.enqueue({ imdbId: 'tt9500011', type: 'movie', reason: 'miss' } as any);
    await harvester.tick();

    const jacketUrls = stub.calls.map((c) => c.url).filter((u) => u.includes('/api/v2.0/indexers/'));
    assert.ok(jacketUrls.length > 0, 'consultou o Jackett');
    const expectedSweep = ptSweepQueryFor({
      titles: { pt: 'Star Wars: O Ataque dos Clones', original: 'Star Wars: Episode II - Attack of the Clones' },
    });
    assert.ok(expectedSweep, 'sanidade: há raiz pt para o título');
    const qOf = (u: string) => {
      try {
        return new URL(u).searchParams.get('Query') || '';
      } catch {
        return '';
      }
    };
    const queries = jacketUrls.map(qOf);
    assert.ok(
      queries.includes(expectedSweep),
      `varredura rodou com a raiz pt (${expectedSweep}); recebido: ${JSON.stringify(queries)}`,
    );
    const sweepUrls = jacketUrls.filter((u) => qOf(u) === expectedSweep);
    assert.ok(sweepUrls.length > 0, 'varredura consultou os globais');
    assert.ok(
      sweepUrls.every((u) => !u.includes('/indexers/br-x/')),
      'varredura pula os indexers BR (eles já recebem o título pt no loop)',
    );
    assert.equal((harvester.status() as any).queriesThisHour >= 1, true, 'consultas anotadas no teto');
  } finally {
    stub.restore();
    config.harvest.maxPerHour = saved.maxPerHour;
    config.harvest.idleWindowMs = saved.idleWindowMs;
    config.harvest.indexerDelayMs = saved.indexerDelayMs;
    config.jackett.indexers = saved.indexers;
    config.jackett.apiKey = saved.apiKey;
    config.jackett.ptBrIndexers = saved.ptBrIndexers;
    config.tmdb.apiKey = saved.tmdbApiKey;
  }
});

test('enqueue deduplica por obra+temporada+episódio', () => {
  harvester.enqueue({ imdbId: 'tt9500001', type: 'movie', reason: 'miss' } as any);
  harvester.enqueue({ imdbId: 'tt9500001', type: 'movie', reason: 'miss' } as any);
  const depth = (harvester.status() as any).queueDepth;
  // Outras entradas de outros testes podem existir; o que não pode é dobrar.
  const st = harvester.status() as any;
  assert.equal(st.queueDepth, depth);
});

test('fila persiste na chave harvest:v1:q', () => {
  harvester.enqueue({ imdbId: 'tt9500002', type: 'series', season: 1, episode: 2, reason: 'next-episode' } as any);
  const stored = cache.get(`${prefix('harvest')}q`) as any[];
  assert.ok(Array.isArray(stored));
  assert.ok(stored.some((e) => e.imdbId === 'tt9500002'));
});

test('teto da fila descarta a mais antiga', () => {
  const originalMax = config.harvest.queueMax;
  try {
    config.harvest.queueMax = 2;
    // Razões distintas contornam o dedupe de 12h.
    harvester.enqueue({ imdbId: 'tt9500003', type: 'movie', reason: `miss-${Date.now()}-a` } as any);
    harvester.enqueue({ imdbId: 'tt9500004', type: 'movie', reason: `miss-${Date.now()}-b` } as any);
    harvester.enqueue({ imdbId: 'tt9500005', type: 'movie', reason: `miss-${Date.now()}-c` } as any);
    const stored = cache.get(`${prefix('harvest')}q`) as any[];
    assert.equal(stored.length, 2, 'nunca passa do teto');
    assert.ok(!stored.some((e) => e.imdbId === 'tt9500003'), 'a mais antiga sai');
  } finally {
    config.harvest.queueMax = originalMax;
  }
});

test('HARVEST_ENABLED=false desliga o enqueue', () => {
  const original = config.harvest.enabled;
  try {
    config.harvest.enabled = false;
    const before = (harvester.status() as any).queueDepth;
    harvester.enqueue({ imdbId: 'tt9500006', type: 'movie', reason: `miss-off-${Date.now()}` } as any);
    assert.equal((harvester.status() as any).queueDepth, before);
  } finally {
    config.harvest.enabled = original;
  }
});

test('consulta com falha no Jackett conta no teto horário', async () => {
  const saved = {
    maxPerHour: config.harvest.maxPerHour,
    idleWindowMs: config.harvest.idleWindowMs,
    indexerDelayMs: config.harvest.indexerDelayMs,
    indexers: config.jackett.indexers,
    apiKey: config.jackett.apiKey,
    tmdbApiKey: config.tmdb.apiKey,
  };
  const stub = stubFetch((url: string) => {
    if (url.includes('/api/v2.0/indexers/')) {
      return { ok: false, status: 500, json: async () => ({}) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  try {
    config.harvest.maxPerHour = 50;
    config.harvest.idleWindowMs = 0;
    config.harvest.indexerDelayMs = 0;
    config.jackett.indexers = ['fail-idx-1', 'fail-idx-2'];
    config.jackett.apiKey = 'fake-key';
    cache.set('meta:movie:tt9500050', { name: 'Fail Harvest Movie', year: '2024', type: 'movie' }, 3600);

    const before = (harvester.status() as any).queriesThisHour;
    harvester.enqueue({ imdbId: 'tt9500050', type: 'movie', reason: `miss-${Date.now()}` } as any);
    await harvester.tick();

    const after = (harvester.status() as any).queriesThisHour;
    assert.equal(after - before, 2, '2 consultas falhas foram debitadas do teto horário');
  } finally {
    stub.restore();
    config.harvest.maxPerHour = saved.maxPerHour;
    config.harvest.idleWindowMs = saved.idleWindowMs;
    config.harvest.indexerDelayMs = saved.indexerDelayMs;
    config.jackett.indexers = saved.indexers;
    config.jackett.apiKey = saved.apiKey;
    config.tmdb.apiKey = saved.tmdbApiKey;
  }
});

test('varredura pt NÃO roda quando estouraria o teto horário', async () => {
  const saved = {
    maxPerHour: config.harvest.maxPerHour,
    idleWindowMs: config.harvest.idleWindowMs,
    indexerDelayMs: config.harvest.indexerDelayMs,
    indexers: config.jackett.indexers,
    ptBrIndexers: config.jackett.ptBrIndexers,
    apiKey: config.jackett.apiKey,
    tmdbApiKey: config.tmdb.apiKey,
  };
  const stub = stubFetch((url: string) => {
    if (url.includes('api.themoviedb.org')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          movie_results: [
            {
              title: 'Star Wars: O Ataque dos Clones',
              original_title: 'Star Wars: Episode II - Attack of the Clones',
              release_date: '2002-05-16',
            },
          ],
        }),
      };
    }
    if (url.includes('/api/v2.0/indexers/')) {
      return { ok: true, status: 200, json: async () => ({ Results: [] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  try {
    // 2 indexers globais no loop + 2 na varredura = 4 necessários.
    // Com maxPerHour = (já usado + 2), o loop gasta 2 e a varredura não cabe.
    config.harvest.idleWindowMs = 0;
    config.harvest.indexerDelayMs = 0;
    config.jackett.indexers = ['glob-1', 'glob-2'];
    config.jackett.ptBrIndexers = [];
    config.jackett.apiKey = 'fake-key';
    config.tmdb.apiKey = 'fake-key';
    const before = (harvester.status() as any).queriesThisHour;
    config.harvest.maxPerHour = before + 2;

    cache.set('meta:movie:tt9500051', { name: 'Star Wars: Episode II', year: '2002', type: 'movie' }, 3600);
    harvester.enqueue({ imdbId: 'tt9500051', type: 'movie', reason: `miss-${Date.now()}` } as any);
    await harvester.tick();

    const expectedSweep = ptSweepQueryFor({
      titles: { pt: 'Star Wars: O Ataque dos Clones', original: 'Star Wars: Episode II - Attack of the Clones' },
    });
    const qOf = (u: string) => {
      try {
        return new URL(u).searchParams.get('Query') || '';
      } catch {
        return '';
      }
    };
    const jacketUrls = stub.calls.map((c) => c.url).filter((u) => u.includes('/api/v2.0/indexers/'));
    const sweepUrls = jacketUrls.filter((u) => qOf(u) === expectedSweep);
    assert.equal(sweepUrls.length, 0, 'varredura foi suprimida pelo teto');
  } finally {
    stub.restore();
    config.harvest.maxPerHour = saved.maxPerHour;
    config.harvest.idleWindowMs = saved.idleWindowMs;
    config.harvest.indexerDelayMs = saved.indexerDelayMs;
    config.jackett.indexers = saved.indexers;
    config.jackett.ptBrIndexers = saved.ptBrIndexers;
    config.jackett.apiKey = saved.apiKey;
    config.tmdb.apiKey = saved.tmdbApiKey;
  }
});

test('colhedor respeita intervalo indexerDelayMs entre consultas ao mesmo indexer', async () => {
  const saved = {
    maxPerHour: config.harvest.maxPerHour,
    idleWindowMs: config.harvest.idleWindowMs,
    indexerDelayMs: config.harvest.indexerDelayMs,
    indexers: config.jackett.indexers,
    ptBrIndexers: config.jackett.ptBrIndexers,
    apiKey: config.jackett.apiKey,
    tmdbApiKey: config.tmdb.apiKey,
  };
  const timestamps: number[] = [];
  const stub = stubFetch((url: string) => {
    if (url.includes('api.themoviedb.org')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          movie_results: [
            {
              title: 'Star Wars: O Ataque dos Clones',
              original_title: 'Star Wars: Episode II - Attack of the Clones',
              release_date: '2002-05-16',
            },
          ],
        }),
      };
    }
    if (url.includes('/api/v2.0/indexers/glob-delay-idx/')) {
      timestamps.push(Date.now());
      return { ok: true, status: 200, json: async () => ({ Results: [] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  try {
    config.harvest.maxPerHour = 50;
    config.harvest.idleWindowMs = 0;
    config.harvest.indexerDelayMs = 60; // 60ms delay
    config.jackett.indexers = ['glob-delay-idx'];
    config.jackett.ptBrIndexers = [];
    config.jackett.apiKey = 'fake-key';
    config.tmdb.apiKey = 'fake-key';

    cache.set('meta:movie:tt9500052', { name: 'Star Wars: Episode II', year: '2002', type: 'movie' }, 3600);
    harvester.enqueue({ imdbId: 'tt9500052', type: 'movie', reason: `miss-${Date.now()}` } as any);
    await harvester.tick();

    assert.equal(timestamps.length, 2, '2 consultas feitas ao mesmo indexer (loop principal + varredura)');
    const delta = timestamps[1] - timestamps[0];
    assert.ok(delta >= 50, `esperou pelo menos indexerDelayMs entre as consultas (${delta}ms >= 50ms)`);
  } finally {
    stub.restore();
    config.harvest.maxPerHour = saved.maxPerHour;
    config.harvest.idleWindowMs = saved.idleWindowMs;
    config.harvest.indexerDelayMs = saved.indexerDelayMs;
    config.jackett.indexers = saved.indexers;
    config.jackett.ptBrIndexers = saved.ptBrIndexers;
    config.jackett.apiKey = saved.apiKey;
    config.tmdb.apiKey = saved.tmdbApiKey;
  }
});

test('atividade recente trava o colhedor (janela deslizante)', () => {
  // Sem tráfego nenhum: janela aberta.
  assert.equal(activity.recentUserTraffic(10 * 60_000), false);
  activity.noteUserRequest();
  assert.equal(activity.recentUserTraffic(10_000), true, 'tráfego dentro da janela trava');
  assert.equal(activity.hasUserTraffic(), true, 'marca de boot continua valendo para o warmup');
});


test('obra cortada pelo teto volta para a FRENTE da fila, antes das novas', async () => {
  // Terminar o que começou vale mais que abrir obra nova: um registro parcial
  // no índice já satisfaz o idxPoolCovered, e a busca passaria a ser servida
  // de uma lista incompleta enquanto o resto da fila é colhido.
  //
  // A fila é do módulo e carrega sobras dos testes anteriores, então o que se
  // cobra é a INVARIANTE — depois de um ciclo cortado pelo teto, a obra da
  // frente continua na frente e nada foi consumido —, não uma obra específica.
  const saved = {
    maxPerHour: config.harvest.maxPerHour,
    idleWindowMs: config.harvest.idleWindowMs,
    indexerDelayMs: config.harvest.indexerDelayMs,
    indexers: config.jackett.indexers,
    apiKey: config.jackett.apiKey,
  };
  try {
    config.harvest.idleWindowMs = 0;
    config.harvest.indexerDelayMs = 0;
    config.jackett.indexers = ['fake-a', 'fake-b', 'fake-c'];
    config.jackett.apiKey = '';
    const before = (harvester.status() as any).queriesThisHour;
    config.harvest.maxPerHour = before + 2;
    cache.set('meta:movie:tt9500061', { name: 'Cortada', year: '2024', type: 'movie' }, 3600);
    harvester.enqueue({ imdbId: 'tt9500061', type: 'movie', reason: `cap-${Date.now()}` } as any);

    const key = `${prefix('harvest')}q`;
    const antes = (cache.get(key) || []) as any[];
    assert.ok(antes.length > 0, 'a fila precisa ter obra para o ciclo cortar');
    const primeiraAntes = antes[0].imdbId;

    await harvester.tick();

    const depois = (cache.get(key) || []) as any[];
    assert.equal(depois.length, antes.length, 'obra cortada não é consumida: ela volta');
    assert.equal(depois[0].imdbId, primeiraAntes, 'e volta para a FRENTE, não para o fim');
  } finally {
    config.harvest.maxPerHour = saved.maxPerHour;
    config.harvest.idleWindowMs = saved.idleWindowMs;
    config.harvest.indexerDelayMs = saved.indexerDelayMs;
    config.jackett.indexers = saved.indexers;
    config.jackett.apiKey = saved.apiKey;
  }
});
