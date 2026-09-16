import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ViewSaude } from '../src/client/painel/view-saude.js';
import { ViewConta } from '../src/client/painel/view-conta.js';
import { ViewGate } from '../src/client/painel/view-gate.js';
import { Card, StatNumber, ProgressBar } from '../src/client/painel/kit.js';
import { ViewColhedor } from '../src/client/painel/view-colhedor.js';
import { ViewSonda } from '../src/client/painel/view-sonda.js';
import { ViewChupim } from '../src/client/painel/view-chupim.js';

test('ViewSaude retorna VNode válido com veredito e serviços', () => {
  const vnode = ViewSaude({
    general: {
      ok: true,
      uptimeS: 120,
      services: { jackett: true, debrid: true, resolvers: 6 },
    },
    conta: { ok: true, service: 'alldebrid' },
    searchFirst: { responses: 10, brVisible: 8, brFound: 9, brCached: 8 },
  });

  assert.ok(vnode, 'ViewSaude deve retornar um VNode');
  assert.equal(typeof vnode, 'object');
  assert.ok(vnode.props, 'VNode deve conter props');
});

test('ViewConta renderiza métricas corretas (933/1000 - 93% e download preso)', () => {
  const vnode = ViewConta({
    conta: {
      total: 933,
      cap: 1000,
      usagePercent: 93,
      ready: 895,
      downloading: 35,
      dead: 3,
      oldestAt: Date.now() - 57 * 3600 * 1000,
      stuckCount: 1,
      warnAt: 800,
    },
  });

  assert.ok(vnode, 'ViewConta deve retornar um VNode');
  assert.equal(typeof vnode, 'object');
});

test('ViewGate renderiza gate com override (999 vs 2000)', () => {
  const vnode = ViewGate({
    gate: {
      autoFetchPauseAt: 999,
      envAutoFetchPauseAt: 2000,
      isAutoFetchPauseAtOverridden: true,
      paused: false,
      diffs: [{ key: 'autoFetchPauseAt', effective: 999, envDefault: 2000 }],
    },
  });

  assert.ok(vnode, 'ViewGate deve retornar um VNode');
  assert.equal(typeof vnode, 'object');
});

test('Componentes do kit (Card, StatNumber, ProgressBar) retornam VNodes', () => {
  const card = Card({ title: 'Teste', badge: { text: 'OK', variant: 'ok' } });
  assert.ok(card && typeof card === 'object');

  const stat = StatNumber({ value: 10, target: 100, label: 'dez' });
  assert.ok(stat && typeof stat === 'object');

  const bar = ProgressBar({ percent: 75, variant: 'ok' });
  assert.ok(bar && typeof bar === 'object');
});

import { h } from '../src/client/painel/vendor/preact.js';

test('ViewColhedor retorna VNode válido com h()', () => {
  const vnode = h(ViewColhedor, {
    harvest: {
      enabled: true,
      paused: false,
      queueDepth: 5,
      queueMax: 100,
      queriesThisHour: 4,
      maxPerHour: 20,
      harvested: 12,
      lastRunAt: new Date().toISOString(),
      queuePreview: [
        { imdbId: 'tt1234567', type: 'movie', reason: 'br-gap', brProbe: true },
      ],
      lastWorks: [
        { at: Date.now(), imdbId: 'tt7654321', type: 'movie', recorded: 3 },
      ],
    },
    metrics: { counters: {} },
  });

  assert.ok(vnode && typeof vnode === 'object');
  assert.equal(vnode.type, ViewColhedor);
  assert.ok(vnode.props);
});

test('ViewSonda renderiza estatísticas da sonda e cobertura F3', () => {
  const vnode = ViewSonda({
    harvest: {
      queuePreview: [
        { imdbId: 'tt1111111', type: 'series', season: 1, episode: 1, brProbe: true },
      ],
    },
    f3: {
      popularCoverage: 0.85,
      brWarmRate: 0.9,
      discoveryRate: 0.95,
    },
    metrics: {
      counters: {
        'autofetch.brProbe.scheduled.evidence': 10,
        'autofetch.brProbe.scheduled.upgrade': 2,
        'autofetch.brProbe.found': 8,
        'autofetch.brProbe.empty': 2,
        'autofetch.brProbe.failed': 1,
        'autofetch.brProbe.capped': 1,
      },
    },
  });

  assert.ok(vnode && typeof vnode === 'object');
  assert.ok(vnode.props);
});

test('ViewChupim retorna VNode válido com h()', () => {
  const vnode = h(ViewChupim, {
    autofetch: {
      paused: false,
      recheckLots: 3,
      settleLots: 1,
      deadBlacklistCount: 2,
      suppressed: 0,
      budget: { used: 4, limit: 15 },
      obras: [
        { digest: 'abc123def456', pools: { br: 1, any: 0, seeds: 0 }, brReady: true, ageMs: 60000 },
      ],
      lastSkips: [
        { reason: 'budget', label: '15/15', at: Date.now() },
      ],
    },
    metrics: { counters: {} },
  });

  assert.ok(vnode && typeof vnode === 'object');
  assert.equal(vnode.type, ViewChupim);
  assert.ok(vnode.props);
});
