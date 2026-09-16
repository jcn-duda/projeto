import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDashboardEnvironment } from './helpers/dashboard.js';

// ---------------------------------------------------------------------------
// C3 — runtime dos painéis extraídos (MagnetDB em magnets.ts; Chupim em
// autofetch.ts), importando o emit Node real e exercitando o Fake DOM do
// helper. Sem `new Function`, sem escopo global compartilhado.
// ---------------------------------------------------------------------------

function flat(node: any): string {
  if (!node) return '';
  return [String(node.textContent || '')].concat((node.children || []).map(flat)).join(' ');
}

async function magnetEnv() {
  return resetDashboardEnvironment();
}

test('renderMagnetDb: L1 mag, agregados duráveis e bad≠dead no DOM real', async () => {
  const { dom, mods } = await magnetEnv();
  mods.magnets.renderMagnetDb(
    {
      enabled: true,
      l1Entries: 1200,
      l1Max: 50000,
      sizeAlive: 10,
      sizeBad: 2,
      sizeLie: 1,
      evictedQuota: 0,
      aliveTtlSeconds: 604800,
      badTtlSeconds: 86400,
      lieTtlSeconds: 604800,
      counters: { droppedBad: 3, droppedDead: 5, droppedLie: 1 },
      byAdapter: { alldebrid: { sizeAlive: 8, sizeBad: 1, sizeLie: 0 } },
    },
    { 'debrid.check.hashes': 100, 'debrid.check.cached': 40 },
  );
  const text = flat(dom.byId['magnetMetrics']);
  assert.match(text, /L1 mag/i);
  assert.match(text, /1200\s*\/\s*50000/);
  assert.match(text, /registros classificados/i);
  assert.match(text, /play sem vídeo/i);
  assert.match(text, /descartados dead/i);
  assert.match(text, /autofetch ≠ bad/);
  assert.match(text, /40%/);
  dom.cleanup();
});

test('renderMagnetDb separa ocupação L1 dos agregados persistentes', async () => {
  const { dom, mods } = await magnetEnv();
  mods.magnets.renderMagnetDb(
    {
      enabled: true, l1Entries: 405, l1Max: 50000, sizeAlive: 73, sizeBad: 0, sizeLie: 1, evictedQuota: 2,
      aliveTtlSeconds: 604800, badTtlSeconds: 86400, lieTtlSeconds: 604800,
      ttlRemainingSeconds: { alive: 432000, bad: null, lie: 100000 },
      counters: { aliveSet: 180, badSet: 4, lieSet: 1, droppedBad: 3, droppedDead: 5, droppedLie: 1, badClearedBlocked: 2 },
      byAdapter: { alldebrid: { sizeAlive: 73, sizeBad: 0, sizeLie: 1, ttlRemainingSeconds: { alive: 432000, bad: null, lie: 100000 } } },
    },
    { 'debrid.check.hashes': 200, 'debrid.check.cached': 50 },
  );
  const text = flat(dom.byId['magnetMetrics']);
  assert.match(text, /Registros persistentes no banco/i);
  assert.match(text, /405\s*\/\s*50000/);
  assert.match(text, /Agregados persistentes por estado e serviço/i);
  assert.match(text, /registros classificados \(≠ L1\)/);
  assert.match(text, /agregados sobrevivem ao restart pelo mag_meta/i);
  assert.match(text, /o mesmo hash pode figurar mais de uma vez/i);
  assert.match(text, /expirados ou órfãos/i);
  assert.match(text, /gravações alive \(inclui renovações\)/i);
  assert.match(text, /25% \(50\/200\)/);
  dom.cleanup();
});

test('renderMagnetSummaryMetrics usa container próprio e sobrevive ao poll do renderMagnetDb', async () => {
  const { dom, mods } = await magnetEnv();
  mods.magnets.renderMagnetSummaryMetrics({
    ok: true, entries: 74, totals: { alive: 73, bad: 0, lie: 1 },
    byAdapter: { alldebrid: { alive: 73, bad: 0, lie: 1 } },
  });
  const summary = flat(dom.byId['magnetSummaryMetrics']);
  assert.match(summary, /Totais consolidados do MagnetDB/i);
  assert.match(summary, /74/);
  assert.match(summary, /serviço alldebrid/i);
  mods.magnets.renderMagnetDb({ enabled: true, l1Entries: 405, l1Max: 50000, sizeAlive: 73, sizeBad: 0, sizeLie: 1, counters: {}, byAdapter: {} }, {});
  assert.match(flat(dom.byId['magnetSummaryMetrics']), /Totais consolidados do MagnetDB/i, 'resumo não é apagado pelo poll');
  assert.match(flat(dom.byId['magnetMetrics']), /L1 mag/i, 'poll pinta o container próprio');
  dom.cleanup();
});

test('renderAutofetchPanel: paused pinta PAUSADO; suppressed com origem e fail-open', async () => {
  const { dom, mods } = await magnetEnv();
  mods.hooks.hooks.register('renderAutofetchStall', () => {});
  mods.autofetch.renderAutofetchPanel({ config: { paused: true, effective: {}, envDefaults: {}, overriddenKeys: [] } });
  assert.equal(dom.byId['afMetricState'].textContent, 'PAUSADO');

  mods.autofetch.renderAutofetchPanel({
    config: { effective: {}, envDefaults: {}, overriddenKeys: [] },
    suppressed: 7,
    _origem: { suppressed: 'duravel' },
  }, 4000);
  assert.equal(dom.byId['afMetricSuppressed'].textContent, '7');
  assert.match(dom.byId['afMetricSuppressed'].title, /Persistente|durável/i);

  mods.autofetch.renderAutofetchPanel({ config: { effective: {}, envDefaults: {}, overriddenKeys: [] }, suppressed: 3 }, 4000);
  assert.equal(dom.byId['afMetricSuppressed'].textContent, '3', 'fail-open mantém o número');
  assert.equal(dom.byId['afMetricSuppressed'].title, '');

  mods.autofetch.renderAutofetchPanel({ config: { effective: {}, envDefaults: {}, overriddenKeys: [] } }, 4000);
  assert.equal(dom.byId['afMetricSuppressed'].textContent, '0');
  dom.cleanup();
});

test('AF_KEYS cobre os knobs raros que o HTML expõe', async () => {
  const { mods } = await magnetEnv();
  for (const key of ['autoFetchRareMax', 'autoFetchRareThreshold', 'autoFetchRareMaxSeeders']) {
    assert.ok(mods.autofetch.AF_KEYS.includes(key), 'AF_KEYS lista ' + key);
  }
});

test('renderAutofetchPanel: bloco de obras (F2) compacto e fail-open sem o campo', async () => {
  const { dom, mods } = await magnetEnv();
  mods.hooks.hooks.register('renderAutofetchStall', () => {});
  mods.autofetch.renderAutofetchPanel({
    config: { effective: {}, envDefaults: {}, overriddenKeys: [] },
    obras: [
      { digest: 'abcdef012345', pools: { br: 2, any: 1, seeds: 0, other: 0 }, brReady: true, ageMs: 60000 },
      { digest: '001122334455', pools: { br: 0, any: 0, seeds: 3, other: 0 }, brReady: false, ageMs: 120000 },
    ],
  }, 4000);
  assert.equal(dom.byId['afMetricObras'].textContent, '2 obra(s)');
  const text = flat(dom.byId['afObrasMetrics']);
  assert.match(text, /abcdef012345/);
  assert.match(text, /001122334455/);
  assert.match(text, /sim/, 'prova BR-ready pintada');
  assert.match(text, /1 min/, 'idade formatada');

  // Sem o campo: contador zerado e aviso honesto (payload de versão anterior).
  mods.autofetch.renderAutofetchPanel({ config: { effective: {}, envDefaults: {}, overriddenKeys: [] } }, 4000);
  assert.equal(dom.byId['afMetricObras'].textContent, '0 obra(s)');
  assert.match(flat(dom.byId['afObrasMetrics']), /Sem obras ativas/i);
  dom.cleanup();
});
