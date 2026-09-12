import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dashboardHtml, loadDashboardModules, registerDashboardHooks, resetDashboardEnvironment } from './helpers/dashboard.js';

// ---------------------------------------------------------------------------
// C3 — runtime da navegação por abas e chips de âncora, importando o emit real
// (sem `new Function`, sem ordem de scripts). switchTab é dirigido por TAB_ITEMS
// e o ciclo status↔nav passa pelo hook rerenderActiveTab (registrado pelo entry;
// aqui via registerDashboardHooks).
// ---------------------------------------------------------------------------

async function navEnv() {
  const env = await resetDashboardEnvironment();
  registerDashboardHooks(env.mods);
  return env;
}

function estadoAba(dom: any, nome: string) {
  return {
    tab: dom.byId['tab' + nome].className,
    view: dom.byId['view' + nome].className,
    aria: dom.byId['tab' + nome].getAttribute('aria-selected'),
  };
}

test('switchTab("colhedor") ativa só o Colhedor e escreve #colhedor', async () => {
  const { dom, mods } = await navEnv();
  mods.nav.switchTab('colhedor');
  assert.equal(estadoAba(dom, 'Colhedor').tab, 'tab-btn active');
  assert.equal(estadoAba(dom, 'Colhedor').view, 'tab-view');
  assert.equal(estadoAba(dom, 'Colhedor').aria, 'true');
  assert.equal(estadoAba(dom, 'Geral').tab, 'tab-btn');
  assert.equal(estadoAba(dom, 'Geral').view, 'tab-view hidden');
  assert.equal(estadoAba(dom, 'Autofetch').view, 'tab-view hidden');
  assert.equal(dom.window.location.hash, '#colhedor');
  dom.cleanup();
});

test('switchTab autofetch/trace escrevem o próprio hash; voltar à Geral só reescreve hash de aba conhecida', async () => {
  const { dom, mods } = await navEnv();
  mods.nav.switchTab('autofetch');
  assert.equal(estadoAba(dom, 'Autofetch').tab, 'tab-btn active');
  assert.equal(dom.window.location.hash, '#autofetch');
  mods.nav.switchTab('trace');
  assert.equal(estadoAba(dom, 'Trace').tab, 'tab-btn active');
  assert.equal(estadoAba(dom, 'Autofetch').tab, 'tab-btn');
  mods.nav.switchTab('geral');
  assert.equal(dom.window.location.hash, '#geral');
  dom.window.location.hash = '#secao-interna';
  mods.nav.switchTab('geral');
  assert.equal(dom.window.location.hash, '#secao-interna', 'âncora desconhecida na Geral não é sobrescrita');
  dom.cleanup();
});

test('handleHash mapeia as abas; vazio/desconhecido cai na Geral; nome inválido não lança', async () => {
  const { dom, mods } = await navEnv();
  for (const [hash, nome] of [['#autofetch', 'Autofetch'], ['#trace', 'Trace'], ['#colhedor', 'Colhedor']]) {
    dom.window.location.hash = hash;
    mods.nav.handleHash();
    assert.equal(estadoAba(dom, nome).tab, 'tab-btn active', hash);
  }
  dom.window.location.hash = '';
  mods.nav.handleHash();
  assert.equal(estadoAba(dom, 'Geral').tab, 'tab-btn active');
  dom.window.location.hash = '#nao-existe';
  mods.nav.handleHash();
  assert.equal(estadoAba(dom, 'Geral').tab, 'tab-btn active');
  assert.doesNotThrow(() => mods.nav.switchTab('inexistente'));
  dom.cleanup();
});

test('chips: um por seção da aba, data-section apontando para id real do HTML', async () => {
  const html = dashboardHtml();
  const { dom, mods } = await navEnv();
  const counts: Record<string, number> = { geral: 9, autofetch: 5, colhedor: 6, trace: 1 };
  for (const [tab, expected] of Object.entries(counts)) {
    mods.nav.renderSectionNav(tab);
    const nav = dom.byId['sectionNav'];
    assert.equal(nav.children.length, expected, tab + ' tem ' + expected + ' seções');
    if (tab === 'geral') assert.match(nav.children[0].className, /active/, 'primeira seção realçada');
    for (const chip of nav.children) {
      const id = chip.getAttribute('data-section');
      assert.ok(id && html.includes('id="' + id + '"'), 'alvo existe no HTML: ' + id);
    }
  }
  dom.cleanup();
});

test('switchTab reconstrói os chips da aba ativa', async () => {
  const { dom, mods } = await navEnv();
  mods.nav.switchTab('colhedor');
  assert.equal(dom.byId['sectionNav'].children.length, 6);
  mods.nav.switchTab('geral');
  assert.equal(dom.byId['sectionNav'].children.length, 9);
  dom.cleanup();
});

test('markActiveSection realça a última seção cujo topo passou da compensação', async () => {
  const { dom, mods } = await navEnv();
  mods.nav.renderSectionNav('trace');
  const sec = dom.element('secTrace');
  sec.offsetTop = 400;
  dom.window.pageYOffset = 250;
  mods.nav.markActiveSection();
  assert.match(dom.byId['sectionNav'].children[0].className, /active/);
  sec.offsetTop = 9000;
  dom.window.pageYOffset = 5000;
  mods.nav.markActiveSection();
  assert.match(dom.byId['sectionNav'].children[0].className, /active/, 'fallback: primeira nunca fica sem realce');
  dom.cleanup();
});

test('activeTabName reflete a aba marcada e cai na Geral sem marcação', async () => {
  const { dom, mods } = await navEnv();
  dom.element('tabTrace').className = 'tab-btn active';
  assert.equal(mods.nav.activeTabName(), 'trace');
  dom.element('tabTrace').className = 'tab-btn';
  assert.equal(mods.nav.activeTabName(), 'geral');
  dom.cleanup();
});
