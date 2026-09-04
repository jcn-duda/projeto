import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Fase 4 — fatia TESTES: contrato da UI de incerteza (_origem) no painel.
// Fake DOM / eval como dashboard-panels-extract e dashboard-panel-runtime.
// Não edita src/public — só fixa o contrato que helpers + consumo devem cumprir.

const CORE_URL = new URL('../src/public/dashboard-core.js', import.meta.url);
const STATUS_URL = new URL('../src/public/dashboard-status.js', import.meta.url);
const HARVEST_URL = new URL('../src/public/dashboard-harvest.js', import.meta.url);
const AUTOFETCH_URL = new URL('../src/public/dashboard-autofetch.js', import.meta.url);

type FakeNode = {
  className: string;
  textContent: string;
  title: string;
  style: Record<string, string>;
  children: FakeNode[];
  appendChild(child: FakeNode): FakeNode;
  removeAttribute(name: string): void;
};

type OrigemApi = {
  origemValue: (value: unknown, kind: string | null) => string;
  origemOf: (map: unknown, key: string) => string | null;
  origemTitle: (kind: string | null, uptimeS: unknown) => string;
  applyOrigem?: (el: FakeNode, value: unknown, kind: string | null, uptimeS: unknown) => void;
  metricOrigem?: (container: FakeNode, key: string, value: unknown, kind: string | null, uptimeS: unknown) => void;
  AMOSTRA_CEDO_S?: number;
};

function fakeNode(): FakeNode {
  const node: FakeNode = {
    className: '',
    textContent: '',
    title: '',
    style: {},
    children: [],
    appendChild(child: FakeNode) {
      node.children.push(child);
      return child;
    },
    removeAttribute(name: string) {
      if (name === 'title') node.title = '';
    },
  };
  return node;
}

function loadOrigemApi(): OrigemApi | null {
  const core = readFileSync(CORE_URL, 'utf8');
  if (!/\bfunction\s+origemOf\s*\(/.test(core) || !/\bfunction\s+origemValue\s*\(/.test(core)) {
    return null;
  }
  const document = {
    createElement: () => fakeNode(),
    createTextNode: (text: string) => ({ text }),
    getElementById: () => fakeNode(),
    addEventListener: () => {},
  };
  const window = {
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    location: { pathname: '/dashboard' },
    confirm: () => false,
    addEventListener: () => {},
  };
  const ret =
    'return {' +
    'origemValue:origemValue,' +
    'origemOf:origemOf,' +
    'origemTitle:origemTitle,' +
    'applyOrigem:typeof applyOrigem==="function"?applyOrigem:undefined,' +
    'metricOrigem:typeof metricOrigem==="function"?metricOrigem:undefined,' +
    'AMOSTRA_CEDO_S:typeof AMOSTRA_CEDO_S!=="undefined"?AMOSTRA_CEDO_S:undefined' +
    '};';
  const factory = new Function('document', 'window', core + '\n' + ret) as (
    doc: unknown,
    win: unknown,
  ) => OrigemApi;
  return factory(document, window);
}

function requireOrigemApi(): OrigemApi {
  const api = loadOrigemApi();
  assert.ok(api, 'aguardando helpers origem* em dashboard-core.js');
  return api!;
}

function valueSpan(container: FakeNode): FakeNode | undefined {
  // metricOrigem anexa metric > span.value (não no container direto).
  for (const child of container.children) {
    if (/\bvalue\b/.test(child.className)) return child;
    const nested = child.children.find((c) => /\bvalue\b/.test(c.className));
    if (nested) return nested;
  }
  return undefined;
}

// --- 1. Helpers runtime -----------------------------------------------------

test('origemValue(x, "naomedido") === "—"', () => {
  const api = requireOrigemApi();
  assert.equal(api.origemValue(42, 'naomedido'), '—');
  assert.equal(api.origemValue(0, 'naomedido'), '—');
  assert.equal(api.origemValue('qualquer', 'naomedido'), '—');
});

test('origemOf: lê _origem; kind inválido / mapa ausente → null (fail-open)', () => {
  const api = requireOrigemApi();
  assert.equal(api.origemOf({ _origem: { sizeAlive: 'duravel' } }, 'sizeAlive'), 'duravel');
  assert.equal(api.origemOf({ _origem: { sizeAlive: 'amostra' } }, 'sizeAlive'), 'amostra');
  assert.equal(api.origemOf({ _origem: { sizeAlive: 'naomedido' } }, 'sizeAlive'), 'naomedido');
  assert.equal(api.origemOf({ _origem: { sizeAlive: 'lixo' } }, 'sizeAlive'), null);
  assert.equal(api.origemOf({}, 'sizeAlive'), null);
  assert.equal(api.origemOf(null, 'sizeAlive'), null);
  assert.equal(api.origemOf({ _origem: null }, 'sizeAlive'), null);
});

test('origemTitle: amostra cedo vs maduro; naomedido; kind null fail-open', () => {
  const api = requireOrigemApi();
  const limiar = api.AMOSTRA_CEDO_S ?? 300;
  const cedo = api.origemTitle('amostra', limiar - 1);
  const maduro = api.origemTitle('amostra', limiar);
  assert.match(cedo, /uptime baixo|subcontar/i);
  assert.match(maduro, /≠|L1\/L2|processo/i);
  assert.notEqual(cedo, maduro, 'cedo e maduro não podem ser o mesmo title');
  assert.match(api.origemTitle('naomedido', 999), /não medido/i);
  assert.match(api.origemTitle('duravel', 10), /Persistente|L1\/L2|durável/i);
  assert.equal(api.origemTitle(null, 10), '', 'kind null: fail-open (title vazio)');
});

// --- 2. DOM fake (metricOrigem / applyOrigem) --------------------------------

test('applyOrigem/metricOrigem: title no DOM fake (cedo vs maduro)', () => {
  const api = requireOrigemApi();
  const limiar = api.AMOSTRA_CEDO_S ?? 300;
  assert.ok(
    typeof api.applyOrigem === 'function' || typeof api.metricOrigem === 'function',
    'aguardando applyOrigem ou metricOrigem em dashboard-core.js',
  );

  if (typeof api.applyOrigem === 'function') {
    const el = fakeNode();
    api.applyOrigem(el, 7, 'amostra', limiar - 1);
    assert.equal(el.textContent, '7');
    assert.match(el.title, /uptime baixo|subcontar/i);
    assert.match(el.className, /amostra-cedo/);

    api.applyOrigem(el, 7, 'amostra', limiar);
    assert.match(el.title, /≠|L1\/L2|processo/i);

    api.applyOrigem(el, 99, 'naomedido', 0);
    assert.equal(el.textContent, '—');
    assert.match(el.title, /não medido/i);

    api.applyOrigem(el, 3, null, 0);
    assert.equal(el.textContent, '3', 'kind null: fail-open mostra o valor');
    assert.equal(el.title, '', 'kind null: remove title');
  }

  if (typeof api.metricOrigem === 'function') {
    const box = fakeNode();
    api.metricOrigem(box, 'sizeAlive', 12, 'amostra', limiar - 1);
    const span = valueSpan(box);
    assert.ok(span, 'metricOrigem cria span.value');
    assert.equal(span!.textContent, '12');
    assert.match(span!.title, /uptime baixo|subcontar/i);
    assert.match(span!.className, /amostra-cedo/);

    const box2 = fakeNode();
    api.metricOrigem(box2, 'sizeAlive', 12, 'amostra', limiar);
    const span2 = valueSpan(box2);
    assert.ok(span2);
    assert.match(span2!.title, /≠|L1\/L2|processo/i);
  }
});

// --- 3. Regex: core define origemOf + AMOSTRA_CEDO_S -------------------------

test('dashboard-core.js define origemOf e AMOSTRA_CEDO_S', () => {
  const core = readFileSync(CORE_URL, 'utf8');
  assert.match(core, /\b(?:function|var)\s+origemOf\b|\borigemOf\s*=/);
  assert.match(core, /\bAMOSTRA_CEDO_S\b\s*=\s*\d+/);
});

// --- 4. Regex dual confirm --------------------------------------------------

test('runAction (status) e drain (harvest) pedem window.confirm', () => {
  const status = readFileSync(STATUS_URL, 'utf8');
  const harvest = readFileSync(HARVEST_URL, 'utf8');

  const runAction = status.match(/function\s+runAction\s*\([^)]*\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(runAction, 'runAction não encontrado em dashboard-status.js');
  assert.match(runAction![0], /window\.confirm\s*\(/);

  const drain = harvest.match(/function\s+drainHarvesterQueue\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
  assert.ok(drain, 'drainHarvesterQueue não encontrado em dashboard-harvest.js');
  assert.match(drain![0], /window\.confirm\s*\(/);
});

// --- 5. Autofetch dead path (assert flexível) --------------------------------

test('autofetch dead path usa applyOrigem ou origemOf (não naomedido isolado)', () => {
  const af = readFileSync(AUTOFETCH_URL, 'utf8');
  const deadIdx = af.search(/afMetricDead|deadBlacklistCount/);
  assert.ok(deadIdx >= 0, 'afMetricDead / deadBlacklistCount ausente no autofetch');
  // Janela ao redor do primeiro uso — cobre o bloco de paint do dead.
  const win = af.slice(Math.max(0, deadIdx - 120), deadIdx + 900);
  const usesHelper = /\bapplyOrigem\s*\(|\borigemOf\s*\(/.test(win);
  assert.ok(
    usesHelper,
    'aguardando dead path usar applyOrigem/origemOf (não lógica naomedido hardcode isolada)',
  );
});
