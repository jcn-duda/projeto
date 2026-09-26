// Modelo puro do diagnostico: normalizacao de indexers, higiene de texto de
// terceiro e tabelas de conta/trace. Sem DOM, sem rede.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scrubDiagnosticText,
  indexerTestRows,
  indexerTestSummary,
  debridAccountRows,
  accountTable,
  accountTestRows,
  traceStageRows,
  traceItemRows,
  recomputeItemRows,
  liveResultRows,
  traceSummaryRows,
} from '../src/client/painel/diagnostico-model.js';

function rowMap(rows: { key: string; value: string; status: string }[]): Record<string, { value: string; status: string }> {
  return Object.fromEntries(rows.map((r) => [r.key, { value: r.value, status: r.status }]));
}

test('scrubDiagnosticText remove magnet, hash e credencial de URL', () => {
  assert.equal(
    scrubDiagnosticText('magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567'),
    '<magnet>',
  );
  assert.equal(
    scrubDiagnosticText('erro hash 0123456789abcdef0123456789abcdef01234567 pronto'),
    'erro hash <hash> pronto',
  );
  assert.equal(
    scrubDiagnosticText('https://jackett/api?apikey=SEGREDO123&q=matrix'),
    'https://jackett/api?apikey=<redacted>&q=matrix',
  );
  assert.equal(scrubDiagnosticText('falha &token=abc123 fim'), 'falha &token=<redacted> fim');
  assert.equal(scrubDiagnosticText(null), '');
  assert.equal(scrubDiagnosticText(undefined), '');
  assert.equal(scrubDiagnosticText(0), '0');

  const long = scrubDiagnosticText('z'.repeat(200));
  assert.equal(long.length, 160, 'teto curto do payload');
  assert.ok(long.endsWith('\u2026'), 'truncado com reticencias');
});

test('indexerTestRows normaliza e ordena falhas primeiro', () => {
  const rows = indexerTestRows({
    results: [
      { id: 'zeta', ok: true, withMagnet: 3 },
      { id: 'alpha', ok: false, error: 'timeout' },
      { id: 'mike', ok: false },
      { indexer: 'beta', ok: false, error: 'HTTP 500 magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567' },
      { id: 'yankee', ok: true, ms: 500, budgetMs: 200 },
      null,
      {},
      'texto',
    ],
  });
  assert.deepEqual(rows.map((r) => r.id), ['alpha', 'beta', 'mike', 'yankee', 'zeta']);
  assert.deepEqual(rows.map((r) => r.state), ['error', 'error', 'empty', 'ok', 'ok']);

  const beta = rows[1];
  assert.equal(beta.hasError, true);
  assert.equal(beta.error, 'HTTP 500 <magnet>', 'o error passa pela higiene');
  assert.equal(beta.overBudget, null, 'sem ms/budget nao inventa overBudget');

  const yankee = rows[3];
  assert.equal(yankee.overBudget, true, 'ms > budget infere overBudget');
  assert.equal(yankee.withMagnet, null);

  const mike = rows[2];
  assert.equal(mike.hasError, false);
  assert.equal(mike.error, null);

  // Array cru (sem envelope results) tambem e aceito.
  assert.equal(indexerTestRows([{ id: 'x', ok: true }]).length, 1);
  assert.deepEqual(indexerTestRows({}), []);
});

test('indexerTestSummary conta a partir das linhas normalizadas', () => {
  const rows = indexerTestRows([
    { id: 'a', ok: true, withMagnet: 2 },
    { id: 'b', ok: true, ms: 900, budgetMs: 100 },
    { id: 'c', ok: false, error: 'boom' },
    { id: 'd', ok: false },
    { id: 'e', ok: true, ms: 50 },
  ]);
  const s = indexerTestSummary(rows);
  assert.equal(s.total, 5);
  assert.equal(s.okCount, 3);
  assert.equal(s.downCount, 2);
  assert.equal(s.errorCount, 1);
  assert.equal(s.emptyCount, 1);
  assert.equal(s.overBudgetCount, 1);
  assert.equal(s.slowestId, 'b');

  assert.deepEqual(indexerTestSummary(null), {
    total: 0, okCount: 0, downCount: 0, errorCount: 0, emptyCount: 0, overBudgetCount: 0, slowestId: null,
  });
});

test('debridAccountRows nao exibe o error textual nem a credencial', () => {
  const ok = debridAccountRows({
    ok: true, label: 'AllDebrid', magnets: 933, ready: 895, active: 35, error: 3,
    limitUsed: 0.85, premiumUntil: 1700000000000, oldestAt: 1690000000000,
    cached: true, fetchedAt: 1700000000000,
  });
  const okMap = rowMap(ok);
  assert.equal(okMap.service.value, 'AllDebrid');
  assert.equal(okMap.state.value, 'Conectado');
  assert.equal(okMap.state.status, 'ok');
  assert.equal(okMap.magnets.value, '933');
  assert.equal(okMap.error.value, '3', 'error numerico entra como contagem');
  assert.equal(okMap.error.status, 'warn');
  assert.equal(okMap.limitUsed.value, '85%');
  assert.equal(okMap.limitUsed.status, 'warn');
  assert.equal(okMap.premiumUntil.value, new Date(1700000000000).toISOString());
  assert.equal(okMap.cached.value, 'memo');

  const fail = debridAccountRows({
    ok: false, service: 'alldebrid',
    error: 'AUTH_BAD_APIKEY',
    reason: 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567',
    fix: 'renove em ?apikey=SEGREDO123',
  });
  const failMap = rowMap(fail);
  assert.equal(failMap.state.status, 'err');
  assert.equal('error' in failMap, false, 'error textual de terceiro nao vira linha');
  assert.equal(failMap.reason.value, '<magnet>');
  assert.equal(failMap.reason.status, 'warn');
  assert.equal(failMap.fix.value, 'renove em ?apikey=<redacted>');
  assert.ok(fail.every((r) => !r.value.includes('SEGREDO123')));
  assert.ok(fail.every((r) => !r.value.includes('0123456789abcdef0123456789abcdef01234567')));
});

test('accountTable ordena falha primeiro e aceita conta solta', () => {
  const table = accountTable({
    accounts: {
      b: { ok: true, service: 'premiumize' },
      a: { ok: false, service: 'alldebrid' },
    },
  });
  assert.deepEqual(table.map((t) => t.id), ['a', 'b']);
  assert.equal(table[0].ok, false);
  assert.equal(table[1].ok, true);
  assert.equal(table[0].label, 'alldebrid');
  assert.ok(table[0].rows.length >= 2, 'a conta carrega as linhas do debridAccountRows');

  const single = accountTable({ account: { ok: true, service: 'torbox', label: 'TorBox' } });
  assert.equal(single.length, 1);
  assert.equal(single[0].id, 'torbox');
  assert.equal(single[0].label, 'TorBox');

  const direct = accountTable({ ok: false, service: 'realdebrid' });
  assert.equal(direct.length, 1);
  assert.equal(direct[0].id, 'realdebrid');

  assert.deepEqual(accountTable(null), []);
});

test('accountTestRows nunca le a chave crua', () => {
  const rows = accountTestRows({
    ok: true, service: 'alldebrid', label: 'AllDebrid',
    apiKey: 'SUPER-SECRET-KEY', key: 'SUPER-SECRET-KEY',
    last4: '4F2A', fingerprint: '0123456789abcdef',
    capabilities: { cacheCheck: true, inventory: false, weird: 'x' },
  });
  const map = rowMap(rows);
  assert.equal(map.result.value, 'Chave validada');
  assert.equal(map.result.status, 'ok');
  assert.equal(map.last4.value, '\u20264F2A');
  assert.equal(map.fingerprint.value, '01234567', 'fingerprint truncado a 8 chars');
  assert.equal(map['cap:cacheCheck'].value, 'sim');
  assert.equal(map['cap:cacheCheck'].status, 'ok');
  assert.equal(map['cap:inventory'].status, 'neutral');
  assert.notEqual(map['cap:inventory'].value, 'sim');
  assert.equal('cap:weird' in map, false, 'capability nao-booleana e ignorada');
  assert.ok(rows.every((r) => !r.value.includes('SUPER-SECRET-KEY')));
});

test('traceStageRows le os estagios e zera contagem invalida', () => {
  assert.deepEqual(traceStageRows(null), []);
  assert.deepEqual(traceStageRows({}), []);
  const rows = traceStageRows({ trace: { stages: { raw: 10, filtered: 7, debrid: null } } });
  assert.deepEqual(rows.map((r) => r.stage), ['raw', 'filtered', 'debrid']);
  assert.deepEqual(rows.map((r) => r.count), [10, 7, 0]);
});

test('traceItemRows e recomputeItemRows normalizam itens e descartam sem rotulo', () => {
  const items = traceItemRows({
    trace: {
      items: [
        { id: 'a', label: 'Filme X', br: true, dubbed: true, quality: '1080p', indexer: 'bludv', seeders: '12', reason: 'quality' },
        { label: '' },
        { label: null },
      ],
    },
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'a');
  assert.equal(items[0].br, true);
  assert.equal(items[0].dubbed, true);
  assert.equal(items[0].seeders, 12);
  assert.equal(items[0].indexer, 'bludv');
  assert.equal(items[0].reason, 'quality');
  assert.equal(items[0].label, 'Filme X');

  const recompute = recomputeItemRows({ recompute: { items: [{ id: 'r', label: 'Item R', now: 'presente' }] } });
  assert.equal(recompute.length, 1);
  assert.equal(recompute[0].now, 'presente');
  assert.equal(recompute[0].reason, null, 'recompute traz now, nao reason');
  assert.deepEqual(traceItemRows({}), []);
});

test('liveResultRows aplica allowlist do veredito e higiene do nome', () => {
  const rows = liveResultRows({
    live: {
      results: [
        { id: '1', name: 'Filme', verdict: 'hit' },
        { name: 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567', verdict: 'nope' },
      ],
    },
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].verdict, 'hit');
  assert.equal(rows[0].label, 'Filme');
  assert.equal(rows[1].verdict, 'unknown', 'veredito fora da allowlist vira unknown');
  assert.equal(rows[1].id, 'item');
  assert.equal(rows[1].label, '<magnet>');
  assert.deepEqual(liveResultRows({}), []);
});

test('traceSummaryRows monta cache/trace/live deterministico', () => {
  const rows = traceSummaryRows({
    found: true,
    origin: 'PUBLIC_URL',
    cache: { partial: false, debridKnown: true, stale: false, remainingS: 42.9 },
    trace: { startedAt: 1700000000000, finishedAt: 1700000005000, chupim: 'pool=br; seeds=allowed; probe=found' },
    live: { allowed: false, reason: 'ad-hard-blocked' },
  });
  const map = rowMap(rows);
  assert.equal(map.found.value, 'sim');
  assert.equal(map.found.status, 'ok');
  assert.equal(map.origin.value, 'PUBLIC_URL');
  assert.equal(map.partial.status, 'ok');
  assert.equal(map.debridKnown.status, 'ok');
  assert.equal(map.stale.status, 'neutral');
  assert.equal(map.remainingS.value, '42s');
  assert.equal(map.startedAt.value, new Date(1700000000000).toISOString());
  assert.equal(map.finishedAt.value, new Date(1700000005000).toISOString());
  assert.equal(map.chupim.value, 'pool=br; seeds=allowed; probe=found');
  assert.equal(map.liveAllowed.value, 'recusada');
  assert.equal(map.liveAllowed.status, 'warn');
  assert.equal(map.liveReason.value, 'ad-hard-blocked');
});
test('recomputeItemRows normaliza now objeto (shape real) para a string de estado', () => {
  const rows = recomputeItemRows({
    recompute: { items: [{ id: 'r', label: 'Item R', now: { state: 'not-cached' } }] },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].now, 'not-cached', 'now:{state} vira a string do estado');
  assert.doesNotMatch(String(rows[0].now), /\[object Object\]/);
  assert.equal(rows[0].reason, null, 'recompute traz now, nao reason');
});