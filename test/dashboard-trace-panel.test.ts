// P5 Fatia C — painel Stream Trace no dashboard: ES5, zero innerHTML, sem
// polling, sem token na URL, e o botão LIVE só aparece para torbox/premiumize
// com o backend permitindo (nunca RD/AD/DL, mesmo se o backend mentir).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const TOKEN = 'tok-painel';
const HASH = 'f'.repeat(40);

type FakeNode = {
  value: string; textContent: string; className: string; type: string; disabled: boolean;
  style: Record<string, string>; children: FakeNode[]; attributes: Record<string, string>;
  appendChild: (n: FakeNode) => FakeNode; setAttribute: (k: string, v: string) => void; focus: () => void;
};

function node(text = ''): FakeNode {
  return {
    value: '', textContent: text, className: '', type: '', disabled: false, style: {}, children: [], attributes: {},
    appendChild(n) { this.children.push(n); return n; },
    setAttribute(k, v) { this.attributes[k] = String(v); },
    focus() {},
  };
}

function loadFrontend(payload: any, token = TOKEN, failStatus: number | null = null) {
  const js = readFileSync(new URL('../src/public/dashboard-trace.js', import.meta.url), 'utf8');
  const els: Record<string, FakeNode> = {};
  const requests: Array<{ path: string; options: any }> = [];
  const document = { createElement: () => node() };
  const prelude = [
    `var currentToken=${JSON.stringify(token)};`,
    'function $(id){return els[id]||(els[id]=node());}',
    'function isObject(v){return !!v&&typeof v==="object"&&!Array.isArray(v);}',
    'function valueText(v){return v===undefined||v===null||v===""?"—":String(v);}',
    'function metric(n,k,v){n.appendChild(node(k+": "+v));}',
    'function element(tag,cls,text){var n=node(text||"");n.className=cls||"";return n;}',
    'function clear(n){n.textContent="";n.children=[];}',
    'function empty(n,text){n.textContent=text;}',
    'function requestJson(path,options){requests.push({path:path,options:options});if(' + failStatus + '){var e=new Error("HTTP '+failStatus+'");e.status=' + failStatus + ';return Promise.reject(e);}return Promise.resolve(payload);}',
  ].join('\n');
  const factory = new Function('els', 'node', 'document', 'requests', 'payload', prelude + '\n' + js + '\nreturn {runQuery:runTraceQuery,runLive:runTraceLive,toggle:toggleTraceLive,allowed:traceLiveAllowed};') as any;
  return { api: factory(els, node, document, requests, payload), els, requests };
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

test('HTML: aba, view, inputs e script depois do debrid-test; ES5 no documento', () => {
  const html = readFileSync(new URL('../src/public/dashboard.html', import.meta.url), 'utf8');
  assert.match(html, /id="tabTrace"/);
  assert.match(html, /id="viewTrace"/);
  assert.match(html, /id="traceType"/);
  assert.match(html, /id="traceId"/);
  assert.match(html, /id="traceQueryBtn"/);
  assert.match(html, /id="traceLiveBtn"/);
  assert.match(html, /id="traceFeedback"/);
  const core = html.indexOf('dashboard-core.js');
  const panels = html.indexOf('dashboard-panels.js');
  const debridTest = html.indexOf('dashboard-debrid-test.js');
  const trace = html.indexOf('dashboard-trace.js');
  assert.ok(core < panels && panels < debridTest && debridTest < trace, 'ordem de scripts é contrato');
  assert.doesNotMatch(html, /\b(?:const|let)\b|=>|\?\.|\?\?/, 'HTML inteiro segue ES5');
});

test('módulo: ES5 puro, sem innerHTML, sem polling, sem loadStatus', () => {
  const js = readFileSync(new URL('../src/public/dashboard-trace.js', import.meta.url), 'utf8');
  assert.doesNotMatch(js, /\b(?:const|let)\b|=>|\?\.|\?\?/, 'módulo ES5');
  assert.doesNotMatch(js, /innerHTML/, 'render nunca usa innerHTML');
  assert.doesNotMatch(js, /setInterval|setTimeout/, 'sem polling automático');
  assert.doesNotMatch(js, /loadStatus|scheduleRefresh/, 'desacoplado do polling da Geral');
  assert.doesNotMatch(js, /localStorage/, 'token é responsabilidade do core');
});

test('traceLiveAllowed: só torbox/premiumize com backend permitindo', () => {
  const { api } = loadFrontend(null);
  assert.equal(api.allowed({ live: { allowed: true, service: 'torbox' } }), true);
  assert.equal(api.allowed({ live: { allowed: true, service: 'premiumize' } }), true);
  assert.equal(api.allowed({ live: { allowed: true, service: 'alldebrid' } }), false);
  assert.equal(api.allowed({ live: { allowed: true, service: 'realdebrid' } }), false);
  assert.equal(api.allowed({ live: { allowed: true, service: 'debridlink' } }), false);
  assert.equal(api.allowed({ live: { allowed: false, service: 'torbox' } }), false);
  assert.equal(api.allowed({}), false, 'sem campo live (backend antigo) o botão nunca aparece');
});

test('runTraceQuery: cache, stages, tabela e totais renderizados; nenhuma chave vaza', async () => {
  const { api, els, requests } = loadFrontend(payloadComTrace);
  els.traceType = node(); els.traceType.value = 'movie';
  els.traceId = node(); els.traceId.value = 'tt111';
  els.traceFeedback = node(); els.traceOutput = node(); els.traceReasons = node();
  els.traceCacheMetrics = node(); els.traceStages = node(); els.traceLiveBtn = node();
  const button = node();
  api.runQuery(button);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(requests.length, 1);
  assert.match(requests[0].path, /stream-trace\.json\?type=movie&id=tt111$/);
  assert.equal(button.disabled, false);
  const rendered = JSON.stringify(els);
  assert.doesNotMatch(rendered, /[a-f0-9]{40}/, 'nenhum hash no DOM');
  assert.doesNotMatch(rendered, /streams:v/, 'nenhuma chave de cache no DOM');
  assert.match(rendered, /filtro de título/);
  assert.match(rendered, /fora do cache/);
  assert.match(rendered, /entregue/);
  assert.equal(els.traceLiveBtn.style.display, 'none', 'sem live permitido o botão some');
});

test('trace null + recompute: mensagem honesta e foto de hoje (now)', async () => {
  const payload = {
    ok: true, found: true, origin: 'recompute', cache: { remainingS: 0, partial: false, debridKnown: true, stale: false },
    trace: null,
    recompute: {
      attempted: true, basis: ['idx'], built: true, note: null,
      items: [{ id: 'r1', label: 'Filme 2024', br: false, now: { state: 'tocável' } }],
    },
    live: { allowed: false, reason: 'no-account', service: null },
  };
  const { api, els, requests } = loadFrontend(payload);
  els.traceType = node(); els.traceType.value = 'movie';
  els.traceId = node(); els.traceId.value = 'tt222';
  els.traceFeedback = node(); els.traceOutput = node(); els.traceReasons = node();
  els.traceCacheMetrics = node(); els.traceStages = node(); els.traceLiveBtn = node();
  api.runQuery(node());
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(requests.length, 1);
  const rendered = JSON.stringify(els);
  assert.match(rendered, /Sem trace gravado/);
  assert.match(rendered, /estado ATUAL/);
  assert.match(rendered, /tocável/);
});

test('erros legíveis por status (400/401/404/429/503)', async () => {
  for (const [status, esperado] of [
    [400, 'Consulta recusada'],
    [401, 'Token rejeitado'],
    [404, 'Obra não está no cache'],
    [429, 'Outro diagnóstico está em andamento'],
    [503, 'Diagnóstico desligado'],
  ] as Array<[number, string]>) {
    const { api, els, requests } = loadFrontend(null, TOKEN, status);
    els.traceType = node(); els.traceType.value = 'movie';
    els.traceId = node(); els.traceId.value = 'tt111';
    els.traceFeedback = node(); els.traceOutput = node(); els.traceReasons = node();
    els.traceCacheMetrics = node(); els.traceStages = node(); els.traceLiveBtn = node();
    els.traceQueryBtn = node();
    api.runQuery(els.traceQueryBtn);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(requests.length, 1, `status ${status} fez a chamada`);
    assert.match(els.traceFeedback.textContent, new RegExp(esperado), `status ${status}`);
  }
});

test('runTraceLive: chama mode=live e renderiza vereditos sem hash', async () => {
  const payload = {
    ok: true, found: true, origin: 'cached',
    cache: { remainingS: 0, partial: false, debridKnown: true, stale: false },
    trace: null, recompute: null,
    live: {
      allowed: true, reason: 'ok', service: 'torbox',
      results: [{ id: 'd1', name: 'Filme 2024', verdict: 'hit' }],
    },
  };
  const { api, els, requests } = loadFrontend(payload);
  els.traceType = node(); els.traceType.value = 'movie';
  els.traceId = node(); els.traceId.value = 'tt111';
  els.traceFeedback = node(); els.traceOutput = node(); els.traceReasons = node();
  els.traceCacheMetrics = node(); els.traceStages = node(); els.traceLiveBtn = node();
  const button = node();
  api.runLive(button);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(requests.length, 1);
  assert.match(requests[0].path, /mode=live/);
  const rendered = JSON.stringify(els);
  assert.match(rendered, /hit/);
  assert.doesNotMatch(rendered, /[a-f0-9]{40}/, 'hash some do render');
  assert.equal(button.disabled, false);
});

test('token ausente: consulta nem sai (zero chamadas)', async () => {
  const { api, els, requests } = loadFrontend(payloadComTrace, '');
  els.traceType = node(); els.traceType.value = 'movie';
  els.traceId = node(); els.traceId.value = 'tt111';
  els.traceFeedback = node(); els.traceOutput = node(); els.traceReasons = node();
  els.traceCacheMetrics = node(); els.traceStages = node(); els.traceLiveBtn = node();
  api.runQuery(node());
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(requests.length, 0, 'sem token não há chamada');
  assert.match(els.traceFeedback.textContent, /Token de diagnóstico ausente/);
});
