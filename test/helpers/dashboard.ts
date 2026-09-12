/* Helper dos testes do cliente ESM de /dashboard (C3).
 *
 * O cliente é emitido duas vezes: no browser (dist/src/public/client/dashboard,
 * ESM nativo, imports reais) e no Node (dist/src/client/dashboard, NodeNext) só
 * para os testes. Aqui a gente importa o emit de Node por import DINÂMICO com
 * URL montada em runtime: o tsconfig raiz exclui src/client e um import estático
 * puxaria o fonte para dentro do programa do servidor, anulando o segundo emit.
 * O emit de BROWSER é exercitado por loadBrowserDashboardModules()/Entry().
 *
 * O DOM falso (getElementById ESTRITO, querySelector por classe/tag/#id) mora em
 * ./dashboard-dom.ts. Testes importam os módulos reais — sem `new Function`, sem
 * regex de corpo de função e sem ordem de scripts. O entry é o único que roda no
 * import; para unit tests use loadDashboardModules() + hooks.register(). */

import { dashboardHtml, installDashboardDom, FakeDom, FakeElement } from './dashboard-dom.js';

export { dashboardHtml, installDashboardDom, FakeDom, FakeElement };
export { FakeElement as Element };

// dist/test/helpers -> dist/src/client/dashboard (emit NodeNext) e
// dist/src/public/client/dashboard (emit browser).
const NODE_DIR = new URL('../../src/client/dashboard/', import.meta.url);
const BROWSER_DIR = new URL('../../src/public/client/dashboard/', import.meta.url);

export interface DashboardModules {
  hooks: any;
  state: any;
  core: any;
  render: any;
  probes: any;
  general: any;
  afStall: any;
  f3: any;
  timers: any;
  catalogPanel: any;
  catalogRender: any;
  catalogActions: any;
  panels: any;
  panelsL2: any;
  panelsIndex: any;
  statusIssues: any;
  statusActions: any;
  statusRoot: any;
  magnets: any;
  autofetch: any;
  autofetchActions: any;
  harvest: any;
  harvestActions: any;
  harvestDebrid: any;
  nav: any;
  health: any;
  debridTest: any;
  trace: any;
  boot: any;
  entry: any;
}

const MODULE_FILES: Record<keyof DashboardModules, string> = {
  hooks: 'hooks.js', state: 'state.js', core: 'core.js', render: 'render.js',
  probes: 'probes.js', general: 'general.js', afStall: 'af-stall.js', f3: 'f3.js',
  timers: 'timers.js', catalogPanel: 'catalog-panel.js', catalogRender: 'catalog-render.js',
  catalogActions: 'catalog-actions.js', panels: 'panels.js', panelsL2: 'panels-l2.js',
  panelsIndex: 'panels-index.js', statusIssues: 'status-issues.js', statusActions: 'status-actions.js',
  statusRoot: 'status-root.js', magnets: 'magnets.js', autofetch: 'autofetch.js',
  autofetchActions: 'autofetch-actions.js', harvest: 'harvest.js', harvestActions: 'harvest-actions.js',
  harvestDebrid: 'harvest-debrid.js', nav: 'nav.js', health: 'health.js',
  debridTest: 'debrid-test.js', trace: 'trace.js', boot: 'boot.js', entry: 'entry.js',
};

let cached: DashboardModules | null = null;

/** Importa o grafo real (exceto o entry) sem instalar DOM nenhum. */
export async function loadDashboardModules(): Promise<DashboardModules> {
  if (!cached) {
    const mods: any = {};
    for (const [key, file] of Object.entries(MODULE_FILES)) {
      if (key === 'entry') continue;
      mods[key] = await import(new URL(file, NODE_DIR).href);
    }
    cached = mods as DashboardModules;
  }
  return cached;
}

/** Importa o entry (que registra hooks e chama bind) — requer DOM instalado. */
export async function loadDashboardEntry(): Promise<any> {
  return import(new URL('entry.js', NODE_DIR).href);
}

/** Importa o emit de BROWSER (exceto o entry) — é o código que a WebView roda. */
export async function loadBrowserDashboardModules(): Promise<DashboardModules> {
  const mods: any = {};
  for (const [key, file] of Object.entries(MODULE_FILES)) {
    if (key === 'entry') continue;
    mods[key] = await import(new URL(file, BROWSER_DIR).href);
  }
  return mods as DashboardModules;
}

/** Importa o entry do emit de browser (registra hooks + bind; precisa de DOM). */
export async function loadBrowserDashboardEntry(): Promise<any> {
  return import(new URL('entry.js', BROWSER_DIR).href);
}

/** DOM limpo + estado zerado + hooks registrados; pronto para exercitar. Não
 * chama bind(): unit tests chamam a função sob teste direto. Por padrão monta o
 * dashboard.html real (getElementById é estrito). */
export async function resetDashboardEnvironment(html: string = dashboardHtml()): Promise<{ dom: FakeDom; mods: DashboardModules }> {
  const dom = installDashboardDom(html);
  const mods = await loadDashboardModules();
  mods.state.resetDashState();
  mods.hooks.hooks.reset();
  return { dom, mods };
}

/** Registra o conjunto fechado de hooks (sem bind). */
export function registerDashboardHooks(mods: DashboardModules): void {
  const h = mods.hooks.hooks;
  h.register('loadStatus', mods.statusRoot.loadStatus);
  h.register('rerenderActiveTab', mods.statusRoot.rerenderActiveTab);
  h.register('activeTabName', mods.nav.activeTabName);
  h.register('renderHealthStrip', mods.health.renderHealthStrip);
  h.register('renderAttentionStrip', mods.health.renderAttentionStrip);
  h.register('updateEmptyState', mods.health.updateEmptyState);
  h.register('dashDebugEnabled', mods.health.dashDebugEnabled);
  h.register('runIndexerTest', mods.probes.runIndexerTest);
  h.register('runResolverTest', mods.probes.runResolverTest);
  h.register('renderGeneralDiagnostics', mods.general.renderGeneralDiagnostics);
  h.register('renderTimersPanel', mods.timers.renderTimersPanel);
  h.register('renderF3Panel', mods.f3.renderF3Panel);
  h.register('renderCatalogPanel', mods.catalogPanel.renderCatalogPanel);
  h.register('renderCatalogReport', mods.catalogRender.renderCatalogReport);
  h.register('renderAutofetchStall', mods.afStall.renderAutofetchStall);
}

/** DOM + módulos + hooks + bind, o boot real do painel. O setInterval de
 * "Atualizado há Ns" é do browser; nos testes ele manteria o processo vivo, então
 * o boot já sai com os timers limpos (o wiring testado não depende do tick). */
export async function bootstrapDashboard(html: string = dashboardHtml()): Promise<{ dom: FakeDom; mods: DashboardModules }> {
  const env = await resetDashboardEnvironment(html);
  registerDashboardHooks(env.mods);
  env.mods.boot.bind();
  const st = env.mods.state.DashState;
  if (st.lastUpdatedTimer) { clearInterval(st.lastUpdatedTimer); st.lastUpdatedTimer = null; }
  if (st.refreshTimer) { clearTimeout(st.refreshTimer); st.refreshTimer = null; }
  return env;
}
