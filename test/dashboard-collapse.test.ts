import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PAGE_ASSETS } from '../src/routes/public.js';
import { dashboardHtml, resetDashboardEnvironment } from './helpers/dashboard.js';

// ---------------------------------------------------------------------------
// C3 — progressive disclosure das 9 seções da Geral. Contrato do HTML + runtime
// do nav ESM no Fake DOM + CSS. Sem `new Function` e sem ordem de scripts.
// ---------------------------------------------------------------------------

const GERAL_SECTIONS = ['secGeral', 'secDebrid', 'secDebridTest', 'secSources', 'secCache', 'secMagnets', 'secIdx', 'secActions', 'secCatalog'];
const OPEN_BY_DEFAULT = 'secGeral';

// Monta as 9 seções (com .section-body/.section-toggle) sob #viewGeral, mais as
// seções de outras abas sem toggle para o fail-open.
function buildSections(dom: any) {
  dom.element('sectionNav');
  const view = dom.element('viewGeral');
  const toggles: any[] = [];
  for (const id of GERAL_SECTIONS) {
    const section = dom.attach(view, 'section', { id });
    const body = dom.attach(section, 'div', { id: id + 'Body', class: 'section-body' });
    if (id !== OPEN_BY_DEFAULT) body.setAttribute('hidden', 'hidden');
    const toggle = dom.attach(section, 'button', { id: 'toggle' + id.slice(3), class: 'section-toggle' });
    toggles.push(toggle);
  }
  // Seções de outras abas: sem corpo/toggle (fail-open).
  for (const id of ['secAfLive', 'secTrace']) dom.attach(view, 'section', { id });
  return { toggles };
}

async function collapseEnv() {
  const env = await resetDashboardEnvironment('');
  const { toggles } = buildSections(env.dom);
  return { ...env, toggles };
}

test('initSectionToggles sincroniza o botão com o [hidden] e é idempotente', async () => {
  const { dom, mods } = await collapseEnv();
  gridToggleDivergent(dom);
  mods.nav.initSectionToggles();
  assert.equal(dom.byId['toggleGeral'].getAttribute('aria-expanded'), 'true');
  assert.equal(dom.byId['toggleGeral'].textContent, 'Recolher');
  assert.equal(dom.byId['toggleDebrid'].getAttribute('aria-expanded'), 'false');
  assert.equal(dom.byId['toggleDebrid'].textContent, 'Expandir');
  mods.nav.initSectionToggles();
  assert.equal(dom.byId['toggleDebrid'].textContent, 'Expandir');
  dom.cleanup();
});

function gridToggleDivergent(dom: any) {
  dom.byId['toggleDebrid'].textContent = 'Recolher';
  dom.byId['toggleDebrid'].setAttribute('aria-expanded', 'true');
}

test('setSectionExpanded expande/recolhe com aria e rótulo; fail-open sem toggle', async () => {
  const { dom, mods } = await collapseEnv();
  assert.equal(mods.nav.setSectionExpanded('secDebrid', true), true);
  assert.equal(dom.byId['secDebridBody'].hasAttribute('hidden'), false);
  assert.equal(dom.byId['toggleDebrid'].getAttribute('aria-expanded'), 'true');
  assert.equal(dom.byId['toggleDebrid'].textContent, 'Recolher');
  assert.equal(mods.nav.setSectionExpanded('secDebrid', false), true);
  assert.equal(dom.byId['secDebridBody'].hasAttribute('hidden'), true);
  assert.equal(dom.byId['toggleDebrid'].textContent, 'Expandir');
  assert.equal(mods.nav.setSectionExpanded('nao-existe', true), false);
  assert.equal(mods.nav.setSectionExpanded('secAfLive', true), false);
  assert.equal(mods.nav.setSectionExpanded('secTrace', true), false);
  dom.cleanup();
});

test('chip expande ANTES de rolar; seção sem toggle só rola', async () => {
  const { dom, mods } = await collapseEnv();
  const chip = { getAttribute: (key: string) => (key === 'data-section' ? 'secMagnets' : null) };
  mods.nav.scrollToSection(chip);
  assert.equal(dom.byId['secMagnetsBody'].hasAttribute('hidden'), false, 'corpo aberto antes do scroll');
  assert.equal(dom.byId['toggleMagnets'].getAttribute('aria-expanded'), 'true');
  assert.equal(dom.byId['secMagnets'].scrolled, true, 'scrollIntoView chamado');
  dom.cleanup();
});

test('bindSectionToggles liga o clique uma vez e recolhe/expande pelo estado atual', async () => {
  const { dom, mods, toggles } = await collapseEnv();
  mods.nav.bindSectionToggles();
  mods.nav.bindSectionToggles();
  assert.equal(toggles.length, 9);
  // dispatch dispara o handler ligado pelo bind.
  dom.byId['toggleCache'].dispatch('click');
  assert.equal(dom.byId['secCacheBody'].hasAttribute('hidden'), false, 'clicar num fechado abre');
  assert.equal(dom.byId['toggleCache'].textContent, 'Recolher');
  dom.byId['toggleGeral'].dispatch('click');
  assert.equal(dom.byId['secGeralBody'].hasAttribute('hidden'), true, 'clicar num aberto recolhe');
  dom.byId['toggleGeral'].dispatch('click');
  assert.equal(dom.byId['secGeralBody'].hasAttribute('hidden'), false);
  dom.cleanup();
});

test('HTML: 9 toggles, 9 corpos, secGeral aberto e disclosure confinado à Geral', () => {
  const html = dashboardHtml();
  assert.equal((html.match(/class="section-toggle"/g) || []).length, 9);
  assert.equal((html.match(/class="section-body"/g) || []).length, 9);
  const geralStart = html.indexOf('id="viewGeral"');
  const geralEnd = html.indexOf('id="viewAutofetch"');
  for (const sec of GERAL_SECTIONS) {
    const idx = html.indexOf('id="' + sec + '"');
    assert.ok(idx > geralStart && idx < geralEnd, sec + ' dentro da Geral');
  }
  assert.equal((html.slice(geralEnd).match(/section-toggle|section-body/g) || []).length, 0);
  for (const sec of GERAL_SECTIONS) {
    const bodyId = sec + 'Body';
    const open = sec === OPEN_BY_DEFAULT;
    assert.match(html, new RegExp('id="' + bodyId + '" class="section-body"' + (open ? '>' : ' hidden>')));
  }
});

test('HTML: IDs/ações dentro dos corpos preservados', () => {
  const html = dashboardHtml();
  for (const id of ['generalMetrics', 'timerMetrics', 'generalDiagnostics', 'debridMetrics', 'debridCards', 'debridTestService', 'indexerCards', 'resolverCards', 'testIndexerId', 'cacheSparkline', 'cacheMetrics', 'magnetSummaryBtn', 'magnetInspectBtn', 'magnetClearBadBtn', 'idxMetrics', 'harvestMetrics', 'f3Metrics', 'catalogScanBtn', 'catalogDedupApplyBtn', 'catalog_targets', 'catalog_manual']) {
    assert.match(html, new RegExp('id="' + id + '"'), id + ' preservado');
  }
});

test('CSS: [hidden] recolhe, head-right, toggle e 44px no mobile; zero hex', () => {
  const css = readFileSync(new URL('../src/public/dashboard.css', import.meta.url), 'utf8');
  assert.match(css, /\.section-body\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
  assert.match(css, /\.section-head-right\s*\{/);
  assert.match(css, /\.section-toggle\s*\{/);
  const mobile = css.match(/@media \(max-width: 650px\)\s*\{[\s\S]*?\n\}\n@media/);
  assert.ok(mobile);
  assert.match(mobile![0], /\.section-toggle/);
  assert.match(mobile![0], /min-height:\s*44px/);
  assert.equal(css.match(/#[0-9a-fA-F]{3,8}\b/g), null);
});

test('favicon: as duas páginas usam /logo.png; allowlist não mudou', () => {
  for (const page of ['dashboard.html', 'configure.html']) {
    const html = readFileSync(new URL('../src/public/' + page, import.meta.url), 'utf8');
    assert.match(html, /<link rel="icon" type="image\/png" href="\/logo\.png" \/>/);
    assert.doesNotMatch(html, /rel="icon"[^>]*href="\/(?!logo\.png)/);
  }
  assert.doesNotMatch(PAGE_ASSETS.join(','), /logo|favicon/);
  assert.doesNotMatch(dashboardHtml(), /logo\.png\?v=/);
});

test('SECTION_ITEMS preservado: 9/5/6/1 chips e a Geral casa com as seções com toggle', async () => {
  const { dom, mods } = await collapseEnv();
  const counts: Record<string, number> = { geral: 9, autofetch: 5, colhedor: 6, trace: 1 };
  for (const [tab, expected] of Object.entries(counts)) {
    mods.nav.renderSectionNav(tab);
    assert.equal(dom.byId['sectionNav'].children.length, expected, tab);
  }
  mods.nav.renderSectionNav('geral');
  const geralChips = dom.byId['sectionNav'].children.map((c: any) => c.getAttribute('data-section'));
  assert.deepEqual(geralChips, GERAL_SECTIONS, 'âncoras da Geral intactas');
  dom.cleanup();
});
