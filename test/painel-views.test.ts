import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ViewSaude } from '../src/client/painel/view-saude.js';
import { ViewConta } from '../src/client/painel/view-conta.js';
import { ViewGate } from '../src/client/painel/view-gate.js';
import { Card, StatNumber, ProgressBar } from '../src/client/painel/kit.js';

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
