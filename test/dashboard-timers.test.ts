import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dashboardHtml, resetDashboardEnvironment } from './helpers/dashboard.js';

// ---------------------------------------------------------------------------
// C3 — conteúdo que o back-end já entrega e a tela pinta: timers/percentis,
// cobertura F3 e cache por namespace. Importa o emit real; sem regex de fonte.
// ---------------------------------------------------------------------------

function flat(node: any): string {
  if (!node) return '';
  return [String(node.textContent || '')].concat((node.children || []).map(flat)).join(' ');
}

function metricValue(box: any, key: string): string | null {
  for (const item of box.children || []) {
    if (item.children && item.children.length >= 2 && item.children[0].textContent === key) {
      return String(item.children[1].textContent || '');
    }
  }
  return null;
}

const TIMERS = {
  'indexer.bludv': { count: 3, avgMs: 340, p50Ms: 300, p95Ms: 900, maxMs: 880 },
  'indexer.nerdfilmes': { count: 2, avgMs: 5000, p50Ms: 4800, p95Ms: 5200, maxMs: 5200 },
  'search.response': { count: 10, avgMs: 900, p50Ms: 800, p95Ms: 1800, maxMs: 2000 },
  'search.first.total': { count: 4, avgMs: 1200, p50Ms: 1100, p95Ms: 1600, maxMs: 1700 },
  'autofetch.recheck': { count: 99, avgMs: 1, p50Ms: 1, p95Ms: 1, maxMs: 1 },
  'cache.hit': { count: 7, avgMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 },
};

test('timers: tabela com count/avg/p50/p95/max por indexer e search.*', async () => {
  const { dom, mods } = await resetDashboardEnvironment();
  mods.timers.renderTimersPanel({ metrics: { timers: TIMERS } });
  const box = dom.byId['timerMetrics'];
  const table = box.children.find((n: any) => n.className === 'timer-table');
  assert.ok(table, 'tabela renderizada');
  const headCells = table.children[0].children[0].children.map((c: any) => c.textContent);
  assert.deepEqual(headCells, ['timer', 'n', 'média', 'p50', 'p95', 'máx']);
  const rows = table.children[1].children;
  assert.deepEqual(rows.map((r: any) => r.children[0].textContent), ['indexer.bludv', 'indexer.nerdfilmes', 'search.first.total', 'search.response']);
  assert.deepEqual(rows[0].children.map((c: any) => c.textContent), ['indexer.bludv', '3', '340 ms', '300 ms', '900 ms', '880 ms']);
  const texto = flat(box);
  assert.ok(!texto.includes('autofetch.recheck'), 'timer fora do funil não entra');
  assert.ok(!texto.includes('cache.hit'), 'timer de cache não entra');
  dom.cleanup();
});

test('timers: sem medições nomeia o estado vazio', async () => {
  const { dom, mods } = await resetDashboardEnvironment();
  assert.doesNotThrow(() => mods.timers.renderTimersPanel({}));
  mods.timers.renderTimersPanel({ metrics: { timers: {} } });
  const box = dom.byId['timerMetrics'];
  assert.equal(box.children[0].className, 'empty');
  assert.match(flat(box), /Sem medições/);
  dom.cleanup();
});

const F3_LATEST = {
  at: 1700000001000, cohortAt: 1699999900000,
  targetWorks: 100, indexedWorks: 80, worksWithBr: 40, worksCached: 20,
  worksKnownMiss: 10, worksUnknown: 10, releasesWithBr: 50, releasesCached: 25,
  movie: { target: 60, indexed: 50, withBr: 25, cached: 12, knownMiss: 5, unknown: 8 },
  series: { target: 40, indexed: 30, withBr: 15, cached: 8, knownMiss: 5, unknown: 2 },
};
const F3_GAUGES = {
  'f3.br.popular.target': 100, 'f3.br.popular.indexed': 80, 'f3.br.popular.withBr': 40,
  'f3.br.popular.cached': 20, 'f3.br.popular.knownMiss': 10, 'f3.br.popular.unknown': 10,
  'f3.br.popular.releasesWithBr': 50, 'f3.br.popular.releasesCached': 25,
  'f3.br.popular.popularCoverage': 0.5, 'f3.br.popular.brWarmRate': 0.5, 'f3.br.popular.discoveryRate': 0.4,
};

test('f3: gauges f3.br.popular.* e latest completo', async () => {
  const { dom, mods } = await resetDashboardEnvironment();
  mods.f3.renderF3Panel(
    { enabled: true, baselineAt: 1699999000000, samples: 9, counters: { sample: 9 }, latest: F3_LATEST, popularCoverage: 0.5, discoveryRate: 0.4, brWarmRate: 0.5 },
    1200,
    F3_GAUGES,
  );
  const box = dom.byId['f3Metrics'];
  assert.equal(metricValue(box, 'indexedWorks'), '80', 'gauge vence o latest');
  assert.equal(metricValue(box, 'worksKnownMiss'), '10');
  assert.equal(metricValue(box, 'releasesCached'), '25');
  assert.equal(metricValue(box, 'popularCoverage'), '50%');
  assert.equal(metricValue(box, 'samples'), '9');
  assert.match(flat(box), /cohortAt/);
  assert.equal(metricValue(box, 'movie em cache / indexadas'), '12/50');
  assert.equal(metricValue(box, 'series com BR / miss / unknown'), '15/5/2');
  dom.cleanup();
});

test('f3: desligado e sem amostra nomeiam o estado, sem lançar', async () => {
  const { dom, mods } = await resetDashboardEnvironment();
  mods.f3.renderF3Panel({ enabled: false }, 10, {});
  assert.match(flat(dom.byId['f3Metrics']), /F3 desligado/);
  assert.doesNotThrow(() => mods.f3.renderF3Panel(null, 10, {}));
  assert.match(flat(dom.byId['f3Metrics']), /sem amostra/);
  dom.cleanup();
});

const CACHE_PAYLOAD = {
  namespaces: [],
  l2: {
    _origem: { fileSizeBytes: 'duravel', walSizeBytes: 'duravel', freelistCount: 'duravel', pendingWrites: 'amostra' },
    fileSizeBytes: 2048, walSizeBytes: 0, freelistCount: 0, pendingWrites: 0,
  },
};
const CACHE_COUNTERS = { 'cache.hit.raw': 8, 'cache.miss.raw': 2, 'cache.hit.streams': 5, 'cache.miss.streams': 5, 'cache.expired': 3 };

test('cache: hit/miss por balde + expirados, mantendo o bloco L2', async () => {
  const { dom, mods } = await resetDashboardEnvironment();
  mods.panelsL2.renderCache(CACHE_PAYLOAD, CACHE_COUNTERS);
  const box = dom.byId['cacheMetrics'];
  const texto = flat(box);
  assert.match(texto, /Persistência L2 \(SQLite\)/);
  assert.match(texto, /Cache por namespace/);
  assert.equal(metricValue(box, 'raw (hit/miss)'), '80% · 8/2');
  assert.equal(metricValue(box, 'streams (hit/miss)'), '50% · 5/5');
  assert.equal(metricValue(box, 'expirados'), '3');
  assert.equal(metricValue(box, 'mag (hit/miss)'), null, 'balde sem atividade não vira linha');
  dom.cleanup();
});

test('cache: sem atividade e sem expirados o grupo não aparece; os 4 campos L2 declaram procedência', async () => {
  const { dom, mods } = await resetDashboardEnvironment();
  mods.panelsL2.renderCache(CACHE_PAYLOAD, {});
  const box = dom.byId['cacheMetrics'];
  assert.equal(flat(box).includes('Cache por namespace'), false);
  // L2: cada campo medido do disco passa por metricMaybeOrigem; a fila pendente
  // é amostra. Título existe nos quatro.
  const l2Titles = box.children.filter((item: any) => {
    const key = item.children && item.children[0] && item.children[0].textContent;
    return key && String(key).includes('L2');
  });
  assert.equal(l2Titles.length, 4, 'os quatro campos do L2 aparecem');
  for (const item of l2Titles) {
    assert.ok(item.children[1].title && item.children[1].title.length > 0, 'L2 com procedência declarada');
  }
  dom.cleanup();
});

test('HTML mantém os containers das três fases', () => {
  const html = dashboardHtml();
  for (const id of ['timerMetrics', 'f3Metrics', 'cacheMetrics']) {
    assert.match(html, new RegExp('id="' + id + '"'), id + ' preservado');
  }
});
