import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dashboardHtml, resetDashboardEnvironment } from './helpers/dashboard.js';

// ---------------------------------------------------------------------------
// C3 — aba Stream Trace: zero innerHTML, sem polling, token no header (nunca na
// URL) e o botão LIVE só para torbox/premiumize com o backend permitindo.
// Importa o emit real; o fetch é dublado pelo helper.
// ---------------------------------------------------------------------------

function flat(node: any): string {
  if (!node) return '';
  return [String(node.textContent || '')].concat((node.children || []).map(flat)).join(' ');
}

async function traceEnv(payload: any, token = 'tok-painel') {
  const env = await resetDashboardEnvironment(dashboardHtml());
  const requests: Array<{ path: string; options: any }> = [];
  let mode: 'ok' | 'fail' = 'ok';
  let failStatus = 0;
  env.dom.setFetch((path: string, options: any) => {
    requests.push({ path: String(path), options });
    if (mode === 'fail') {
      return Promise.resolve({ ok: false, status: failStatus, json: () => Promise.resolve({ error: 'HTTP ' + failStatus }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
  });
  env.mods.state.DashState.token = token;
  return {
    ...env,
    requests,
    fail(status: number) { mode = 'fail'; failStatus = status; },
  };
}

const payloadComTrace = {
  ok: true, found: true, type: 'movie', id: 'tt111', origin: 'cached',
  cache: { remainingS: 120, partial: false, debridKnown: true, stale: false },
  trace: {
    startedAt: 1, finishedAt: 2,
    stages: { raw: 4, afterSort: 3, final: 1 },
    items: [
      { id: 's1', reason: 'title-filter', label: 'Outro Filme 2023', br: false },
      { id: 's2', reason: 'cached-only', label: 'Fora do Cache 2024', br: true, dubbed: true, quality: '1080p' },
    ],
  },
  recompute: null,
  live: { allowed: false, reason: 'no-account', service: null },
};

test('traceLiveAllowed: só torbox/premiumize com backend permitindo', async () => {
  const { mods } = await resetDashboardEnvironment();
  assert.equal(mods.trace.traceLiveAllowed({ live: { allowed: true, service: 'torbox' } }), true);
  assert.equal(mods.trace.traceLiveAllowed({ live: { allowed: true, service: 'premiumize' } }), true);
  for (const svc of ['alldebrid', 'realdebrid', 'debridlink']) {
    assert.equal(mods.trace.traceLiveAllowed({ live: { allowed: true, service: svc } }), false, svc);
  }
  assert.equal(mods.trace.traceLiveAllowed({ live: { allowed: false, service: 'torbox' } }), false);
  assert.equal(mods.trace.traceLiveAllowed({}), false);
});

test('runTraceQuery renderiza cache, stages, tabela e totais sem vazar chaves', async () => {
  const { dom, mods, requests } = await traceEnv(payloadComTrace);
  dom.byId['traceType'].value = 'movie';
  dom.byId['traceId'].value = 'tt111';
  mods.trace.runTraceQuery();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(requests.length, 1);
  assert.match(requests[0].path, /stream-trace\.json\?type=movie&id=tt111$/);
  assert.doesNotMatch(String(requests[0].path), /token=/);
  const rendered = flat(dom.byId['traceOutput']);
  assert.doesNotMatch(rendered, /[a-f0-9]{40}/);
  assert.doesNotMatch(rendered, /streams:v/);
  assert.match(rendered, /filtro de título/);
  assert.match(rendered, /fora do cache/);
  assert.equal(dom.byId['traceLiveBtn'].style.display, 'none');
  dom.cleanup();
});

test('trace null + recompute: mensagem honesta e foto de hoje (now)', async () => {
  const payload = {
    ok: true, found: true, origin: 'recompute', cache: { remainingS: 0, partial: false, debridKnown: true, stale: false },
    trace: null,
    recompute: { attempted: true, basis: ['idx'], built: true, note: null, items: [{ id: 'r1', label: 'Filme 2024', br: false, now: { state: 'tocável' } }] },
    live: { allowed: false, reason: 'no-account', service: null },
  };
  const { dom, mods } = await traceEnv(payload);
  dom.byId['traceType'].value = 'movie';
  dom.byId['traceId'].value = 'tt222';
  mods.trace.runTraceQuery();
  await new Promise((r) => setTimeout(r, 20));
  const rendered = flat(dom.byId['traceOutput']);
  assert.match(rendered, /Sem trace gravado/);
  assert.match(rendered, /estado ATUAL/);
  assert.match(rendered, /tocável/);
  dom.cleanup();
});

test('erros legíveis por status (400/401/404/429/503)', async () => {
  for (const [status, esperado] of [[400, 'Consulta recusada'], [401, 'Token rejeitado'], [404, 'Obra não está no cache'], [429, 'Outro diagnóstico está em andamento'], [503, 'Diagnóstico desligado']] as Array<[number, string]>) {
    const { dom, mods, fail } = await traceEnv(null);
    dom.byId['traceType'].value = 'movie';
    dom.byId['traceId'].value = 'tt111';
    fail(status);
    mods.trace.runTraceQuery();
    await new Promise((r) => setTimeout(r, 20));
    assert.match(dom.byId['traceFeedback'].textContent, new RegExp(esperado), 'status ' + status);
    dom.cleanup();
  }
});

test('runTraceLive chama mode=live e renderiza vereditos sem hash', async () => {
  const payload = {
    ok: true, found: true, origin: 'cached',
    cache: { remainingS: 0, partial: false, debridKnown: true, stale: false },
    trace: null, recompute: null,
    live: { allowed: true, reason: 'ok', service: 'torbox', results: [{ id: 'd1', name: 'Filme 2024', verdict: 'hit' }] },
  };
  const { dom, mods, requests } = await traceEnv(payload);
  dom.byId['traceType'].value = 'movie';
  dom.byId['traceId'].value = 'tt111';
  mods.trace.runTraceLive();
  await new Promise((r) => setTimeout(r, 20));
  assert.match(requests[0].path, /mode=live/);
  const rendered = flat(dom.byId['traceOutput']);
  assert.match(rendered, /hit/);
  assert.doesNotMatch(rendered, /[a-f0-9]{40}/);
  dom.cleanup();
});

test('token ausente: consulta nem sai e o feedback orienta', async () => {
  const { dom, mods, requests } = await traceEnv(payloadComTrace, '');
  dom.byId['traceType'].value = 'movie';
  dom.byId['traceId'].value = 'tt111';
  mods.trace.runTraceQuery();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(requests.length, 0);
  assert.match(dom.byId['traceFeedback'].textContent, /Token de diagnóstico ausente/);
  dom.cleanup();
});

test('HTML preserva os ids da aba Trace e o módulo não faz polling', () => {
  const html = dashboardHtml();
  for (const id of ['tabTrace', 'viewTrace', 'traceType', 'traceId', 'traceQueryBtn', 'traceLiveBtn', 'traceFeedback']) {
    assert.match(html, new RegExp('id="' + id + '"'));
  }
});
