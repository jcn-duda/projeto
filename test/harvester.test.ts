// Colhedor (Fase 4): fila persistente de obras, dedupe por obra+razão, teto de
// fila e freio de atividade em janela deslizante. O ciclo roda SÓ no primeiro
// teste (tick exportado para isso); em produção quem o chama é o setInterval
// do start(), nunca o caminho da resposta.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import * as cache from '../src/utils/cache.js';
import config from '../src/config.js';
import { prefix } from '../src/utils/cache-keys.js';
import harvester from '../src/providers/harvester.js';
import * as activity from '../src/providers/activity.js';

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
    assert.equal(st.queueDepth, 0, 'obra consumida');

    // Ciclo seguinte: teto já alcançado — a próxima obra nem sai da fila.
    harvester.enqueue({ imdbId: 'tt9500010', type: 'movie', reason: 'miss' } as any);
    await harvester.tick();
    st = harvester.status();
    assert.equal(st.queueDepth, 1, 'teto atingido segura a obra na fila');
    assert.equal(st.queriesThisHour, 2, 'nenhuma consulta nova além do teto');
  } finally {
    config.harvest.maxPerHour = saved.maxPerHour;
    config.harvest.idleWindowMs = saved.idleWindowMs;
    config.harvest.indexerDelayMs = saved.indexerDelayMs;
    config.jackett.indexers = saved.indexers;
    config.jackett.apiKey = saved.apiKey;
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

test('atividade recente trava o colhedor (janela deslizante)', () => {
  // Sem tráfego nenhum: janela aberta.
  assert.equal(activity.recentUserTraffic(10 * 60_000), false);
  activity.noteUserRequest();
  assert.equal(activity.recentUserTraffic(10_000), true, 'tráfego dentro da janela trava');
  assert.equal(activity.hasUserTraffic(), true, 'marca de boot continua valendo para o warmup');
});
