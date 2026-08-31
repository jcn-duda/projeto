import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Runtime do painel (/dashboard) executado de verdade: pill + banner
// persistente refletem o ok:false JÁ presente em /dashboard-status.json
// (incidente de 2026-08-30: o pill ficava verde com timeout da conta, catálogo
// indisponível ou serviço debrid morto, porque o cálculo só olhava auth/quota
// e Jackett — o resto morria num <details> fechado). dashboard-status.js é
// módulo de declarações (nada roda no load), então os testes EXECUTAM
// renderStatus/renderDebrid com um DOM falso, sobre o escopo global
// compartilhado core + status/panels. Extraído de catalog-panel.test.ts junto
// da regressão de 2026-08-31 (falso "atenção" com sem-debrid) para os dois
// arquivos caberem no teto de 400 linhas da catraca.
// ---------------------------------------------------------------------------

function dashboardHtml() {
  return readFileSync(new URL('../../src/public/dashboard.html', import.meta.url), 'utf8');
}

interface FakeNode {
  className: string;
  textContent: string;
  style: Record<string, string>;
  children: FakeNode[];
  appendChild(child: FakeNode): FakeNode;
  setAttribute(key: string, value: string): void;
  focus(): void;
}

function fakeNode(): FakeNode {
  const node: FakeNode = {
    className: '',
    textContent: '',
    style: {},
    children: [],
    appendChild(child: FakeNode) {
      node.children.push(child);
      return child;
    },
    setAttribute() { /* não usado nestes testes */ },
    focus() { /* gate de token chama focus no input */ },
  };
  return node;
}

function loadDashboardStatusApi(fetch?: (url: string, init?: any) => Promise<any>): { els: Record<string, FakeNode>; renderStatus: (data: any) => void; runResolverTest: (id: string, button?: FakeNode | null) => void; setToken: (token: string) => void } {
  const core = readFileSync(new URL('../../src/public/dashboard-core.js', import.meta.url), 'utf8');
  const status = readFileSync(new URL('../../src/public/dashboard-status.js', import.meta.url), 'utf8');
  // Renderizadores que vivem em dashboard-panels.js / no inline do HTML são
  // irrelevantes aqui: stubs só para renderStatus não estourar.
  const stubs = [
    'function renderGeneral() {}',
    'function renderDebrid() {}',
    'function renderSources() {}',
    'function renderCache() {}',
    'function renderMagnetDb() {}',
    'function renderReleaseIndex() {}',
    'function renderHarvest() {}',
    'function renderAutofetchPanel() {}',
    'function renderHarvesterPanel() {}',
    'function drawSparkline() {}',
    'function pushSeries() { return []; }',
    'function updateLastUpdated() {}',
    'function updateActionAvailability() {}',
  ].join('\n');
  const els: Record<string, FakeNode> = {};
  const document = {
    hidden: false,
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
  // dashboard-core.js + dashboard-status.js compartilham escopo global (sem
  // IIFE); os parâmetros document/window/fetch sombreiam os globals ausentes.
  const factory = new Function('document', 'window', 'fetch', core + '\n' + status + '\n' + stubs + '\nreturn { renderStatus: renderStatus, runResolverTest: runResolverTest, setToken: function (token) { currentToken = String(token || ""); } };') as
    (doc: unknown, win: unknown, fn: unknown) => { renderStatus: (data: any) => void; runResolverTest: (id: string, b?: FakeNode | null) => void; setToken: (t: string) => void };
  const result = factory(document, window, fetch);
  return { els, renderStatus: result.renderStatus, runResolverTest: result.runResolverTest, setToken: result.setToken };
}

function bannerLines(els: Record<string, FakeNode>): string {
  return els.statusBannerText.children.map((child) => child.textContent).join('\n');
}

// Carrega core + panels (dashboard-panels.js) sobre o mesmo DOM falso, com os
// pintores trocados por dublês: `card` captura os itens montados por
// renderDebrid para o teste do estado do card da conta (ok em accounts), e
// `renderMetrics` fica mudo. As declarações de função dos stubs vêm DEPOIS do
// código real no mesmo escopo, então sobrepõem as do core por hoisting.
function loadDashboardPanelsApi(): { renderDebrid: (data: any, autofetch?: any) => void; captured: any[] } {
  const core = readFileSync(new URL('../../src/public/dashboard-core.js', import.meta.url), 'utf8');
  const panels = readFileSync(new URL('../../src/public/dashboard-panels.js', import.meta.url), 'utf8');
  const captured: any[] = [];
  const stubs = [
    'function renderMetrics() {}',
    'function card(container, item, options) { capturedCards.push(item); }',
  ].join('\n');
  const els: Record<string, FakeNode> = {};
  const document = {
    hidden: false,
    createElement: () => fakeNode(),
    createTextNode: (text: string) => ({ text }),
    getElementById: (id: string) => (els[id] = els[id] || fakeNode()),
    addEventListener: () => {},
  };
  const window = {
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    location: { pathname: '/dashboard', hash: '' },
    confirm: () => false,
    addEventListener: () => {},
  };
  const factory = new Function('document', 'window', 'fetch', 'capturedCards', core + '\n' + panels + '\n' + stubs + '\nreturn { renderDebrid: renderDebrid };') as
    (doc: unknown, win: unknown, fn: unknown, captured: any[]) => { renderDebrid: (data: any, autofetch?: any) => void };
  const result = factory(document, window, undefined, captured);
  return { renderDebrid: result.renderDebrid, captured };
}

test('pill fica warn (não verde) e o banner mostra timeout da conta com o erro', () => {
  const { els, renderStatus } = loadDashboardStatusApi();
  renderStatus({
    general: { ok: true, services: { addon: true, jackett: true, debrid: false, resolvers: 5 } },
    debrid: {
      active: 'alldebrid',
      account: { ok: false, service: 'alldebrid', label: 'AllDebrid', reason: 'timeout', error: 'timeout consultando o debrid' },
      accounts: {},
    },
  });
  assert.equal(els.connection.className, 'connection warn', 'timeout não pode deixar o pill verde');
  assert.match(els.connectionText.textContent, /problema/);
  assert.match(els.statusBanner.className, /\bvisible\b/, 'banner persistente aparece com ok:false');
  assert.match(els.statusBanner.className, /\bwarn\b/);
  const texto = bannerLines(els);
  assert.match(texto, /AllDebrid/, 'a conta culpada é nomeada');
  assert.match(texto, /timeout consultando o debrid/, 'o erro medido viaja no texto');
  assert.match(texto, /tempo esgotado consultando o serviço/, 'reason traduzido em texto claro');
});

test('auth e quota sobem o pill a erro e o banner traz o fix de cada serviço', () => {
  const { els, renderStatus } = loadDashboardStatusApi();
  renderStatus({
    general: { ok: true, services: { addon: true, jackett: true, debrid: false, resolvers: 5 } },
    debrid: {
      active: 'alldebrid',
      account: { ok: false, service: 'alldebrid', label: 'AllDebrid', reason: 'auth', error: 'AUTH_BAD_APIKEY', fix: 'renove a chave em alldebrid.com/account/api' },
      accounts: {
        realdebrid: { ok: false, service: 'realdebrid', label: 'Real-Debrid', reason: 'quota', fix: 'apague magnets com node dist/scripts/magnets.js' },
      },
    },
  });
  assert.equal(els.connection.className, 'connection error', 'auth/quota provam conta inutilizável');
  assert.match(els.statusBanner.className, /\berror\b/);
  const texto = bannerLines(els);
  assert.match(texto, /renove a chave/, 'fix da conta ativa aparece no banner');
  assert.match(texto, /node dist\/scripts\/magnets\.js/, 'fix da conta do operador (accounts[*]) aparece no banner');
});

test('catalog.ok:false com hint sobe no banner e o pill não fica verde', () => {
  const { els, renderStatus } = loadDashboardStatusApi();
  renderStatus({
    general: { ok: true, services: { addon: true, jackett: true, debrid: true, resolvers: 5 } },
    debrid: { active: 'alldebrid', account: { ok: true, service: 'alldebrid', label: 'AllDebrid' }, accounts: {} },
    catalog: { ok: false, reason: 'chave-operador-desativada', hint: 'ligue DEBRID_OPERATOR_ENV_ACCOUNT e recrie a stack' },
  });
  assert.equal(els.connection.className, 'connection warn', 'catálogo indisponível é atenção, não verde');
  const texto = bannerLines(els);
  assert.match(texto, /Catálogo da conta indisponível/);
  assert.match(texto, /uso da conta do operador desligado no \.env/, 'reason traduzido');
  assert.match(texto, /DEBRID_OPERATOR_ENV_ACCOUNT/, 'hint do backend viaja intacto');
});

test('resposta saudável esconde o banner e devolve o pill ao verde', () => {
  const { els, renderStatus } = loadDashboardStatusApi();
  renderStatus({
    general: { ok: true, services: { addon: true, jackett: true, debrid: true, resolvers: 5 } },
    debrid: { active: 'alldebrid', account: { ok: true, service: 'alldebrid', label: 'AllDebrid' }, accounts: {} },
    catalog: { ok: true },
  });
  assert.equal(els.connection.className, 'connection online');
  assert.equal(els.statusBanner.className, 'status-banner', 'banner some sozinho quando a resposta é saudável');
  assert.equal(els.statusBannerText.children.length, 0);
});

// ---------------------------------------------------------------------------
// Regressão do falso alerta em instância pública segura (captura da VPS,
// 2026-08-31): com DEBRID_ALLOW_ENV_KEY=false + DEBRID_OPERATOR_ENV_ACCOUNT=true
// a instalação anônima fica SEM debrid de propósito — o backend é honesto
// (active=null, account=sem-debrid) e a conta real do operador viaja em
// debrid.accounts com ok:true. O painel tratava estado de configuração como
// problema operacional: "atenção · 1 problema(s)" e banner "Debrid (conta
// ativa): nenhum serviço de debrid configurado" com a conta saudável.
// ---------------------------------------------------------------------------

test('account=sem-debrid com a conta do operador ok em accounts é neutro: pill online, banner escondido', () => {
  const { els, renderStatus } = loadDashboardStatusApi();
  renderStatus({
    general: { ok: true, services: { addon: true, jackett: true, debrid: false, resolvers: 5 } },
    debrid: {
      active: null,
      account: { ok: false, reason: 'sem-debrid', service: null },
      accounts: { alldebrid: { ok: true, service: 'alldebrid', label: 'AllDebrid', magnets: 846 } },
    },
    catalog: { ok: true },
  });
  assert.equal(els.connection.className, 'connection online', 'conta do operador saudável não pode acender atenção');
  assert.match(els.connectionText.textContent, /^online$/, 'pill sem "problema(s)"');
  assert.equal(els.statusBanner.className, 'status-banner', 'banner some: sem-debrid é sem configuração, não problema');
  assert.equal(els.statusBannerText.children.length, 0);
});

test('sem-debrid sem nenhuma conta do operador também é neutro e o genérico de services.debrid=false não dispara', () => {
  const { els, renderStatus } = loadDashboardStatusApi();
  renderStatus({
    general: { ok: true, services: { addon: true, jackett: true, debrid: false, resolvers: 0 } },
    debrid: { active: null, account: { ok: false, reason: 'sem-debrid', service: null }, accounts: {} },
    catalog: { ok: true },
  });
  assert.equal(els.connection.className, 'connection online', 'sem conta nenhuma é estado sem configuração, não problema');
  assert.equal(els.statusBanner.className, 'status-banner');
  assert.equal(els.statusBannerText.children.length, 0);
});

test('sem-debrid não esconde erro real: auth da conta do operador em accounts sobe o pill a erro', () => {
  const { els, renderStatus } = loadDashboardStatusApi();
  renderStatus({
    general: { ok: true, services: { addon: true, jackett: true, debrid: false, resolvers: 5 } },
    debrid: {
      active: null,
      account: { ok: false, reason: 'sem-debrid', service: null },
      accounts: { alldebrid: { ok: false, service: 'alldebrid', label: 'AllDebrid', reason: 'auth', error: 'AUTH_BAD_APIKEY', fix: 'renove a chave em alldebrid.com/account/api' } },
    },
    catalog: { ok: true },
  });
  assert.equal(els.connection.className, 'connection error', 'auth prova conta inutilizável');
  assert.match(els.statusBanner.className, /\bvisible\b/);
  assert.match(els.statusBanner.className, /\berror\b/);
  const texto = bannerLines(els);
  assert.match(texto, /AllDebrid/, 'a conta culpada é nomeada');
  assert.match(texto, /chave de API recusada/, 'reason traduzido');
  assert.match(texto, /renove a chave/, 'fix da conta do operador viaja no banner');
  assert.doesNotMatch(texto, /conta ativa/, 'a instalação anônima sem debrid não reaparece como problema');
});

test('sem-debrid com rate limit na conta do operador fica em atenção (nem online, nem erro)', () => {
  const { els, renderStatus } = loadDashboardStatusApi();
  renderStatus({
    general: { ok: true, services: { addon: true, jackett: true, debrid: false, resolvers: 5 } },
    debrid: {
      active: null,
      account: { ok: false, reason: 'sem-debrid', service: null },
      accounts: { alldebrid: { ok: false, service: 'alldebrid', label: 'AllDebrid', reason: 'rate' } },
    },
    catalog: { ok: true },
  });
  assert.equal(els.connection.className, 'connection warn', 'rate é transitório: atenção, não derruba a vermelho');
  assert.match(els.statusBanner.className, /\bwarn\b/);
  assert.match(bannerLines(els), /rate limit do serviço/);
});

// Mesma correção no card do serviço: conta ok em accounts (a do operador, no
// shape exato da VPS) não pode ficar em "não medido" — mesmo critério do
// espelho da conta ativa; warn:true (limiar do operador) degrada para atenção.
// O item vindo de accounts entra pelo caminho service/label (sem campo id),
// então a busca usa (id || service).
test('renderDebrid: conta do operador ok em accounts é saudável no card, não "não medido"', () => {
  const { renderDebrid, captured } = loadDashboardPanelsApi();
  const porServico = (lista: any[]) => lista.filter((item: any) => item && (item.id || item.service) === 'alldebrid');
  renderDebrid({
    active: null,
    account: { ok: false, reason: 'sem-debrid', service: null },
    accounts: { alldebrid: { ok: true, service: 'alldebrid', label: 'AllDebrid', magnets: 846 } },
  });
  const alldebrid = porServico(captured).pop();
  assert.ok(alldebrid, 'card AllDebrid renderizado');
  assert.equal(alldebrid.status, 'online', 'ok:true em accounts é saudável (sem warn)');
  assert.equal(alldebrid.magnets, 846, 'os detalhes da conta seguem no card');
  renderDebrid({
    active: null,
    account: { ok: false, reason: 'sem-debrid', service: null },
    accounts: { alldebrid: { ok: true, service: 'alldebrid', label: 'AllDebrid', magnets: 846, warn: true } },
  });
  const comWarn = porServico(captured).pop();
  assert.equal(comWarn.status, 'warn', 'warn do limiar do operador degrada o card para atenção');
});

test('banner persistente existe no HTML e dashboard-status.js permanece ES5 sem innerHTML', () => {
  const html = dashboardHtml();
  assert.match(html, /id="statusBanner"/);
  assert.match(html, /id="statusBannerText"/);
  const statusJs = readFileSync(new URL('../../src/public/dashboard-status.js', import.meta.url), 'utf8');
  assert.doesNotMatch(statusJs, /\b(?:const|let)\b|=>|\?\.|\?\?/, 'dashboard-status.js continua ES5');
  // Sem innerHTML COM DADOS: o único uso é o option estático do seletor de
  // namespace (string literal, nada da rede); o banner é preenchido por
  // textContent/appendChild.
  const uses = statusJs.match(/innerHTML\s*=[^;]+;/g) || [];
  assert.equal(uses.length, 1, 'único innerHTML permitido é o option estático');
  assert.doesNotMatch(uses[0], /\+/, 'sem concatenação de dados no innerHTML');
});

// Teste de resolver BR no painel: o card kind=resolver usa endpoint próprio
// (/test-resolver.json, backend em escopo separado); o frontend espelha o
// gate/feedback de runIndexerTest e reconsulta o estado depois de medir.

test('dashboard-core/panels: kind=resolver ganha botão Testar este resolver; indexador segue igual; ES5', () => {
  const core = readFileSync(new URL('../../src/public/dashboard-core.js', import.meta.url), 'utf8'); const panels = readFileSync(new URL('../../src/public/dashboard-panels.js', import.meta.url), 'utf8');
  assert.match(core, /"Testar este resolver"/);
  assert.match(core, /setAttribute\("data-resolver-id"/);
  assert.match(core, /runResolverTest\(button\.getAttribute\("data-resolver-id"\), button\)/);
  assert.match(core, /"Testar este indexador"/); // caminho do indexador permanece intacto
  assert.match(core, /runIndexerTest\(button\.getAttribute\("data-indexer-id"\), button\)/);
  assert.match(panels, /renderCollection\(\$\("resolverCards"\), resolvers, "resolvers", \{ testable: true, kind: "resolver" \}\)/);
  for (const js of [core, panels]) {
    assert.doesNotMatch(js, /\b(?:const|let)\b|=>|\?\.|\?\?/, 'ES5 (WebView de TV)');
    assert.doesNotMatch(js, /innerHTML/, 'dados só por textContent/appendChild');
  }
});

test('runResolverTest: gate de id/token, falha vira erro e sucesso mostra releases/latência/host e reconsulta', async () => {
  const calls: Array<{ url: string; init: any }> = [];
  let payload: any = { ok: false, error: 'resolver fora do ar' };
  const api = loadDashboardStatusApi((url: string, init: any) => {
    calls.push({ url: String(url), init });
    const body = String(url).indexOf('/test-resolver.json') !== -1 ? payload : { general: { ok: true, services: {} } };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  });
  // `els` é preguiçoso: o elemento só existe depois do primeiro $("testOutput")
  // dentro de runResolverTest — ler antes da chamada captura undefined.
  api.runResolverTest('', null);
  assert.match(api.els.testOutput.textContent, /Informe o ID do resolver/);
  api.runResolverTest('bludv', null);
  assert.match(api.els.testOutput.textContent, /Informe o token antes de testar um resolver/);
  assert.equal(calls.length, 0, 'gate: nenhuma chamada sem id ou sem token');
  api.setToken('segredo');
  api.runResolverTest('vacatorrent', null);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(calls[0].url, /\/test-resolver\.json\?id=vacatorrent$/, 'endpoint do resolver chamado com o id');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers['X-Indexer-Test-Token'], 'segredo');
  assert.match(api.els.testOutput.className, /\berror\b/);
  assert.match(api.els.testOutput.textContent, /Falhou · resolver fora do ar/);
  payload = { ok: true, results: 7, ms: 800, host: 'vaqueirofilmes.com' };
  api.runResolverTest('vacatorrent', null);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(api.els.testOutput.className, /\bok\b/);
  assert.match(api.els.testOutput.textContent, /vacatorrent · OK · 7 release\(s\) · 800 ms · host vaqueirofilmes\.com/);
  assert.ok(calls.some((c) => c.url.indexOf('/dashboard-status.json') !== -1), 'loadStatus roda após medir (card sai de não medido)');
});
