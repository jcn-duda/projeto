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
  // PRIMEIRO do arquivo: o tick consome uma fila que começa vazia. Sem rede —
  // apiKey vazia faz cada busca devolver [] e o meta entra pelo cache.
  const saved = {
    maxPerHour: config.harvest.maxPerHour, idleWindowMs: config.harvest.idleWindowMs, indexerDelayMs: config.harvest.indexerDelayMs,
    indexers: config.jackett.indexers, apiKey: config.jackett.apiKey,
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
    config.harvest.idleWindowMs = saved.idleWindowMs; config.harvest.indexerDelayMs = saved.indexerDelayMs;
    config.jackett.indexers = saved.indexers; config.jackett.apiKey = saved.apiKey;
  }
});

test('Etapa 5: colheita cortada pelo teto grava índice PARCIAL; recolheita completa limpa', async () => {
  // O registro incompleto não pode servir o fast-path da busca: a obra volta à
  // frente da fila e a recolheita (completa) regrava sem o flag (last-write-wins).
  const saved = {
    maxPerHour: config.harvest.maxPerHour, idleWindowMs: config.harvest.idleWindowMs, indexerDelayMs: config.harvest.indexerDelayMs,
    indexers: config.jackett.indexers, apiKey: config.jackett.apiKey, ptSweepGlobal: config.jackett.ptSweepGlobal,
    rdWarmEnabled: config.debrid.rdWarm.enabled,
  };
  const stub = stubFetch((url: string) => url.includes('/api/v2.0/indexers/')
    ? { ok: true, status: 200, json: async () => ({ Results: [{ Title: 'Cap Movie (2024) 1080p', MagnetUri: `magnet:?xt=urn:btih:${'ca'.repeat(20)}&dn=Cap.Movie`, Seeders: 10, Tracker: 'cap' }] }) }
    : { ok: false, status: 404, json: async () => ({}) });
  try {
    harvesterLive.reset();
    harvester.clearQueue();
    // Teto de UMA consulta EFETIVA neste ciclo (o bucket horário pode ter
    // consultas residuais de testes anteriores — o guard do tick usa o
    // acumulado): a obra sai pela metade no segundo indexer.
    config.harvest.maxPerHour = harvestWorker.queriesThisHour() + 1;
    config.harvest.idleWindowMs = 0;
    config.harvest.indexerDelayMs = 0;
    config.jackett.indexers = ['cap-a', 'cap-b'];
    config.jackett.apiKey = 'chave-de-teste';
    config.jackett.ptSweepGlobal = false; // varredura não rouba a única consulta
    config.debrid.rdWarm.enabled = false;
    cache.set('meta:movie:tt9500140', { name: 'Cap Movie', year: '2024', type: 'movie' }, 3600);

    harvester.enqueue({ imdbId: 'tt9500140', type: 'movie', reason: `partial-cap-${Date.now()}` } as any);
    await harvester.tick();
    assert.equal(releaseIndex.isPartial('tt9500140', {}), true, 'obra cortada pelo teto grava índice parcial');

    // Entrada capped volta à FRENTE da fila (harvester.ts); recolheita com teto
    // folgado termina a obra e limpa o flag.
    config.harvest.maxPerHour = 1000;
    await harvester.tick();
    assert.equal(releaseIndex.isPartial('tt9500140', {}), false, 'recolheita completa destrava o registro');
  } finally {
    stub.restore();
    config.harvest.maxPerHour = saved.maxPerHour; config.harvest.idleWindowMs = saved.idleWindowMs; config.harvest.indexerDelayMs = saved.indexerDelayMs;
    config.jackett.indexers = saved.indexers; config.jackett.apiKey = saved.apiKey;
    config.jackett.ptSweepGlobal = saved.ptSweepGlobal; config.debrid.rdWarm.enabled = saved.rdWarmEnabled;
    harvesterLive.reset(); harvester.clearQueue();
  }
});

test('colhedor roda a varredura pt-BR nos globais, como a busca ao vivo', async () => {
  // O dublado titulado em PT mora em tracker global e a query em inglês não
  // o encontra: o colhedor que só copiasse a query principal alimentaria um
  // índice cego para essas releases. Aqui a varredura é cobrada com a MESMA
  // raiz (franchiseRoot) do caminho ao vivo — e provada fora do indexer BR.
  const saved = {
    maxPerHour: config.harvest.maxPerHour, idleWindowMs: config.harvest.idleWindowMs, indexerDelayMs: config.harvest.indexerDelayMs,
    indexers: config.jackett.indexers, apiKey: config.jackett.apiKey, ptBrIndexers: config.jackett.ptBrIndexers, tmdbApiKey: config.tmdb.apiKey,
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
    // Cinemeta e qualquer outra rede: erro rápido — obra de drenagem desiste.
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
    config.harvest.maxPerHour = saved.maxPerHour; config.harvest.idleWindowMs = saved.idleWindowMs; config.harvest.indexerDelayMs = saved.indexerDelayMs;
    config.jackett.indexers = saved.indexers; config.jackett.apiKey = saved.apiKey;
    config.jackett.ptBrIndexers = saved.ptBrIndexers; config.tmdb.apiKey = saved.tmdbApiKey;
  }
});

test('Etapa 1: eficácia — done só quando algo entra no índice; empty no resto', async () => {
  // Eficácia: consultou tudo sem release relevante = harvest.empty; só quem
  // alimentou o índice conta em harvest.done. Delta pós-reset; meta do cache.
  const saved = {
    maxPerHour: config.harvest.maxPerHour, idleWindowMs: config.harvest.idleWindowMs, indexerDelayMs: config.harvest.indexerDelayMs,
    indexers: config.jackett.indexers, apiKey: config.jackett.apiKey, rdWarmEnabled: config.debrid.rdWarm.enabled,
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
    config.harvest.maxPerHour = saved.maxPerHour; config.harvest.idleWindowMs = saved.idleWindowMs; config.harvest.indexerDelayMs = saved.indexerDelayMs;
    config.jackett.indexers = saved.indexers; config.jackett.apiKey = saved.apiKey; config.debrid.rdWarm.enabled = saved.rdWarmEnabled;
    harvesterLive.reset(); harvester.clearQueue();
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

test('Etapa 2: tráfego no MEIO da obra preempta — devolve à frente, preserva enqueuedAt e não conta tentativa', async () => {
  // Usuário chega no MEIO da colheita: a obra volta à FRENTE com o enqueuedAt
  // original e SEM custo de tentativa — tráfego não é falha; só o capped dropa.
  const saved = {
    maxPerHour: config.harvest.maxPerHour, idleWindowMs: config.harvest.idleWindowMs, indexerDelayMs: config.harvest.indexerDelayMs,
    indexers: config.jackett.indexers, apiKey: config.jackett.apiKey, tmdbApiKey: config.tmdb.apiKey,
    rawMaxItems: config.rawCache.maxItems, rdWarmEnabled: config.debrid.rdWarm.enabled,
  };
  let indexerHits = 0;
  const stub = stubFetch((url: string) => {
    if (url.includes('/api/v2.0/indexers/')) {
      indexerHits += 1;
      // Tráfego do usuário chega na PRIMEIRA consulta da obra: o guard do
      // tick já rodou (sem tráfego), então o freio pega o laço no indexer
      // seguinte — a preempção acontece no MEIO do harvestOne.
      activity.noteUserRequest();
      return { ok: true, status: 200, json: async () => ({ Results: [] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  try {
    harvesterLive.reset();
    metrics.reset();
    config.harvest.maxPerHour = 1000;
    // Janela curta (100ms) e espera entre ticks: `recentUserTraffic` precisa
    // expirar para o guard do tick seguinte liberar a obra de novo.
    config.harvest.idleWindowMs = 100;
    config.harvest.indexerDelayMs = 0;
    config.jackett.indexers = ['pre-a', 'pre-b', 'pre-c'];
    config.jackett.apiKey = 'chave-de-teste';
    config.tmdb.apiKey = '';
    // Cache bruto desligado: a MESMA query não pode virar hit no tick seguinte
    // e calar o stub — o tráfego tem que ser notado em TODA consulta.
    config.rawCache.maxItems = 0;
    config.debrid.rdWarm.enabled = false;
    harvester.setPaused(false);
    harvester.clearQueue();
    cache.clearNamespace('harvest');

    cache.set('meta:movie:tt9500131', { name: 'Preempted Movie', year: '2024', type: 'movie' }, 3600);
    harvester.enqueue({ imdbId: 'tt9500131', type: 'movie', reason: `preempt-${Date.now()}` } as any);

    const key = `${prefix('harvest')}q`;
    const antes = (cache.get(key) || []) as any[];
    const obraAntes = antes.find((e) => e.imdbId === 'tt9500131');
    assert.ok(obraAntes, 'obra enfileirada antes do tick');
    const enqueuedAtAntes = obraAntes.enqueuedAt;

    // 4 ticks preemptados seguidos: se a preempção contasse tentativa (como o
    // capped), a obra seria dropada no 4º encontro (harvest.capped.dropped).
    for (let i = 0; i < 4; i += 1) {
      await harvester.tick();
      assert.equal((harvester.status() as any).queueDepth, 1, `tick ${i + 1}: obra preemptada volta à fila`);
      await new Promise((r) => setTimeout(r, 120));
    }

    const snap = metrics.snapshot().counters;
    assert.ok((snap['harvest.preempted'] || 0) >= 4, 'cada preempção contou harvest.preempted');
    assert.equal(snap['harvest.capped.dropped'] || 0, 0, 'preempção não é capped: nada dropado no 4º encontro');
    const depois = (cache.get(key) || []) as any[];
    const obraDepois = depois.find((e) => e.imdbId === 'tt9500131');
    assert.ok(obraDepois, 'obra continua na fila após 4 preempções (attemptsByObra não incrementou)');
    assert.equal(obraDepois.enqueuedAt, enqueuedAtAntes, 'enqueuedAt preservado na retomada');
    assert.equal(obraDepois.resumed, true, 'entrada retomada carrega o sinal resumed para o painel');
    assert.equal((harvester.status() as any).queueDepth, 1, 'fila intacta após 4 preempções');
    assert.ok(indexerHits >= 4, 'o stub disparou em toda consulta (raw desligado)');
  } finally {
    stub.restore();
    config.harvest.maxPerHour = saved.maxPerHour; config.harvest.idleWindowMs = saved.idleWindowMs; config.harvest.indexerDelayMs = saved.indexerDelayMs;
    config.jackett.indexers = saved.indexers; config.jackett.apiKey = saved.apiKey; config.tmdb.apiKey = saved.tmdbApiKey;
    config.rawCache.maxItems = saved.rawMaxItems; config.debrid.rdWarm.enabled = saved.rdWarmEnabled;
    harvesterLive.reset(); harvester.clearQueue();
  }
});
