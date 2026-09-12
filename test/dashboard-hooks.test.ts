import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PAGE_ASSETS } from '../src/routes/public.js';

// ---------------------------------------------------------------------------
// Fase 1 + Fase 2 do saneamento do dashboard — quebra das dependências
// cíclicas/para-frente por injeção explícita via DashHooks (dashboard-hooks.js)
// e centralização do estado mutável em DashState (dashboard-state.js).
//
// O que este arquivo fixa:
//   1. O registro existe, é ES5 e é o PRIMEIRO script da página (os módulos
//      se registram no próprio load); o estado (DashState) carrega logo
//      depois, antes de qualquer consumidor;
//   2. A composição COMPLETA (todos os módulos de declaração, sem o boot)
//      registra o conjunto fechado de hooks e o call() FALHA ALTO em hook
//      obrigatório ausente — no-op silencioso mascarava composição quebrada;
//   3. As arestas mascaradas por typeof sumiram dos consumidores, os
//      consumidores de loadStatus não citam mais o símbolo global e NENHUM
//      consumidor chama o símbolo do provedor com argumentos (o hook é o
//      único caminho entre módulos; wiring fica no boot);
//   4. As guardas de capacidade REALMENTE opcional continuam no lugar
//      (AbortController, scrollIntoView, closest e o guard de element() no
//      renderSectionNav, que cobre o sandbox core+nav);
//   5. Comportamento: switchTab desenha a aba recém-ativada via hook
//      (rerenderActiveTab fecha sobre DashState.lastStatusRoot) e o card()
//      dispara as sondas por hook.
// ---------------------------------------------------------------------------

const P = (name: string) => readFileSync(new URL('../src/public/' + name, import.meta.url), 'utf8');
const HTML = () => P('dashboard.html');
const ES6 = /\b(?:const|let)\b|=>|\?\.|\?\?/;

const CONSUMERS_LOADSTATUS = [
  'dashboard-probes.js',
  'dashboard-health.js',
  'dashboard-autofetch.js',
  'dashboard-harvest.js',
  'dashboard-harvest-debrid.js',
  'dashboard-catalog.js',
  'dashboard-magnets.js',
];

// O conjunto fechado de hooks da página: nome → módulo provedor.
const HOOK_GRAPH: Array<[string, string]> = [
  ['loadStatus', 'dashboard-status.js'],
  ['rerenderActiveTab', 'dashboard-status.js'],
  ['activeTabName', 'dashboard-nav.js'],
  ['renderHealthStrip', 'dashboard-health.js'],
  ['renderAttentionStrip', 'dashboard-health.js'],
  ['updateEmptyState', 'dashboard-health.js'],
  ['dashDebugEnabled', 'dashboard-health.js'],
  ['runIndexerTest', 'dashboard-probes.js'],
  ['runResolverTest', 'dashboard-probes.js'],
  ['renderGeneralDiagnostics', 'dashboard-general.js'],
  ['renderTimersPanel', 'dashboard-timers.js'],
  ['renderF3Panel', 'dashboard-f3.js'],
  ['renderCatalogPanel', 'dashboard-catalog-panel.js'],
  ['renderCatalogReport', 'dashboard-catalog.js'],
  ['renderAutofetchStall', 'dashboard-af-stall.js'],
];

// ---------------------------------------------------------------------------
// 1 — O registro e a página
// ---------------------------------------------------------------------------

test('dashboard-hooks.js: registro ES5, sem innerHTML, com register/has/call', () => {
  const js = P('dashboard-hooks.js');
  assert.match(js, /var DashHooks = \{/);
  assert.match(js, /register: function \(name, fn\)/);
  assert.match(js, /has: function \(name\)/);
  assert.match(js, /call: function \(name\)/);
  assert.doesNotMatch(js, ES6, 'ES5 puro (WebView de TV)');
  assert.doesNotMatch(js, /innerHTML/, 'dados só por textContent/appendChild');
});

test('PAGE_ASSETS inclui hooks e estado; o HTML carrega hooks → estado → core', () => {
  assert.ok(PAGE_ASSETS.includes('dashboard-hooks.js'), 'allowlist fechada: asset novo precisa de registro');
  assert.ok(PAGE_ASSETS.includes('dashboard-state.js'), 'estado compartilhado (Fase 2) na allowlist');
  const html = HTML();
  const hooks = html.lastIndexOf('/dashboard-hooks.js');
  const state = html.lastIndexOf('/dashboard-state.js');
  const core = html.lastIndexOf('/dashboard-core.js');
  const boot = html.lastIndexOf('/dashboard-boot.js');
  assert.ok(hooks !== -1 && hooks < core, 'hooks é o primeiro script (os módulos se registram no load)');
  assert.ok(state !== -1 && hooks < state && state < core, 'DashState carrega antes de qualquer consumidor');
  assert.ok(core > 0 && core < boot, 'ordem base preservada: core antes do boot');
});

// ---------------------------------------------------------------------------
// 2 — Composição completa: o conjunto fechado de hooks registrados
// ---------------------------------------------------------------------------

// Todos os módulos de declaração, na ordem do HTML — EXCETO o boot (o único
// que roda wiring de DOM). Nada aqui toca rede: o load só declara funções e
// escreve no registro DashHooks.
const FULL_COMPOSITION = [
  'dashboard-hooks.js', 'dashboard-state.js', 'dashboard-core.js', 'dashboard-render.js',
  'dashboard-panels.js', 'dashboard-status.js', 'dashboard-probes.js',
  'dashboard-debrid-test.js', 'dashboard-trace.js', 'dashboard-autofetch.js',
  'dashboard-harvest.js', 'dashboard-harvest-debrid.js', 'dashboard-f3.js',
  'dashboard-catalog.js', 'dashboard-magnets.js', 'dashboard-nav.js',
  'dashboard-health.js', 'dashboard-timers.js', 'dashboard-general.js',
  'dashboard-af-stall.js', 'dashboard-catalog-panel.js',
];

test('composição completa registra exatamente o conjunto fechado de hooks (sem o boot)', () => {
  const code = FULL_COMPOSITION.map(P).join('\n') + '\nreturn DashHooks;';
  const factory = new Function('document', 'window', code) as (doc: unknown, win: unknown) => any;
  const DashHooks = factory(
    { getElementById: () => null, createElement: () => ({}), addEventListener: () => {} },
    { location: { pathname: '/dashboard' }, localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, addEventListener: () => {} },
  );
  // Todo hook do grafo está registrado pelo módulo certo.
  for (const [name] of HOOK_GRAPH) {
    assert.ok(DashHooks.has(name), 'hook registrado: ' + name);
  }
  // Fase 2 (revisão da Fase 1): hook OBRIGATÓRIO ausente falha ALTO — call
  // lança com o nome, em vez de devolver undefined como no-op silencioso.
  assert.equal(DashHooks.has('hook-inexistente'), false);
  assert.throws(() => DashHooks.call('hook-inexistente'), /hook obrigatório ausente: hook-inexistente/);
});

test('cada register mora no arquivo provedor do hook (grafo declarado na origem)', () => {
  for (const [name, provider] of HOOK_GRAPH) {
    const js = P(provider);
    assert.match(js, new RegExp('DashHooks\\.register\\("' + name + '"'), provider + ' registra ' + name);
  }
});

// ---------------------------------------------------------------------------
// 3 — As guardas-máscara sumiram; consumidores não citam o símbolo alheio
// ---------------------------------------------------------------------------

test('status.js não referencia mais por typeof os módulos que consome por hook', () => {
  const status = P('dashboard-status.js');
  for (const name of ['renderTimersPanel', 'renderF3Panel', 'renderCatalogPanel', 'activeTabName', 'dashDebugEnabled', 'renderHealthStrip', 'renderAttentionStrip', 'updateEmptyState']) {
    assert.doesNotMatch(status, new RegExp('typeof ' + name + '\\b'), 'guarda-máscara removida: ' + name);
  }
});

test('nav.js fecha o ciclo status↔nav pelo hook, sem citar símbolo do status', () => {
  const nav = P('dashboard-nav.js');
  assert.doesNotMatch(nav, /typeof renderActivePanels\b/, 'guarda-máscara removida: renderActivePanels');
  assert.doesNotMatch(nav, /typeof lastStatusRoot\b/, 'guarda-máscara removida: lastStatusRoot');
  assert.match(nav, /DashHooks\.call\("rerenderActiveTab"\)/);
  // renderSectionNav/markActiveSection são do PRÓPRIO arquivo (hoisting):
  // chamada direta, sem guarda morta.
  assert.doesNotMatch(nav, /typeof renderSectionNav\b/);
  assert.doesNotMatch(nav, /typeof markActiveSection\b/);
});

test('render→probes e panels→general/autofetch→af-stall/catalog-panel→catalog são hooks', () => {
  const render = P('dashboard-render.js');
  assert.match(render, /DashHooks\.call\("runIndexerTest"/);
  assert.match(render, /DashHooks\.call\("runResolverTest"/);
  const panels = P('dashboard-panels.js');
  assert.match(panels, /DashHooks\.call\("renderGeneralDiagnostics"/);
  assert.doesNotMatch(panels, /typeof renderGeneralDiagnostics\b/);
  const autofetch = P('dashboard-autofetch.js');
  assert.match(autofetch, /DashHooks\.call\("renderAutofetchStall"/);
  assert.doesNotMatch(autofetch, /typeof renderAutofetchStall\b/);
  const catalogPanel = P('dashboard-catalog-panel.js');
  assert.match(catalogPanel, /DashHooks\.call\("renderCatalogReport"/);
  assert.match(catalogPanel, /DashHooks\.has\("renderCatalogReport"\)/, 'has() mantém o early-return da guarda antiga');
  assert.doesNotMatch(catalogPanel, /typeof renderCatalogReport\b/);
});

test('nenhum consumidor cita loadStatus como global; status segue dono exclusivo', () => {
  for (const file of CONSUMERS_LOADSTATUS) {
    const js = P(file);
    assert.match(js, /DashHooks\.call\("loadStatus"\)/, file + ' pede o refresh pelo hook');
  }
  const status = P('dashboard-status.js');
  assert.match(status, /function loadStatus\(/, 'status mantém a definição');
  assert.match(status, /DashHooks\.register\("loadStatus", loadStatus\)/);
});

// Revisão da Fase 1: o teste antigo só barrava a chamada direta SEM
// argumentos (`runIndexerTest()`), então uma regressão `runIndexerTest(id, b)`
// passava verde. Hoje o hook é o ÚNICO caminho entre módulos: nenhum arquivo
// pode citar o símbolo do provedor seguido de parêntese — exceto o provedor
// (definição/uso interno) e o boot (wiring contratado, documentado em
// probes.js: "o boot segue ligando o botão do formulário direto").
// O casamento roda SEM comentários: o contrato é sobre código; prosa que
// cita "loadStatus (dashboard-status.js)" não é chamada.
test('nenhum módulo chama hook alheio direto — com ou sem argumentos (hook é o caminho)', () => {
  const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const files = FULL_COMPOSITION.concat(['dashboard-boot.js']);
  for (const [name, provider] of HOOK_GRAPH) {
    const direct = new RegExp('\\b' + name + '\\s*\\(');
    for (const file of files) {
      if (file === provider || file === 'dashboard-boot.js' || file === 'dashboard-hooks.js') continue;
      assert.doesNotMatch(stripComments(P(file)), direct, file + ' não pode chamar ' + name + '() direto — use DashHooks.call');
    }
  }
});

// ---------------------------------------------------------------------------
// 3b — Estado compartilhado (Fase 2): DashState é o dono único
// ---------------------------------------------------------------------------

const STATE_KEYS = ['token', 'refreshTimer', 'lastUpdatedTimer', 'requestInFlight', 'consecutiveFailures', 'lastOkAt', 'lastStatusRoot'];

test('dashboard-state.js: dono único das sete chaves; consumidores mutam propriedades, não o binding', () => {
  const state = P('dashboard-state.js');
  assert.match(state, /var DashState = \{/);
  for (const key of STATE_KEYS) {
    assert.match(state, new RegExp('\\b' + key + ':'), 'chave do estado: ' + key);
  }
  assert.doesNotMatch(state, ES6, 'ES5 puro (WebView de TV)');
  const files = FULL_COMPOSITION.concat(['dashboard-boot.js']);
  for (const file of files) {
    if (file === 'dashboard-state.js') continue;
    const js = P(file);
    // O binding antigo sumiu de todo módulo: o caminho é DashState.token.
    assert.doesNotMatch(js, /\bcurrentToken\b/, file + ': currentToken virou DashState.token (Fase 2)');
    // Invariante do estado compartilhado: mutar PROPRIEDADES, nunca
    // reatribuir o binding importado (quebraria os outros módulos em silêncio).
    assert.doesNotMatch(js, /\bDashState\s*=[^=]/, file + ' não reatribui o objeto DashState');
  }
});

// ---------------------------------------------------------------------------
// 4 — Guardas de capacidade REALMENTE opcional preservadas
// ---------------------------------------------------------------------------

test('guardas de capacidade opcional continuam no lugar (não eram máscaras)', () => {
  assert.match(P('dashboard-core.js'), /typeof AbortController !== "undefined"/, 'AbortController é capacidade da plataforma');
  const nav = P('dashboard-nav.js');
  assert.match(nav, /typeof target\.scrollIntoView === "function"/, 'scrollIntoView é capacidade do nó');
  assert.match(nav, /typeof node\.closest === "function"/, 'closest é capacidade do nó');
  assert.match(nav, /typeof element !== "function"/, 'guard de element() cobre o sandbox core+nav sem desenho');
  // E o boot continua com o wiring fail-open testado (contrato do collapse).
  const boot = P('dashboard-boot.js');
  assert.match(boot, /typeof bindMagnetPanel === "function"/);
  assert.match(boot, /typeof initSectionToggles === "function"\) initSectionToggles\(\)/);
});

// ---------------------------------------------------------------------------
// 5 — Comportamento: os hooks ligam os lados de verdade
// ---------------------------------------------------------------------------

interface FakeNode {
  className: string;
  textContent: string;
  attrs: Record<string, string>;
  children: FakeNode[];
  appended: FakeNode[];
  listeners: Record<string, Array<() => void>>;
  appendChild(child: FakeNode): FakeNode;
  addEventListener(type: string, fn: () => void): void;
  setAttribute(key: string, value: string): void;
  getAttribute(key: string): string | null;
}

function fakeNode(): FakeNode {
  const node: FakeNode = {
    className: '',
    textContent: '',
    attrs: {},
    children: [],
    appended: [],
    listeners: {},
    appendChild(child) { node.appended.push(child); node.children.push(child); return child; },
    addEventListener(type, fn) { (node.listeners[type] = node.listeners[type] || []).push(fn); },
    setAttribute(key, value) { node.attrs[key] = value; },
    getAttribute(key) { return node.attrs[key] ?? null; },
  };
  return node;
}

test('switchTab desenha a aba recém-ativada com o ÚLTIMO payload, via rerenderActiveTab', () => {
  const els: Record<string, FakeNode> = {};
  const document = {
    hidden: false,
    getElementById: (id: string) => (els[id] = els[id] || fakeNode()),
    createElement: () => fakeNode(),
    createTextNode: (text: string) => ({ text }),
    addEventListener: () => {},
  };
  const window = { location: { pathname: '/dashboard', hash: '', search: '' }, addEventListener: () => {}, pageYOffset: 0, localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } };
  // Composição mínima: hooks + estado + core + render + status + nav + stubs.
  // Fase 2 (revisão da Fase 1): call() falha alto em hook obrigatório
  // ausente, então os hooks SEM provedor nesta composição mínima (health,
  // timers, f3, catalog-panel) precisam de registro stubado — os stubs
  // "function ..." soltos nunca eram chamados (o consumo é por DashHooks).
  const stubs = [
    'function renderGeneral() {}', 'function renderDebrid() {}', 'function renderSources() {}',
    'function renderCache() {}', 'function renderMagnetDb() {}', 'function renderReleaseIndex() {}',
    'function renderHarvest() {}', 'function renderAutofetchPanel() { rendered.af += 1; }',
    'function renderHarvesterPanel() { rendered.col += 1; }', 'function drawSparkline() {}',
    'function pushSeries() { return []; }', 'function updateLastUpdated() {}',
    'function updateActionAvailability() {}', 'var rendered = { af: 0, col: 0 };',
    'DashHooks.register("dashDebugEnabled", function () { return false; });',
    'DashHooks.register("renderHealthStrip", function () {}); DashHooks.register("renderAttentionStrip", function () {});',
    'DashHooks.register("updateEmptyState", function () {});',
    'DashHooks.register("renderTimersPanel", function () {}); DashHooks.register("renderF3Panel", function () {});',
    'DashHooks.register("renderCatalogPanel", function () {});',
  ].join('\n');
  const factory = new Function(
    'document', 'window',
    FULL_COMPOSITION.slice(0, 6).map(P).join('\n') + '\n' + P('dashboard-nav.js') + '\n' + stubs +
    '\nreturn { renderStatus: renderStatus, switchTab: switchTab, counts: rendered };',
  ) as (doc: unknown, win: unknown) => any;
  const api = factory(document, window);
  for (const id of ['tabGeral', 'tabAutofetch', 'tabColhedor', 'tabTrace', 'viewGeral', 'viewAutofetch', 'viewColhedor', 'viewTrace']) {
    els[id] = els[id] || fakeNode();
  }
  els['tabGeral'].className = 'tab-btn active';
  api.renderStatus({ ok: true, general: { uptimeS: 10 }, metrics: { counters: {} } });
  assert.equal(api.counts.af, 0, 'aba oculta não desenha no poll');
  api.switchTab('autofetch');
  assert.equal(api.counts.af, 1, 'troca de aba desenha pelo hook rerenderActiveTab (lastStatusRoot)');
  assert.equal(api.counts.col, 0);
});

test('card() testável dispara a sonda pelo hook — render não conhece probes', () => {
  const els: Record<string, FakeNode> = {};
  const document = {
    getElementById: (id: string) => (els[id] = els[id] || fakeNode()),
    createElement: () => fakeNode(),
    createTextNode: (text: string) => ({ text }),
    addEventListener: () => {},
  };
  const window = { location: { pathname: '/dashboard' }, addEventListener: () => {}, localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } };
  const factory = new Function(
    'document', 'window',
    FULL_COMPOSITION.slice(0, 4).map(P).join('\n') + '\nreturn { card: card, DashHooks: DashHooks };',
  ) as (doc: unknown, win: unknown) => any;
  const api = factory(document, window);
  const calls: string[] = [];
  api.DashHooks.register('runIndexerTest', (id: string) => calls.push('indexer:' + id));
  api.DashHooks.register('runResolverTest', (id: string) => calls.push('resolver:' + id));
  const box = fakeNode();
  api.card(box, { id: 'bludv-cardigann', label: 'BLUDV' }, { testable: true });
  api.card(box, { id: 'vacatorrent', label: 'Vaca Torrent' }, { testable: true, kind: 'resolver' });
  // O botão nasce DENTRO do details.card (box do card), não no container.
  const buttons: FakeNode[] = [];
  for (const cardBox of box.appended) {
    for (const child of cardBox.appended) {
      if (child.className === 'mini-action') buttons.push(child);
    }
  }
  assert.equal(buttons.length, 2, 'dois botões de teste criados');
  (buttons[0].listeners.click[0] as () => void)();
  (buttons[1].listeners.click[0] as () => void)();
  assert.deepEqual(calls, ['indexer:bludv-cardigann', 'resolver:vacatorrent'], 'clique chega ao provedor pelo registro');
});
