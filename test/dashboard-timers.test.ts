import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PAGE_ASSETS } from '../src/routes/public.js';

// ---------------------------------------------------------------------------
// Fase 3 do redesign do dashboard — conteúdo que o back-end já entrega e a
// tela descartava:
//   3.1 dashboard-timers.js  ← tabela de metrics.timers (indexer.<id> +
//                              search.*) com count/avg/p50/p95/max;
//   3.2 dashboard-f3.js      ← gauges f3.br.popular.* + f3.latest completo;
//   3.3 renderCache          ← cache.hit.*/miss.* por balde + cache.expired.
// Tudo executa o JS real do front em sandbox com DOM falso, como
// dashboard-health-strip/dashboard-render-split já fazem. Nenhuma rota,
// payload ou ação muda.
// ---------------------------------------------------------------------------

const PUBLIC = (name: string) => readFileSync(new URL('../src/public/' + name, import.meta.url), 'utf8');
const HTML = () => PUBLIC('dashboard.html');
const ES6 = /\b(?:const|let)\b|=>|\?\.|\?\?/;

interface FakeNode {
  className: string;
  textContent: string;
  type: string;
  hidden: boolean;
  title: string;
  children: FakeNode[];
  appended: FakeNode[];
  attrs: Record<string, string>;
  appendChild(child: FakeNode): FakeNode;
  setAttribute(key: string, value: string): void;
  getAttribute(key: string): string | null;
  removeAttribute(): void;
  addEventListener(): void;
  querySelector(): null;
}

function fakeNode(): FakeNode {
  const node: FakeNode = {
    className: '',
    textContent: '',
    type: '',
    hidden: false,
    title: '',
    children: [],
    appended: [],
    attrs: {},
    appendChild(child) { node.appended.push(child); node.children.push(child); return child; },
    setAttribute(key, value) { node.attrs[key] = String(value); },
    getAttribute(key) { return node.attrs[key] ?? null; },
    removeAttribute() { /* sem title persistente entre renders */ },
    addEventListener() { /* wiring coberto no boot */ },
    querySelector() { return null; },
  };
  return node;
}

function buildSandbox(files: string[], returns: string) {
  const els: Record<string, FakeNode> = {};
  const document = {
    hidden: false,
    getElementById: (id: string) => (els[id] = els[id] || fakeNode()),
    createElement: () => fakeNode(),
    createTextNode: (text: string) => ({ text }),
    addEventListener: () => {},
  };
  const window = {
    location: { pathname: '/dashboard', hash: '', search: '' },
    addEventListener: () => {},
    pageYOffset: 0,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  };
  const code = files.map((name) => PUBLIC(name)).join('\n');
  const factory = new Function('document', 'window', code + '\nreturn {' + returns + '};') as (
    doc: unknown,
    win: unknown,
  ) => any;
  return { api: factory(document, window), els };
}

function textOf(node: FakeNode | undefined): string {
  if (!node) return '';
  const parts: string[] = [];
  parts.push(String(node.textContent || ''));
  for (const child of node.children || []) parts.push(textOf(child));
  return parts.join(' ');
}

// metric()/metricOrigem() montam <div class="metric"><span class="key">…</span>
// <span class="value">…</span></div>. O DOM falso não agrega textContent, então
// a leitura da linha é feita pelos filhos.
function metricValue(box: FakeNode, key: string): string | null {
  for (const item of box.children || []) {
    if (item.children && item.children.length >= 2 && item.children[0].textContent === key) {
      return String(item.children[1].textContent || '');
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 3.1 — Latências e percentis (dashboard-timers.js)
// ---------------------------------------------------------------------------

const TIMERS = {
  'indexer.bludv': { count: 3, avgMs: 340, p50Ms: 300, p95Ms: 900, maxMs: 880 },
  'indexer.nerdfilmes': { count: 2, avgMs: 5000, p50Ms: 4800, p95Ms: 5200, maxMs: 5200 },
  'search.response': { count: 10, avgMs: 900, p50Ms: 800, p95Ms: 1800, maxMs: 2000 },
  'search.first.total': { count: 4, avgMs: 1200, p50Ms: 1100, p95Ms: 1600, maxMs: 1700 },
  'autofetch.recheck': { count: 99, avgMs: 1, p50Ms: 1, p95Ms: 1, maxMs: 1 },
  'cache.hit': { count: 7, avgMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 },
};

test('3.1 timers: tabela com count/avg/p50/p95/max por indexer e search.*', () => {
  const { api, els } = buildSandbox(['dashboard-core.js', 'dashboard-render.js', 'dashboard-timers.js'], 'renderTimersPanel: renderTimersPanel');
  api.renderTimersPanel({ metrics: { timers: TIMERS } });
  const box = els['timerMetrics'];
  const table = box.appended.filter((n) => n.className === 'timer-table')[0];
  assert.ok(table, 'tabela renderizada em #timerMetrics');
  const headCells = table.children[0].children[0].children.map((c: FakeNode) => c.textContent);
  assert.deepEqual(headCells, ['timer', 'n', 'média', 'p50', 'p95', 'máx']);
  const rows = table.children[1].children;
  // indexer.* primeiro; em cada bloco, ordem alfabética.
  assert.deepEqual(
    rows.map((r: FakeNode) => r.children[0].textContent),
    ['indexer.bludv', 'indexer.nerdfilmes', 'search.first.total', 'search.response'],
  );
  assert.deepEqual(
    rows[0].children.map((c: FakeNode) => c.textContent),
    ['indexer.bludv', '3', '340 ms', '300 ms', '900 ms', '880 ms'],
  );
  // Só indexer./search. entram: autofetch.* e cache.* têm painel próprio.
  const flat = textOf(box);
  assert.ok(flat.indexOf('autofetch.recheck') === -1, 'timer fora do funil não entra');
  assert.ok(flat.indexOf('cache.hit') === -1, 'timer de cache não entra');
});

test('3.1 timers: sem medições o container nomeia o estado vazio', () => {
  const { api, els } = buildSandbox(['dashboard-core.js', 'dashboard-render.js', 'dashboard-timers.js'], 'renderTimersPanel: renderTimersPanel');
  assert.doesNotThrow(() => api.renderTimersPanel({}));
  api.renderTimersPanel({ metrics: { timers: {} } });
  const box = els['timerMetrics'];
  assert.equal(box.children[0].className, 'empty');
  assert.match(textOf(box), /Sem medições/);
});

test('3.1 timers: módulo ES5, sem innerHTML e sem execução no load', () => {
  const js = PUBLIC('dashboard-timers.js');
  assert.doesNotMatch(js, ES6, 'ES5 puro (WebView de TV)');
  assert.doesNotMatch(js, /innerHTML/, 'dados só por textContent/appendChild');
  assert.doesNotMatch(js, /\bbind\s*\(\s*\)\s*;?\s*$/, 'declaração pura, nada roda no load');
});

test('3.1 timers: HTML, allowlist e ordem de scripts (boot por último)', () => {
  const html = HTML();
  assert.match(html, /id="timerMetrics"/);
  assert.ok(PAGE_ASSETS.includes('dashboard-timers.js'), 'módulo novo entra na allowlist fechada');
  const health = html.lastIndexOf('/dashboard-health.js');
  const timers = html.lastIndexOf('/dashboard-timers.js');
  const boot = html.lastIndexOf('/dashboard-boot.js');
  assert.ok(health < timers && timers < boot, 'timers depois do health, boot sempre por último');
});

// ---------------------------------------------------------------------------
// 3.2 — Cobertura BR completa (dashboard-f3.js)
// ---------------------------------------------------------------------------

const F3_LATEST = {
  at: 1700000001000,
  cohortAt: 1699999900000,
  targetWorks: 100,
  indexedWorks: 80,
  worksWithBr: 40,
  worksCached: 20,
  worksKnownMiss: 10,
  worksUnknown: 10,
  releasesWithBr: 50,
  releasesCached: 25,
  movie: { target: 60, indexed: 50, withBr: 25, cached: 12, knownMiss: 5, unknown: 8 },
  series: { target: 40, indexed: 30, withBr: 15, cached: 8, knownMiss: 5, unknown: 2 },
};

const F3_GAUGES = {
  'f3.br.popular.target': 100,
  'f3.br.popular.indexed': 80,
  'f3.br.popular.withBr': 40,
  'f3.br.popular.cached': 20,
  'f3.br.popular.knownMiss': 10,
  'f3.br.popular.unknown': 10,
  'f3.br.popular.releasesWithBr': 50,
  'f3.br.popular.releasesCached': 25,
  'f3.br.popular.popularCoverage': 0.5,
  'f3.br.popular.brWarmRate': 0.5,
  'f3.br.popular.discoveryRate': 0.4,
};

test('3.2 f3: gauges f3.br.popular.* e latest completo', () => {
  const { api, els } = buildSandbox(['dashboard-core.js', 'dashboard-render.js', 'dashboard-f3.js'], 'renderF3Panel: renderF3Panel');
  api.renderF3Panel(
    { enabled: true, baselineAt: 1699999000000, samples: 9, counters: { sample: 9 }, latest: F3_LATEST, popularCoverage: 0.5, discoveryRate: 0.4, brWarmRate: 0.5 },
    1200,
    F3_GAUGES,
  );
  const box = els['f3Metrics'];
  assert.equal(metricValue(box, 'indexedWorks'), '80', 'gauge indexed vence o latest');
  assert.equal(metricValue(box, 'worksKnownMiss'), '10');
  assert.equal(metricValue(box, 'worksUnknown'), '10');
  assert.equal(metricValue(box, 'releasesWithBr'), '50');
  assert.equal(metricValue(box, 'releasesCached'), '25', 'releasesCached não some como objeto');
  assert.equal(metricValue(box, 'popularCoverage'), '50%');
  assert.equal(metricValue(box, 'samples'), '9', 'f3.counters.sample alimenta samples');
  assert.match(textOf(box), /cohortAt/, 'cohortAt aparece');
  assert.equal(metricValue(box, 'movie em cache / indexadas'), '12/50', 'movie desmembra o sub-objeto');
  assert.equal(metricValue(box, 'series com BR / miss / unknown'), '15/5/2', 'series desmembra o sub-objeto');
});

test('3.2 f3: desligado e sem amostra nomeiam o estado, sem lançar', () => {
  const { api, els } = buildSandbox(['dashboard-core.js', 'dashboard-render.js', 'dashboard-f3.js'], 'renderF3Panel: renderF3Panel');
  api.renderF3Panel({ enabled: false }, 10, {});
  assert.match(textOf(els['f3Metrics']), /F3 desligado/);
  const vazio = buildSandbox(['dashboard-core.js', 'dashboard-render.js', 'dashboard-f3.js'], 'renderF3Panel: renderF3Panel');
  assert.doesNotThrow(() => vazio.api.renderF3Panel(null, 10, {}));
  assert.match(textOf(vazio.els['f3Metrics']), /sem amostra/);
});

// ---------------------------------------------------------------------------
// 3.3 — Cache por namespace (renderCache em dashboard-panels.js)
// ---------------------------------------------------------------------------

const CACHE_PAYLOAD = {
  namespaces: [],
  l2: {
    _origem: { fileSizeBytes: 'duravel', walSizeBytes: 'duravel', freelistCount: 'duravel', pendingWrites: 'amostra' },
    fileSizeBytes: 2048,
    walSizeBytes: 0,
    freelistCount: 0,
    pendingWrites: 0,
  },
};

const CACHE_COUNTERS = {
  'cache.hit.raw': 8,
  'cache.miss.raw': 2,
  'cache.hit.streams': 5,
  'cache.miss.streams': 5,
  'cache.expired': 3,
};

test('3.3 cache: hit/miss por balde + expirados, mantendo o bloco L2', () => {
  const { api, els } = buildSandbox(['dashboard-core.js', 'dashboard-render.js', 'dashboard-panels.js'], 'renderCache: renderCache');
  api.renderCache(CACHE_PAYLOAD, CACHE_COUNTERS);
  const box = els['cacheMetrics'];
  const flat = textOf(box);
  assert.match(flat, /Persistência L2 \(SQLite\)/);
  assert.match(flat, /Cache por namespace/);
  assert.equal(metricValue(box, 'raw (hit/miss)'), '80% · 8/2');
  assert.equal(metricValue(box, 'streams (hit/miss)'), '50% · 5/5');
  assert.equal(metricValue(box, 'expirados'), '3');
  // Balde sem atividade não vira linha (não inventar zero).
  assert.equal(metricValue(box, 'mag (hit/miss)'), null);
});

test('3.3 cache: sem atividade de balde e sem expirados o grupo não aparece', () => {
  const { api, els } = buildSandbox(['dashboard-core.js', 'dashboard-render.js', 'dashboard-panels.js'], 'renderCache: renderCache');
  api.renderCache(CACHE_PAYLOAD, {});
  assert.equal(textOf(els['cacheMetrics']).indexOf('Cache por namespace'), -1);
});
