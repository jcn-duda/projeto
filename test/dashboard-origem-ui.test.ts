import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadDashboardModules, resetDashboardEnvironment } from './helpers/dashboard.js';

// ---------------------------------------------------------------------------
// C3 — UI de incerteza (_origem): helpers puros no core, pintura no render.
// Importa o emit real (sem `new Function`) e exercita o Fake DOM do helper.
// ---------------------------------------------------------------------------

test('origemValue(x, "naomedido") === "—"', async () => {
  const mods = await loadDashboardModules();
  assert.equal(mods.core.origemValue(42, 'naomedido'), '—');
  assert.equal(mods.core.origemValue(0, 'naomedido'), '—');
  assert.equal(mods.core.origemValue('qualquer', 'naomedido'), '—');
});

test('origemOf lê _origem; kind inválido/mapa ausente → null (fail-open)', async () => {
  const mods = await loadDashboardModules();
  assert.equal(mods.core.origemOf({ _origem: { sizeAlive: 'duravel' } }, 'sizeAlive'), 'duravel');
  assert.equal(mods.core.origemOf({ _origem: { sizeAlive: 'amostra' } }, 'sizeAlive'), 'amostra');
  assert.equal(mods.core.origemOf({ _origem: { sizeAlive: 'naomedido' } }, 'sizeAlive'), 'naomedido');
  assert.equal(mods.core.origemOf({ _origem: { sizeAlive: 'lixo' } }, 'sizeAlive'), null);
  assert.equal(mods.core.origemOf({}, 'sizeAlive'), null);
  assert.equal(mods.core.origemOf(null, 'sizeAlive'), null);
  assert.equal(mods.core.origemOf({ _origem: null }, 'sizeAlive'), null);
});

test('origemTitle distingue amostra cedo/madura, naomedido e null', async () => {
  const mods = await loadDashboardModules();
  const limiar = mods.core.AMOSTRA_CEDO_S;
  const cedo = mods.core.origemTitle('amostra', limiar - 1);
  const maduro = mods.core.origemTitle('amostra', limiar);
  assert.match(cedo, /uptime baixo|subcontar/i);
  assert.match(maduro, /≠|L1\/L2|processo/i);
  assert.notEqual(cedo, maduro);
  assert.match(mods.core.origemTitle('naomedido', 999), /não medido/i);
  assert.match(mods.core.origemTitle('duravel', 10), /Persistente|L1\/L2|durável/i);
  assert.equal(mods.core.origemTitle(null, 10), '');
});

test('applyOrigem/metricOrigem pintam title e amostra-cedo no DOM', async () => {
  const { dom, mods } = await resetDashboardEnvironment();
  const limiar = mods.core.AMOSTRA_CEDO_S;
  const el = dom.element('origemNode');
  mods.render.applyOrigem(el, 7, 'amostra', limiar - 1);
  assert.equal(el.textContent, '7');
  assert.match(el.title, /uptime baixo|subcontar/i);
  assert.match(el.className, /amostra-cedo/);

  mods.render.applyOrigem(el, 7, 'amostra', limiar);
  assert.match(el.title, /≠|L1\/L2|processo/i);

  mods.render.applyOrigem(el, 99, 'naomedido', 0);
  assert.equal(el.textContent, '—');
  assert.match(el.title, /não medido/i);

  mods.render.applyOrigem(el, 3, null, 0);
  assert.equal(el.textContent, '3', 'kind null: fail-open mostra o valor');
  assert.equal(el.title, '', 'kind null: remove title');

  const box = dom.element('origemMetrics');
  mods.render.metricOrigem(box, 'sizeAlive', 12, 'amostra', limiar - 1);
  const metric = box.children[0];
  const span = metric.children.find((c: any) => String(c.className).includes('value'));
  assert.ok(span, 'metricOrigem cria span.value');
  assert.equal(span.textContent, '12');
  assert.match(span.title, /uptime baixo|subcontrar/i);
  assert.match(span.className, /amostra-cedo/);
  dom.cleanup();
});

test('autofetch suppressed usa origemOf (durável do snapshot) e fail-open sem _origem', async () => {
  const { dom, mods } = await resetDashboardEnvironment();
  mods.hooks.hooks.register('renderAutofetchStall', () => {});
  mods.autofetch.renderAutofetchPanel({ config: { effective: {}, envDefaults: {}, overriddenKeys: [] }, suppressed: 9, _origem: { suppressed: 'duravel' } }, 1000);
  assert.equal(dom.byId['afMetricSuppressed'].textContent, '9');
  assert.match(dom.byId['afMetricSuppressed'].title, /Persistente|L1\/L2|durável/i);
  mods.autofetch.renderAutofetchPanel({ config: { effective: {}, envDefaults: {}, overriddenKeys: [] }, suppressed: 9 }, 1000);
  assert.equal(dom.byId['afMetricSuppressed'].title, '', 'sem _origem o title esvazia');
  dom.cleanup();
});
