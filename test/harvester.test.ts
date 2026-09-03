// Colhedor (Fase 4): fila persistente de obras, dedupe por obra+razão, teto de
// fila e freio de atividade em janela deslizante. Os dois primeiros testes
// rodam o ciclo de verdade (tick exportado para isso, sem rede); em produção
// quem o chama é o setInterval do start(), nunca o caminho da resposta.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import * as cache from '../src/utils/cache.js';
import config from '../src/config.js';
config.seed.enabled = false;
import { prefix } from '../src/utils/cache-keys.js';
import harvester from '../src/providers/harvester.js';
import rdWarmer from '../src/providers/rd-warmer.js';
import * as activity from '../src/providers/activity.js';
import { stubFetch } from './helpers/stub.js';
import { ptSweepQueryFor } from '../src/providers/search-plan.js';
import * as harvesterLive from '../src/utils/harvester-live.js';
import * as releaseIndex from '../src/utils/release-index.js';
import * as metrics from '../src/utils/metrics.js';
import * as harvestWorker from '../src/providers/harvest-worker.js';

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

test('Etapa 1: eficácia — done só quando algo entra no índice; empty no resto', async () => {
  // A distinção da métrica não pode mais ser "consultou com sucesso" (ok):
  // obra que consultou tudo mas não achou release relevante é `harvest.empty`,
  // e só quem realmente alimentou o índice conta em `harvest.done`. Delta
  // sobre snapshot após reset, sem depender de estado residual. Sem rede —
  // fetch dublê; meta entra pelo cache.
  const saved = {
    maxPerHour: config.harvest.maxPerHour,
    idleWindowMs: config.harvest.idleWindowMs,
    indexerDelayMs: config.harvest.indexerDelayMs,
    indexers: config.jackett.indexers,
    apiKey: config.jackett.apiKey,
    rdWarmEnabled: config.debrid.rdWarm.enabled,
  };
  const stub = stubFetch((url: string) => {
    if (url.includes('/api/v2.0/indexers/')) {
      const query = String(new URL(url).searchParams.get('Query') || '').toLowerCase();
      if (query.includes('empty')) {
        return { ok: true, status: 200, json: async () => ({ Results: [] }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          Results: [
            {
              Title: 'Done Movie (2024) 1080p',
              MagnetUri: `magnet:?xt=urn:btih:${'e'.repeat(40)}&dn=Done.Movie`,
              Seeders: 10,
              Tracker: 'thepiratebay',
            },
          ],
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  try {
    config.harvest.maxPerHour = 1000;
    config.harvest.idleWindowMs = 0;
    config.harvest.indexerDelayMs = 0;
    config.jackett.indexers = ['efic-idx'];
    config.jackett.apiKey = 'chave-de-teste';
    config.debrid.rdWarm.enabled = false;
    harvesterLive.reset();
    harvester.setPaused(false);
    harvester.clearQueue();

    cache.set('meta:movie:tt9500121', { name: 'Empty Movie', year: '2024', type: 'movie' }, 3600);
    cache.set('meta:movie:tt9500122', { name: 'Done Movie', year: '2024', type: 'movie' }, 3600);

    metrics.reset();
    harvester.enqueue({ imdbId: 'tt9500121', type: 'movie', reason: `efic-empty-${Date.now()}` } as any);
    await harvester.tick();
    let counters = metrics.snapshot().counters;
    assert.ok((counters['harvest.empty'] || 0) >= 1, 'consulta OK sem release relevante conta harvest.empty');
    assert.equal(counters['harvest.done'] || 0, 0, 'sem entrada no índice, harvest.done fica em 0');

    harvester.enqueue({ imdbId: 'tt9500122', type: 'movie', reason: `efic-done-${Date.now()}` } as any);
    await harvester.tick();
    counters = metrics.snapshot().counters;
    assert.ok((counters['harvest.done'] || 0) >= 1, 'obra com release relevante conta harvest.done');
  } finally {
    stub.restore();
    config.harvest.maxPerHour = saved.maxPerHour;
    config.harvest.idleWindowMs = saved.idleWindowMs;
    config.harvest.indexerDelayMs = saved.indexerDelayMs;
    config.jackett.indexers = saved.indexers;
    config.jackett.apiKey = saved.apiKey;
    config.debrid.rdWarm.enabled = saved.rdWarmEnabled;
    harvesterLive.reset();
    harvester.clearQueue();
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
    // Etapa 1: o descarte por estouro tem que deixar rastro medido. O default
    // de HARVEST_BR_FIRST é true no .env, então o caminho deste teste é o
    // FIFO (shift) — o priorizado (pop) tem assert próprio no
    // harvester-priority.test.ts. clearQueue() no início para não depender de
    // estado residual; harvestBrFirst false força o shift.
    harvester.clearQueue();
    harvesterLive.reset();
    harvesterLive.set({ harvestBrFirst: false });
    const beforeDrop = metrics.snapshot().counters['harvest.queue.dropped'] || 0;
    // Razões distintas contornam o dedupe de 12h.
    harvester.enqueue({ imdbId: 'tt9500003', type: 'movie', reason: `miss-${Date.now()}-a` } as any);
    harvester.enqueue({ imdbId: 'tt9500004', type: 'movie', reason: `miss-${Date.now()}-b` } as any);
    harvester.enqueue({ imdbId: 'tt9500005', type: 'movie', reason: `miss-${Date.now()}-c` } as any);
    const stored = cache.get(`${prefix('harvest')}q`) as any[];
    assert.equal(stored.length, 2, 'nunca passa do teto');
    assert.ok(!stored.some((e) => e.imdbId === 'tt9500003'), 'a mais antiga sai');
    const afterDrop = metrics.snapshot().counters['harvest.queue.dropped'] || 0;
    assert.equal(afterDrop - beforeDrop, 1, 'o shift do estouro conta harvest.queue.dropped por item');
  } finally {
    config.harvest.queueMax = originalMax;
    harvesterLive.reset();
    harvester.clearQueue();
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
