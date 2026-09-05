import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Runtime dos módulos extraídos na Fase 1 do painel (magnetdb → panels,
// Chupim → dashboard-autofetch). Separado de dashboard.test.ts para caber
// no teto de 400 linhas da catraca.

type FakeNode = {
  className: string;
  textContent: string;
  style: Record<string, string>;
  children: FakeNode[];
  checked: boolean;
  value: string;
  appendChild(child: FakeNode): FakeNode;
};

function fakeNode(): FakeNode {
  const node: FakeNode = {
    className: '',
    textContent: '',
    style: {},
    children: [],
    checked: false,
    value: '',
    appendChild(child: FakeNode) {
      node.children.push(child);
      return child;
    },
  };
  return node;
}

function loadPanelsApi(): { els: Record<string, FakeNode>; renderMagnetDb: (data: unknown, counters: unknown) => void } {
  const core = readFileSync(new URL('../src/public/dashboard-core.js', import.meta.url), 'utf8');
  const panels = readFileSync(new URL('../src/public/dashboard-panels.js', import.meta.url), 'utf8');
  const els: Record<string, FakeNode> = {};
  const document = {
    createElement: () => fakeNode(),
    createTextNode: (text: string) => ({ text }),
    getElementById: (id: string) => (els[id] = els[id] || fakeNode()),
    addEventListener: () => {},
  };
  const window = {
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    location: { pathname: '/dashboard' },
    confirm: () => false,
    addEventListener: () => {},
  };
  const factory = new Function(
    'document',
    'window',
    core + '\n' + panels + '\nreturn { renderMagnetDb: renderMagnetDb };',
  ) as (doc: unknown, win: unknown) => { renderMagnetDb: (data: unknown, counters: unknown) => void };
  return { els, renderMagnetDb: factory(document, window).renderMagnetDb };
}

function loadAutofetchApi(): { els: Record<string, FakeNode>; renderAutofetchPanel: (af: unknown) => void } {
  const core = readFileSync(new URL('../src/public/dashboard-core.js', import.meta.url), 'utf8');
  const afJs = readFileSync(new URL('../src/public/dashboard-autofetch.js', import.meta.url), 'utf8');
  const els: Record<string, FakeNode> = {};
  const document = {
    getElementById: (id: string) => (els[id] = els[id] || fakeNode()),
    createElement: () => fakeNode(),
    createTextNode: (text: string) => ({ text }),
    addEventListener: () => {},
  };
  const window = {
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    location: { pathname: '/dashboard' },
    confirm: () => false,
    addEventListener: () => {},
  };
  const factory = new Function(
    'document',
    'window',
    core + '\n' + afJs + '\nreturn { renderAutofetchPanel: renderAutofetchPanel };',
  ) as (doc: unknown, win: unknown) => { renderAutofetchPanel: (af: unknown) => void };
  return { els, renderAutofetchPanel: factory(document, window).renderAutofetchPanel };
}

function flat(node: FakeNode): string {
  return [node.textContent].concat(node.children.map(flat)).join(' ');
}

test('renderMagnetDb: L1 mag, amostra e bad≠dead no Fake DOM', () => {
  const { els, renderMagnetDb } = loadPanelsApi();
  renderMagnetDb(
    {
      enabled: true,
      l1Entries: 1200,
      l1Max: 50000,
      sizeAlive: 10,
      sizeBad: 2,
      sizeLie: 1,
      evictedQuota: 0,
      aliveTtlSeconds: 604800,
      badTtlSeconds: 86400,
      lieTtlSeconds: 604800,
      counters: { droppedBad: 3, droppedDead: 5, droppedLie: 1 },
      byAdapter: { alldebrid: { sizeAlive: 8, sizeBad: 1, sizeLie: 0 } },
    },
    { 'debrid.check.hashes': 100, 'debrid.check.cached': 40 },
  );
  const text = flat(els.cacheMetrics);
  assert.match(text, /L1 mag/i);
  assert.match(text, /1200\s*\/\s*50000/);
  assert.match(text, /amostra processo/i);
  assert.match(text, /play sem vídeo/i);
  assert.match(text, /descartados dead/i);
  assert.match(text, /autofetch ≠ bad/);
  assert.match(text, /40%/);
});

test('renderAutofetchPanel: config.paused pinta afMetricState = PAUSADO', () => {
  const { els, renderAutofetchPanel } = loadAutofetchApi();
  renderAutofetchPanel({ config: { paused: true, effective: {}, envDefaults: {}, overriddenKeys: [] } });
  assert.equal(els.afMetricState.textContent, 'PAUSADO');
});
