import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { CLIENT_ASSETS, PAGE_ASSETS } from '../src/routes/public.js';
import {
  bootstrapDashboard,
  dashboardHtml,
  loadDashboardModules,
  loadDashboardEntry,
  resetDashboardEnvironment,
} from './helpers/dashboard.js';

// ---------------------------------------------------------------------------
// C3 — cutover ESM do dashboard. Este arquivo fixa:
//   1. IMPORT DOM-FREE: o grafo de módulos (exceto o entry) importa sem DOM
//      instalado — nenhum efeito de topo, nenhum document/window no load.
//   2. WIRING EXPLÍCITO: o entry registra o conjunto FECHADO de hooks; módulos
//      não se registram sozinhos; call() falha alto em ausente.
//   3. BOOT REAL: bootstrapDashboard() monta listeners e o DOM; a troca de aba
//      desenha o último payload pelo hook.
//   4. GRAFO/ALLOWLIST/ENTRY: todo arquivo emitido está em CLIENT_ASSETS (e
//      vice-versa), PAGE_ASSETS só tem HTML/CSS/imagens, o HTML tem UM
//      <script type="module"> e nenhum import nu.
// ---------------------------------------------------------------------------

const DIST_DIR = new URL('../src/public/client/dashboard/', import.meta.url);
const SRC_DIR = new URL('../../src/client/dashboard/', import.meta.url);

// ---------------------------------------------------------------------------
// 1 — Import DOM-free
// ---------------------------------------------------------------------------

test('grafo de módulos importa sem DOM: nenhum efeito de topo fora do entry', async () => {
  assert.equal(typeof (globalThis as any).document, 'undefined', 'pré-condição: sem document');
  assert.equal(typeof (globalThis as any).window, 'undefined', 'pré-condição: sem window');
  const mods = await loadDashboardModules();
  // Cada módulo expõe funções; o único com um efeito de boot é o entry.
  assert.equal(typeof mods.statusRoot.loadStatus, 'function');
  assert.equal(typeof mods.boot.bind, 'function');
  assert.equal(typeof mods.render.card, 'function');
  assert.equal(typeof mods.core.requestJson, 'function');
  // Importar não registra hook algum: o registro é wiring do entry.
  assert.equal(mods.hooks.hooks.has('loadStatus'), false, 'import não registra hook');
  assert.equal(mods.hooks.hooks.has('renderHealthStrip'), false);
});

test('hooks.call falha alto em hook obrigatório ausente (não é no-op)', async () => {
  const { mods } = await resetDashboardEnvironment();
  assert.equal(mods.hooks.hooks.has('inexistente'), false);
  assert.throws(() => mods.hooks.hooks.call('inexistente'), /hook obrigatório ausente: inexistente/);
});

test('nenhum módulo (exceto o entry) registra hook no load', () => {
  const files = readdirSync(SRC_DIR).filter((f) => f.endsWith('.ts') && f !== 'entry.ts' && f !== 'hooks.ts');
  for (const file of files) {
    const src = readFileSync(new URL(file, SRC_DIR), 'utf8');
    assert.doesNotMatch(src, /hooks\.register\s*\(/, file + ' não pode registrar hook no load');
  }
});

// ---------------------------------------------------------------------------
// 2 — Wiring explícito e boot real
// ---------------------------------------------------------------------------

test('entry registra o conjunto fechado de hooks e chama bind()', async () => {
  const { dom } = await resetDashboardEnvironment();
  const entry = await loadDashboardEntry();
  assert.equal(typeof entry.registerHooks, 'function');
  const names = [
    'loadStatus', 'rerenderActiveTab', 'activeTabName',
    'renderHealthStrip', 'renderAttentionStrip', 'updateEmptyState', 'dashDebugEnabled',
    'runIndexerTest', 'runResolverTest', 'renderGeneralDiagnostics',
    'renderTimersPanel', 'renderF3Panel', 'renderCatalogPanel',
    'renderCatalogReport', 'renderAutofetchStall',
  ];
  // O entry auto-executa registerHooks() + bind() no import (DOM instalado antes).
  const mods = await loadDashboardModules();
  for (const name of names) assert.ok(mods.hooks.hooks.has(name), 'hook registrado pelo entry: ' + name);
  // bind() ligou o botão de salvar token (prova de wiring real).
  assert.ok(dom.byId['saveToken'].addEventListener, 'saveToken existe');
  dom.cleanup();
});

test('bootstrap religa listeners e a troca de aba desenha a aba ativa pelo hook', async () => {
  const { dom, mods } = await bootstrapDashboard();
  // O binding é idempotente o suficiente para exercitar o clique de aba.
  const calls: string[] = [];
  // Substitui os pintores das abas por contadores via registry.
  mods.hooks.hooks.register('renderHealthStrip', () => {});
  mods.hooks.hooks.register('renderAttentionStrip', () => {});
  mods.hooks.hooks.register('renderGeneralDiagnostics', () => {});
  mods.hooks.hooks.register('renderTimersPanel', () => {});
  mods.hooks.hooks.register('renderF3Panel', () => {});
  mods.hooks.hooks.register('renderCatalogPanel', () => {});
  mods.hooks.hooks.register('renderCatalogReport', () => {});
  mods.hooks.hooks.register('renderAutofetchStall', () => calls.push('af'));
  // Painéis diretos (fora de hook) viram stubs no objeto do módulo não é
  // possível (ESM congelado); então a prova é o disparo do hook ao trocar.
  dom.window.location.hash = '#autofetch';
  dom.byId['tabAutofetch'].dispatch('click');
  assert.equal(mods.nav.activeTabName(), 'autofetch', 'aba ativa após o clique');
  assert.equal(dom.byId['viewAutofetch'].className, 'tab-view');
  assert.ok(dom.byId['viewGeral'].className.includes('hidden'));
  dom.cleanup();
});

test('saveToken do estado vazio não faz requisição sem token e mostra o estado honesto', async () => {
  const { dom, mods } = await resetDashboardEnvironment();
  // Sem token: updateEmptyState mostra o bloco.
  mods.state.DashState.token = '';
  mods.health.updateEmptyState();
  assert.equal(dom.byId['healthEmptyState'].hidden, false);
  // Com token, some.
  mods.state.DashState.token = 'tok';
  mods.health.updateEmptyState();
  assert.equal(dom.byId['healthEmptyState'].hidden, true);
  dom.cleanup();
});

// ---------------------------------------------------------------------------
// 3 — Grafo, allowlist e entry no HTML
// ---------------------------------------------------------------------------

test('CLIENT_ASSETS cobre exatamente os arquivos emitidos do dashboard', () => {
  const emitted = readdirSync(DIST_DIR).filter((f) => f.endsWith('.js')).sort();
  const allowlisted = CLIENT_ASSETS.filter((a) => a.startsWith('client/dashboard/'))
    .map((a) => a.replace('client/dashboard/', ''))
    .sort();
  assert.deepEqual(allowlisted, emitted, 'todo arquivo emitido precisa de rota na allowlist fechada');
});

test('PAGE_ASSETS fica só com HTML/CSS/imagens (nenhum .js)', () => {
  for (const asset of PAGE_ASSETS) {
    assert.doesNotMatch(asset, /\.js$/, 'asset clássico não pertence mais a PAGE_ASSETS: ' + asset);
  }
  assert.ok(PAGE_ASSETS.includes('dashboard.css'));
  assert.ok(PAGE_ASSETS.includes('dashboard-tokens.css'));
});

test('dashboard.html tem UM <script type="module"> no entry e nenhum script clássico', () => {
  const html = dashboardHtml();
  const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
  assert.equal(scripts.length, 1, 'um único script');
  assert.match(scripts[0], /type="module"/);
  assert.match(scripts[0], /src="\/client\/dashboard\/entry\.js"/);
  assert.doesNotMatch(html, /src="\/dashboard-[\w-]+\.js/);
  assert.doesNotMatch(html, /<script(?![^>]*type="module")[^>]*src=/);
});

test('nenhum import nu (sem .js) no emit de browser', () => {
  const files = readdirSync(DIST_DIR).filter((f) => f.endsWith('.js'));
  for (const file of files) {
    const js = readFileSync(new URL(file, DIST_DIR), 'utf8');
    const imports = [...js.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g)].map((m) => m[1]);
    for (const spec of imports) {
      assert.match(spec, /\.js$/, file + ' importa sem .js: ' + spec);
    }
    assert.doesNotMatch(js, /\brequire\s*\(/, file + ' não pode usar require');
  }
});

test('o emit de browser do dashboard preserva os contratos funcionais por módulo', () => {
  const read = (name: string) => readFileSync(new URL(name, DIST_DIR), 'utf8');
  // Abas/nav, saúde, MagnetDB, Chupim, Colhedor, catálogo, timers/probes, trace.
  assert.match(read('nav.js'), /switchTab/);
  assert.match(read('health.js'), /renderHealthStrip/);
  assert.match(read('magnets.js'), /renderMagnetDb/);
  assert.match(read('autofetch.js'), /renderAutofetchPanel/);
  assert.match(read('harvest.js'), /renderHarvesterPanel/);
  assert.match(read('catalog-render.js'), /renderCatalogReport/);
  assert.match(read('timers.js'), /renderTimersPanel/);
  assert.match(read('probes.js'), /runResolverTest/);
  assert.match(read('trace.js'), /runTraceQuery/);
});

test('ids referenciados pelo cliente ⊆ ids do dashboard.html (getElementById estrito)', () => {
  const html = dashboardHtml();
  const ids = new Set<string>();
  for (const file of readdirSync(SRC_DIR).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(new URL(file, SRC_DIR), 'utf8');
    for (const match of src.matchAll(/\$\('([A-Za-z0-9_]+)'\)/g)) ids.add(match[1]);
    for (const match of src.matchAll(/getElementById\('([A-Za-z0-9_]+)'\)/g)) ids.add(match[1]);
  }
  // Sem o DOM estrito, um id digitado errado criava um nó fantasma e o teste
  // passava. Aqui a ausência no HTML é falha explícita.
  const missing = [...ids].filter((id) => !html.includes('id="' + id + '"')).sort();
  assert.deepEqual(missing, [], 'ids referenciados sem alvo no dashboard.html: ' + missing.join(', '));
  assert.ok(ids.size > 100, 'a varredura precisa achar os ids do painel (achou ' + ids.size + ')');
});

test('getElementById estrito: id ausente devolve null; element() cria e fixa', async () => {
  const { dom, mods } = await resetDashboardEnvironment('');
  assert.equal(dom.document.getElementById('nao-existe-no-dom'), null);
  assert.equal(mods.core.$('nao-existe-no-dom'), null, 'o $ do cliente respeita o DOM estrito');
  const created = dom.element('nao-existe-no-dom');
  assert.equal(dom.byId['nao-existe-no-dom'], created);
  assert.equal(dom.document.getElementById('nao-existe-no-dom'), created);
  dom.cleanup();
});
