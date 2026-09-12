import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapDashboard, dashboardHtml, resetDashboardEnvironment } from './helpers/dashboard.js';

// ---------------------------------------------------------------------------
// C3 — payload que o back-end já entrega e a tela pinta: catálogo no poll,
// diagnóstico de stall do Chupim, memória/serviços/contadores e resolver nunca
// medido. Importa o emit real.
// ---------------------------------------------------------------------------

function flat(node: any): string {
  if (!node) return '';
  return [String(node.textContent || '')].concat((node.children || []).map(flat)).join(' ');
}

const CATALOG_REPORT = {
  ok: true,
  report: {
    magnets: 7, ready: 5,
    works: { known: 4, unknown: 3 },
    byCached: { hit: 3, miss: 2, blocked: 1, unknown: 1 },
    byBucket: { dub: { count: 2, bytes: 2048 }, dual: { count: 1, bytes: 1024 } },
    totals: { count: 7, bytes: 4096 },
  },
};

test('catálogo no poll popula #catalog_report sem POST', async () => {
  const { dom, mods } = await bootstrapDashboard();
  let fetches = 0;
  dom.setFetch(() => { fetches += 1; return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }); });
  mods.catalogPanel.renderCatalogPanel({ catalog: CATALOG_REPORT });
  const texto = flat(dom.byId['catalog_report']);
  assert.match(texto, /Magnets/);
  assert.match(texto, / 7/);
  assert.match(texto, /Dublado/);
  assert.match(texto, /⚡ hit: 3/);
  assert.match(texto, /Totais: 7 magnets/);
  assert.equal(fetches, 0, 'o relatório do poll não dispara requisição');
  dom.cleanup();
});

test('catálogo indisponível vira erro com hint; shape alheio não apaga a seção', async () => {
  const { dom, mods } = await bootstrapDashboard();
  mods.catalogPanel.renderCatalogPanel({ catalog: { ok: false, reason: 'chave-operador-desativada', hint: 'ligue DEBRID_OPERATOR_ENV_ACCOUNT' } });
  assert.match(flat(dom.byId['catalog_report']), /DEBRID_OPERATOR_ENV_ACCOUNT/);
  dom.byId['catalog_report'].textContent = '';
  mods.catalogPanel.renderCatalogPanel({ general: {} });
  assert.equal(flat(dom.byId['catalog_report']), '', 'sem catalog não mexe na seção');
  dom.cleanup();
});

const AF_STALL = {
  pendingLocks: 2,
  searchSlots: { searches: 3, occupied: 4 },
  seasonSearchKeys: 5,
  searchesInFlight: 1,
  lots: [
    { id: 'abc123def456', hashes: 7, attempts: 2, isSettle: false, ageMs: 65000, refusals: 1, inFlight: true },
    { id: 'ffff00001111', hashes: 3, attempts: 4, isSettle: true, ageMs: 900000, refusals: 0, inFlight: false },
  ],
  skips: { 'account-gate': 3, budget: 2 },
  lastSkips: [{ reason: 'budget', label: 'Coringa 1080p', pool: 'br', adapter: 'alldebrid', at: 1700000000000 }],
};

test('stall: lots/slots/locks/skips povoam #afStallMetrics', async () => {
  const { dom, mods } = await resetDashboardEnvironment();
  mods.afStall.renderAutofetchStall(AF_STALL, 1000);
  const box = dom.byId['afStallMetrics'];
  const texto = flat(box);
  for (const needle of ['pendingLocks', 'seasonSearchKeys', 'searchesInFlight', 'searchSlots (buscas)', 'searchSlots (ocupados)', 'desistências registradas', 'budget', 'Coringa 1080p']) {
    assert.ok(texto.includes(needle), 'painel de stall contém: ' + needle);
  }
  const table = box.children.find((n: any) => n.className === 'timer-table');
  assert.ok(table, 'tabela de lotes renderizada');
  assert.equal(table.children[1].children.length, 2);
  const lote = flat(table);
  assert.match(lote, /abc123def456/);
  assert.match(lote, /recheck · em voo/);
  assert.match(lote, /settle/);
  dom.cleanup();
});

const GENERAL_ROOT = {
  general: {
    ok: true, uptimeS: 1200,
    memory: { rss: 104857600, heapUsed: 52428800, heapTotal: 73400320 },
    services: { addon: true, jackett: 'naomedido', debrid: true, resolvers: 5 },
  },
  metrics: { counters: { 'debrid.cleanup.protectedBrSkipped': 11, 'debrid.instant.fromAliveAsCache': 4 } },
  magnetdb: { counters: { dropped: 9, droppedBad: 2 } },
  releaseIndex: { wastedQueries: 30, wastedMs: 4200, wastedQueriesBackground: 12, wastedMsBackground: 800 },
};

test('geral: memória, serviços tri-estado e contadores órfãos', async () => {
  const { dom, mods } = await resetDashboardEnvironment();
  mods.general.renderGeneralDiagnostics(GENERAL_ROOT);
  const texto = flat(dom.byId['generalDiagnostics']);
  for (const needle of ['Memória do processo', 'RSS 100 MB', 'Heap usado 50 MB', 'Heap total 70 MB', 'Serviços', 'não medido', 'resolvers embutidos', 'protectedBrSkipped', ' 11', 'fromAliveAsCache', 'magnetdb.counters.dropped', ' 9', 'wastedQueries', ' 30', 'wastedQueries.background', ' 12', 'wastedMs', 'wastedMs.background']) {
    assert.ok(texto.includes(needle), 'geral contém: ' + needle);
  }
  dom.cleanup();
});

test('renderGeneral faz o wiring do painel de processo pelo hook', async () => {
  const { dom, mods } = await resetDashboardEnvironment();
  let painted = 0;
  mods.hooks.hooks.register('renderGeneralDiagnostics', (root: any) => { painted += 1; mods.general.renderGeneralDiagnostics(root); });
  mods.panels.renderGeneral(GENERAL_ROOT);
  assert.equal(painted, 1);
  assert.match(flat(dom.byId['generalDiagnostics']), /Memória do processo/);
  dom.cleanup();
});

test('resolvers: sem status/lastMs/lastError o card diz "nunca medido"', async () => {
  const { dom, mods } = await resetDashboardEnvironment();
  mods.panels.renderSources({
    general: { uptimeS: 1000 },
    resolvers: [
      { id: 'vacatorrent', label: 'Vaca Torrent', port: 8703, embedded: true, domain: 'vaqueirofilmes.com' },
      { id: 'nerdfilmes', label: 'NerdFilmes', status: 'ok', lastMs: 800, lastError: null, results: 7 },
    ],
  });
  const cards = dom.byId['resolverCards'].children;
  const never = cards.find((c: any) => flat(c).includes('Vaca Torrent'));
  assert.ok(never, 'card do vacatorrent');
  assert.equal(never.getAttribute('data-status'), 'unknown', 'estado não medido');
  assert.match(flat(never), /nunca medido neste processo/);
  const medido = cards.find((c: any) => flat(c).includes('NerdFilmes'));
  assert.ok(medido);
  assert.match(flat(medido), /800/);
  dom.cleanup();
});

test('resolvers: AMOSTRA_CEDO_S distingue processo recém-iniciado', async () => {
  const { dom, mods } = await resetDashboardEnvironment();
  mods.panels.renderSources({ general: { uptimeS: 50 }, resolvers: [{ id: 'bludv', label: 'BluDV' }] });
  assert.match(flat(dom.byId['resolverCards'].children[0]), /recém-iniciado/);
  assert.match(flat(dom.byId['resolverCards'].children[0]), /nunca medido/);
  dom.cleanup();
});

test('resolvers: _origem lastMs=naomedido vence um lastMs residual', async () => {
  const { dom, mods } = await resetDashboardEnvironment();
  mods.panels.renderSources({ general: { uptimeS: 1000 }, resolvers: [{ id: 'torrentdosfilmes', label: 'Torrent dos Filmes', _origem: { lastMs: 'naomedido' }, lastMs: 555 }] });
  const card = dom.byId['resolverCards'].children[0];
  assert.equal(card.getAttribute('data-status'), 'unknown');
  assert.match(flat(card), /nunca medido neste processo/);
  dom.cleanup();
});

test('HTML contém os containers das três fases e os botões do catálogo', () => {
  const html = dashboardHtml();
  for (const id of ['generalDiagnostics', 'afStallMetrics', 'catalog_report', 'catalog_dedup_preview', 'catalog_targets']) {
    assert.match(html, new RegExp('id="' + id + '"'));
  }
  for (const id of ['catalogScanBtn', 'catalogDedupApplyBtn', 'catalogManualDeleteBtn', 'catalogSelectAllBtn']) {
    assert.match(html, new RegExp('id="' + id + '"'));
  }
});
