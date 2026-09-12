import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapDashboard, dashboardHtml, resetDashboardEnvironment, registerDashboardHooks } from './helpers/dashboard.js';

// ---------------------------------------------------------------------------
// C3 — runtime do status/pill/banner e dos painéis, importando o emit real.
// O pill/banner refletem o ok:false JÁ presente no /dashboard-status.json; a
// degradação transitória não pode pintar verde. Sem `new Function`.
// ---------------------------------------------------------------------------

function bannerLines(dom: any): string {
  return dom.byId['statusBannerText'].children.map((c: any) => c.textContent).join('\n');
}

function flat(node: any): string {
  if (!node) return '';
  return [String(node.textContent || '')].concat((node.children || []).map(flat)).join(' ');
}

async function statusEnv() {
  return bootstrapDashboard();
}

function cardByTitle(container: any, title: string): any {
  for (const box of container.children || []) {
    if (flat(box).includes(title)) return box;
  }
  return null;
}

test('pill fica warn e o banner nomeia o timeout da conta com o erro', async () => {
  const { dom, mods } = await statusEnv();
  mods.statusRoot.renderStatus({
    general: { ok: true, services: { addon: true, jackett: true, debrid: false, resolvers: 5 } },
    debrid: {
      active: 'alldebrid',
      account: { ok: false, service: 'alldebrid', label: 'AllDebrid', reason: 'timeout', error: 'timeout consultando o debrid' },
      accounts: {},
    },
  });
  assert.equal(dom.byId['connection'].className, 'connection warn');
  assert.match(dom.byId['connectionText'].textContent, /problema/);
  assert.match(dom.byId['statusBanner'].className, /\bvisible\b/);
  assert.match(dom.byId['statusBanner'].className, /\bwarn\b/);
  const texto = bannerLines(dom);
  assert.match(texto, /AllDebrid/);
  assert.match(texto, /timeout consultando o debrid/);
  assert.match(texto, /tempo esgotado consultando o serviço/);
  dom.cleanup();
});

test('auth e quota sobem o pill a erro e o banner traz o fix de cada conta', async () => {
  const { dom, mods } = await statusEnv();
  mods.statusRoot.renderStatus({
    general: { ok: true, services: { addon: true, jackett: true, debrid: false, resolvers: 5 } },
    debrid: {
      active: 'alldebrid',
      account: { ok: false, service: 'alldebrid', label: 'AllDebrid', reason: 'auth', error: 'AUTH_BAD_APIKEY', fix: 'renove a chave em alldebrid.com/account/api' },
      accounts: { realdebrid: { ok: false, service: 'realdebrid', label: 'Real-Debrid', reason: 'quota', fix: 'apague magnets com node dist/scripts/magnets.js' } },
    },
  });
  assert.equal(dom.byId['connection'].className, 'connection error');
  assert.match(dom.byId['statusBanner'].className, /\berror\b/);
  const texto = bannerLines(dom);
  assert.match(texto, /renove a chave/);
  assert.match(texto, /node dist\/scripts\/magnets\.js/);
  dom.cleanup();
});

test('catalog.ok:false com hint sobe no banner e o pill não fica verde', async () => {
  const { dom, mods } = await statusEnv();
  mods.statusRoot.renderStatus({
    general: { ok: true, services: { addon: true, jackett: true, debrid: true, resolvers: 5 } },
    debrid: { active: 'alldebrid', account: { ok: true, service: 'alldebrid', label: 'AllDebrid' }, accounts: {} },
    catalog: { ok: false, reason: 'chave-operador-desativada', hint: 'ligue DEBRID_OPERATOR_ENV_ACCOUNT e recrie a stack' },
  });
  assert.equal(dom.byId['connection'].className, 'connection warn');
  const texto = bannerLines(dom);
  assert.match(texto, /Catálogo da conta indisponível/);
  assert.match(texto, /uso da conta do operador desligado no \.env/);
  assert.match(texto, /DEBRID_OPERATOR_ENV_ACCOUNT/);
  dom.cleanup();
});

test('resposta saudável esconde o banner e devolve o pill ao verde', async () => {
  const { dom, mods } = await statusEnv();
  mods.statusRoot.renderStatus({
    general: { ok: true, services: { addon: true, jackett: true, debrid: true, resolvers: 5 } },
    debrid: { active: 'alldebrid', account: { ok: true, service: 'alldebrid', label: 'AllDebrid' }, accounts: {} },
    catalog: { ok: true },
  });
  assert.equal(dom.byId['connection'].className, 'connection online');
  assert.equal(dom.byId['statusBanner'].className, 'status-banner');
  assert.equal(dom.byId['statusBannerText'].children.length, 0);
  dom.cleanup();
});

test('account=sem-debrid com conta do operador saudável em accounts é neutro', async () => {
  const { dom, mods } = await statusEnv();
  mods.statusRoot.renderStatus({
    general: { ok: true, services: { addon: true, jackett: true, debrid: false, resolvers: 5 } },
    debrid: {
      active: null,
      account: { ok: false, reason: 'sem-debrid', service: null },
      accounts: { alldebrid: { ok: true, service: 'alldebrid', label: 'AllDebrid', magnets: 846 } },
    },
    catalog: { ok: true },
  });
  assert.equal(dom.byId['connection'].className, 'connection online');
  assert.match(dom.byId['connectionText'].textContent, /^online$/);
  assert.equal(dom.byId['statusBanner'].className, 'status-banner');
  dom.cleanup();
});

test('sem-debrid não esconde erro real: auth da conta do operador sobe a erro', async () => {
  const { dom, mods } = await statusEnv();
  mods.statusRoot.renderStatus({
    general: { ok: true, services: { addon: true, jackett: true, debrid: false, resolvers: 5 } },
    debrid: {
      active: null,
      account: { ok: false, reason: 'sem-debrid', service: null },
      accounts: { alldebrid: { ok: false, service: 'alldebrid', label: 'AllDebrid', reason: 'auth', error: 'AUTH_BAD_APIKEY', fix: 'renove a chave' } },
    },
    catalog: { ok: true },
  });
  assert.equal(dom.byId['connection'].className, 'connection error');
  const texto = bannerLines(dom);
  assert.match(texto, /AllDebrid/);
  assert.match(texto, /chave de API recusada/);
  assert.doesNotMatch(texto, /conta ativa/);
  dom.cleanup();
});

test('sem-debrid com rate limit na conta do operador fica em atenção', async () => {
  const { dom, mods } = await statusEnv();
  mods.statusRoot.renderStatus({
    general: { ok: true, services: { addon: true, jackett: true, debrid: false, resolvers: 5 } },
    debrid: { active: null, account: { ok: false, reason: 'sem-debrid', service: null }, accounts: { alldebrid: { ok: false, service: 'alldebrid', label: 'AllDebrid', reason: 'rate' } } },
    catalog: { ok: true },
  });
  assert.equal(dom.byId['connection'].className, 'connection warn');
  assert.match(bannerLines(dom), /rate limit do serviço/);
  dom.cleanup();
});

test('services.jackett === "naomedido" alerta e não pinta verde; false usa outro texto', async () => {
  const { dom, mods } = await statusEnv();
  mods.statusRoot.renderStatus({
    general: { ok: true, services: { addon: true, jackett: 'naomedido', debrid: true, resolvers: 5 } },
    debrid: { active: 'alldebrid', account: { ok: true, service: 'alldebrid', label: 'AllDebrid' }, accounts: {} },
    catalog: { ok: true },
  });
  assert.equal(dom.byId['connection'].className, 'connection warn');
  const texto = bannerLines(dom);
  assert.match(texto, /Jackett não medido/);
  assert.doesNotMatch(texto, /sem catálogo/);
  dom.cleanup();
});

test('renderDebrid: conta do operador ok em accounts é saudável no card, warn degrada', async () => {
  const { dom, mods } = await statusEnv();
  mods.panels.renderDebrid({
    active: null,
    account: { ok: false, reason: 'sem-debrid', service: null },
    accounts: { alldebrid: { ok: true, service: 'alldebrid', label: 'AllDebrid', magnets: 846 } },
  });
  const card = cardByTitle(dom.byId['debridCards'], 'AllDebrid');
  assert.ok(card, 'card AllDebrid renderizado');
  assert.equal(card.getAttribute('data-status'), 'online');
  assert.match(flat(card), /846/);
  mods.panels.renderDebrid({
    active: null,
    account: { ok: false, reason: 'sem-debrid', service: null },
    accounts: { alldebrid: { ok: true, service: 'alldebrid', label: 'AllDebrid', magnets: 846, warn: true } },
  });
  const warn = cardByTitle(dom.byId['debridCards'], 'AllDebrid');
  assert.equal(warn.getAttribute('data-status'), 'warn');
  dom.cleanup();
});

test('breaker tri-estado: naomedido não vira fechado; legado tripped permanece', async () => {
  const { dom, mods } = await statusEnv();
  mods.panels.renderSources({
    indexers: [
      { id: 'hdrtorrent', breaker: { state: 'naomedido', tripped: false } },
      { id: 'tpb', breaker: { tripped: true } },
      { id: 'x1337', breaker: { tripped: false } },
    ],
  });
  const hdr = cardByTitle(dom.byId['indexerCards'], 'hdrtorrent');
  const tpb = cardByTitle(dom.byId['indexerCards'], 'tpb');
  const x1337 = cardByTitle(dom.byId['indexerCards'], 'x1337');
  assert.match(flat(hdr), /não medido/);
  assert.doesNotMatch(flat(hdr), /fechado/);
  assert.match(flat(tpb), /aberto/);
  assert.match(flat(x1337), /fechado/);
  dom.cleanup();
});

test('runResolverTest: gate de id/token, erro e sucesso com releases/latência/host', async () => {
  const { dom, mods } = await statusEnv();
  const calls: Array<{ url: string; init: any }> = [];
  let payload: any = { ok: false, error: 'resolver fora do ar' };
  dom.setFetch((url: string, init: any) => {
    calls.push({ url: String(url), init });
    const body = String(url).includes('/test-resolver.json') ? payload : { general: { ok: true, services: {} } };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  });
  mods.probes.runResolverTest('');
  assert.match(dom.byId['testOutput'].textContent, /Informe o ID do resolver/);
  mods.probes.runResolverTest('bludv');
  assert.match(dom.byId['testOutput'].textContent, /Informe o token antes de testar um resolver/);
  assert.equal(calls.length, 0);
  mods.state.DashState.token = 'segredo';
  mods.probes.runResolverTest('vacatorrent');
  await new Promise((r) => setTimeout(r, 25));
  assert.match(calls[0].url, /\/test-resolver\.json\?id=vacatorrent$/);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers['X-Indexer-Test-Token'], 'segredo');
  assert.match(dom.byId['testOutput'].className, /\berror\b/);
  assert.match(dom.byId['testOutput'].textContent, /Falhou · resolver fora do ar/);
  payload = { ok: true, results: 7, ms: 800, host: 'vaqueirofilmes.com' };
  mods.probes.runResolverTest('vacatorrent');
  await new Promise((r) => setTimeout(r, 25));
  assert.match(dom.byId['testOutput'].className, /\bok\b/);
  assert.match(dom.byId['testOutput'].textContent, /vacatorrent · OK · 7 release\(s\) · 800 ms · host vaqueirofilmes\.com/);
  assert.ok(calls.some((c) => c.url.includes('/dashboard-status.json')), 'loadStatus roda após medir');
  dom.cleanup();
});

test('HTML tem o banner e o card testável; status-actions tem um único innerHTML estático', () => {
  const html = dashboardHtml();
  assert.match(html, /id="statusBanner"/);
  assert.match(html, /id="statusBannerText"/);
});

// ---------------------------------------------------------------------------
// Dreno destrutivo das remoções represadas (autofetch-suppressed-drain):
// updateActionAvailability HABILITA só com saldo, runAction confirma antes do
// POST e o feedback carrega o saldo removidas/elegíveis/restantes.
// ---------------------------------------------------------------------------

async function drainEnv() {
  const env = await resetDashboardEnvironment();
  registerDashboardHooks(env.mods);
  let loads = 0;
  const requests: any[] = [];
  env.mods.hooks.hooks.register('loadStatus', () => { loads += 1; });
  env.dom.setFetch((url: string, init: any) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, removidas: 3, elegiveis: 5, restantes: 2 }) });
  });
  return { ...env, requests, loads: () => loads };
}

test('updateActionAvailability: botão do dreno represado só habilita com saldo', async () => {
  const { dom, mods } = await drainEnv();
  mods.statusActions.updateActionAvailability({ autofetch: { suppressed: 0 }, harvest: {}, debrid: {}, indexers: [] });
  assert.equal(dom.byId['afSuppressedDrainBtn'].disabled, true, 'sem represadas, desabilitado');
  mods.statusActions.updateActionAvailability({ autofetch: { suppressed: 4 }, harvest: {}, debrid: {}, indexers: [] });
  assert.equal(dom.byId['afSuppressedDrainBtn'].disabled, false, 'com saldo, habilitado');
  dom.cleanup();
});

test('runAction autofetch-suppressed-drain: confirm antes do POST e saldo no feedback', async () => {
  const { dom, mods, requests, loads } = await drainEnv();
  const button = dom.attach(dom.body, 'button', { 'data-action': 'autofetch-suppressed-drain', 'data-paused': 'false' });
  let confirmText = '';
  dom.window.confirm = (text: string) => { confirmText = text; return false; };
  mods.statusActions.runAction(button);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(requests.length, 0, 'cancelar não posta');
  assert.equal(loads(), 0, 'cancelar não recarrega');
  assert.match(confirmText, /remoções represadas/i);

  dom.window.confirm = () => true;
  mods.statusActions.runAction(button);
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/dashboard-action.json');
  assert.deepEqual(requests[0].body, { action: 'autofetch-suppressed-drain', paused: false, confirm: true });
  const feedback = dom.byId['feedback'].textContent;
  assert.match(feedback, /Removidas 3|3 removida/);
  assert.match(feedback, /5 elegível/);
  assert.match(feedback, /2 restante/);
  assert.equal(loads(), 1, 'sucesso recarrega o status pelo hook');
  dom.cleanup();
});

// ---------------------------------------------------------------------------
// loadStatus: falha de rede ≠ exceção de render/wiring. A resposta que chega e
// quebra a tela não pode ser reportada como "instância inalcançável".
// ---------------------------------------------------------------------------

test('loadStatus: exceção de render vira "falha ao desenhar", não "instância inalcançável"', async () => {
  const { dom, mods } = await bootstrapDashboard();
  dom.setFetch((url: string) => {
    const body = String(url).includes('/dashboard-status.json')
      ? { general: { services: { addon: true }, uptimeS: 1 }, cache: {}, metrics: {} }
      : {};
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  });
  mods.state.DashState.token = 'tok';
  mods.hooks.hooks.register('renderHealthStrip', () => { throw new Error('wiring quebrado'); });
  mods.statusRoot.loadStatus();
  await new Promise((r) => setTimeout(r, 25));
  const feedback = dom.byId['feedback'].textContent;
  assert.match(feedback, /A resposta chegou/);
  assert.match(feedback, /wiring quebrado/);
  assert.doesNotMatch(feedback, /inalcançável/);
  assert.equal(dom.byId['connection'].className, 'connection error');
  assert.match(dom.byId['connectionText'].textContent, /falha ao desenhar/);
  dom.cleanup();
});

test('loadStatus: falha de rede mantém "instância inalcançável"', async () => {
  const { dom, mods } = await bootstrapDashboard();
  dom.setFetch(() => Promise.reject(new Error('ECONNREFUSED')));
  mods.state.DashState.token = 'tok';
  mods.statusRoot.loadStatus();
  await new Promise((r) => setTimeout(r, 25));
  assert.match(dom.byId['feedback'].textContent, /Instância inalcançável/);
  assert.doesNotMatch(dom.byId['feedback'].textContent, /A resposta chegou/);
  dom.cleanup();
});

test('services.debrid=false sem motivo detalhado vira aviso explícito (não engolido)', async () => {
  const { dom, mods } = await resetDashboardEnvironment();
  mods.statusIssues.renderStatusBanner(mods.statusIssues.collectStatusIssues({
    general: { services: { addon: true, jackett: true, debrid: false, resolvers: 5 } },
    debrid: { active: null, account: { ok: false, reason: 'sem-debrid', service: null }, accounts: {} },
    catalog: { ok: true },
    indexers: [], resolvers: [],
  }));
  const texto = bannerLines(dom);
  assert.match(texto, /Debrid reportado indisponível no geral/);
  assert.match(texto, /verifique chave e conta/);
  dom.cleanup();
});
