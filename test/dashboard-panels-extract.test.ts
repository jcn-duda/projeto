import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Runtime dos módulos extraídos na Fase 1 do painel (magnetdb → panels,
// Chupim → dashboard-autofetch). Separado de dashboard.test.ts para caber
// no teto de 400 linhas da catraca.

type FakeNode = {
  className: string;
  textContent: string;
  title: string;
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
    title: '',
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

function loadPanelsApi(): {
  els: Record<string, FakeNode>;
  renderMagnetDb: (data: unknown, counters: unknown) => void;
  renderMagnetSummaryMetrics: (data: unknown) => void;
} {
  // Fase 0: helpers de desenho migraram do core para dashboard-render.js e o
  // painel do MagnetDB migrou de panels para dashboard-magnets.js (container
  // próprio #magnetMetrics).
  const core = readFileSync(new URL('../src/public/dashboard-core.js', import.meta.url), 'utf8');
  const render = readFileSync(new URL('../src/public/dashboard-render.js', import.meta.url), 'utf8');
  const panels = readFileSync(new URL('../src/public/dashboard-panels.js', import.meta.url), 'utf8');
  const magnets = readFileSync(new URL('../src/public/dashboard-magnets.js', import.meta.url), 'utf8');
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
    core + '\n' + render + '\n' + panels + '\n' + magnets +
      '\nreturn { renderMagnetDb: renderMagnetDb, renderMagnetSummaryMetrics: renderMagnetSummaryMetrics };',
  ) as (doc: unknown, win: unknown) => {
    renderMagnetDb: (data: unknown, counters: unknown) => void;
    renderMagnetSummaryMetrics: (data: unknown) => void;
  };
  return { els, renderMagnetDb: factory(document, window).renderMagnetDb, renderMagnetSummaryMetrics: factory(document, window).renderMagnetSummaryMetrics };
}

function loadAutofetchApi(): { els: Record<string, FakeNode>; renderAutofetchPanel: (af: unknown, uptimeS?: number) => void } {
  const core = readFileSync(new URL('../src/public/dashboard-core.js', import.meta.url), 'utf8');
  const render = readFileSync(new URL('../src/public/dashboard-render.js', import.meta.url), 'utf8');
  const afJs = readFileSync(new URL('../src/public/dashboard-autofetch.js', import.meta.url), 'utf8');
  // Fase 1 do saneamento: o fim do renderAutofetchPanel pede o painel de stall
  // por DashHooks.call — o registro precisa existir na composição. Fase 2
  // (call estrito): hook obrigatório ausente lança, então sem o af-stall no
  // sandbox o stub é registrado explicitamente aqui.
  const hooks = readFileSync(new URL('../src/public/dashboard-hooks.js', import.meta.url), 'utf8');
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
    hooks + '\n' + core + '\n' + render + '\n' + afJs + '\nDashHooks.register("renderAutofetchStall", function () {});\nreturn { renderAutofetchPanel: renderAutofetchPanel };',
  ) as (doc: unknown, win: unknown) => { renderAutofetchPanel: (af: unknown, uptimeS?: number) => void };
  return { els, renderAutofetchPanel: factory(document, window).renderAutofetchPanel };
}

function flat(node: FakeNode): string {
  return [node.textContent].concat(node.children.map(flat)).join(' ');
}

test('renderMagnetDb: L1 mag, agregados duráveis e bad≠dead no Fake DOM', () => {
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
  const text = flat(els.magnetMetrics);
  assert.match(text, /L1 mag/i);
  assert.match(text, /1200\s*\/\s*50000/);
  assert.match(text, /registros classificados/i);
  assert.match(text, /play sem vídeo/i);
  assert.match(text, /descartados dead/i);
  assert.match(text, /autofetch ≠ bad/);
  assert.match(text, /40%/);
});

// Caso real do feedback (VPS): l1Entries=405 contra agregados 73/0/1 — a UI
// separa a ocupação bruta do L1 dos estados restaurados pelo mag_meta, sem
// afirmar que tudo no L1 é válido (órfãos/expirados podem existir).
test('renderMagnetDb: distingue ocupação L1 dos agregados persistentes', () => {
  const { els, renderMagnetDb } = loadPanelsApi();
  renderMagnetDb(
    {
      enabled: true,
      l1Entries: 405,
      l1Max: 50000,
      sizeAlive: 73,
      sizeBad: 0,
      sizeLie: 1,
      evictedQuota: 2,
      aliveTtlSeconds: 604800,
      badTtlSeconds: 86400,
      lieTtlSeconds: 604800,
      ttlRemainingSeconds: { alive: 432000, bad: null, lie: 100000 },
      counters: {
        aliveSet: 180,
        badSet: 4,
        lieSet: 1,
        droppedBad: 3,
        droppedDead: 5,
        droppedLie: 1,
        badClearedBlocked: 2,
      },
      byAdapter: { alldebrid: { sizeAlive: 73, sizeBad: 0, sizeLie: 1 } },
    },
    { 'debrid.check.hashes': 200, 'debrid.check.cached': 50 },
  );
  const text = flat(els.magnetMetrics);
  // Grupos com procedência explícita, na ordem: L1 × agregados × contadores.
  assert.match(text, /Registros persistentes no banco/i);
  assert.match(text, /405\s*\/\s*50000/, 'ocupação real do namespace mag no L1');
  assert.match(text, /Agregados persistentes por estado e serviço/i);
  assert.match(text, /registros classificados \(≠ L1\)/);
  // Textos curtos: agregados sobrevivem ao restart; mesmo hash pode ter
  // conta/estado; L1 pode conter órfãos — não é contagem de válidos.
  assert.match(text, /agregados sobrevivem ao restart pelo mag_meta/i);
  assert.match(text, /o mesmo hash pode figurar mais de uma vez/i);
  assert.match(text, /expirados ou órfãos/i);
  // Contadores de gravação/renovação e descartes, além da taxa de cache medida.
  assert.match(text, /gravações alive \(inclui renovações\)/i);
  assert.match(text, /descartados dead/i);
  assert.match(text, /25% \(50\/200\)/);
});

// Achado B1 (Fase 0): renderMagnetSummaryMetrics dividia o #magnetMetrics com
// o renderMagnetDb — cada poll (renderStatus) apagava o resumo manual que o
// operador acabara de pedir. Cada um agora pinta o próprio container.
test('renderMagnetSummaryMetrics usa container próprio e sobrevive ao poll do renderMagnetDb', () => {
  const { els, renderMagnetDb, renderMagnetSummaryMetrics } = loadPanelsApi();
  renderMagnetSummaryMetrics({
    ok: true,
    entries: 74,
    totals: { alive: 73, bad: 0, lie: 1 },
    byAdapter: { alldebrid: { alive: 73, bad: 0, lie: 1 } },
  });
  const summaryText = flat(els.magnetSummaryMetrics);
  assert.match(summaryText, /Totais consolidados do MagnetDB/i);
  assert.match(summaryText, /74/);
  assert.match(summaryText, /serviço alldebrid/i);
  // O poll seguinte (renderMagnetDb) pinta o container dele sem tocar o resumo.
  renderMagnetDb(
    {
      enabled: true,
      l1Entries: 405,
      l1Max: 50000,
      sizeAlive: 73,
      sizeBad: 0,
      sizeLie: 1,
      counters: {},
      byAdapter: {},
    },
    {},
  );
  assert.match(flat(els.magnetSummaryMetrics), /Totais consolidados do MagnetDB/i, 'resumo manual não é apagado pelo poll');
  assert.match(flat(els.magnetMetrics), /L1 mag/i, 'poll pinta o container próprio do renderMagnetDb');
});

test('renderAutofetchPanel: config.paused pinta afMetricState = PAUSADO', () => {
  const { els, renderAutofetchPanel } = loadAutofetchApi();
  renderAutofetchPanel({ config: { paused: true, effective: {}, envDefaults: {}, overriddenKeys: [] } });
  assert.equal(els.afMetricState.textContent, 'PAUSADO');
});

// Fila de remoções represadas (gate removeById): pinta pelo mesmo caminho de
// origem do dead — número do snapshot + procedência durável no title.
test('renderAutofetchPanel: suppressed pinta afMetricSuppressed com origem durável', () => {
  const { els, renderAutofetchPanel } = loadAutofetchApi();
  renderAutofetchPanel({
    config: { effective: {}, envDefaults: {}, overriddenKeys: [] },
    suppressed: 7,
    _origem: { suppressed: 'duravel' },
  }, 4000);
  assert.equal(els.afMetricSuppressed.textContent, '7');
  assert.match(els.afMetricSuppressed.title, /Persistente|durável/i);
});

// Fail-open do paintAfOrigem: sem _origem (backend ainda sem a chave) o número
// fica e o title esvazia — mesma tolerância que o dead tem com rota velha.
test('renderAutofetchPanel: suppressed sem _origem mantém o número (fail-open)', () => {
  const { els, renderAutofetchPanel } = loadAutofetchApi();
  renderAutofetchPanel({
    config: { effective: {}, envDefaults: {}, overriddenKeys: [] },
    suppressed: 3,
  }, 4000);
  assert.equal(els.afMetricSuppressed.textContent, '3');
  assert.equal(els.afMetricSuppressed.title, '');
});

// Sem a chave inteira (rota velha), `af.suppressed || 0` pinta 0 — e o gating
// do botão (status.js) fica no fail-closed: não há como drenar o invisível.
test('renderAutofetchPanel: suppressed ausente pinta 0', () => {
  const { els, renderAutofetchPanel } = loadAutofetchApi();
  renderAutofetchPanel({ config: { effective: {}, envDefaults: {}, overriddenKeys: [] } }, 4000);
  assert.equal(els.afMetricSuppressed.textContent, '0');
});
