import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import config from '../src/config.js';
// Extração §5.8: a allowlist e a lista de confirmação moram em
// dashboard-actions.ts. Importar os conjuntos exportados verifica o ESTADO
// real do despacho (em vez de regex sobre o texto do fonte, que quebrava a
// cada refactor de formato sem relação com comportamento).
import { DASHBOARD_ACTIONS, DESTRUCTIVE_ACTIONS } from '../src/routes/dashboard-actions.js';

const ACTIONS = [
  'catalog-scan',
  'catalog-report',
  'dedup-preview',
  'dedup-apply',
  'audit-backfill',
  'audit-requeue',
  'catalog-list',
  'manual-delete',
  'cleanup-preview',
  'cleanup-apply',
];
// As destrutivas exigem confirm: true. Nenhuma das outras é destrutiva.
const DESTRUCTIVE = ['dedup-apply', 'cleanup-apply', 'manual-delete'];

function dashboardHtml() {
  return readFileSync(new URL('../../src/public/dashboard.html', import.meta.url), 'utf8');
}

test('dashboard-actions: as 10 ações do catálogo estão na allowlist do despacho', () => {
  for (const action of ACTIONS) {
    assert.ok(DASHBOARD_ACTIONS.has(action), `${action} deve estar na allowlist`);
  }
});

test('dashboard-actions: exatamente dedup-apply, cleanup-apply e manual-delete exigem confirm', () => {
  for (const action of DESTRUCTIVE) {
    assert.ok(DESTRUCTIVE_ACTIONS.has(action), `${action} deve estar na lista de confirmação`);
  }
  for (const action of ACTIONS) {
    if (DESTRUCTIVE.includes(action)) continue;
    assert.ok(!DESTRUCTIVE_ACTIONS.has(action), `${action} NÃO deve exigir confirmação`);
  }
});

test('dashboard.html: seção Conta / Catálogo com os IDs exigidos e botões das ações', () => {
  const html = dashboardHtml();
  assert.match(html, /id="catalog_report"/);
  assert.match(html, /id="catalog_dedup_preview"/);
  assert.match(html, /id="catalog_targets"/);
  // Botões que postam as ações (via catalogAction no JS).
  assert.match(html, /id="catalogScanBtn"/);
  assert.match(html, /id="catalogDedupApplyBtn"/);
  // O JS recorre a catalogAction com as ações esperadas.
  assert.match(html, /catalogAction\(\s*"catalog-scan"/);
  assert.match(html, /catalogAction\(\s*"dedup-apply"/);
});

test('dashboard.html: aplicar de dedup exige confirmação nativa antes de postar', () => {
  const html = dashboardHtml();
  const idx = html.indexOf('function runCatalogDedupApply');
  assert.ok(idx !== -1, 'handler do dedup-apply presente');
  const body = html.slice(idx, idx + 260);
  assert.match(body, /window\.confirm/);
  const confirmIdx = body.indexOf('window.confirm');
  const actionIdx = body.indexOf('catalogAction("dedup-apply"');
  assert.ok(confirmIdx !== -1 && actionIdx !== -1 && confirmIdx < actionIdx, 'confirm antes do post');
});

test('dashboard.html: o JS da nova seção continua ES5 (WebView de Smart TV)', () => {
  const html = dashboardHtml();
  assert.doesNotMatch(html, /\b(?:const|let)\b|=>|\?\.|\?\?/, 'dashboard.html continua ES5');
});

test('dashboard.html: checkbox catalog_include_known presente e enviado como includeKnown no corpo', () => {
  const html = dashboardHtml();
  assert.match(html, /id="catalog_include_known"/);
  assert.match(html, /includeKnown: catalogIncludeKnown\(\)/, 'o corpo da ação carrega includeKnown lido do checkbox');
  assert.match(html, /function catalogIncludeKnown/, 'há uma função que lê o estado do checkbox');
});

test('dashboard.html: alvo com t.known é marcado (preexistente) na lista da limpeza', () => {
  const html = dashboardHtml();
  assert.match(html, /preexistente/);
});

// Limpador BR com prova: o default de idade mínima foi fixado em 48h. Motivo
// medido: o acervo da AllDebrid se recicla em até ~3 dias, então o antigo
// default de 7 dias nunca liberava vaga; duas janelas de observação (48h)
// ainda descartam o download que acabou de ser aquecido.
test('cleanupMinAgeMs default é 48h, não 7 dias', () => {
  assert.equal(config.catalog.cleanupMinAgeMs, 48 * 3600 * 1000);
});

// Valor explícito da env ainda vence o default: config.js lê o process.env uma
// vez no load, então este teste importa uma cópia fresca do módulo (bust de
// cache via query) com a variável setada antes, sem tocar o singleton do topo
// deste arquivo nem o estado de outros testes do processo.
test('CATALOG_CLEANUP_MIN_AGE_MS explícito vence o default de 48h', async () => {
  process.env.CATALOG_CLEANUP_MIN_AGE_MS = '999000';
  try {
    // Expressão não-literal: mantém o cache bust via query (instância fresca
    // do módulo) sem o TS tentar resolver a URL literal (TS2307). O default
    // do módulo é o objeto config.
    const fresh = (await import('../src/config.js' + '?cleanup-age=override')) as any;
    const cfg: { catalog: { cleanupMinAgeMs: number } } = fresh.default;
    assert.equal(cfg.catalog.cleanupMinAgeMs, 999000);
  } finally {
    delete process.env.CATALOG_CLEANUP_MIN_AGE_MS;
  }
});

// Regressão do painel: `audit-backfill`, `dedup-apply` e `cleanup-apply`
// devolvem CONTADORES (`scanned`/`deleted`/`falhas`), nunca um relatório.
// Ligá-los ao renderCatalogReport fazia `report.byCached["hit"]` estourar
// sobre `undefined` — e, por acontecer DENTRO do .then(), o .catch() do
// catalogAction pintava "Ação não concluída" para uma auditoria que já tinha
// rodado e gravado evidência no servidor. Medido no dashboard ao vivo:
// "Cannot read properties of undefined (reading 'hit')".
test('dashboard.html: ações que mutam usam renderCatalogOutcome, não renderCatalogReport', () => {
  const html = dashboardHtml();
  const linhas = html.split('\n');
  for (const action of ['audit-backfill', 'dedup-apply', 'cleanup-apply']) {
    const alvo = `catalogAction("${action}"`;
    const linha = linhas.find((l) => l.includes(alvo));
    assert.ok(linha, `ação ${action} não encontrada no painel`);
    assert.ok(
      linha!.includes('renderCatalogOutcome'),
      `${action} deve renderizar contadores, não relatório`,
    );
  }
});

// Um relatório ausente ou parcial não pode derrubar o render: os dois mapas
// agregados (`byCached` e `byBucket`) precisam de default próprio, do mesmo
// jeito que `report.works` e `report.totals` já são acessados com guarda.
test('dashboard.html: byCached e byBucket têm default antes do acesso indexado', () => {
  const html = dashboardHtml();
  assert.match(html, /var cached = report\.byCached \|\| \{\};/);
  assert.match(html, /var buckets = report\.byBucket \|\| \{\};/);
  assert.doesNotMatch(html, /report\.byCached\[/);
  assert.doesNotMatch(html, /report\.byBucket\[/);
});

// Erro de RENDER não pode ser reportado como falha da AÇÃO: o servidor já
// executou (a auditoria escreve evidência antes de a tela desenhar).
test('dashboard.html: callback do catalogAction roda isolado em try/catch', () => {
  const html = dashboardHtml();
  assert.match(html, /callback\(data\);\s*\}\s*catch \(renderError\)/);
});

// Indisponibilidade (`ok:false` com 200 — ex.: conta do operador desligada no
// .env) não pode pintar feedback verde "concluída": o operador via sucesso na
// tela e o motivo cru só no corpo do painel. O ramo de erro precisa vir ANTES
// do feedback de sucesso dentro do .then, e o hint do backend (o conserto)
// tem de chegar ao painel via bucketError.
test('dashboard.html: indisponibilidade da ação vira feedback de erro com hint, antes do sucesso', () => {
  const html = dashboardHtml();
  const idx = html.indexOf('function catalogAction');
  assert.ok(idx !== -1, 'catalogAction presente');
  const corpo = html.slice(idx, idx + 1400);
  const erroIdx = corpo.indexOf('!data.ok');
  assert.ok(erroIdx !== -1, 'ramo de indisponibilidade presente no .then');
  const sucessoIdx = corpo.indexOf('concluída.');
  assert.ok(sucessoIdx !== -1 && erroIdx < sucessoIdx, 'erro avaliado antes do feedback de sucesso');
  assert.match(corpo, /setCatalogFeedback\("Ação " \+ action \+ " indisponível: " \+ bucketError\(data\), "error"\)/);
  // bucketError anexa o hint (com escaping de valueText, sem innerHTML).
  const bucketIdx = html.indexOf('function bucketError');
  assert.ok(bucketIdx !== -1);
  const bucket = html.slice(bucketIdx, bucketIdx + 400);
  assert.match(bucket, /data\.hint/);
  assert.match(bucket, /valueText\(data\.hint\)/);
});

// Selecionar todos: conveniência sobre uma ação IRREVERSÍVEL, então duas
// invariantes. (a) download em curso nunca entra na seleção em massa — o
// checkbox nasce `disabled` e o toggle o ignora; (b) o resumo mostra o TAMANHO
// junto da contagem, porque "12 selecionados" não diz se são 2 GB ou 2 TB.
test('dashboard.html: selecionar todos pula os desabilitados e resume com tamanho', () => {
  const html = dashboardHtml();
  assert.match(html, /id="catalogSelectAllBtn"/);
  assert.match(html, /id="catalog_selection"/);
  const idx = html.indexOf('function toggleCatalogSelectAll');
  assert.ok(idx !== -1, 'handler do selecionar-todos presente');
  const corpo = html.slice(idx, idx + 900);
  assert.match(corpo, /if \(!nodes\[i\]\.disabled\) nodes\[i\]\.checked = ligar;/, 'só marca o que não está desabilitado');
  assert.match(html, /box\.setAttribute\("data-size"/, 'o checkbox carrega o tamanho para o resumo somar');
  const resumo = html.slice(html.indexOf('function refreshCatalogSelection'), html.indexOf('function toggleCatalogSelectAll'));
  assert.match(resumo, /formatBytes\(bytes\)/, 'o resumo mostra bytes, não só contagem');
});

// ---------------------------------------------------------------------------
// Pill + banner persistente refletem o ok:false JÁ presente em
// /dashboard-status.json (incidente de 2026-08-30: o pill ficava verde com
// timeout da conta, catálogo indisponível ou serviço debrid morto, porque o
// cálculo só olhava auth/quota e Jackett — o resto morria num <details>
// fechado). dashboard-status.js é módulo de declarações (nada roda no load),
// então o teste EXECUTA renderStatus com um DOM falso, sobre o escopo global
// compartilhado core + status — mesmo padrão do displayValue.
// ---------------------------------------------------------------------------

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
