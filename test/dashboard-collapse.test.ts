import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PAGE_ASSETS } from '../src/routes/public.js';

// ---------------------------------------------------------------------------
// Fase 4 (redução de altura) — progressive disclosure nas 9 seções da Geral.
// O critério de altura ("Geral precisa caber") não pode custar telemetria:
// cada seção mantém <section>/IDs/ações, o corpo entra em .section-body
// (secGeral aberto, outras 8 [hidden]) e o conteúdo oculto segue pintado a
// cada poll. Três camadas: contrato do HTML, runtime do dashboard-nav.js no
// DOM falso (mesmo padrão de dashboard-nav/dashboard-health-strip) e CSS.
// ---------------------------------------------------------------------------

const PUBLIC = (name: string) => readFileSync(new URL('../../src/public/' + name, import.meta.url), 'utf8');
const HTML = () => PUBLIC('dashboard.html');
const CSS = () => PUBLIC('dashboard.css');
const NAV = () => PUBLIC('dashboard-nav.js');
const BOOT = () => PUBLIC('dashboard-boot.js');
const REGISTER = readFileSync(new URL('../../src/routes/register.ts', import.meta.url), 'utf8');
const ES6 = /\b(?:const|let)\b|=>|\?\.|\?\?/;

const GERAL_SECTIONS = [
  'secGeral', 'secDebrid', 'secDebridTest', 'secSources', 'secCache',
  'secMagnets', 'secIdx', 'secActions', 'secCatalog',
];
const OPEN_BY_DEFAULT = 'secGeral';

// ---------------------------------------------------------------------------
// Camada 1 — HTML: 9 corpos, 9 toggles, secGeral aberto, resto fechado e o
// disclosure confinado à aba Geral (as outras abas não ganham toggle).
// ---------------------------------------------------------------------------

test('HTML: as 9 seções da Geral têm .section-body e .section-toggle — e só elas', () => {
  const html = HTML();
  assert.equal((html.match(/class="section-toggle"/g) || []).length, 9, 'exatamente 9 toggles (só a Geral)');
  assert.equal((html.match(/class="section-body"/g) || []).length, 9, 'exatamente 9 corpos .section-body');
  // Confinamento: fora do #viewGeral (Chupim/Colhedor/Trace) nenhuma seção
  // tem toggle — o disclosure é da aba Geral, não do painel inteiro.
  const geralStart = html.indexOf('id="viewGeral"');
  const geralEnd = html.indexOf('id="viewAutofetch"');
  for (const sec of GERAL_SECTIONS) {
    const idx = html.indexOf('id="' + sec + '"');
    assert.ok(idx > geralStart && idx < geralEnd, sec + ' fica dentro da aba Geral');
  }
  const fora = (html.slice(geralEnd).match(/section-toggle|section-body/g) || []).length;
  assert.equal(fora, 0, 'nenhum toggle/corpo fora da Geral');
});

test('HTML: cada seção tem toggle com aria-controls → corpo e estado inicial correto', () => {
  const html = HTML();
  for (const sec of GERAL_SECTIONS) {
    const bodyId = sec + 'Body';
    const open = sec === OPEN_BY_DEFAULT;
    assert.match(html, new RegExp('id="' + bodyId + '" class="section-body"' + (open ? '>' : ' hidden>')), bodyId + (open ? ' aberto' : ' nasce [hidden]'));
    const toggle = html.match(new RegExp('<button id="(toggle[A-Za-z]+)" class="section-toggle" type="button" aria-expanded="' + (open ? 'true' : 'false') + '" aria-controls="' + bodyId + '" aria-labelledby="\\1 ([A-Za-z]+Title)">(' + (open ? 'Recolher' : 'Expandir') + ')</button>'));
    assert.ok(toggle, 'toggle de ' + sec + ' com estado, alvo e nome acessível corretos');
    assert.match(html, new RegExp('id="' + toggle![2] + '"'), sec + ': aria-labelledby aponta para o título');
    const toggleIdx = html.indexOf('aria-controls="' + bodyId + '"');
    const bodyIdx = html.indexOf('id="' + bodyId + '"');
    assert.ok(toggleIdx > -1 && bodyIdx > toggleIdx, sec + ': toggle antes do corpo');
  }
});

test('HTML: secGeral agrupa lastUpdated + toggle em .section-head-right', () => {
  const html = HTML();
  const rightIdx = html.indexOf('class="section-head-right"');
  const updatedIdx = html.indexOf('id="lastUpdated"');
  const toggleIdx = html.indexOf('id="toggleGeral"');
  assert.ok(rightIdx > -1 && updatedIdx > rightIdx && toggleIdx > updatedIdx,
    '.section-head-right contém lastUpdated seguido do toggle');
  assert.equal((html.match(/section-head-right/g) || []).length, 1, 'só a secGeral usa o agrupamento');
});

test('HTML: IDs/ações dentro dos corpos preservados (poll pinta conteúdo oculto)', () => {
  const html = HTML();
  for (const id of ['generalMetrics', 'timerMetrics', 'generalDiagnostics', 'debridMetrics', 'debridCards',
    'debridTestService', 'indexerCards', 'resolverCards', 'testIndexerId', 'cacheSparkline', 'cacheMetrics',
    'magnetSummaryBtn', 'magnetInspectBtn', 'magnetClearBadBtn', 'idxMetrics', 'harvestMetrics', 'f3Metrics',
    'catalogScanBtn', 'catalogDedupApplyBtn', 'catalog_targets', 'catalog_manual']) {
    assert.match(html, new RegExp('id="' + id + '"'), id + ' preservado');
  }
});

// ---------------------------------------------------------------------------
// Camada 2 — runtime do dashboard-nav.js: setSectionExpanded/init/bind e o
// chip que expande ANTES de rolar. DOM falso com a estrutura real da Geral.
// ---------------------------------------------------------------------------

const scrollEvents: string[] = [];

function makeNode(tag: string, id: string | null, cls: string) {
  const node: any = {
    tagName: tag.toUpperCase(), id: id || '', className: cls, textContent: '',
    attrs: {} as Record<string, string>, children: [] as any[], parentNode: null as any,
    listeners: {} as Record<string, Array<(event: any) => void>>,
    appendChild(child: any) { child.parentNode = node; node.children.push(child); return child; },
    addEventListener(type: string, fn: (event: any) => void) { (node.listeners[type] = node.listeners[type] || []).push(fn); },
    setAttribute(key: string, value: string) { node.attrs[key] = String(value); },
    getAttribute(key: string) { return Object.prototype.hasOwnProperty.call(node.attrs, key) ? node.attrs[key] : null; },
    removeAttribute(key: string) { delete node.attrs[key]; },
    hasAttribute(key: string) { return Object.prototype.hasOwnProperty.call(node.attrs, key); },
    // querySelector mínimo: DFS por classe (".x") — cobre .section-body e
    // .section-toggle, os únicos seletores que o nav consulta na seção.
    querySelector(sel: string) {
      if (sel.indexOf('.') !== 0) return null;
      const want = sel.slice(1);
      for (const child of node.children) {
        if (String(child.className).split(' ').indexOf(want) !== -1) return child;
        const hit = child.querySelector(sel);
        if (hit) return hit;
      }
      return null;
    },
    closest(selector: string) {
      let el: any = node;
      while (el) { if (selector === 'section' && el.tagName === 'SECTION') return el; el = el.parentNode; }
      return null;
    },
    scrollIntoView() { scrollEvents.push('scroll:' + (id || cls)); },
  };
  return node;
}

function buildSandbox(specs: Array<{ id: string; body?: boolean }>) {
  const byId: Record<string, any> = {};
  const sections: any[] = [];
  const toggles: any[] = [];
  const reg = (node: any) => { byId[node.id] = node; return node; };
  for (const spec of specs) {
    const section = reg(makeNode('section', spec.id, ''));
    const head = makeNode('div', null, 'section-head');
    section.appendChild(head);
    if (spec.body !== false) {
      const body = reg(makeNode('div', spec.id + 'Body', 'section-body'));
      if (spec.id !== OPEN_BY_DEFAULT) body.setAttribute('hidden', 'hidden');
      section.appendChild(body);
      const toggle = reg(makeNode('button', 'toggle' + spec.id.slice(3), 'section-toggle'));
      head.appendChild(toggle);
      toggles.push(toggle);
    }
    sections.push(section);
  }
  const document = {
    getElementById: (id: string) => byId[id] || null,
    createElement: () => makeNode('div', null, ''),
    createTextNode: (text: string) => ({ text }),
    addEventListener: () => {},
    querySelectorAll(selector: string) {
      if (selector === '#viewGeral section') return sections;
      if (selector === '.section-toggle') return toggles;
      throw new Error('seletor não suportado no sandbox: ' + selector);
    },
  };
  const window = { location: { pathname: '/dashboard', hash: '', search: '' }, addEventListener: () => {}, pageYOffset: 0 };
  const factory = new Function('document', 'window',
    PUBLIC('dashboard-core.js') + '\n' + NAV() + '\nreturn { setSectionExpanded: setSectionExpanded, syncSectionToggle: syncSectionToggle, initSectionToggles: initSectionToggles, bindSectionToggles: bindSectionToggles, scrollToSection: scrollToSection };') as
    (doc: unknown, win: unknown) => any;
  return { api: factory(document, window), byId, sections, toggles };
}

// As 9 seções reais + duas de outras abas (sem corpo/toggle) para o fail-open.
const SPECS: Array<{ id: string; body?: boolean }> = [
  ...GERAL_SECTIONS.map((id) => ({ id })),
  { id: 'secAfLive', body: false },
  { id: 'secTrace', body: false },
];

function freshSandbox() {
  scrollEvents.length = 0;
  return buildSandbox(SPECS);
}

test('initSectionToggles sincroniza o botão com o [hidden] do corpo (fonte única) e é idempotente', () => {
  const { api, byId } = freshSandbox();
  byId['toggleDebrid'].textContent = 'Recolher'; // rótulo/aria divergentes do HTML
  byId['toggleDebrid'].setAttribute('aria-expanded', 'true');
  api.initSectionToggles();
  assert.equal(byId['toggleGeral'].getAttribute('aria-expanded'), 'true');
  assert.equal(byId['toggleGeral'].textContent, 'Recolher');
  assert.equal(byId['toggleDebrid'].getAttribute('aria-expanded'), 'false');
  assert.equal(byId['toggleDebrid'].textContent, 'Expandir');
  assert.equal(byId['toggleCatalog'].textContent, 'Expandir');
  api.initSectionToggles(); // segunda passada não muda nada
  assert.equal(byId['toggleDebrid'].textContent, 'Expandir');
});

test('setSectionExpanded expande/recolhe com aria e rótulo corretos; fail-open sem toggle', () => {
  const { api, byId } = freshSandbox();
  assert.equal(api.setSectionExpanded('secDebrid', true), true);
  assert.equal(byId['secDebridBody'].hasAttribute('hidden'), false);
  assert.equal(byId['toggleDebrid'].getAttribute('aria-expanded'), 'true');
  assert.equal(byId['toggleDebrid'].textContent, 'Recolher');
  assert.equal(api.setSectionExpanded('secDebrid', false), true);
  assert.equal(byId['secDebridBody'].hasAttribute('hidden'), true);
  assert.equal(byId['toggleDebrid'].getAttribute('aria-expanded'), 'false');
  assert.equal(byId['toggleDebrid'].textContent, 'Expandir');
  // secGeral (aberta) pode ser recolhida e reaberta.
  assert.equal(api.setSectionExpanded('secGeral', false), true);
  assert.equal(byId['secGeralBody'].hasAttribute('hidden'), true);
  assert.equal(api.setSectionExpanded('secGeral', true), true);
  assert.equal(byId['secGeralBody'].hasAttribute('hidden'), false);
  // Id desconhecido e seção sem toggle (outras abas): false, sem lançar.
  assert.equal(api.setSectionExpanded('nao-existe', true), false);
  assert.equal(api.setSectionExpanded('secAfLive', true), false);
  assert.equal(api.setSectionExpanded('secTrace', true), false);
});

test('chip expande ANTES de rolar (scroll para seção recolhida não pousa no vazio)', () => {
  const { api, byId } = freshSandbox();
  const chip = { getAttribute: (key: string) => (key === 'data-section' ? 'secMagnets' : null) };
  const body = byId['secMagnetsBody'];
  const originalRemove = body.removeAttribute.bind(body);
  body.removeAttribute = (key: string) => { scrollEvents.push('expand'); originalRemove(key); };
  api.scrollToSection(chip);
  assert.equal(body.hasAttribute('hidden'), false, 'corpo aberto');
  assert.deepEqual(scrollEvents, ['expand', 'scroll:secMagnets'], 'ordem: expande, depois rola');
  assert.equal(byId['toggleMagnets'].getAttribute('aria-expanded'), 'true');
});

test('chip de seção sem toggle (outras abas) só rola; chip desconhecido não rola', () => {
  const { api } = freshSandbox();
  api.scrollToSection({ getAttribute: (key: string) => (key === 'data-section' ? 'secTrace' : null) });
  assert.deepEqual(scrollEvents, ['scroll:secTrace'], 'sem expand: seção sem toggle não lança');
  api.scrollToSection({ getAttribute: () => null });
  assert.equal(scrollEvents.length, 1, 'id vazio: nada acontece');
});

test('bindSectionToggles liga o clique de todos os toggles e recolhe/expande no estado atual', () => {
  const { api, byId, toggles } = freshSandbox();
  api.bindSectionToggles();
  api.bindSectionToggles(); // guard: nada de dupla ligação
  assert.equal((byId['toggleDebrid'].listeners.click || []).length, 1, 'um listener por toggle');
  assert.equal(toggles.length, 9, '9 toggles ligados');
  const fire = (toggle: any) => toggle.listeners.click[0]({ currentTarget: toggle });
  fire(byId['toggleCache']);
  assert.equal(byId['secCacheBody'].hasAttribute('hidden'), false, 'clicar num fechado abre');
  assert.equal(byId['toggleCache'].textContent, 'Recolher');
  fire(byId['toggleGeral']);
  assert.equal(byId['secGeralBody'].hasAttribute('hidden'), true, 'clicar num aberto recolhe');
  assert.equal(byId['toggleGeral'].textContent, 'Expandir');
  fire(byId['toggleGeral']);
  assert.equal(byId['secGeralBody'].hasAttribute('hidden'), false, 'segundo clique reabre');
});

test('boot liga init/bind dos toggles e o módulo nav segue ES5 puro', () => {
  const boot = BOOT();
  assert.match(boot, /typeof initSectionToggles === "function"\) initSectionToggles\(\)/);
  assert.match(boot, /typeof bindSectionToggles === "function"\) bindSectionToggles\(\)/);
  const nav = NAV();
  for (const fn of ['setSectionExpanded', 'syncSectionToggle', 'initSectionToggles', 'bindSectionToggles']) {
    assert.match(nav, new RegExp('function ' + fn + '\\('), fn + ' presente no nav');
  }
  assert.match(nav, /setSectionExpanded\(id, true\)/, 'chip expande antes de rolar');
  assert.doesNotMatch(nav, ES6, 'dashboard-nav.js continua ES5');
});

// ---------------------------------------------------------------------------
// Camada 3 — CSS: o [hidden] realmente recolhe, o toggle é um alvo de toque
// no mobile (44px) e o contrato de zero hex segue valendo no CSS tocado.
// ---------------------------------------------------------------------------

test('CSS: .section-body[hidden], .section-head-right, .section-toggle e 44px no mobile', () => {
  const css = CSS();
  assert.match(css, /\.section-body\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
  assert.match(css, /\.section-head-right\s*\{/);
  assert.match(css, /\.section-toggle\s*\{/);
  const mobile = css.match(/@media \(max-width: 650px\)\s*\{[\s\S]*?\n\}\n@media/);
  assert.ok(mobile, 'bloco @media 650px presente');
  assert.match(mobile ? mobile[0] : '', /\.section-toggle/, 'toggle coberto pelo piso de 44px');
  assert.match(mobile ? mobile[0] : '', /min-height:\s*44px/, 'alvo de toque no mobile');
  assert.equal(css.match(/#[0-9a-fA-F]{3,8}\b/g), null, 'zero hex (cores só de var(--...))');
});

// ---------------------------------------------------------------------------
// Favicon: as duas páginas apontam para o /logo.png que JÁ é rota — nenhuma
// rota nova, nenhum outro ícone, e a allowlist de assets não mudou.
// ---------------------------------------------------------------------------

test('favicon: dashboard.html e configure.html usam /logo.png; backend intocado', () => {
  for (const page of ['dashboard.html', 'configure.html']) {
    const html = PUBLIC(page);
    assert.match(html, /<link rel="icon" type="image\/png" href="\/logo\.png" \/>/, page + ' com link de ícone');
    assert.doesNotMatch(html, /rel="icon"[^>]*href="\/(?!logo\.png)/, page + ': nenhum outro ícone');
  }
  assert.match(REGISTER, /app\.get\('\/logo\.png'/, 'rota /logo.png pré-existente');
  assert.doesNotMatch(REGISTER, /favicon/, 'nenhuma rota de favicon criada');
  assert.doesNotMatch(PAGE_ASSETS.join(','), /logo|favicon/, 'allowlist de assets não mudou');
  // O HTML versionado só toca .css/.js com ?v= — o favicon viaja sem versão.
  assert.doesNotMatch(HTML(), /logo\.png\?v=/, 'logo não entra no versionamento ?v=');
});

// ---------------------------------------------------------------------------
// Chips preservados: o SECTION_ITEMS do nav continua com 9/5/6/1 âncoras e a
// lista da Geral é exatamente a das seções com toggle.
// ---------------------------------------------------------------------------

function idsOfTab(nav: string, tab: string, next: string | null): string[] {
  const start = nav.indexOf(tab + ': [');
  const end = next ? nav.indexOf(next + ': [') : nav.indexOf('function activeTabName');
  const slice = nav.slice(start, end);
  const out: string[] = [];
  const re = /id: "([A-Za-z]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(slice)) !== null) out.push(match[1]);
  return out;
}

test('SECTION_ITEMS preservado: 9/5/6/1 chips e a Geral casa com as seções com toggle', () => {
  const nav = NAV();
  assert.deepEqual(idsOfTab(nav, 'geral', 'autofetch'), GERAL_SECTIONS, 'âncoras da Geral intactas');
  assert.equal(idsOfTab(nav, 'autofetch', 'colhedor').length, 5);
  assert.equal(idsOfTab(nav, 'colhedor', 'trace').length, 6);
  assert.equal(idsOfTab(nav, 'trace', null).length, 1);
});
