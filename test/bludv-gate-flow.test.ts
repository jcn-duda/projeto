/**
 * Cadeia completa do portão BLUDV (resolveGateMagnet / prefetchGateMagnet).
 *
 * Cobertura do contrato medido em outubro/2026:
 *   (a) cadeia completa com FlareSolverr + HTTP simulados → magnet
 *   (b) cada destino inseguro é recusado SEM tocar rede proibida
 *   (c) coalescing: duas chamadas simultâneas ao mesmo gate = 1 cadeia
 *   (d) cache só de sucesso; falha NUNCA entra no cache
 *   (e) prefetch é oportunista: cadeia em andamento → prefetch pulado
 *   (f) sessions.destroy roda no finally, inclusive sob erro
 *   (g) callback com gate_erro ou sem magnet vira erro, não resultado vazio
 *   (h) prazo/abort devolve erro estável e não deixa cadeia viva
 *
 * Zero rede real: stubFetch substitui global.fetch. Zero banco real:
 * setup-env.js aponta CACHE_PERSIST=false e magnets.db para tmpdir.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveGateMagnet, prefetchGateMagnet } from '../resolvers/profiles/bludv-gate-flow.js';
import { BludvAdGateError } from '../resolvers/profiles/bludv-gate.js';
import { stubFetch } from './helpers/stub.js';
import { siteUrl, postUrl, magnet, gateUrl, callbackHtml } from './helpers/bludv-gate-fixtures.js';

const SOLVER = 'http://127.0.0.1:8191';
const GATE_HOST = 'bludvfilmes1.xyz';
const CALLBACK_PATH = '/gate/callback';
const OPTS = { solverUrl: SOLVER, minWaitMs: 0, timeoutMs: 10_000 };

// IDs únicos por teste para não colidir com o cache de módulo (TTL 30 min).
let nextId = 200;
function freshGate(): string { return gateUrl(nextId++); }

// ── Dublês de Response (corpo legível via readBody do transport) ─────────
function flareOk(extra: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ status: 'ok', ...extra }), { status: 200 });
}
function htmlBody(text: string): Response {
  return new Response(text, { status: 200 });
}
function redirect302(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}
function jsonBody(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200 });
}

// ── Handler da cadeia feliz ──────────────────────────────────────────────
interface ChainParts {
  gateHref: string;
  callbackHref: string;
  code?: string;
  hopUrl?: string;
  promoHtml?: string;
  hopHtml?: string;
  solutionHtml?: string;
  solutionUrl?: string;
}
function chainHandler(parts: ChainParts, overrides?: (url: string, init?: RequestInit) => Response | null): (url: string, init?: RequestInit) => Response {
  const code = parts.code ?? 'CODEFIX';
  const hopUrl = parts.hopUrl ?? 'https://promobr.online/hop/h1';
  const promoHtml = parts.promoHtml ?? '<a href="https://x.gd/s1">Ir</a>';
  const hopHtml = parts.hopHtml ?? '<a href="https://promobr.online/go/g1">Ir</a>';
  const solutionUrl = parts.solutionUrl ?? parts.callbackHref;
  const solutionHtml = parts.solutionHtml ?? callbackHtml(magnet);
  return (url, init) => {
    const custom = overrides?.(url, init);
    if (custom) return custom;
    const method = init?.method || 'GET';
    if (url === `${SOLVER}/v1` && method === 'POST') {
      const body = JSON.parse(init!.body as string);
      if (body.cmd === 'sessions.create') return flareOk({ session: body.session });
      if (body.cmd === 'request.get') {
        if (body.url === parts.gateHref) {
          return flareOk({ solution: { url: 'https://promobr.online/jump/j1', response: promoHtml, status: 200 } });
        }
        if (body.url.startsWith(`https://${GATE_HOST}${CALLBACK_PATH}`)) {
          return flareOk({ solution: { url: solutionUrl, response: solutionHtml, status: 200 } });
        }
      }
      if (body.cmd === 'sessions.destroy') return flareOk({});
    }
    if (url === 'https://promobr.online/jump/j1') return htmlBody(promoHtml);
    if (url.startsWith('https://x.gd/')) return redirect302(`https://valedesconto.shop/r/r1?utm_content=${code}`);
    if (url.startsWith('https://promobr.online/api/end')) return jsonBody({ url: hopUrl });
    if (url.startsWith('https://promobr.online/hop/')) return htmlBody(hopHtml);
    if (url.startsWith('https://promobr.online/go/')) return redirect302(parts.callbackHref);
    throw new Error(`fetch inesperado: ${method} ${url}`);
  };
}

function callbackHref(token = 'TOKFIX', ref = 'REFFIX'): string {
  return `https://${GATE_HOST}${CALLBACK_PATH}?token=${token}&ref=${ref}`;
}

// ══════════════════════════════════════════════════════════════════════════
// (a) Cadeia completa
// ══════════════════════════════════════════════════════════════════════════
test('(a) cadeia completa com FlareSolverr e HTTP simulados devolve magnet', async () => {
  const gate = freshGate();
  const cb = callbackHref();
  const stub = stubFetch(chainHandler({ gateHref: gate, callbackHref: cb }));
  try {
    const result = await resolveGateMagnet(gate, postUrl, OPTS);
    assert.equal(result, magnet);
    // Criação e destruição da sessão, mais dois request.get (gate + callback).
    const posts = stub.calls.filter((c) => c.options?.method === 'POST');
    assert.equal(posts.length, 4, 'esperados 4 POSTs ao solvedor (create, 2×get, destroy)');
    const cmds = posts.map((c) => JSON.parse(c.options.body as string).cmd);
    assert.deepEqual(cmds, ['sessions.create', 'request.get', 'request.get', 'sessions.destroy']);
  } finally { stub.restore(); }
});

// ══════════════════════════════════════════════════════════════════════════
// (b) Destinos inseguros
// ══════════════════════════════════════════════════════════════════════════
test('(b) rejeita destino inseguro sem tocar rede proibida', async () => {
  // O solvedor devolve solution.url fora da allowlist → erro ANTES de qualquer
  // fetch ao host proibido.
  const gate = freshGate();
  const cb = callbackHref();
  const forbiddenUrls = [
    'https://evil.example/jump/e1',
    'https://promobr.online.evil.example/jump/e1',
    'http://promobr.online/jump/e1',
  ];
  for (const badUrl of forbiddenUrls) {
    const touched: string[] = [];
    const stub = stubFetch(chainHandler(
      { gateHref: gate, callbackHref: cb },
      (url, init) => {
        const method = init?.method || 'GET';
        if (url === `${SOLVER}/v1` && method === 'POST') {
          const body = JSON.parse(init!.body as string);
          if (body.cmd === 'request.get' && body.url === gate) {
            return flareOk({ solution: { url: badUrl, response: '', status: 200 } });
          }
        }
        touched.push(url);
        return null; // segue o handler padrão
      },
    ));
    try {
      await assert.rejects(resolveGateMagnet(gate, postUrl, OPTS), (err: unknown) => {
        assert.ok(err instanceof BludvAdGateError, 'erro do portão');
        return true;
      });
      // Nenhum fetch direto ao host proibido (o solvedor é localhost, permitido).
      const forbidden = touched.filter((u) => u.includes('evil.example'));
      assert.equal(forbidden.length, 0, `rede proibida tocada: ${forbidden.join(', ')}`);
    } finally { stub.restore(); }
  }
});

// ══════════════════════════════════════════════════════════════════════════
// (c) Coalescing
// ══════════════════════════════════════════════════════════════════════════
test('(c) duas chamadas simultâneas ao mesmo gate = 1 cadeia', async () => {
  const gate = freshGate();
  const cb = callbackHref();
  let creates = 0;
  const stub = stubFetch(chainHandler(
    { gateHref: gate, callbackHref: cb },
    (url, init) => {
      if (url === `${SOLVER}/v1` && init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        if (body.cmd === 'sessions.create') creates++;
      }
      return null;
    },
  ));
  try {
    const [r1, r2] = await Promise.all([
      resolveGateMagnet(gate, postUrl, OPTS),
      resolveGateMagnet(gate, postUrl, OPTS),
    ]);
    assert.equal(r1, magnet);
    assert.equal(r2, magnet);
    assert.equal(creates, 1, 'coalescing falhou: mais de 1 sessão criada');
  } finally { stub.restore(); }
});

// ══════════════════════════════════════════════════════════════════════════
// (d) Cache
// ══════════════════════════════════════════════════════════════════════════
test('(d1) cache de sucesso reutiliza magnet sem nova cadeia', async () => {
  const gate = freshGate();
  const cb = callbackHref();
  let creates = 0;
  const stub = stubFetch(chainHandler(
    { gateHref: gate, callbackHref: cb },
    (url, init) => {
      if (url === `${SOLVER}/v1` && init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        if (body.cmd === 'sessions.create') creates++;
      }
      return null;
    },
  ));
  try {
    const r1 = await resolveGateMagnet(gate, postUrl, OPTS);
    const r2 = await resolveGateMagnet(gate, postUrl, OPTS);
    assert.equal(r1, magnet);
    assert.equal(r2, magnet);
    assert.equal(creates, 1, 'segunda chamada deveria bater cache, não criar sessão');
  } finally { stub.restore(); }
});

test('(d2) falha não entra no cache — próxima tentativa reexecuta a cadeia', async () => {
  const gate = freshGate();
  const cb = callbackHref();
  let attempt = 0;
  let creates = 0;
  const stub = stubFetch(chainHandler(
    { gateHref: gate, callbackHref: cb },
    (url, init) => {
      if (url === `${SOLVER}/v1` && init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        if (body.cmd === 'sessions.create') {
          creates++;
          if (attempt === 0) {
            attempt++;
            // Primeira tentativa: solver devolve solution inválida → erro.
            return flareOk({ solution: { url: 'https://promobr.online/jump/j1', response: '', status: 500 } });
          }
        }
      }
      return null;
    },
  ));
  try {
    await assert.rejects(resolveGateMagnet(gate, postUrl, OPTS));
    // Segunda tentativa: cadeia completa normal (handler padrão).
    const r2 = await resolveGateMagnet(gate, postUrl, OPTS);
    assert.equal(r2, magnet);
    assert.equal(creates, 2, 'falha não pode entrar no cache; reexecução obrigatória');
  } finally { stub.restore(); }
});

// ══════════════════════════════════════════════════════════════════════════
// (e) Prefetch oportunista
// ══════════════════════════════════════════════════════════════════════════
test('(e) prefetch descartado quando cadeia em andamento', async () => {
  const gate = freshGate();
  const cb = callbackHref();
  let creates = 0;
  const stub = stubFetch(chainHandler(
    { gateHref: gate, callbackHref: cb },
    (url, init) => {
      if (url === `${SOLVER}/v1` && init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        if (body.cmd === 'sessions.create') creates++;
      }
      return null;
    },
  ));
  try {
    // Inicia a cadeia real (play).
    const play = resolveGateMagnet(gate, postUrl, OPTS);
    // Prefetch oportunista: deve ser ignorado porque há cadeia em andamento.
    prefetchGateMagnet(gate, postUrl, OPTS);
    await play;
    assert.equal(creates, 1, 'prefetch não pode criar cadeia extra quando play está ativo');
  } finally { stub.restore(); }
});

// O teste acima não mede a cerca: com o MESMO gate, o coalescing por URL já
// segura o prefetch sozinho. Aqui é outro gate (outro post da mesma busca) — sem
// a cerca ele ENFILEIRARIA uma sessão extra no solvedor, que atende uma
// requisição por vez e é compartilhado com todos os indexers Cloudflare.
test('(e2) prefetch de OUTRO gate não enfileira sessão enquanto o play ocupa o solvedor', async () => {
  const gatePlay = freshGate();
  const gatePrefetch = freshGate();
  const cb = callbackHref();
  let creates = 0;
  // Só a cadeia do play tem dublô: se o prefetch acordar uma segunda sessão, o
  // `request.get` do gate dele cai no handler e conta como sessão criada.
  const stub = stubFetch(chainHandler(
    { gateHref: gatePlay, callbackHref: cb },
    (url, init) => {
      if (url === `${SOLVER}/v1` && init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        if (body.cmd === 'sessions.create') creates++;
      }
      return null;
    },
  ));
  try {
    const play = resolveGateMagnet(gatePlay, postUrl, OPTS);
    prefetchGateMagnet(gatePrefetch, postUrl, OPTS);
    await play;
    // Cede um tick: sem a cerca, a segunda cadeia começaria aqui.
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(creates, 1, 'prefetch de outro gate não pode abrir segunda sessão no solvedor');
  } finally { stub.restore(); }
});

// ══════════════════════════════════════════════════════════════════════════
// (f) Destroy da sessão no caminho de erro
// ══════════════════════════════════════════════════════════════════════════
test('(f) destroy da sessão mesmo quando a cadeia falha', async () => {
  const gate = freshGate();
  const cb = callbackHref();
  let destroyed = false;
  const stub = stubFetch(chainHandler(
    { gateHref: gate, callbackHref: cb },
    (url, init) => {
      if (url === `${SOLVER}/v1` && init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        if (body.cmd === 'sessions.destroy') destroyed = true;
        // Falha logo no primeiro flareGet (solution com status 500).
        if (body.cmd === 'request.get' && body.url === gate) {
          return flareOk({ solution: { url: 'https://promobr.online/jump/j1', response: '', status: 500 } });
        }
      }
      return null;
    },
  ));
  try {
    await assert.rejects(resolveGateMagnet(gate, postUrl, OPTS));
    assert.equal(destroyed, true, 'sessão não foi destruída no caminho de erro');
  } finally { stub.restore(); }
});

// ══════════════════════════════════════════════════════════════════════════
// (g) Callback com erro ou sem magnet
// ══════════════════════════════════════════════════════════════════════════
test('(g1) callback com gate_erro vira BludvAdGateError', async () => {
  const gate = freshGate();
  const cb = callbackHref();
  const stub = stubFetch(chainHandler({
    gateHref: gate,
    callbackHref: cb,
    solutionUrl: `https://${GATE_HOST}${CALLBACK_PATH}?token=TOKFIX&ref=REFFIX&gate_erro=1`,
    solutionHtml: '<html><body>erro</body></html>',
  }));
  try {
    await assert.rejects(resolveGateMagnet(gate, postUrl, OPTS), (err: unknown) => {
      assert.ok(err instanceof BludvAdGateError);
      assert.match((err as BludvAdGateError).message, /callback recusado/);
      return true;
    });
  } finally { stub.restore(); }
});

test('(g2) callback sem magnet válido vira BludvAdGateError', async () => {
  const gate = freshGate();
  const cb = callbackHref();
  const stub = stubFetch(chainHandler({
    gateHref: gate,
    callbackHref: cb,
    solutionHtml: '<html><body>sem magnet aqui</body></html>',
  }));
  try {
    await assert.rejects(resolveGateMagnet(gate, postUrl, OPTS), (err: unknown) => {
      assert.ok(err instanceof BludvAdGateError);
      assert.match((err as BludvAdGateError).message, /magnet/);
      return true;
    });
  } finally { stub.restore(); }
});

// ══════════════════════════════════════════════════════════════════════════
// (h) Prazo/abort
// ══════════════════════════════════════════════════════════════════════════
test('(h) abort devolve erro estável e não deixa cadeia viva', async () => {
  const gate = freshGate();
  const cb = callbackHref();
  const ac = new AbortController();
  let creates = 0;
  const stub = stubFetch(chainHandler(
    { gateHref: gate, callbackHref: cb },
    (url, init) => {
      if (url === `${SOLVER}/v1` && init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        if (body.cmd === 'sessions.create') {
          creates++;
          // Aborta logo após criar a sessão.
          setTimeout(() => ac.abort(new DOMException('', 'TimeoutError')), 0);
        }
      }
      return null;
    },
  ));
  try {
    await assert.rejects(resolveGateMagnet(gate, postUrl, { ...OPTS, signal: ac.signal }), (err: unknown) => {
      assert.ok(err instanceof BludvAdGateError);
      // Mensagem estável: não inclui detalhes do signal nem URL.
      assert.match((err as BludvAdGateError).message, /prazo esgotado|cancelado/);
      return true;
    });
    // Após o abort, uma nova chamada (sem signal abortado) deve funcionar.
    const gate2 = freshGate();
    const cb2 = callbackHref('TOK2', 'REF2');
    const stub2 = stubFetch(chainHandler({ gateHref: gate2, callbackHref: cb2 }));
    try {
      const r = await resolveGateMagnet(gate2, postUrl, OPTS);
      assert.equal(r, magnet);
    } finally { stub2.restore(); }
  } finally { stub.restore(); }
});
