import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PAGE_ASSETS } from '../src/routes/public.js';

// ---------------------------------------------------------------------------
// Fase 3B do redesign do dashboard (3.4–3.7) — payload que o back-end JÁ
// entrega e a tela descartava. Nenhuma rota, payload ou ação muda:
//   3.4 dashboard-catalog-panel.js ← catalog.report no load/poll, sem POST
//   3.5 dashboard-af-stall.js      ← lots/pendingLocks/searchSlots/seasonSearchKeys/
//                                    searchesInFlight/skips/lastSkips do Chupim
//   3.6 dashboard-general.js       ← general.memory/services + contadores órfãos
//   3.7 renderSources              ← resolver sem status/lastMs = "nunca medido"
// Tudo executa o JS real do front em sandbox com DOM falso, como
// dashboard-timers.test.ts já faz.
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
  style: Record<string, string>;
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
    style: {},
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

function buildSandbox(files: string[], extra: string, returns: string) {
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
  const factory = new Function('document', 'window', 'capturedCards', code + '\n' + extra + '\nreturn {' + returns + '};') as (
    doc: unknown,
    win: unknown,
    captured: unknown,
  ) => any;
  return { api: factory(document, window, []), els };
}

function textOf(node: FakeNode | undefined): string {
  if (!node) return '';
  const parts: string[] = [];
  parts.push(String(node.textContent || ''));
  for (const child of node.children || []) parts.push(textOf(child));
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// 3.4 — catalogo no poll (dashboard-catalog-panel.js)
// ---------------------------------------------------------------------------

const CATALOG_REPORT = {
  ok: true,
  report: {
    magnets: 7,
    ready: 5,
    works: { known: 4, unknown: 3 },
    byCached: { hit: 3, miss: 2, blocked: 1, unknown: 1 },
    byBucket: { dub: { count: 2, bytes: 2048 }, dual: { count: 1, bytes: 1024 } },
    totals: { count: 7, bytes: 4096 },
  },
};

test('3.4 catálogo: catalog.report do poll popula #catalog_report sem POST', () => {
  const { api, els } = buildSandbox(
    ['dashboard-core.js', 'dashboard-render.js', 'dashboard-catalog.js', 'dashboard-catalog-panel.js'],
    '',
    'renderCatalogPanel: renderCatalogPanel',
  );
  api.renderCatalogPanel({ catalog: CATALOG_REPORT });
  const flat = textOf(els.catalog_report);
  assert.match(flat, /Magnets/);
  assert.match(flat, / 7/);
  assert.match(flat, /Dublado/, 'tabela por balde renderizada');
  assert.match(flat, /⚡ hit: 3/, 'pills de cache medidas');
  assert.match(flat, /Totais: 7 magnets/, 'totais do relatório');
});

test('3.4 catálogo: indisponibilidade do poll vira erro com motivo; shape alheio não apaga a seção', () => {
  const { api, els } = buildSandbox(
    ['dashboard-core.js', 'dashboard-render.js', 'dashboard-catalog.js', 'dashboard-catalog-panel.js'],
    '',
    'renderCatalogPanel: renderCatalogPanel',
  );
  api.renderCatalogPanel({ catalog: { ok: false, reason: 'chave-operador-desativada', hint: 'ligue DEBRID_OPERATOR_ENV_ACCOUNT' } });
  assert.match(textOf(els.catalog_report), /DEBRID_OPERATOR_ENV_ACCOUNT/, 'hint do backend chega ao corpo');
  // Sem a chave catalog no payload (rota antiga) nada é sobrescrito.
  els.catalog_report.textContent = '';
  els.catalog_report.children.length = 0;
  api.renderCatalogPanel({ general: {} });
  assert.equal(textOf(els.catalog_report), '', 'sem catalog não mexe na seção');
});

test('3.4 catálogo: módulo do poll é somente leitura (sem fetch/requestJson/POST)', () => {
  const js = PUBLIC('dashboard-catalog-panel.js');
  assert.doesNotMatch(js, /\bfetch\b|requestJson|method:\s*"POST"/, 'o relatório do poll não dispara requisição');
  assert.doesNotMatch(js, ES6, 'ES5 puro (WebView de TV)');
  assert.doesNotMatch(js, /innerHTML/, 'dados só por textContent/appendChild');
  assert.doesNotMatch(js, /\bbind\s*\(\s*\)\s*;?\s*$/, 'declaração pura, nada roda no load');
});

test('3.4 catálogo: os 11 botões e IDs do painel são preservados', () => {
  const html = HTML();
  const ids = [
    'catalogScanBtn', 'catalogReportBtn', 'catalogAuditBtn', 'catalogRequeueBtn',
    'catalogDedupPreviewBtn', 'catalogDedupApplyBtn', 'catalogCleanupPreviewBtn',
    'catalogCleanupApplyBtn', 'catalogListBtn', 'catalogSelectAllBtn', 'catalogManualDeleteBtn',
  ];
  for (const id of ids) assert.match(html, new RegExp('id="' + id + '"'), id + ' preservado');
  const catalog = PUBLIC('dashboard-catalog.js');
  for (const fn of ['runCatalogDedupApply', 'runCatalogCleanupApply', 'runCatalogManualDelete']) {
    const idx = catalog.indexOf('function ' + fn);
    assert.ok(idx !== -1, fn + ' presente');
    assert.match(catalog.slice(idx, idx + 500), /window\.confirm/, fn + ' mantém confirmação');
  }
});

// ---------------------------------------------------------------------------
// 3.5 — diagnostico de stall do Chupim (dashboard-af-stall.js)
// ---------------------------------------------------------------------------

const AF_STALL = {
  pendingLocks: 2,
  searchSlots: { searches: 3, occupied: 4 },
  seasonSearchKeys: 5,
  searchesInFlight: 1,
  lots: [
    { id: 'abc123def456', hashes: 7, attempts: 2, isSettle: false, ageMs: 65000, refusals: 1, inFlight: true },
    { id: 'ffff00001111', hashes: 3, attempts: 4, isSettle: true, ageMs: 900000, refusals: 0, inFlight: false },
  ],
  skips: { 'account-gate': 3, budget: 2 },
  lastSkips: [
    { reason: 'budget', label: 'Coringa 1080p', pool: 'br', adapter: 'alldebrid', at: 1700000000000 },
  ],
};

test('3.5 stall: lots/slots/locks/skips povoam #afStallMetrics no Fake DOM', () => {
  const { api, els } = buildSandbox(
    ['dashboard-core.js', 'dashboard-render.js', 'dashboard-panels.js', 'dashboard-af-stall.js'],
    '',
    'renderAutofetchStall: renderAutofetchStall',
  );
  api.renderAutofetchStall(AF_STALL, 1000);
  const box = els.afStallMetrics;
  assert.match(textOf(box), /pendingLocks/);
  assert.match(textOf(box), /seasonSearchKeys/);
  assert.match(textOf(box), /searchesInFlight/);
  // Métricas de slot: 3 buscas e 4 ocupados.
  const flat = textOf(box);
  assert.match(flat, /searchSlots \(buscas\)/);
  assert.match(flat, / 3/);
  assert.match(flat, /searchSlots \(ocupados\)/);
  assert.match(flat, / 4/);
  // Tabela de lotes com os dois registros.
  const table = box.appended.filter((n) => n.className === 'timer-table')[0];
  assert.ok(table, 'tabela de lotes renderizada');
  assert.equal(table.children[1].children.length, 2);
  const flatLote = textOf(table);
  assert.match(flatLote, /abc123def456/);
  assert.match(flatLote, /recheck · em voo/);
  assert.match(flatLote, /settle/);
  // Skips e última desistência.
  assert.match(flat, /desistências registradas/);
  assert.match(flat, /budget/);
  assert.match(flat, /Coringa 1080p/);
});

test('3.5 stall: renderAutofetchPanel faz o wiring do painel de stall', () => {
  const { api, els } = buildSandbox(
    ['dashboard-core.js', 'dashboard-render.js', 'dashboard-panels.js', 'dashboard-autofetch.js', 'dashboard-af-stall.js'],
    '',
    'renderAutofetchPanel: renderAutofetchPanel',
  );
  api.renderAutofetchPanel({ config: { effective: {}, envDefaults: {}, overriddenKeys: [] }, lots: AF_STALL.lots, pendingLocks: 1 }, 1000);
  assert.match(textOf(els.afStallMetrics), /lotes recheck/);
  assert.ok(els.afStallMetrics.appended.some((n) => n.className === 'timer-table'), 'tabela no painel do Chupim');
  // Os IDs af_* e o formulário permanecem intactos.
  const html = HTML();
  for (const id of ['afMetricState', 'afMetricGate', 'af_autoFetchBr', 'af_autoFetchMax', 'afSaveBtn']) {
    assert.match(html, new RegExp('id="' + id + '"'), id + ' preservado');
  }
});

test('3.5 stall: módulo ES5, sem innerHTML e sem execução no load', () => {
  const js = PUBLIC('dashboard-af-stall.js');
  assert.doesNotMatch(js, ES6, 'ES5 puro');
  assert.doesNotMatch(js, /innerHTML/, 'dados só por textContent/appendChild');
  assert.doesNotMatch(js, /\bbind\s*\(\s*\)\s*;?\s*$/, 'declaração pura');
});

// ---------------------------------------------------------------------------
// 3.6 — memoria/servicos/contadores (dashboard-general.js)
// ---------------------------------------------------------------------------

const GENERAL_ROOT = {
  general: {
    ok: true,
    uptimeS: 1200,
    memory: { rss: 104857600, heapUsed: 52428800, heapTotal: 73400320 },
    services: { addon: true, jackett: 'naomedido', debrid: true, resolvers: 5 },
  },
  metrics: {
    counters: { 'debrid.cleanup.protectedBrSkipped': 11, 'debrid.instant.fromAliveAsCache': 4 },
  },
  magnetdb: { counters: { dropped: 9, droppedBad: 2 } },
  releaseIndex: { wastedQueries: 30, wastedMs: 4200, wastedQueriesBackground: 12, wastedMsBackground: 800 },
};

test('3.6 geral: memória, serviços tri-estado e contadores órfãos em #generalDiagnostics', () => {
  const { api, els } = buildSandbox(
    ['dashboard-core.js', 'dashboard-render.js', 'dashboard-panels.js', 'dashboard-general.js'],
    '',
    'renderGeneralDiagnostics: renderGeneralDiagnostics',
  );
  api.renderGeneralDiagnostics(GENERAL_ROOT);
  const flat = textOf(els.generalDiagnostics);
  assert.match(flat, /Memória do processo/);
  assert.match(flat, /RSS 100 MB/, 'RSS formatado');
  assert.match(flat, /Heap usado 50 MB/, 'heap usado formatado');
  assert.match(flat, /Heap total 70 MB/, 'heap total formatado');
  assert.match(flat, /Serviços/);
  assert.match(flat, /não medido/, 'jackett tri-estado não vira sim/não');
  assert.match(flat, /resolvers embutidos/);
  assert.match(flat, /protectedBrSkipped/);
  assert.match(flat, / 11/);
  assert.match(flat, /fromAliveAsCache/);
  assert.match(flat, /magnetdb\.counters\.dropped/);
  assert.match(flat, / 9/);
  assert.match(flat, /wastedQueries/);
  assert.match(flat, / 30/);
  assert.match(flat, /wastedQueries\.background/);
  assert.match(flat, / 12/);
  assert.match(flat, /wastedMs/);
  assert.match(flat, /fundo|background/);
});

test('3.6 geral: renderGeneral faz o wiring do painel de processo', () => {
  const { api, els } = buildSandbox(
    ['dashboard-core.js', 'dashboard-render.js', 'dashboard-panels.js', 'dashboard-general.js'],
    '',
    'renderGeneral: renderGeneral',
  );
  api.renderGeneral(GENERAL_ROOT);
  assert.match(textOf(els.generalDiagnostics), /Memória do processo/);
});

test('3.6 geral: módulo ES5, sem innerHTML e sem execução no load', () => {
  const js = PUBLIC('dashboard-general.js');
  assert.doesNotMatch(js, ES6, 'ES5 puro');
  assert.doesNotMatch(js, /innerHTML/, 'dados só por textContent/appendChild');
  assert.doesNotMatch(js, /\bbind\s*\(\s*\)\s*;?\s*$/, 'declaração pura');
});

// ---------------------------------------------------------------------------
// 3.7 — resolver nunca medido (renderSources)
// ---------------------------------------------------------------------------

function loadResolverApi(): { renderSources: (data: any) => void; captured: any[] } {
  const core = PUBLIC('dashboard-core.js');
  const render = PUBLIC('dashboard-render.js');
  const panels = PUBLIC('dashboard-panels.js');
  const captured: any[] = [];
  const stubs = 'function card(container, item) { capturedCards.push(item); }';
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
  const factory = new Function('document', 'window', 'capturedCards', core + '\n' + render + '\n' + panels + '\n' + stubs + '\nreturn { renderSources: renderSources };') as (
    doc: unknown,
    win: unknown,
    captured: unknown,
  ) => { renderSources: (data: any) => void };
  return { renderSources: factory(document, window, captured).renderSources, captured };
}

test('3.7 resolvers: sem status/lastMs/lastError o card diz "nunca medido"', () => {
  const { renderSources, captured } = loadResolverApi();
  renderSources({
    general: { uptimeS: 1000 },
    resolvers: [
      { id: 'vacatorrent', label: 'Vaca Torrent', port: 8703, embedded: true, domain: 'vaqueirofilmes.com' },
      { id: 'nerdfilmes', label: 'NerdFilmes', status: 'ok', lastMs: 800, lastError: null, results: 7 },
    ],
  });
  const byId = (id: string) => captured.filter((item: any) => item && item.id === id).pop();
  const never = byId('vacatorrent');
  assert.equal(never.status, 'naomedido', 'estado não medido');
  assert.match(String(never.lastMs), /nunca medido neste processo/);
  assert.match(String(never.lastError), /nunca medido neste processo/);
  const medido = byId('nerdfilmes');
  assert.equal(medido.status, 'ok');
  assert.equal(medido.lastMs, 800);
  assert.equal(medido.lastError, '—', 'medido sem erro não vira "nunca medido"');
});

test('3.7 resolvers: AMOSTRA_CEDO_S distingue processo recém-iniciado de nunca medido', () => {
  const { renderSources, captured } = loadResolverApi();
  renderSources({ general: { uptimeS: 50 }, resolvers: [{ id: 'bludv', label: 'BluDV' }] });
  assert.match(String(captured[0].lastMs), /recém-iniciado|recém-iniciad/);
  assert.match(String(captured[0].lastMs), /nunca medido/);
});

test('3.7 resolvers: _origem lastMs=naomedido vence um lastMs residual', () => {
  const { renderSources, captured } = loadResolverApi();
  renderSources({
    general: { uptimeS: 1000 },
    resolvers: [{ id: 'torrentdosfilmes', label: 'Torrent dos Filmes', _origem: { lastMs: 'naomedido' }, lastMs: 555 }],
  });
  assert.equal(captured[0].status, 'naomedido');
  assert.match(String(captured[0].lastMs), /nunca medido neste processo/);
});

// ---------------------------------------------------------------------------
// Metadados: HTML, allowlist e ordem de scripts
// ---------------------------------------------------------------------------

test('fase 3B: HTML tem os containers novos e a allowlist ganhou os módulos', () => {
  const html = HTML();
  assert.match(html, /id="generalDiagnostics"/);
  assert.match(html, /id="afStallMetrics"/);
  for (const asset of ['dashboard-general.js', 'dashboard-af-stall.js', 'dashboard-catalog-panel.js']) {
    assert.ok(PAGE_ASSETS.includes(asset), asset + ' na allowlist fechada');
    assert.match(html, new RegExp('src="/' + asset.replace('.', '\\.') + '"'));
  }
});

test('fase 3B: ordem de scripts — novos módulos depois de timers, boot por último', () => {
  const html = HTML();
  const idx = (name: string) => html.lastIndexOf('/' + name);
  const timers = idx('dashboard-timers.js');
  const general = idx('dashboard-general.js');
  const afStall = idx('dashboard-af-stall.js');
  const catalogPanel = idx('dashboard-catalog-panel.js');
  const boot = idx('dashboard-boot.js');
  assert.ok(timers < general && general < boot, 'general entre timers e boot');
  assert.ok(timers < afStall && afStall < boot, 'af-stall entre timers e boot');
  assert.ok(timers < catalogPanel && catalogPanel < boot, 'catalog-panel entre timers e boot');
});

test('fase 3B: dashboard.html permanece ES5 (sem scripts inline)', () => {
  const html = HTML();
  assert.doesNotMatch(html, ES6, 'HTML ES5');
  assert.doesNotMatch(html, /function (?:renderGeneralDiagnostics|renderAutofetchStall|renderCatalogPanel)\(/, 'sem inline');
});
