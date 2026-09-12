import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CLIENT_ASSETS, PAGE_ASSETS } from '../src/routes/public.js';
import { dashboardHtml, loadDashboardModules } from './helpers/dashboard.js';

// ---------------------------------------------------------------------------
// C3 — contrato de QUEM define o quê no cliente ESM do dashboard. Em vez de
// regexar o texto de cada arquivo (frágil a refactor de formato), importa-se o
// emit Node real e se checa os símbolos exportados por módulo. A allowlist/PAGE_
// ASSETS e o entry único ficam no dashboard-esm.test.ts.
// ---------------------------------------------------------------------------

test('render define os helpers de desenho; core mantém os puros', async () => {
  const mods = await loadDashboardModules();
  for (const fn of ['formatBytes', 'formatDuration', 'formatDate', 'displayValue', 'stateName', 'stateLabel', 'element', 'empty', 'applyOrigem', 'metricOrigem', 'metric', 'renderMetrics', 'asList', 'card', 'drawSparkline']) {
    assert.equal(typeof mods.render[fn], 'function', 'render exporta ' + fn);
    assert.equal(mods.core[fn], undefined, 'core não define mais ' + fn);
  }
  for (const fn of ['isObject', 'first', 'valueText', 'origemOf', 'origemValue', 'origemTitle', 'requestJson', 'pushSeries']) {
    assert.equal(typeof mods.core[fn], 'function', 'core mantém ' + fn);
  }
  assert.equal(typeof mods.core.$, 'function');
  assert.equal(mods.core.AMOSTRA_CEDO_S, 300);
});

test('probes definem as sondas; status-root mantém o polling/ações', async () => {
  const mods = await loadDashboardModules();
  for (const fn of ['runIndexerTest', 'runResolverTest', 'testResultText', 'resolverTestResultText']) {
    assert.equal(typeof mods.probes[fn], 'function', 'probes exporta ' + fn);
    assert.equal(mods.statusRoot[fn], undefined, 'status-root não define mais ' + fn);
  }
  for (const fn of ['renderStatus', 'loadStatus', 'scheduleRefresh']) {
    assert.equal(typeof mods.statusRoot[fn], 'function', 'status-root mantém ' + fn);
  }
  assert.equal(typeof mods.statusActions.runAction, 'function', 'runAction mora em status-actions');
  assert.equal(typeof mods.statusIssues.collectStatusIssues, 'function', 'collectStatusIssues mora em status-issues');
});

test('nav define as abas; panels não as define; magnets define renderMagnetDb', async () => {
  const mods = await loadDashboardModules();
  for (const fn of ['switchTab', 'handleHash', 'activeTabName', 'renderSectionNav', 'setSectionExpanded']) {
    assert.equal(typeof mods.nav[fn], 'function', 'nav exporta ' + fn);
  }
  assert.equal(mods.panels.switchTab, undefined);
  assert.equal(mods.panels.handleHash, undefined);
  assert.equal(typeof mods.magnets.renderMagnetDb, 'function');
  assert.equal(mods.panels.renderMagnetDb, undefined, 'o banco não mora em panels');
  assert.equal(typeof mods.panelsL2.renderCache, 'function');
  assert.equal(typeof mods.panelsIndex.renderReleaseIndex, 'function');
  assert.equal(typeof mods.general.renderGeneralDiagnostics, 'function');
});

test('HTML do painel referencia só o entry ESM e nenhum asset clássico', () => {
  const html = dashboardHtml();
  assert.equal((html.match(/<script\b/g) || []).length, 1);
  assert.match(html, /<script type="module" src="\/client\/dashboard\/entry\.js"><\/script>/);
  assert.doesNotMatch(html, /src="\/dashboard-[\w-]+\.js/);
});

test('PAGE_ASSETS só tem CSS; CLIENT_ASSETS cobre os módulos ESM', () => {
  assert.equal(PAGE_ASSETS.some((a) => a.endsWith('.js')), false, 'PAGE_ASSETS ficou só com CSS/imagens');
  for (const asset of ['client/dashboard/entry.js', 'client/dashboard/core.js', 'client/dashboard/render.js', 'client/dashboard/status-root.js', 'client/dashboard/magnets.js']) {
    assert.ok(CLIENT_ASSETS.includes(asset), 'allowlist fechada sem ' + asset);
  }
});
