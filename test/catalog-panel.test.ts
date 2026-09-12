import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import config from '../src/config.js';
// A allowlist e a lista de confirmação moram em dashboard-actions.ts.
import { DASHBOARD_ACTIONS, DESTRUCTIVE_ACTIONS } from '../src/routes/dashboard-actions.js';
import { dashboardHtml, resetDashboardEnvironment } from './helpers/dashboard.js';

const ACTIONS = [
  'catalog-scan', 'catalog-report', 'dedup-preview', 'dedup-apply', 'audit-backfill',
  'audit-requeue', 'catalog-list', 'manual-delete', 'cleanup-preview', 'cleanup-apply',
];
const DESTRUCTIVE = ['dedup-apply', 'cleanup-apply', 'manual-delete'];

function flat(node: any): string {
  if (!node) return '';
  return [String(node.textContent || '')].concat((node.children || []).map(flat)).join(' ');
}

async function catalogEnv() {
  const env = await resetDashboardEnvironment();
  const requests: Array<{ url: string; body: any }> = [];
  let response: any = { ok: true };
  env.dom.setFetch((url: string, init: any) => {
    let body: any = null;
    try { body = JSON.parse(init.body); } catch { body = null; }
    requests.push({ url: String(url), body });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(typeof response === 'function' ? response(body) : response) });
  });
  env.mods.hooks.hooks.register('loadStatus', () => {});
  return { ...env, requests, setResponse(r: any) { response = r; } };
}

test('dashboard-actions: as 10 ações do catálogo estão na allowlist do despacho', () => {
  for (const action of ACTIONS) assert.ok(DASHBOARD_ACTIONS.has(action), action);
});

test('dashboard-actions: só dedup-apply, cleanup-apply e manual-delete exigem confirm', () => {
  for (const action of DESTRUCTIVE) assert.ok(DESTRUCTIVE_ACTIONS.has(action), action);
  for (const action of ACTIONS) {
    if (DESTRUCTIVE.includes(action)) continue;
    assert.ok(!DESTRUCTIVE_ACTIONS.has(action), action + ' não deve exigir confirm');
  }
});

test('dashboard.html: seção do catálogo com os IDs e botões das ações', () => {
  const html = dashboardHtml();
  for (const id of ['catalog_report', 'catalog_dedup_preview', 'catalog_targets', 'catalogScanBtn', 'catalogDedupApplyBtn', 'catalog_include_known', 'catalogSelectAllBtn', 'catalog_selection']) {
    assert.match(html, new RegExp('id="' + id + '"'), id);
  }
});

test('dedup-apply exige confirmação nativa antes de postar', async () => {
  const { dom, mods, requests } = await catalogEnv();
  dom.window.confirm = () => false;
  mods.catalogActions.runCatalogDedupApply();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(requests.length, 0, 'cancelar não posta');
  dom.window.confirm = () => true;
  mods.catalogActions.runCatalogDedupApply();
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(requests[0].body.action, 'dedup-apply');
  assert.equal(requests.length, 2, 'dedup-apply + recarga do relatório');
  dom.cleanup();
});

test('catalogAction carrega includeKnown do checkbox; bucketError anexa o hint', async () => {
  const { dom, mods, requests } = await catalogEnv();
  dom.element('catalog_include_known').checked = true;
  mods.catalogActions.runCatalogScan();
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(requests[0].body.includeKnown, true);
  const err = mods.catalogRender.bucketError({ ok: false, reason: 'chave-operador-desativada', hint: 'ligue DEBRID_OPERATOR_ENV_ACCOUNT' });
  assert.match(err, /ligue DEBRID_OPERATOR_ENV_ACCOUNT/);
  dom.cleanup();
});

test('ações que mutam usam renderCatalogOutcome (contadores) e não estouram no relatório', async () => {
  const { dom, mods, setResponse } = await catalogEnv();
  let calls = 0;
  setResponse((body: any) => {
    calls += 1;
    if (body && body.action === 'audit-backfill') return { ok: true, scanned: 5, evidencied: 2, deleted: 1 };
    return { ok: true, report: { magnets: 7, ready: 5, works: {}, byCached: {}, byBucket: {}, totals: { count: 7, bytes: 4096 } } };
  });
  mods.catalogActions.runCatalogAudit();
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(calls, 2, 'audit + recarga do relatório');
  const feedback = dom.byId['catalog_feedback'].textContent;
  assert.match(feedback, /auditados: 5/);
  assert.match(feedback, /apagados: 1/);
  assert.match(flat(dom.byId['catalog_report']), /Magnets/);
  dom.cleanup();
});

test('indisponibilidade (ok:false) vira feedback de erro com hint', async () => {
  const { dom, mods, setResponse } = await catalogEnv();
  setResponse({ ok: false, reason: 'chave-operador-desativada', hint: 'ligue DEBRID_OPERATOR_ENV_ACCOUNT' });
  mods.catalogActions.runCatalogAudit();
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(dom.byId['catalog_feedback'].className, 'feedback error');
  assert.match(dom.byId['catalog_feedback'].textContent, /DEBRID_OPERATOR_ENV_ACCOUNT/);
  dom.cleanup();
});

test('renderCatalogReport tolera relatório parcial sem estourar (defaults byCached/byBucket)', async () => {
  const { dom, mods } = await catalogEnv();
  assert.doesNotThrow(() => mods.catalogRender.renderCatalogReport({ ok: true, report: { magnets: 1, totals: { count: 1, bytes: 10 } } }));
  assert.match(flat(dom.byId['catalog_report']), /Magnets/);
  dom.cleanup();
});

test('renderCatalogDedup marca preexistente; select-all pula desabilitados com resumo em bytes', async () => {
  const { dom, mods } = await catalogEnv();
  mods.catalogRender.renderCatalogDedup({ ok: true, targets: [{ hash: 'a1b2c3d4', size: 2048, known: true, filename: 'Filme A', reason: 'foreign' }] });
  assert.match(flat(dom.byId['catalog_targets']), /preexistente/);
  mods.catalogRender.renderCatalogManual({
    ok: true,
    rows: [
      { serviceId: 'a', size: 2048, filename: 'Filme A', bucket: 'dub' },
      { serviceId: 'b', size: 1024, filename: 'Filme B', active: true, bucket: 'dub' },
    ],
  });
  const boxes = mods.catalogRender.catalogBoxes();
  assert.equal(boxes.length, 2);
  assert.equal(boxes[1].disabled, true, 'download em curso nasce desabilitado');
  mods.catalogRender.toggleCatalogSelectAll();
  assert.equal(boxes[0].checked, true, 'marca só o não desabilitado');
  assert.equal(boxes[1].checked, false);
  assert.match(dom.byId['catalog_selection'].textContent, /2\.0 KB/, 'resumo mostra o tamanho');
  dom.cleanup();
});

test('cleanupMinAgeMs default é 48h e a env explícita vence', async () => {
  assert.equal(config.catalog.cleanupMinAgeMs, 48 * 3600 * 1000);
  process.env.CATALOG_CLEANUP_MIN_AGE_MS = '999000';
  try {
    const fresh = (await import('../src/config.js' + '?cleanup-age=override')) as any;
    assert.equal(fresh.default.catalog.cleanupMinAgeMs, 999000);
  } finally {
    delete process.env.CATALOG_CLEANUP_MIN_AGE_MS;
  }
});

test('o JS do catálogo é ESM e não usa new Function/globals', () => {
  const src = readFileSync(new URL('../../src/client/dashboard/catalog-actions.ts', import.meta.url), 'utf8');
  assert.match(src, /export function catalogAction|export function runCatalogScan/);
  assert.doesNotMatch(src, /new Function/);
});

test('catálogo é read-only no load: render do poll não emite POST', async () => {
  const { dom, mods, requests } = await catalogEnv();
  mods.hooks.hooks.register('renderCatalogReport', mods.catalogRender.renderCatalogReport);
  mods.catalogRender.renderCatalogReport({ ok: true, report: { magnets: 3, totals: { count: 3, bytes: 30 } } });
  mods.catalogPanel.renderCatalogPanel({ catalog: { ok: true, report: { magnets: 3, totals: { count: 3, bytes: 30 } } } });
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(requests.length, 0, 'render do relatório e do poll não postam nada');
  dom.cleanup();
});
