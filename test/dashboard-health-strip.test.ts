import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.CACHE_PERSIST = 'false';

import { createApp } from '../src/app.js';
import config from '../src/config.js';
import { createTestServer } from './e2e/e2e-harness.js';
import { PAGE_ASSETS } from '../src/routes/public.js';

// ---------------------------------------------------------------------------
// Fase 2 do redesign do dashboard (2.1–2.5): faixa sticky de sinais vitais,
// faixa de atenção reutilizando collectStatusIssues, estado vazio honesto sem
// token, nav de âncoras por aba e renderização SOMENTE da aba ativa com o
// último payload. Tudo executa o JS real do front em sandbox com DOM falso —
// o padrão já estabelecido por dashboard-panel-runtime/dashboard-nav.
// ---------------------------------------------------------------------------

let server: any;
let savedToken: string;

before(async () => {
  savedToken = config.jackett.testToken;
  config.jackett.testToken = '';
  server = await createTestServer(createApp().app);
});

after(async () => {
  await server.close();
  config.jackett.testToken = savedToken;
});

const CORE = () => readFileSync(new URL('../src/public/dashboard-core.js', import.meta.url), 'utf8');
const RENDER = () => readFileSync(new URL('../src/public/dashboard-render.js', import.meta.url), 'utf8');
const STATUS = () => readFileSync(new URL('../src/public/dashboard-status.js', import.meta.url), 'utf8');
const HEALTH = () => readFileSync(new URL('../src/public/dashboard-health.js', import.meta.url), 'utf8');
const NAV = () => readFileSync(new URL('../src/public/dashboard-nav.js', import.meta.url), 'utf8');
const HTML = () => readFileSync(new URL('../src/public/dashboard.html', import.meta.url), 'utf8');
const CSS = () => readFileSync(new URL('../src/public/dashboard.css', import.meta.url), 'utf8');

interface FakeNode {
  className: string;
  textContent: string;
  hidden: boolean;
  title: string;
  type: string;
  /** Nó de texto (createTextNode): só o texto cru. */
  text?: string;
  children: FakeNode[];
  attrs: Record<string, string>;
  appended: FakeNode[];
  appendChild(child: FakeNode): FakeNode;
  addEventListener(type: string, fn: () => void): void;
  setAttribute(key: string, value: string): void;
  getAttribute(key: string): string | null;
  removeAttribute(key: string): void;
  scrollIntoView(): void;
}

function fakeNode(): FakeNode {
  const node: FakeNode = {
    className: '',
    textContent: '',
    hidden: false,
    title: '',
    type: '',
    children: [],
    attrs: {},
    appended: [],
    appendChild(child: FakeNode) { node.appended.push(child); node.children.push(child); return child; },
    addEventListener() { /* binding coberto por teste de wiring */ },
    setAttribute(key, value) { node.attrs[key] = value; },
    getAttribute(key) { return node.attrs[key] ?? null; },
    removeAttribute() { /* título ausente no sinal neutro */ },
    scrollIntoView() { /* asserção de scroll usa chamadas registradas */ },
  };
  return node;
}

function buildSandbox(options: { nav?: boolean; stubs?: string[] } = {}) {
  const els: Record<string, FakeNode> = {};
  const document = {
    hidden: false,
    getElementById: (id: string) => (els[id] = els[id] || fakeNode()),
    createElement: () => fakeNode(),
    createTextNode: (text: string) => ({ text }),
    addEventListener: () => {},
  };
  const location = { pathname: '/dashboard', hash: '', search: '' };
  const window = { location, addEventListener: () => {}, pageYOffset: 0, confirm: () => false };
  const localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  (window as any).localStorage = localStorage;
  const base = CORE() + '\n' + RENDER() + '\n' + STATUS() + '\n' + HEALTH() + '\n' +
    (options.nav ? NAV() + '\n' : '') +
    (options.stubs || []).join('\n');
  const factory = new Function(
    'document', 'window',
    base + '\nreturn { renderStatus: renderStatus, renderHealthStrip: renderHealthStrip, renderAttentionStrip: renderAttentionStrip, collectStatusIssues: collectStatusIssues, updateEmptyState: updateEmptyState, saveEmptyToken: saveEmptyToken, renderActivePanels: renderActivePanels, setToken: function (t) { currentToken = String(t || ""); }, activeTabName: typeof activeTabName === "function" ? activeTabName : null, switchTab: typeof switchTab === "function" ? switchTab : null, renderSectionNav: typeof renderSectionNav === "function" ? renderSectionNav : null };',
  ) as (doc: unknown, win: unknown) => any;
  return { api: factory(document, window), els, location, window };
}

const PANEL_STUBS = [
  'function renderGeneral() {}',
  'function renderDebrid() {}',
  'function renderSources() {}',
  'function renderCache() {}',
  'function renderMagnetDb() {}',
  'function renderReleaseIndex() {}',
  'function renderHarvest() {}',
  'function renderF3Panel() {}',
  'function renderAutofetchPanel() { rendered.autofetch += 1; }',
  'function renderHarvesterPanel() { rendered.colhedor += 1; }',
  'function drawSparkline() {}',
  'function pushSeries() { return []; }',
  'function updateLastUpdated() {}',
  'function updateActionAvailability() {}',
  'var rendered = { autofetch: 0, colhedor: 0, geral: 0 };',
  'var renderGeneralOriginal = renderGeneral;',
  'renderGeneral = function () { rendered.geral += 1; renderGeneralOriginal.apply(this, arguments); };',
];

const PAYLOAD = {
  ok: true,
  status: 'online',
  general: { uptimeS: 1200 },
  metrics: { counters: { 'debrid.check.cached': 30, 'debrid.check.hashes': 100, 'davail.servedHashes': 55 } },
  cache: { hitRate: 0.42, entries: 12, maxEntries: 84000, l2: { fileSizeBytes: 2048 } },
  debrid: { account: { service: 'alldebrid', label: 'AllDebrid', ok: true, magnets: 652, ready: 639, active: 9, error: 4 } },
  autofetch: { queues: { count: 2, items: 5 }, recheckLots: 1, settleLots: 0, budget: { used: 3, limit: 30 }, paused: false },
  searchFirst: { responses: 8, brFound: 5, brCached: 2, brHidden: 1, brVisible: 4, brLate: 1 },
  indexers: [], resolvers: [],
};

// ---------------------------------------------------------------------------
// 2.1 — Faixa de sinais vitais
// ---------------------------------------------------------------------------

test('faixa de saúde: taxa ⚡ usa debrid.check.cached/hashes e exclui davail.servedHashes', () => {
  const { api, els } = buildSandbox();
  api.renderHealthStrip(PAYLOAD);
  const strip = els['healthStrip'];
  assert.equal(strip.appended.length, 6, 'seis sinais vitais');
  const rate = strip.appended[0];
  const rateValue = String(rate.appended[1].appended[1].text ?? '');
  assert.equal(rateValue, '30%', '30 de 100 hashes = 30% (não 85% com davail somado)');
  assert.match(rate.title, /davail/);
  assert.match(rate.title, /fora da taxa/);
});

test('faixa de saúde: seis sinais com semáforo e detalhe em title', () => {
  const { api, els } = buildSandbox();
  api.renderHealthStrip(PAYLOAD);
  const cells = els['healthStrip'].appended;
  const keys = cells.map((c: FakeNode) => c.appended[0].textContent);
  assert.deepEqual(keys, ['Taxa ⚡', 'Conta debrid', 'Indexers', 'Cache', 'Chupim', '1ª resposta (I0)']);
  for (const cell of cells) {
    assert.match(cell.className, /health-cell state-(online|warn|error|unknown)/, 'semáforo por estado');
    assert.ok(cell.title.length > 0, 'detalhe em title: ' + cell.title);
  }
  assert.ok(cells[0].title.indexOf('davail') !== -1, 'taxa ⚡ explica o que fica fora da taxa');
  // Conta saudável = verde; Chupim ativo com filas = verde; I0 com respostas = verde.
  assert.match(cells[1].className, /state-online/);
  assert.match(cells[4].className, /state-online/);
  assert.match(cells[5].className, /state-online/);
  assert.match(String(cells[4].appended[1].appended[1].text ?? ''), /2 fila\(s\)/);
});

test('faixa de saúde: conta com warn pinta amarelo; conta ok:false pinta vermelho', () => {
  const warn = buildSandbox();
  warn.api.renderHealthStrip({
    debrid: { account: { service: 'alldebrid', ok: true, warn: true, warnAt: 4000, warnAtUnit: 'magnets', magnets: 3900 } },
  });
  assert.match(warn.els['healthStrip'].appended[1].className, /state-warn/);
  assert.match(warn.els['healthStrip'].appended[1].title, /aviso operacional/);

  const erro = buildSandbox();
  erro.api.renderHealthStrip({ debrid: { account: { service: 'alldebrid', ok: false, reason: 'quota' } } });
  assert.match(erro.els['healthStrip'].appended[1].className, /state-error/);
});

test('faixa de saúde: payload vazio renderiza seis sinais em "não medido" sem lançar', () => {
  const { api, els } = buildSandbox();
  assert.doesNotThrow(() => api.renderHealthStrip({}));
  const cells = els['healthStrip'].appended;
  assert.equal(cells.length, 6);
  assert.match(cells[0].className, /state-unknown/);
  assert.equal(cells[0].appended[1].appended[1].text, '—');
});

// ---------------------------------------------------------------------------
// 2.1 — Faixa de atenção reutiliza collectStatusIssues (mesmos 4 vetores do
// banner + semáfaro de erro quando há issue error)
// ---------------------------------------------------------------------------

function attentionApi() {
  return buildSandbox();
}

// O DOM falso não agrega textContent de filhos: as linhas vivem em `appended`.
function stripText(els: Record<string, FakeNode>): string {
  return els['attentionStrip'].appended.map((l: FakeNode) => l.textContent ?? '').join('\n');
}

test('faixa de atenção: indexador offline gera linha visível', () => {
  const { api, els } = attentionApi();
  const issues = api.collectStatusIssues({
    indexers: [{ id: 'track1', name: 'Track1', online: false, breaker: { state: 'fechado' } }],
    resolvers: [],
  });
  api.renderAttentionStrip(issues);
  assert.match(els['attentionStrip'].className, /visible/);
  assert.ok(!/error/.test(els['attentionStrip'].className.replace(/attention-strip( visible)?/, '')));
  assert.ok(els['attentionStrip'].textContent.indexOf('Track1') !== -1 || els['attentionStrip'].appended.some((l: FakeNode) => (l.textContent ?? '').indexOf('Track1') !== -1));
});

test('faixa de atenção: resolver quebrado e conta com warn aparecem; saudável some', () => {
  const { api, els } = attentionApi();
  const issues = api.collectStatusIssues({
    indexers: [],
    resolvers: [{ id: 'res1', label: 'Res 1', broken: true }],
    debrid: { account: { service: 'realdebrid', ok: true, warn: true, label: 'RealDebrid' } },
  });
  api.renderAttentionStrip(issues);
  assert.match(els['attentionStrip'].className, /visible/);
  assert.ok(stripText(els).indexOf('Res 1') !== -1);
  assert.ok(stripText(els).indexOf('RealDebrid') !== -1);
  assert.ok(stripText(els).indexOf('aviso operacional') !== -1);

  const ok = attentionApi();
  ok.api.renderAttentionStrip(ok.api.collectStatusIssues({ indexers: [], resolvers: [] }));
  assert.ok(!/visible/.test(ok.els['attentionStrip'].className), 'saudável: faixa some sozinha');
});

test('faixa de atenção: catálogo ok:false e issue error trocam a faixa para erro', () => {
  const { api, els } = attentionApi();
  const issues = api.collectStatusIssues({
    indexers: [],
    resolvers: [],
    catalog: { ok: false, reason: 'erro' },
    general: { services: { addon: false } },
  });
  api.renderAttentionStrip(issues);
  assert.match(els['attentionStrip'].className, /visible/);
  assert.match(els['attentionStrip'].className, /error/, 'general.services.addon=false é issue error');
  assert.ok(stripText(els).indexOf('Catálogo') !== -1);
});

// ---------------------------------------------------------------------------
// 2.2 — Estado vazio honesto sem token
// ---------------------------------------------------------------------------

test('estado vazio: sem token o bloco aparece; com token ele some', () => {
  const { api, els } = buildSandbox();
  api.setToken('');
  api.updateEmptyState();
  assert.equal(els['healthEmptyState'].hidden, false, 'sem token: estado vazio visível');
  api.setToken('tok');
  api.updateEmptyState();
  assert.equal(els['healthEmptyState'].hidden, true, 'com token: estado vazio some');
});

test('estado vazio: HTML nomeia causa e saída, com campo de token dentro', () => {
  const html = HTML();
  assert.match(html, /id="healthEmptyState"/);
  assert.match(html, /id="emptyToken"/);
  assert.match(html, /id="emptySaveToken"/);
  assert.match(html, /JACKETT_TEST_TOKEN/);
  assert.match(html, /Salvar e consultar/);
  // Honestidade: nenhum texto pode prometer carregamento em curso sem request.
  assert.doesNotMatch(html, /Aguardando \/dashboard-status\.json/, 'placeholder antigo prometia carga');
  assert.doesNotMatch(html, /Aguardando amostra\./);
  assert.match(html, /Nenhuma requisição foi feita/);
});

// ---------------------------------------------------------------------------
// 2.3 — Nav de âncoras por aba (chips + seção ativa)
// ---------------------------------------------------------------------------

test('chips de âncora: um por seção da aba ativa, com data-section e alvo no HTML', () => {
  const html = HTML();
  const { api, els } = buildSandbox({ nav: true });
  const reset = () => { const nav = els['sectionNav'] || (els['sectionNav'] = fakeNode()); nav.appended = []; nav.children = []; };
  api.renderSectionNav('geral');
  const chips = els['sectionNav'].appended;
  assert.equal(chips.length, 9, 'Geral tem 9 seções ancoradas');
  assert.match(chips[0].className, /active/, 'primeira seção começa ativa');
  for (const chip of chips) {
    const id = chip.attrs['data-section'];
    assert.ok(id, 'chip com data-section');
    assert.ok(html.indexOf('id="' + id + '"') !== -1, 'alvo existe no HTML: ' + id);
  }
  reset();
  api.renderSectionNav('autofetch');
  assert.equal(els['sectionNav'].appended.length, 5, 'Chupim tem 5 seções');
  reset();
  api.renderSectionNav('colhedor');
  assert.equal(els['sectionNav'].appended.length, 6, 'Colhedor tem 6 seções');
  reset();
  api.renderSectionNav('trace');
  assert.equal(els['sectionNav'].appended.length, 1, 'Trace tem 1 seção');
});

test('switchTab reconstrói os chips da aba recém-ativada', () => {
  const { api, els } = buildSandbox({ nav: true });
  const reset = () => { const nav = els['sectionNav'] || (els['sectionNav'] = fakeNode()); nav.appended = []; nav.children = []; };
  reset();
  api.switchTab('autofetch');
  assert.equal(els['sectionNav'].appended.length, 5);
  reset();
  api.switchTab('geral');
  assert.equal(els['sectionNav'].appended.length, 9);
});

test('CSS da faixa sticky, chips e compensação de scroll das seções', () => {
  const css = CSS();
  assert.match(css, /\.health-wrap\s*\{[^}]*position:\s*sticky[^}]*\}/);
  assert.match(css, /\.health-strip/);
  assert.match(css, /\.attention-strip\.visible/);
  assert.match(css, /\.section-chip\.active/);
  assert.match(css, /scroll-margin-top:\s*1\d\dpx/, 'seções ancoram abaixo das barras fixas');
  // Container fluido + grade de 12 colunas em telas grandes (2.4).
  assert.match(css, /\.wrap\s*\{\s*max-width:\s*1440px/);
  assert.match(css, /@media\s*\(min-width:\s*1600px\)/);
  assert.match(css, /#viewGeral\s*\{[^}]*grid-template-columns:\s*repeat\(12/);
  // Sem cor literal: o contrato da Fase 1 continua valendo no CSS novo.
  assert.equal(css.match(/#[0-9a-fA-F]{3,8}\b/g), null);
});

// ---------------------------------------------------------------------------
// 2.5 — Renderização somente da faixa de saúde + aba ativa
// ---------------------------------------------------------------------------

// A contagem fina dos pintores por aba vive no escopo do sandbox; este teste
// cobre o contrato inteiro: poll só desenha a aba ativa, e a troca desenha a
// recém-ativada a partir do ÚLTIMO payload (lastStatusRoot), sem novo poll.
test('contagem fina: poll só desenha a aba ativa; lastStatusRoot alimenta a troca', () => {
  const els: Record<string, FakeNode> = {};
  const document = {
    hidden: false,
    getElementById: (id: string) => (els[id] = els[id] || fakeNode()),
    createElement: () => fakeNode(),
    createTextNode: (text: string) => ({ text }),
    addEventListener: () => {},
  };
  const window = { location: { pathname: '/dashboard', hash: '', search: '' }, addEventListener: () => {}, pageYOffset: 0 };
  const factory = new Function(
    'document', 'window',
    CORE() + '\n' + RENDER() + '\n' + STATUS() + '\n' + HEALTH() + '\n' + NAV() + '\n' + PANEL_STUBS.join('\n') + '\n' +
    'return { renderStatus: renderStatus, renderActivePanels: renderActivePanels, switchTab: switchTab, counts: rendered };',
  ) as (doc: unknown, win: unknown) => any;
  const api = factory(document, window);

  // Os nós só nascem no getElementById; crie os das abas antes de setar
  // className direto no registro.
  for (const id of ['tabGeral', 'tabAutofetch', 'tabColhedor', 'tabTrace', 'viewGeral', 'viewAutofetch', 'viewColhedor', 'viewTrace']) {
    els[id] = els[id] || fakeNode();
  }
  els['tabGeral'].className = 'tab-btn active';
  els['tabAutofetch'].className = 'tab-btn';
  els['tabColhedor'].className = 'tab-btn';
  api.renderStatus(PAYLOAD);
  api.renderStatus(PAYLOAD); // segundo poll: Geral de novo, Chupim/Colhedor intocados
  assert.equal(api.counts.geral, 2, 'Geral desenha a cada poll');
  assert.equal(api.counts.autofetch, 0, 'Chupim oculto não desenha no poll');
  assert.equal(api.counts.colhedor, 0, 'Colhedor oculto não desenha no poll');

  // Troca de aba: switchTab dispara o render da Chupim com o ÚLTIMO payload
  // (mesmo objeto de antes — nenhum poll novo aconteceu).
  api.switchTab('autofetch');
  assert.equal(api.counts.autofetch, 1, 'aba recém-ativada desenha uma vez na troca');
  assert.equal(api.counts.colhedor, 0);
});

// ---------------------------------------------------------------------------
// Contratos de asset/lista
// ---------------------------------------------------------------------------

test('PAGE_ASSETS inclui dashboard-health.js e o HTML carrega antes do boot', () => {
  assert.ok(PAGE_ASSETS.includes('dashboard-health.js'), 'allowlist fechada: asset novo precisa de registro');
  const html = HTML();
  const nav = html.indexOf('/dashboard-nav.js');
  const health = html.indexOf('/dashboard-health.js');
  const boot = html.indexOf('/dashboard-boot.js');
  assert.ok(health !== -1);
  assert.ok(nav < health && health < boot, 'health depois do nav, boot sempre por último');
});

test('dashboard-health.js segue ES5 estrito e não usa innerHTML', () => {
  const js = HEALTH();
  assert.doesNotMatch(js, /\b(?:const|let)\b|=>|\?\.|\?\?/, 'ES5 puro (Fire TV / smart TV)');
  assert.doesNotMatch(js, /innerHTML/, 'dados de rede só por textContent/appendChild');
});

test('rota /dashboard responde com o asset da faixa de saúde versionado', async () => {
  const res = await server.request('GET', '/dashboard');
  assert.equal(res.status, 200);
  assert.match(res.text, /dashboard-health\.js\?v=/, 'asset novo entra no versionamento ?v=');
});
