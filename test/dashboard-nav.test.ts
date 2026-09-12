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
  // Fase 1 do saneamento: nav.js se registra no DashHooks no próprio load, e o
  // switchTab pede o redesenho da aba ativa pelo hook rerenderActiveTab. Fase 2
  // (call estrito): hook obrigatório ausente lança, então esta composição
  // mínima (sem status.js) registra o stub do consumidor explicitamente.
  const hooks = readFileSync(new URL('../src/public/dashboard-hooks.js', import.meta.url), 'utf8');
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
    hooks + '\n' + core + '\n' + nav + '\nDashHooks.register("rerenderActiveTab", function () {});\nreturn { switchTab: switchTab, handleHash: handleHash };',
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

// ---------------------------------------------------------------------------
// Fase 2.3 do redesign — nav de âncoras por aba. Os chips vivem em
// #sectionNav; cada um aponta para o id de um <section> da aba ativa. Aqui o
// sandbox inclui também dashboard-render.js (o guard de renderSectionNav
// precisa do helper element() para desenhar).
// ---------------------------------------------------------------------------

function loadNavWithChips() {
  const core = readFileSync(new URL('../src/public/dashboard-core.js', import.meta.url), 'utf8');
  const render = readFileSync(new URL('../src/public/dashboard-render.js', import.meta.url), 'utf8');
  const nav = readFileSync(new URL('../src/public/dashboard-nav.js', import.meta.url), 'utf8');
  // Fase 1 do saneamento: hooks primeiro (nav se registra no load dele).
  const hooks = readFileSync(new URL('../src/public/dashboard-hooks.js', import.meta.url), 'utf8');
  // Nós ricos (appendChild/attrs/offsetTop): o tipo estreito do FakeNode não
  // descreve os chips — any de propósito, confinado a este loader.
  const els: Record<string, any> = new Proxy({} as Record<string, any>, {
    // Acesso direto a els['secTrace'] (fora do getElementById) também cria o
    // nó, como o getElementById lazy do harness antigo já fazia.
    get(target: Record<string, any>, prop: PropertyKey) {
      if (typeof prop !== 'string') return undefined;
      if (!(prop in target)) target[prop] = node();
      return target[prop];
    },
  });
  const node = () => {
    const n: any = fakeNode();
    n.appended = [];
    n.children = [];
    // textContent = "" limpa os filhos, como no DOM real: renderSectionNav
    // reconstrói o nav a cada troca de aba e os testes contam `appended` do
    // zero.
    Object.defineProperty(n, 'textContent', {
      get() { return n._text || ''; },
      set(value) { n._text = String(value); n.appended = []; n.children = []; },
      configurable: true,
    });
    n.appendChild = (child: any) => { n.appended.push(child); n.children.push(child); return child; };
    n.addEventListener = () => {};
    n.removeAttribute = () => {};
    n.scrollIntoView = () => { n.scrolled = true; };
    return n;
  };
  const document = {
    getElementById: (id: string) => (els[id] = els[id] || node()),
    createElement: () => node(),
    createTextNode: (text: string) => ({ text }),
    addEventListener: () => {},
  };
  const location = { pathname: '/dashboard', hash: '', search: '' };
  const window = { location, addEventListener: () => {}, pageYOffset: 0 };
  const factory = new Function(
    'document',
    'window',
    hooks + '\n' + core + '\n' + render + '\n' + nav + '\nDashHooks.register("rerenderActiveTab", function () {});\nreturn { switchTab: switchTab, renderSectionNav: renderSectionNav, markActiveSection: markActiveSection };',
  ) as (doc: unknown, win: unknown) => any;
  return { api: factory(document, window), els, location, window };
}

test('chips: um por seção da aba ativa, com data-section apontando para id real do HTML', () => {
  const html = readFileSync(new URL('../src/public/dashboard.html', import.meta.url), 'utf8');
  const { api, els } = loadNavWithChips();
  api.renderSectionNav('geral');
  const chips = els['sectionNav'].appended;
  assert.equal(chips.length, 9, 'Geral tem 9 seções ancoradas');
  assert.match(chips[0].className, /active/, 'primeira seção começa realçada');
  for (const chip of chips) {
    const id = chip.attrs['data-section'];
    assert.ok(id && html.indexOf('id="' + id + '"') !== -1, 'alvo existe no HTML: ' + id);
  }
});

test('chips trocam com a aba: switchTab reconstrói a lista da aba ativa', () => {
  const { api, els } = loadNavWithChips();
  api.switchTab('colhedor');
  assert.equal(els['sectionNav'].appended.length, 6, 'Colhedor tem 6 seções');
  api.switchTab('trace');
  assert.equal(els['sectionNav'].appended.length, 1, 'Trace tem 1 seção');
  api.switchTab('autofetch');
  assert.equal(els['sectionNav'].appended.length, 5, 'Chupim tem 5 seções');
  api.switchTab('geral');
  assert.equal(els['sectionNav'].appended.length, 9);
});

test('markActiveSection realça a última seção cujo topo passou da compensação', () => {
  const { api, els, window } = loadNavWithChips();
  api.renderSectionNav('trace');
  const sec = els['secTrace'];
  sec.attrs['x-offsetTop'] = '0';
  (sec as any).offsetTop = 400;
  window.pageYOffset = 250; // 400 - 170 <= 250 → seção ativa
  api.markActiveSection();
  assert.match(els['sectionNav'].appended[0].className, /active/);
  window.pageYOffset = 5000; // topo muito abaixo → primeira seção é o fallback
  (sec as any).offsetTop = 9000;
  api.markActiveSection();
  assert.match(els['sectionNav'].appended[0].className, /active/, 'fallback: primeira seção nunca fica sem realce');
});
