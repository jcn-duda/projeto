import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import config from '../src/config.js';

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

function diagnosticsSource() {
  // relativo ao arquivo de teste compilado em dist/test: ../../ volta à raiz
  // do repositório, onde o FONTE .ts existe (não é copiado para dist/).
  return readFileSync(new URL('../../src/routes/diagnostics.ts', import.meta.url), 'utf8');
}

function dashboardHtml() {
  return readFileSync(new URL('../../src/public/dashboard.html', import.meta.url), 'utf8');
}

test('diagnostics.ts: as 10 ações do catálogo estão na allowlist do dashboardAction', () => {
  const src = diagnosticsSource();
  const match = src.match(/if \(!\[([\s\S]*?)\]\s*\.includes\(action\)\)/);
  assert.ok(match, 'allowlist declarada no dashboardAction');
  const allowed = match![1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  for (const action of ACTIONS) {
    assert.ok(allowed.includes(action), `${action} deve estar na allowlist`);
  }
});

test('diagnostics.ts: exatamente dedup-apply e cleanup-apply exigem confirm', () => {
  const src = diagnosticsSource();
  const match = src.match(/(\[[^\]]*\]\.includes\(action\) && req\.body\?\.confirm\s*!==\s*true)/);
  assert.ok(match, 'linha de confirmação presente no dashboardAction');
  const arrayText = (match![1] as string).match(/^\[([\s\S]*?)\]\./)![1];
  const confirmed = arrayText.split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  for (const action of DESTRUCTIVE) {
    assert.ok(confirmed.includes(action), `${action} deve estar na lista de confirmação`);
  }
  for (const action of ACTIONS) {
    if (DESTRUCTIVE.includes(action)) continue;
    assert.ok(!confirmed.includes(action), `${action} NÃO deve exigir confirmação`);
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
