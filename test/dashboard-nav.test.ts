import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Fase 0 do redesign — runtime do dashboard-nav.js no DOM falso.
// switchTab passou a ser dirigido por tabela (TAB_ITEMS); aqui se prova que o
// comportamento observável não mudou: classes/aria dos 4 botões e views,
// escrita do hash da aba e a regra antiga da Geral (só reescreve o hash
// quando ele aponta para outra aba conhecida).

type FakeNode = {
  className: string;
  textContent: string;
  attrs: Record<string, string>;
  setAttribute(key: string, value: string): void;
  getAttribute(key: string): string | null;
};

function fakeNode(): FakeNode {
  const node: FakeNode = {
    className: '',
    textContent: '',
    attrs: {},
    setAttribute(key, value) { node.attrs[key] = value; },
    getAttribute(key) { return node.attrs[key] ?? null; },
  };
  return node;
}

function loadNavApi() {
  const core = readFileSync(new URL('../src/public/dashboard-core.js', import.meta.url), 'utf8');
  const nav = readFileSync(new URL('../src/public/dashboard-nav.js', import.meta.url), 'utf8');
  const els: Record<string, FakeNode> = {};
  const document = {
    getElementById: (id: string) => (els[id] = els[id] || fakeNode()),
    createElement: () => fakeNode(),
    addEventListener: () => {},
  };
  const location = { pathname: '/dashboard', hash: '' };
  const window = { location, addEventListener: () => {} };
  const factory = new Function(
    'document',
    'window',
    core + '\n' + nav + '\nreturn { switchTab: switchTab, handleHash: handleHash };',
  ) as (doc: unknown, win: unknown) => { switchTab: (name: string) => void; handleHash: () => void };
  const api = factory(document, window);
  return { api, els, location };
}

function estadoAba(els: Record<string, FakeNode>, nome: string) {
  const tab = els['tab' + nome].className;
  const view = els['view' + nome].className;
  const aria = els['tab' + nome].getAttribute('aria-selected');
  return { tab, view, aria };
}

test('switchTab("colhedor") ativa só o Colhedor e escreve #colhedor', () => {
  const { api, els, location } = loadNavApi();
  api.switchTab('colhedor');
  assert.equal(estadoAba(els, 'Colhedor').tab, 'tab-btn active');
  assert.equal(estadoAba(els, 'Colhedor').view, 'tab-view');
  assert.equal(estadoAba(els, 'Colhedor').aria, 'true');
  assert.equal(estadoAba(els, 'Geral').tab, 'tab-btn');
  assert.equal(estadoAba(els, 'Geral').view, 'tab-view hidden');
  assert.equal(estadoAba(els, 'Autofetch').view, 'tab-view hidden');
  assert.equal(estadoAba(els, 'Trace').view, 'tab-view hidden');
  assert.equal(location.hash, '#colhedor');
});

test('switchTab("autofetch") e ("trace") escrevem o próprio hash', () => {
  const { api, els, location } = loadNavApi();
  api.switchTab('autofetch');
  assert.equal(estadoAba(els, 'Autofetch').tab, 'tab-btn active');
  assert.equal(location.hash, '#autofetch');
  api.switchTab('trace');
  assert.equal(estadoAba(els, 'Trace').tab, 'tab-btn active');
  assert.equal(estadoAba(els, 'Autofetch').tab, 'tab-btn');
  assert.equal(location.hash, '#trace');
});

test('voltar à Geral reescreve o hash só quando ele é de outra aba conhecida', () => {
  const { api, location } = loadNavApi();
  api.switchTab('trace');
  api.switchTab('geral');
  assert.equal(location.hash, '#geral', 'saía de #trace → reescreve para #geral');
  // Comportamento antigo preservado: âncora desconhecida na Geral não é tocada.
  location.hash = '#secao-interna';
  api.switchTab('geral');
  assert.equal(location.hash, '#secao-interna', '#ancora qualquer na Geral não é sobrescrito');
});

test('handleHash mapeia #autofetch/#colhedor/#trace; hash vazio ou desconhecido cai na Geral', () => {
  const { api, els, location } = loadNavApi();
  location.hash = '#autofetch';
  api.handleHash();
  assert.equal(estadoAba(els, 'Autofetch').tab, 'tab-btn active');
  location.hash = '#trace';
  api.handleHash();
  assert.equal(estadoAba(els, 'Trace').tab, 'tab-btn active');
  location.hash = '#colhedor';
  api.handleHash();
  assert.equal(estadoAba(els, 'Colhedor').tab, 'tab-btn active');
  location.hash = '';
  api.handleHash();
  assert.equal(estadoAba(els, 'Geral').tab, 'tab-btn active');
  location.hash = '#nao-existe';
  api.handleHash();
  assert.equal(estadoAba(els, 'Geral').tab, 'tab-btn active', 'hash desconhecido → aba default');
});

test('nome de aba inválido em switchTab cai na Geral (sem lançar)', () => {
  const { api, els } = loadNavApi();
  assert.doesNotThrow(() => api.switchTab('inexistente'));
  assert.equal(estadoAba(els, 'Geral').tab, 'tab-btn active');
});
