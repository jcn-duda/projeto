import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import config from '../src/config.js';
// A allowlist e a lista de confirmação moram em dashboard-actions.ts.
import { DASHBOARD_ACTIONS, DESTRUCTIVE_ACTIONS } from '../src/routes/dashboard-actions.js';
// Modelo puro da aba Limpeza do /painel (o cliente legado de /dashboard saiu).
import {
  catalogListRows,
  catalogVerdict,
  catalogSelection,
  toggleAllSelection,
  catalogPageCount,
  catalogPageSlice,
  cleanupPreviewSummary,
  canApplyCleanup,
  cleanupSkippedLine,
} from '../src/client/painel/limpeza/catalogo-model.js';

const ACTIONS = [
  'catalog-scan', 'catalog-report', 'dedup-preview', 'dedup-apply', 'audit-backfill',
  'audit-requeue', 'catalog-list', 'manual-delete', 'cleanup-preview', 'cleanup-apply',
];
const DESTRUCTIVE = ['dedup-apply', 'cleanup-apply', 'manual-delete'];

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

test('catalogListRows normaliza o contrato real de catalog-list e o veredito exige prova', () => {
  const rows = catalogListRows({
    ok: true,
    rows: [
      { serviceId: 'a1', hash: 'a1b2c3d4e5', filename: 'Filme Estrangeiro', size: 2048, bucket: 'lixo', foreignProof: 'lang:en', active: true },
      { serviceId: 'b2', hash: 'b2c3d4e5f6', filename: 'Filme PT', size: 1024, bucket: 'dub', ptProof: 'pt' },
    ],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].hashShort, 'a1b2c3d4');
  assert.equal(rows[0].bucketName, 'Lixo / indefinido');
  assert.equal(rows[0].active, true);
  assert.equal(catalogVerdict(rows[0]).text, 'estrangeiro');
  assert.equal(catalogVerdict(rows[1]).text, 'PT');
  // Sem prova alguma, o veredito não condena nem promove.
  const [semProva] = catalogListRows({ ok: true, rows: [{ serviceId: 'c', bucket: 'dual' }] });
  assert.equal(catalogVerdict(semProva).text, 'Dual');
  assert.deepEqual(catalogListRows(null), []);
});

test('seleção ignora download em curso e o resumo carrega bytes', () => {
  const rows = catalogListRows({
    ok: true,
    rows: [
      { serviceId: 'a', size: 2048, bucket: 'dub' },
      { serviceId: 'b', size: 1024, bucket: 'dub', active: true },
    ],
  });
  // O desabilitado (active) nunca é elegível; o marcado respeita a mesma regra.
  assert.deepEqual(toggleAllSelection(rows, []), ['a']);
  assert.deepEqual(toggleAllSelection(rows, ['a']), []);
  const selection = catalogSelection(rows, ['a', 'b']);
  assert.equal(selection.count, 1, 'linha em curso não conta');
  assert.equal(selection.bytes, 2048);
  assert.equal(selection.eligible, 1);
});

test('paginação do cliente respeita o tamanho de página e clampa', () => {
  assert.equal(catalogPageCount(0), 1);
  assert.equal(catalogPageCount(45), 3);
  const rows = Array.from({ length: 45 }, (_, i) => i);
  assert.equal(catalogPageSlice(rows, 1).length, 20);
  assert.equal(catalogPageSlice(rows, 3).length, 5);
  assert.equal(catalogPageSlice(rows, 99)[0], 40, 'página acima do teto clampa na última');
});

test('cleanupPreviewSummary normaliza targets/skipped e a falha preserva o motivo', () => {
  const ok = cleanupPreviewSummary({
    ok: true,
    targets: [{ hash: 'abc', size: 10 }],
    skipped: { protected: 1, known: 2 },
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.targets.length, 1);
  assert.equal(ok.skipped.protected, 1);
  assert.equal(ok.skipped.known, 2);
  assert.match(cleanupSkippedLine(ok.skipped), /protegidos: 1/);

  const fail = cleanupPreviewSummary({ ok: false, reason: 'sem-adapter', hint: 'ligue DEBRID_OPERATOR_ENV_ACCOUNT' });
  assert.equal(fail.ok, false);
  assert.match(String(fail.reason), /ligue DEBRID_OPERATOR_ENV_ACCOUNT/);
  assert.deepEqual(fail.targets, []);
  assert.equal(canApplyCleanup(null), false);
  assert.equal(canApplyCleanup(fail), false);
  assert.equal(canApplyCleanup(ok), true, 'só com alvo a ação destrutiva é liberada');
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

test('a aba de catálogo do /painel é ESM sem new Function e usa as ações reais do backend', () => {
  for (const file of ['limpeza/catalogo-model.ts', 'limpeza/view-catalogo.ts', 'limpeza/view-manutencao.ts']) {
    const src = readFileSync(new URL('../../src/client/painel/' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /new Function/, file + ' não pode usar new Function');
  }
  const view = readFileSync(new URL('../../src/client/painel/limpeza/view-catalogo.ts', import.meta.url), 'utf8');
  const maint = readFileSync(new URL('../../src/client/painel/limpeza/view-manutencao.ts', import.meta.url), 'utf8');
  for (const action of ['catalog-list', 'catalog-scan', 'manual-delete']) {
    assert.match(view, new RegExp(`'${action}'`), action + ' preservado na navegação');
  }
  for (const action of ['cleanup-preview', 'cleanup-apply', 'audit-requeue', 'audit-backfill', 'warm-pause', 'warm-resume', 'warm-drain']) {
    assert.match(maint, new RegExp(`'${action}'`), action + ' preservado na manutenção');
  }
});

import { nextCatalogListState } from '../src/client/painel/limpeza/catalogo-model.js';

test('nextCatalogListState preserva a ultima lista boa e nao trava em carregando', () => {
  const semLista = nextCatalogListState(null, { ok: false, error: '429' });
  assert.equal(semLista.ok, false);
  assert.equal(semLista.reason, '429');
  assert.equal(semLista.retry, true, 'sem lista previa a falha vira erro com retry');

  const boa = { ok: true, rows: [{ serviceId: 'a' }], total: 1 };
  assert.equal(nextCatalogListState(boa, { ok: false, error: 'timeout' }), boa, 'refresh que falhou nao apaga a lista boa');

  const erroAnterior = { ok: false, reason: 'sem-adapter' };
  const depois = nextCatalogListState(erroAnterior, { ok: false, error: 'boom' });
  assert.equal(depois.ok, false);
  assert.equal(depois.retry, true, 'erro anterior nao e lista boa');

  assert.deepEqual(nextCatalogListState(boa, { ok: true, data: { ok: true, rows: [] } }), { ok: true, rows: [] });
  assert.equal(nextCatalogListState(boa, { ok: true }).reason, 'resposta vazia do servidor');
});

test('a manutencao da limpeza invalida a previa ao mudar o maximo (contrato de fonte)', () => {
  const src = readFileSync(new URL('../../src/client/painel/limpeza/view-manutencao.ts', import.meta.url), 'utf8');
  const at = src.search(/label="M[^"]*ximo por rodada"/);
  assert.ok(at >= 0, 'campo maximo por rodada encontrado');
  // Isola o PROPRIO campo (label -> fim do elemento `/>`): olhar uma janela
  // larga pescava o `setCleanup(null)` do ToggleField logo abaixo e o teste
  // passava vazio.
  const fim = src.indexOf('/>', at);
  assert.ok(fim > at, 'fim do campo maximo');
  const campo = src.slice(at, fim + 2);
  assert.match(campo, /onChange=/, 'o campo maximo tem onChange');
  assert.match(campo, /setMax/, 'o campo atualiza o estado do maximo');
  assert.match(campo, /setCleanup\(null\)/, 'mudar o maximo invalida a previa (o plano mostrado nao pode divergir do aplicado)');
});