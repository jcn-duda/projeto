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

function dashboardCatalogJs() {
  return readFileSync(new URL('../../src/public/dashboard-catalog.js', import.meta.url), 'utf8');
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
  const js = dashboardCatalogJs();
  assert.match(html, /id="catalog_report"/);
  assert.match(html, /id="catalog_dedup_preview"/);
  assert.match(html, /id="catalog_targets"/);
  // Botões que postam as ações (via catalogAction no JS).
  assert.match(html, /id="catalogScanBtn"/);
  assert.match(html, /id="catalogDedupApplyBtn"/);
  // O JS recorre a catalogAction com as ações esperadas.
  assert.match(js, /catalogAction\(\s*"catalog-scan"/);
  assert.match(js, /catalogAction\(\s*"dedup-apply"/);
});

test('dashboard.html: aplicar de dedup exige confirmação nativa antes de postar', () => {
  const js = dashboardCatalogJs();
  const idx = js.indexOf('function runCatalogDedupApply');
  assert.ok(idx !== -1, 'handler do dedup-apply presente');
  const body = js.slice(idx, idx + 260);
  assert.match(body, /window\.confirm/);
  const confirmIdx = body.indexOf('window.confirm');
  const actionIdx = body.indexOf('catalogAction("dedup-apply"');
  assert.ok(confirmIdx !== -1 && actionIdx !== -1 && confirmIdx < actionIdx, 'confirm antes do post');
});

test('dashboard.html: o JS da nova seção continua ES5 (WebView de Smart TV)', () => {
  const html = dashboardHtml();
  const js = dashboardCatalogJs();
  assert.doesNotMatch(html, /\b(?:const|let)\b|=>|\?\.|\?\?/, 'dashboard.html continua ES5');
  assert.doesNotMatch(js, /\b(?:const|let)\b|=>|\?\.|\?\?/, 'dashboard-catalog.js continua ES5');
});

test('dashboard.html: checkbox catalog_include_known presente e enviado como includeKnown no corpo', () => {
  const html = dashboardHtml();
  const js = dashboardCatalogJs();
  assert.match(html, /id="catalog_include_known"/);
  assert.match(js, /includeKnown: catalogIncludeKnown\(\)/, 'o corpo da ação carrega includeKnown lido do checkbox');
  assert.match(js, /function catalogIncludeKnown/, 'há uma função que lê o estado do checkbox');
});

test('dashboard.html: alvo com t.known é marcado (preexistente) na lista da limpeza', () => {
  const js = dashboardCatalogJs();
  assert.match(js, /preexistente/);
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
  const js = dashboardCatalogJs();
  const linhas = js.split('\n');
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
  const js = dashboardCatalogJs();
  assert.match(js, /var cached = report\.byCached \|\| \{\};/);
  assert.match(js, /var buckets = report\.byBucket \|\| \{\};/);
  assert.doesNotMatch(js, /report\.byCached\[/);
  assert.doesNotMatch(js, /report\.byBucket\[/);
});

// Erro de RENDER não pode ser reportado como falha da AÇÃO: o servidor já
// executou (a auditoria escreve evidência antes de a tela desenhar).
test('dashboard.html: callback do catalogAction roda isolado em try/catch', () => {
  const js = dashboardCatalogJs();
  assert.match(js, /callback\(data\);\s*\}\s*catch \(renderError\)/);
});

// Indisponibilidade (`ok:false` com 200 — ex.: conta do operador desligada no
// .env) não pode pintar feedback verde "concluída": o operador via sucesso na
// tela e o motivo cru só no corpo do painel. O ramo de erro precisa vir ANTES
// do feedback de sucesso dentro do .then, e o hint do backend (o conserto)
// tem de chegar ao painel via bucketError.
test('dashboard.html: indisponibilidade da ação vira feedback de erro com hint, antes do sucesso', () => {
  const js = dashboardCatalogJs();
  const idx = js.indexOf('function catalogAction');
  assert.ok(idx !== -1, 'catalogAction presente');
  const corpo = js.slice(idx, idx + 1400);
  const erroIdx = corpo.indexOf('!data.ok');
  assert.ok(erroIdx !== -1, 'ramo de indisponibilidade presente no .then');
  const sucessoIdx = corpo.indexOf('concluída.');
  assert.ok(sucessoIdx !== -1 && erroIdx < sucessoIdx, 'erro avaliado antes do feedback de sucesso');
  assert.match(corpo, /setCatalogFeedback\("Ação " \+ action \+ " indisponível: " \+ bucketError\(data\), "error"\)/);
  // bucketError anexa o hint (com escaping de valueText, sem innerHTML).
  const bucketIdx = js.indexOf('function bucketError');
  assert.ok(bucketIdx !== -1);
  const bucket = js.slice(bucketIdx, bucketIdx + 400);
  assert.match(bucket, /data\.hint/);
  assert.match(bucket, /valueText\(data\.hint\)/);
});

// Selecionar todos: conveniência sobre uma ação IRREVERSÍVEL, então duas
// invariantes. (a) download em curso nunca entra na seleção em massa — o
// checkbox nasce `disabled` e o toggle o ignora; (b) o resumo mostra o TAMANHO
// junto da contagem, porque "12 selecionados" não diz se são 2 GB ou 2 TB.
test('dashboard.html: selecionar todos pula os desabilitados e resume com tamanho', () => {
  const html = dashboardHtml();
  const js = dashboardCatalogJs();
  assert.match(html, /id="catalogSelectAllBtn"/);
  assert.match(html, /id="catalog_selection"/);
  const idx = js.indexOf('function toggleCatalogSelectAll');
  assert.ok(idx !== -1, 'handler do selecionar-todos presente');
  const corpo = js.slice(idx, idx + 900);
  assert.match(corpo, /if \(!nodes\[i\]\.disabled\) nodes\[i\]\.checked = ligar;/, 'só marca o que não está desabilitado');
  assert.match(js, /box\.setAttribute\("data-size"/, 'o checkbox carrega o tamanho para o resumo somar');
  const resumo = js.slice(js.indexOf('function refreshCatalogSelection'), js.indexOf('function toggleCatalogSelectAll'));
  assert.match(resumo, /formatBytes\(bytes\)/, 'o resumo mostra bytes, não só contagem');
});
