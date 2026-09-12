import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bootstrapDashboard, dashboardHtml, registerDashboardHooks, resetDashboardEnvironment } from './helpers/dashboard.js';

// ---------------------------------------------------------------------------
// C3 — faixa sticky de sinais vitais, faixa de atenção (mesma fonte do banner),
// estado vazio honesto sem token e render da aba ativa. Importa o emit real.
// ---------------------------------------------------------------------------

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

// textNode é { text } no Fake DOM; o valor do sinal vive no segundo filho do
// health-value.
function signalValue(cell: any): string {
  const value = cell.children[1];
  const text = value.children[1];
  return String(text && text.text !== undefined ? text.text : '');
}

test('faixa de saúde: taxa ⚡ usa cached/hashes e exclui davail; seis sinais com title', async () => {
  const { dom, mods } = await resetDashboardEnvironment();
  mods.health.renderHealthStrip(PAYLOAD);
  const cells = dom.byId['healthStrip'].children;
  assert.equal(cells.length, 6);
  assert.equal(signalValue(cells[0]), '30%', '30/100, não 85% com davail somado');
  assert.match(cells[0].title, /davail/);
  assert.match(cells[0].title, /fora da taxa/);
  assert.deepEqual(cells.map((c: any) => c.children[0].textContent), ['Taxa ⚡', 'Conta debrid', 'Indexers', 'Cache', 'Chupim', '1ª resposta (I0)']);
  for (const cell of cells) {
    assert.match(cell.className, /health-cell state-(online|warn|error|unknown)/);
    assert.ok(cell.title.length > 0);
  }
  assert.match(cells[1].className, /state-online/);
  assert.match(cells[4].className, /state-online/);
  assert.match(cells[5].className, /state-online/);
  assert.match(signalValue(cells[4]), /2 fila\(s\)/);
  dom.cleanup();
});

test('faixa de saúde: conta warn/erro e payload vazio', async () => {
  const { dom, mods } = await resetDashboardEnvironment();
  mods.health.renderHealthStrip({ debrid: { account: { service: 'alldebrid', ok: true, warn: true, warnAt: 4000, warnAtUnit: 'magnets', magnets: 3900 } } });
  assert.match(dom.byId['healthStrip'].children[1].className, /state-warn/);
  assert.match(dom.byId['healthStrip'].children[1].title, /aviso operacional/);

  mods.health.renderHealthStrip({ debrid: { account: { service: 'alldebrid', ok: false, reason: 'quota' } } });
  assert.match(dom.byId['healthStrip'].children[1].className, /state-error/);

  assert.doesNotThrow(() => mods.health.renderHealthStrip({}));
  assert.equal(dom.byId['healthStrip'].children.length, 6);
  assert.match(dom.byId['healthStrip'].children[0].className, /state-unknown/);
  assert.equal(signalValue(dom.byId['healthStrip'].children[0]), '—');
  dom.cleanup();
});

test('faixa de atenção reutiliza collectStatusIssues e some sozinha quando saudável', async () => {
  const { dom, mods } = await resetDashboardEnvironment();
  const issues = mods.statusIssues.collectStatusIssues({
    indexers: [{ id: 'track1', name: 'Track1', online: false, breaker: { state: 'fechado' } }],
    resolvers: [{ id: 'res1', label: 'Res 1', broken: true }],
    debrid: { account: { service: 'realdebrid', ok: true, warn: true, label: 'RealDebrid' } },
  });
  mods.health.renderAttentionStrip(issues);
  const strip = dom.byId['attentionStrip'];
  assert.match(strip.className, /visible/);
  const texto = strip.children.map((l: any) => l.textContent).join('\n');
  assert.match(texto, /Track1/);
  assert.match(texto, /Res 1/);
  assert.match(texto, /aviso operacional/);

  mods.health.renderAttentionStrip(mods.statusIssues.collectStatusIssues({ indexers: [], resolvers: [] }));
  assert.ok(!/visible/.test(strip.className), 'saudável: faixa some');
  dom.cleanup();
});

test('faixa de atenção: issue error (addon=false) + catálogo ok:false trocam para erro', async () => {
  const { dom, mods } = await resetDashboardEnvironment();
  const issues = mods.statusIssues.collectStatusIssues({
    indexers: [], resolvers: [],
    catalog: { ok: false, reason: 'erro' },
    general: { services: { addon: false } },
  });
  mods.health.renderAttentionStrip(issues);
  assert.match(dom.byId['attentionStrip'].className, /error/);
  assert.match(dom.byId['attentionStrip'].children.map((l: any) => l.textContent).join('\n'), /Catálogo/);
  dom.cleanup();
});

test('estado vazio honesto: sem token aparece; com token some', async () => {
  const { dom, mods } = await resetDashboardEnvironment();
  mods.state.DashState.token = '';
  mods.health.updateEmptyState();
  assert.equal(dom.byId['healthEmptyState'].hidden, false);
  mods.state.DashState.token = 'tok';
  mods.health.updateEmptyState();
  assert.equal(dom.byId['healthEmptyState'].hidden, true);
  dom.cleanup();
});

test('HTML do estado vazio nomeia causa e saída, sem prometer carga', () => {
  const html = dashboardHtml();
  for (const needle of ['id="healthEmptyState"', 'id="emptyToken"', 'id="emptySaveToken"', 'JACKETT_TEST_TOKEN', 'Salvar e consultar', 'Nenhuma requisição foi feita']) {
    assert.ok(html.includes(needle), 'HTML contém: ' + needle);
  }
  assert.doesNotMatch(html, /Aguardando \/dashboard-status\.json/);
  assert.doesNotMatch(html, /Aguardando amostra\./);
});

test('poll só desenha a aba ativa; troca desenha a recém-ativada com o último payload', async () => {
  const { dom, mods } = await bootstrapDashboard();
  let afPaints = 0;
  mods.hooks.hooks.register('renderAutofetchStall', () => { afPaints += 1; });
  dom.byId['tabGeral'].className = 'tab-btn active';
  for (const id of ['tabAutofetch', 'tabColhedor', 'tabTrace']) dom.byId[id].className = 'tab-btn';
  mods.statusRoot.renderStatus(PAYLOAD);
  mods.statusRoot.renderStatus(PAYLOAD);
  assert.equal(afPaints, 0, 'aba oculta não desenha no poll');
  mods.nav.switchTab('autofetch');
  assert.equal(afPaints, 1, 'troca desenha a recém-ativada pelo hook');
  dom.cleanup();
});

test('CSS da faixa sticky, chips e compensação de scroll', () => {
  const css = readFileSync(new URL('../src/public/dashboard.css', import.meta.url), 'utf8');
  assert.match(css, /\.health-wrap\s*\{[^}]*position:\s*sticky[^}]*\}/);
  assert.match(css, /\.health-strip/);
  assert.match(css, /\.attention-strip\.visible/);
  assert.match(css, /\.section-chip\.active/);
  assert.match(css, /scroll-margin-top:\s*1\d\dpx/);
  assert.match(css, /\.wrap\s*\{\s*max-width:\s*1440px/);
  assert.match(css, /@media\s*\(min-width:\s*1600px\)/);
  assert.match(css, /#viewGeral\s*\{[^}]*grid-template-columns:\s*repeat\(12/);
  assert.equal(css.match(/#[0-9a-fA-F]{3,8}\b/g), null);
});
