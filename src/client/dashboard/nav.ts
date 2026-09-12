/* Adom Power-Movie — /dashboard: navegação por abas e âncoras (C3, ESM).
 * switchTab dirigido por TABELA + nav de âncoras por aba: chips fixos, um por
 * seção, com realce da seção visível no scroll. A troca de aba também dispara o
 * render da aba recém-ativada com o último payload via hook rerenderActiveTab —
 * a nav não referencia status-root. Nada toca o DOM no import. */

import { $ } from './core.js';
import { element } from './render.js';
import { hooks } from './hooks.js';

interface TabItem { name: string; tabId: string; viewId: string; hash: string; }

// Tabela única de abas: nome lógico, id do botão, id da view e hash da URL. A
// ordem define o fallback: "geral" é a primeira e a aba default.
const TAB_ITEMS: TabItem[] = [
  { name: 'geral', tabId: 'tabGeral', viewId: 'viewGeral', hash: '#geral' },
  { name: 'autofetch', tabId: 'tabAutofetch', viewId: 'viewAutofetch', hash: '#autofetch' },
  { name: 'colhedor', tabId: 'tabColhedor', viewId: 'viewColhedor', hash: '#colhedor' },
  { name: 'trace', tabId: 'tabTrace', viewId: 'viewTrace', hash: '#trace' },
];

function tabByName(name: string): TabItem | null {
  for (let i = 0; i < TAB_ITEMS.length; i += 1) {
    if (TAB_ITEMS[i].name === name) return TAB_ITEMS[i];
  }
  return null;
}

export function switchTab(name: string): void {
  const active = tabByName(name) || TAB_ITEMS[0];
  const isDefault = active === TAB_ITEMS[0];
  // Guarda intacta do comportamento antigo: só comuta com os oito elementos
  // presentes (o painel pode estar truncado em teste/embed).
  for (let i = 0; i < TAB_ITEMS.length; i += 1) {
    if (!$(TAB_ITEMS[i].tabId) || !$(TAB_ITEMS[i].viewId)) return;
  }
  for (let i = 0; i < TAB_ITEMS.length; i += 1) {
    const entry = TAB_ITEMS[i];
    const isActive = entry === active;
    $(entry.tabId).className = 'tab-btn' + (isActive ? ' active' : '');
    $(entry.tabId).setAttribute('aria-selected', isActive ? 'true' : 'false');
    $(entry.viewId).className = 'tab-view' + (isActive ? '' : ' hidden');
  }
  // Comportamento preservado: a aba default só REESCREVE o hash quando ele
  // aponta para outra aba conhecida — um #ancora qualquer na Geral não é
  // sobrescrito; as demais abas sempre refletem a própria hash.
  if (!isDefault) {
    if (window.location.hash !== active.hash) window.location.hash = active.hash;
  } else {
    const known: string[] = [];
    for (let i = 0; i < TAB_ITEMS.length; i += 1) {
      if (TAB_ITEMS[i] !== TAB_ITEMS[0]) known.push(TAB_ITEMS[i].hash);
    }
    if (known.indexOf(window.location.hash) !== -1) window.location.hash = TAB_ITEMS[0].hash;
  }
  // Chips de âncora da aba recém-ativada. renderSectionNav/markActiveSection são
  // DESTE arquivo (hoisting): chamada direta, sem guarda — o guard de element()
  // dentro de renderSectionNav cobre o sandbox sem o módulo de desenho.
  renderSectionNav(active.name);
  // A aba recém-ativada desenha o ÚLTIMO payload conhecido — sem isso ela ficaria
  // vazia até o próximo poll (10 s). O hook (registrado pelo entry) fecha sobre
  // DashState.lastStatusRoot: hook obrigatório — status sempre carrega.
  hooks.call('rerenderActiveTab');
  markActiveSection();
}

export function handleHash(): void {
  const hash = String(window.location.hash || '').replace(/^#/, '');
  const entry = tabByName(hash);
  // Hash desconhecido ou vazio cai na aba default (geral), como antes.
  switchTab(entry ? entry.name : TAB_ITEMS[0].name);
}

// ---- nav de âncoras por aba ----
// Uma entrada por SEÇÃO de aba (os ids vivem nos <section> do HTML). A ordem
// define a leitura: a primeira seção é o topo da aba.
const SECTION_ITEMS: Record<string, Array<{ id: string; label: string }>> = {
  geral: [
    { id: 'secGeral', label: 'Geral' },
    { id: 'secDebrid', label: 'Debrid' },
    { id: 'secDebridTest', label: 'Testar chave' },
    { id: 'secSources', label: 'Fontes' },
    { id: 'secCache', label: 'Cache' },
    { id: 'secMagnets', label: 'MagnetDB' },
    { id: 'secIdx', label: 'Índice' },
    { id: 'secActions', label: 'Ações' },
    { id: 'secCatalog', label: 'Catálogo' },
  ],
  autofetch: [
    { id: 'secAfLive', label: 'Visão viva' },
    { id: 'secAfSources', label: 'Fontes e volume' },
    { id: 'secAfProtect', label: 'Proteção' },
    { id: 'secAfLifecycle', label: 'Ciclo de vida' },
    { id: 'secAfActions', label: 'Presets' },
  ],
  colhedor: [
    { id: 'secHarvestLive', label: 'Visão viva' },
    { id: 'secHarvestDebrid', label: 'Conta de debrid' },
    { id: 'secHarvestTraffic', label: 'Ritmo' },
    { id: 'secHarvestQueue', label: 'Fila' },
    { id: 'secHarvestSeed', label: 'Sementes' },
    { id: 'secHarvestActions', label: 'Presets' },
  ],
  trace: [
    { id: 'secTrace', label: 'Stream Trace' },
  ],
};

export function activeTabName(): string {
  for (let i = 0; i < TAB_ITEMS.length; i += 1) {
    const btn = $(TAB_ITEMS[i].tabId);
    if (btn && String(btn.className).indexOf(' active') !== -1) return TAB_ITEMS[i].name;
  }
  return TAB_ITEMS[0].name;
}

export function scrollToSection(chip: any): void {
  const id = chip && chip.getAttribute ? chip.getAttribute('data-section') : null;
  const target = id ? $(id) : null;
  if (!target) return;
  // Fase 4: o chip de seção RECOLHIDA expande antes de rolar — scroll para um
  // corpo [hidden] pousaria num cabeçalho seguido de vazio. Seção sem toggle
  // (outras abas, sandbox) falha aberta dentro do guard, sem lançar.
  setSectionExpanded(id, true);
  if (typeof target.scrollIntoView === 'function') target.scrollIntoView(true);
}

// ---- Fase 4: progressive disclosure nas 9 seções da Geral ----
// Cada <section> da Visão Geral carrega um corpo .section-body e um botão
// .section-toggle no cabeçalho. O HTML NASCE com secGeral aberto e as outras 8
// fechadas ([hidden]); aqui NÃO há estado próprio — o atributo hidden do corpo é
// a fonte única e o botão só o espelha (aria-expanded + rótulo).
const TOGGLE_OPEN = 'Recolher';
const TOGGLE_CLOSED = 'Expandir';

function sectionBodyFor(section: any): any {
  return section && section.querySelector ? section.querySelector('.section-body') : null;
}

function sectionToggleFor(section: any): any {
  return section && section.querySelector ? section.querySelector('.section-toggle') : null;
}

// Expande/recolhe UMA seção por id. Idempotente e fail-open: devolve false sem
// lançar quando a seção não tem corpo/toggle (outras abas, sandbox).
export function setSectionExpanded(id: string, expanded: boolean): boolean {
  const section = $(id);
  if (!section) return false;
  const body = sectionBodyFor(section);
  const toggle = sectionToggleFor(section);
  if (!body || !toggle) return false;
  if (expanded) body.removeAttribute('hidden');
  else body.setAttribute('hidden', 'hidden');
  toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  toggle.textContent = expanded ? TOGGLE_OPEN : TOGGLE_CLOSED;
  return true;
}

// Sincroniza o botão com o estado que veio do HTML (a fonte única é o [hidden] do
// corpo, nunca o rótulo atual): init pode rodar duas vezes.
export function syncSectionToggle(section: any): void {
  const body = sectionBodyFor(section);
  const toggle = sectionToggleFor(section);
  if (!body || !toggle) return;
  const collapsed = body.hasAttribute('hidden');
  toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  toggle.textContent = collapsed ? TOGGLE_CLOSED : TOGGLE_OPEN;
}

export function initSectionToggles(): void {
  const sections = document.querySelectorAll ? document.querySelectorAll('#viewGeral section') : [];
  for (let i = 0; i < sections.length; i += 1) syncSectionToggle(sections[i]);
}

function sectionOfToggle(node: any): any {
  if (node && typeof node.closest === 'function') return node.closest('section');
  let el = node;
  while (el && el.tagName !== 'SECTION') el = el.parentNode;
  return el || null;
}

function onSectionToggleClick(event: any): void {
  const btn = event.currentTarget || event.target;
  const section = sectionOfToggle(btn);
  const body = sectionBodyFor(section);
  if (!section || !body) return;
  // Recolhido = [hidden] presente: expandir é remover, e vice-versa.
  setSectionExpanded(section.id, body.hasAttribute('hidden'));
}

let sectionTogglesBound = false;

export function bindSectionToggles(): void {
  if (sectionTogglesBound) return;
  sectionTogglesBound = true;
  const buttons = document.querySelectorAll ? document.querySelectorAll('.section-toggle') : [];
  for (let i = 0; i < buttons.length; i += 1) {
    buttons[i].addEventListener('click', onSectionToggleClick);
  }
}

// Reconstrói os chips a CADA troca de aba: a aba define as seções, e o container
// é público (usualmente ~9 chips na Geral, 5 no Chupim).
export function renderSectionNav(tabName: string): void {
  const nav = $('sectionNav');
  const items = SECTION_ITEMS[tabName] || [];
  // Sem helper de desenho (sandbox só com core+nav) não há o que fazer.
  if (!nav || typeof element !== 'function') return;
  nav.textContent = '';
  for (let i = 0; i < items.length; i += 1) {
    const chip = element('button', 'section-chip' + (i === 0 ? ' active' : ''));
    chip.type = 'button';
    chip.setAttribute('data-section', items[i].id);
    chip.setAttribute('aria-label', 'Ir para ' + items[i].label);
    chip.appendChild(document.createTextNode(items[i].label));
    chip.addEventListener('click', (event: any) => {
      scrollToSection(event.currentTarget || event.target);
    });
    nav.appendChild(chip);
  }
}

// Realce da seção visível: último topo que já passou da compensação das duas
// barras fixas. A lista de seções vem dos CHIPS RENDERIZADOS (data-section) e não
// de activeTabName(): renderSectionNav é quem define o que está na tela.
export function markActiveSection(): void {
  const nav = $('sectionNav');
  const offset = 170;
  let current: string | null = null;
  if (!nav || !nav.children || !nav.children.length) return;
  const chips = nav.children;
  for (let i = 0; i < chips.length; i += 1) {
    const id = chips[i] && chips[i].getAttribute ? chips[i].getAttribute('data-section') : null;
    if (!id) continue;
    const el = $(id);
    if (el && (el.offsetTop - offset) <= (window.pageYOffset || 0)) current = id;
  }
  if (!current) current = chips[0] && chips[0].getAttribute ? chips[0].getAttribute('data-section') : null;
  for (let i = 0; i < chips.length; i += 1) {
    if (!chips[i].getAttribute) continue;
    chips[i].className = 'section-chip' + (chips[i].getAttribute('data-section') === current ? ' active' : '');
  }
}

let sectionNavBound = false;

export function bindSectionNav(): void {
  if (sectionNavBound) return;
  sectionNavBound = true;
  window.addEventListener('scroll', markActiveSection, false);
}
