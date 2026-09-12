import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bootstrapDashboard,
  loadDashboardModules,
  registerDashboardHooks,
  resetDashboardEnvironment,
} from './helpers/dashboard.js';

// ---------------------------------------------------------------------------
// C3 — registro de hooks e estado compartilhado do dashboard ESM.
// O registro deixou de acontecer no topo dos módulos: quem registra é o entry
// (wiring explícito). Aqui se fixa:
//   1. importar módulos NÃO registra hook (nenhum efeito de topo);
//   2. registerHooks() do entry fecha o conjunto e call() falha alto em ausente;
//   3. DashState é dono único das sete chaves e os módulos mutam propriedades;
//   4. o ciclo status↔nav e render→probes passa pelo registry, nunca por
//      chamada direta.
// ---------------------------------------------------------------------------

const HOOK_GRAPH = [
  'loadStatus', 'rerenderActiveTab', 'activeTabName',
  'renderHealthStrip', 'renderAttentionStrip', 'updateEmptyState', 'dashDebugEnabled',
  'runIndexerTest', 'runResolverTest', 'renderGeneralDiagnostics',
  'renderTimersPanel', 'renderF3Panel', 'renderCatalogPanel',
  'renderCatalogReport', 'renderAutofetchStall',
];

test('importar o grafo não registra hook algum (registro é wiring do entry)', async () => {
  const { mods } = await resetDashboardEnvironment();
  for (const name of HOOK_GRAPH) {
    assert.equal(mods.hooks.hooks.has(name), false, 'import não registra: ' + name);
  }
  assert.throws(() => mods.hooks.hooks.call('loadStatus'), /hook obrigatório ausente: loadStatus/);
});

test('registerHooks/entry fecham exatamente o conjunto obrigatório', async () => {
  const { mods } = await bootstrapDashboard();
  for (const name of HOOK_GRAPH) assert.ok(mods.hooks.hooks.has(name), 'registrado: ' + name);
  // register/has/call são a API do registry.
  assert.equal(typeof mods.hooks.hooks.register, 'function');
  assert.equal(typeof mods.hooks.hooks.has, 'function');
  assert.equal(typeof mods.hooks.hooks.call, 'function');
});

test('DashState é dono único das sete chaves e é mutado por propriedade', async () => {
  const mods = await loadDashboardModules();
  const keys = ['token', 'refreshTimer', 'lastUpdatedTimer', 'requestInFlight', 'consecutiveFailures', 'lastOkAt', 'lastStatusRoot'];
  for (const key of keys) assert.ok(key in mods.state.DashState, 'chave do estado: ' + key);
  // Mutação por propriedade funciona e o reset restaura o padrão.
  mods.state.DashState.token = 'abc';
  assert.equal(mods.state.DashState.token, 'abc');
  mods.state.resetDashState();
  assert.equal(mods.state.DashState.token, '');
  assert.equal(mods.state.DashState.requestInFlight, false);
});

test('nav fecha o ciclo status↔nav pelo hook rerenderActiveTab', async () => {
  const { dom, mods } = await resetDashboardEnvironment();
  const calls: string[] = [];
  registerDashboardHooks(mods);
  mods.hooks.hooks.register('rerenderActiveTab', () => calls.push('rerender'));
  // Força a aba a trocar; a nav pede o redesenho pelo registry, não cita status.
  mods.nav.switchTab('trace');
  assert.deepEqual(calls, ['rerender']);
  dom.cleanup();
});

test('card() testável dispara a sonda pelo hook (render não conhece probes)', async () => {
  const { dom, mods } = await resetDashboardEnvironment();
  const calls: string[] = [];
  mods.hooks.hooks.register('runIndexerTest', (id: string) => calls.push('indexer:' + id));
  mods.hooks.hooks.register('runResolverTest', (id: string) => calls.push('resolver:' + id));
  const box = dom.element('cardBox');
  mods.render.card(box, { id: 'bludv-cardigann', label: 'BLUDV' }, { testable: true });
  mods.render.card(box, { id: 'vacatorrent', label: 'Vaca Torrent' }, { testable: true, kind: 'resolver' });
  const buttons: any[] = [];
  for (const cardBox of box.children) {
    for (const child of cardBox.children) if (child.className === 'mini-action') buttons.push(child);
  }
  assert.equal(buttons.length, 2);
  buttons[0].dispatch('click');
  buttons[1].dispatch('click');
  assert.deepEqual(calls, ['indexer:bludv-cardigann', 'resolver:vacatorrent']);
  dom.cleanup();
});
