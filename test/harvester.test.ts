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

test('colhedor extrai hash de magnet URI e calcula score correto (80/40/5) para o rdWarmer', async () => {
  const saved = {
    maxPerHour: config.harvest.maxPerHour,
    idleWindowMs: config.harvest.idleWindowMs,
    indexerDelayMs: config.harvest.indexerDelayMs,
    indexers: config.jackett.indexers,
    apiKey: config.jackett.apiKey,
    tmdbApiKey: config.tmdb.apiKey,
    rdWarmEnabled: config.debrid.rdWarm.enabled,
    debridService: config.debrid.service,
  };

  const hBrDub = 'a'.repeat(40);
  const hGlobDub = 'b'.repeat(40);
  const hLeg = 'c'.repeat(40);

  const stub = stubFetch((url: string) => {
    if (url.includes('api.themoviedb.org')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          movie_results: [
            {
              title: 'Filme Teste Score',
              original_title: 'Test Score Movie',
              release_date: '2024-01-01',
            },
          ],
        }),
      };
    }
    if (url.includes('/api/v2.0/indexers/')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          Results: [
            // 1: BR Dublado (só magnet, sem infoHash)
            {
              Title: 'Filme Teste Score (2024) 1080p DUAL Dublado',
              MagnetUri: `magnet:?xt=urn:btih:${hBrDub}&dn=Filme.BR`,
              Seeders: 5,
              Tracker: 'comandotorrents',
              isBr: true,
            },
            // 2: Dublado global (sem isBr, mas com r.dubbed)
            {
              Title: 'Test Score Movie (2024) 1080p Dual Audio',
              MagnetUri: `magnet:?xt=urn:btih:${hGlobDub}&dn=Filme.Glob`,
              Seeders: 10,
              Tracker: 'thepiratebay',
              dubbed: true,
              isBr: false,
            },
            // 3: Legendado/original
            {
              Title: 'Test Score Movie (2024) 1080p English Subbed',
              MagnetUri: `magnet:?xt=urn:btih:${hLeg}&dn=Filme.Leg`,
              Seeders: 20,
              Tracker: 'thepiratebay',
            },
          ],
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });

  try {
    cache.clearNamespace('raw');
    cache.clearNamespace('tmdb');
    cache.clearNamespace('meta');
    cache.clearNamespace('rdc');
    cache.clearNamespace('rdq');
    rdWarmer.reset();
    config.debrid.rdWarm.enabled = true;
    config.debrid.service = 'realdebrid';

    // Drena obras residuais deixadas por outros testes
    config.jackett.apiKey = '';
    let guard = 0;
    while ((harvester.status() as any).queueDepth > 0 && guard++ < 250) await harvester.tick();

    const before = (harvester.status() as any).queriesThisHour || 0;
    config.harvest.maxPerHour = before + 50;
    config.harvest.idleWindowMs = 0;
    config.harvest.indexerDelayMs = 0;
    config.jackett.indexers = ['test-score-idx'];
    config.jackett.apiKey = 'fake-key';
    config.tmdb.apiKey = 'fake-key';

    cache.set('meta:movie:tt9500099', { name: 'Test Score Movie', year: '2024', type: 'movie' }, 3600);
    harvester.enqueue({ imdbId: 'tt9500099', type: 'movie', reason: `score-test-${Date.now()}` } as any);
    await harvester.tick();

    const warmStatus = rdWarmer.status();
    assert.equal(warmStatus.queueDepth, 3, 'todos os 3 hashes extraídos de magnet foram enfileirados');

    const warmQueue = cache.get(`${prefix('rdq')}wq`) as any[];
    assert.ok(Array.isArray(warmQueue), 'fila do rdWarmer foi persistida no cache');

    const brEntry = warmQueue.find((e) => e.hash === hBrDub);
    const globEntry = warmQueue.find((e) => e.hash === hGlobDub);
    const legEntry = warmQueue.find((e) => e.hash === hLeg);

    assert.ok(brEntry, 'BR dublado está na fila');
    assert.equal(brEntry.score, 80, 'BR dublado recebe score 80');

    assert.ok(globEntry, 'Dublado global está na fila');
    assert.equal(globEntry.score, 40, 'Dublado global recebe score 40');

    assert.ok(legEntry, 'Legendado está na fila');
    assert.equal(legEntry.score, 5, 'Legendado recebe score 5');
  } finally {
    stub.restore();
    config.harvest.maxPerHour = saved.maxPerHour;
    config.harvest.idleWindowMs = saved.idleWindowMs;
    config.harvest.indexerDelayMs = saved.indexerDelayMs;
    config.jackett.indexers = saved.indexers;
    config.jackett.apiKey = saved.apiKey;
    config.tmdb.apiKey = saved.tmdbApiKey;
    config.debrid.rdWarm.enabled = saved.rdWarmEnabled;
    config.debrid.service = saved.debridService;
    rdWarmer.reset();
  }
});


test("3.2: prioritizeQueue põe evidência BR antes e é estável (FIFO no mesmo rank)", () => {
  harvesterLive.reset();
  const now = Date.now();
  const a = { imdbId: 'tt3000001', type: 'movie', reason: 'next-episode' as any, season: null, episode: null, enqueuedAt: now - 1000 };
  const b = { imdbId: 'tt3000002', type: 'movie', reason: 'miss' as any, season: null, episode: null, enqueuedAt: now - 900 };
  const c = { imdbId: 'tt3000003', type: 'movie', reason: 'popular' as any, season: null, episode: null, enqueuedAt: now - 800 };
  // tt3000002 tem release BR dublada no índice (evidência BR rank 2).
  releaseIndex.record('tt3000002', {}, [{ infoHash: '9'.repeat(40), title: 'Filme BR (2024) DUBLADO 1080p', isBr: true, indexer: 'x', seeders: 1 }]);
  const out = (harvester as any).prioritizeQueue([a, b, c]);
  assert.deepEqual(out.map((e: any) => e.imdbId), ['tt3000001', 'tt3000002', 'tt3000003'], 'next-episode > índice-BR > FIFO');
});

test("3.2: bound de fome — obra sem BR muito antiga sobe acima do next-episode", () => {
  harvesterLive.reset();
  harvesterLive.set({ harvestBrMaxWaitMs: 1000 });
  const now = Date.now();
  const old = { imdbId: 'tt3000010', type: 'movie', reason: 'popular' as any, season: null, episode: null, enqueuedAt: now - 5000 };
  const fresh = { imdbId: 'tt3000011', type: 'movie', reason: 'next-episode' as any, season: null, episode: null, enqueuedAt: now };
  const out = (harvester as any).prioritizeQueue([fresh, old]);
  assert.deepEqual(out.map((e: any) => e.imdbId), ['tt3000010', 'tt3000011'], 'starved rank-0 sobe na frente');
  harvesterLive.reset();
});

test('3.2: harvestBrMaxWaitMs=0 desliga o bound de fome', () => {
  harvesterLive.reset();
  harvesterLive.set({ harvestBrFirst: true, harvestBrMaxWaitMs: 0 });
  const old = { imdbId: 'tt3000012', type: 'movie', reason: 'popular', season: null, episode: null, enqueuedAt: 1 };
  const next = { imdbId: 'tt3000013', type: 'series', reason: 'next-episode', season: 1, episode: 2, enqueuedAt: Date.now() };
  const out = (harvester as any).prioritizeQueue([old, next]);
  assert.deepEqual(out.map((e: any) => e.imdbId), ['tt3000013', 'tt3000012']);
  harvesterLive.reset();
});

test("3.2: harvestBrFirst=false restaura FIFO exato", () => {
  harvesterLive.reset();
  harvesterLive.set({ harvestBrFirst: false });
  const now = Date.now();
  const a = { imdbId: 'tt3000020', type: 'movie', reason: 'next-episode' as any, season: null, episode: null, enqueuedAt: now - 100 };
  const b = { imdbId: 'tt3000021', type: 'movie', reason: 'popular' as any, season: null, episode: null, enqueuedAt: now - 50 };
  const out = (harvester as any).prioritizeQueue([b, a]);
  assert.deepEqual(out.map((e: any) => e.imdbId), ['tt3000020', 'tt3000021'], 'sem priorização, ordem de chegada vence');
  harvesterLive.reset();
});

test('3.2: rank 2 para SÉRIE via season/episode no índice', () => {
  harvesterLive.reset();
  harvesterLive.set({ harvestBrFirst: true, harvestBrMaxWaitMs: 0 });
  const idx = 'a'.repeat(40);
  // Evidência BR da série gravada na chave da temporada (pack cobre episódio).
  releaseIndex.record('tt3000031', { season: 2, episode: 3 }, [
    { infoHash: idx, title: 'Serie (2020) S02E03 1080p DUBLADO', isBr: true, indexer: 'x', seeders: 1 },
  ]);
  metrics.reset();
  const serieComBR = { imdbId: 'tt3000031', type: 'series', reason: 'miss', season: 2, episode: 3, enqueuedAt: Date.now() - 500 };
  const outro = { imdbId: 'tt3000032', type: 'movie', reason: 'miss', season: null, episode: null, enqueuedAt: Date.now() - 1 };
  const plain = { imdbId: 'tt3000033', type: 'movie', reason: 'popular', season: null, episode: null, enqueuedAt: Date.now() };
  const out = (harvester as any).prioritizeQueue([outro, serieComBR as any, plain]);
  assert.deepEqual(out.map((e: any) => e.imdbId), ['tt3000031', 'tt3000032', 'tt3000033'], 'série com evidência BR na temporada sobe acima do FIFO, no rank 2');
  assert.equal(metrics.snapshot().counters['cache.hit.idx'], undefined, 'priorização consulta o índice sem promover LRU/métricas');
  harvesterLive.reset();
});

test('3.2: lied (post prometeu PT, arquivo EN) NÃO prioriza', () => {
  harvesterLive.reset();
  harvesterLive.set({ harvestBrFirst: true, harvestBrMaxWaitMs: 0 });
  const idx = 'b'.repeat(40);
  releaseIndex.record('tt3000040', {}, [
    { infoHash: idx, title: 'Filme (2020) 1080p DUBLADO', isBr: true, indexer: 'x', seeders: 1 },
  ]);
  releaseIndex.markLied('tt3000040', {}, idx); // os arquivos provaram release EN
  const plain = { imdbId: 'tt3000041', type: 'movie', reason: 'popular', season: null, episode: null, enqueuedAt: Date.now() - 1000 };
  const lied = { imdbId: 'tt3000040', type: 'movie', reason: 'miss', season: null, episode: null, enqueuedAt: Date.now() };
  const out = (harvester as any).prioritizeQueue([lied, plain]);
  assert.deepEqual(out.map((e: any) => e.imdbId), ['tt3000041', 'tt3000040'], 'lied não ganha rank 2: FIFO puro decide');
  harvesterLive.reset();
});

test('3.2: toggle false restaura FIFO de um array já priorizado', () => {
  harvesterLive.reset();
  harvesterLive.set({ harvestBrFirst: false });
  const a = { imdbId: 'tt3000050', type: 'movie', reason: 'next-episode', season: null, episode: null, enqueuedAt: 2000 };
  const b = { imdbId: 'tt3000051', type: 'movie', reason: 'popular', season: null, episode: null, enqueuedAt: 1000 };
  // Primeiro prioriza (flag ligada): a ganha.
  harvesterLive.set({ harvestBrFirst: true, harvestBrMaxWaitMs: 0 });
  assert.deepEqual((harvester as any).prioritizeQueue([a, b]).map((e: any) => e.imdbId), ['tt3000050', 'tt3000051'], 'priorizado: next-episode na frente');
  // O toggle desliga ao vivo: FIFO exato volta, mesmo sobre a ordem priorizada anterior.
  harvesterLive.set({ harvestBrFirst: false });
  assert.deepEqual((harvester as any).prioritizeQueue([a, b]).map((e: any) => e.imdbId), ['tt3000051', 'tt3000050'], 'sem priorização a ordem de chegada original é restaurada');
  harvesterLive.reset();
});

test('3.2: capacidade com prioridade ativa NÃO remove a cabeça prioritária', () => {
  harvesterLive.reset();
  try {
    harvester.setPaused(true); // não consome nada durante o teste
    harvester.clearQueue();
    harvesterLive.set({ harvestBrFirst: true, harvestBrMaxWaitMs: 0, harvestQueueMax: 10 });
    const cap = 'c'.repeat(40);
    releaseIndex.record('tt3000060', { season: 1, episode: 1 }, [
      { infoHash: cap, title: 'Serie (2020) S01E01 1080p DUBLADO', isBr: true, indexer: 'x', seeders: 1 },
    ]);
    // Cabeça prioritária + dez entradas comuns estouram o teto mínimo (10).
    harvester.enqueue({ imdbId: 'tt3000060', type: 'series', season: 1, episode: 1, reason: 'next-episode' });
    for (let i = 61; i <= 70; i += 1) {
      harvester.enqueue({ imdbId: `tt30000${i}`, type: 'movie', reason: 'popular' });
    }

    const st: any = harvester.status();
    assert.equal(st.queueDepth, 10, 'nunca passa do teto mesmo com evidência');
    assert.ok(st.queuePreview.some((e: any) => e.imdbId === 'tt3000060'), 'a cabeça prioritária continua na fila');
    assert.equal(st.queuePreview[0].imdbId, 'tt3000060', 'status devolve a ordem efetiva com a prioritária primeiro');
  } finally {
    harvester.setPaused(false);
    harvesterLive.reset();
    harvester.clearQueue();
  }
});
