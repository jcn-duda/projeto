import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ACTIONS = [
  'catalog-scan',
  'catalog-report',
  'dedup-preview',
  'dedup-apply',
  'audit-backfill',
  'cleanup-preview',
  'cleanup-apply',
];
// As destrutivas exigem confirm: true. Nenhuma das outras é destrutiva.
const DESTRUCTIVE = ['dedup-apply', 'cleanup-apply'];

function diagnosticsSource() {
  // relativo ao arquivo de teste compilado em dist/test: ../../ volta à raiz
  // do repositório, onde o FONTE .ts existe (não é copiado para dist/).
  return readFileSync(new URL('../../src/routes/diagnostics.ts', import.meta.url), 'utf8');
}

function dashboardHtml() {
  return readFileSync(new URL('../../src/public/dashboard.html', import.meta.url), 'utf8');
}

test('diagnostics.ts: as 7 ações do catálogo estão na allowlist do dashboardAction', () => {
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