import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Contrato do cookieJar opt-in em resolvers/transport.js.
 *
 * O `followProtectedUrl` aceita `cookieJar: true`, guarda os `Set-Cookie` da
 * resposta por hostname e reenvia como `Cookie` SOMENTE quando o próximo salto
 * tem o mesmo hostname; um salto para hostname diferente NÃO leva o cookie.
 * `cookieJar` omitido (ou false) mantém os headers sem `Cookie` e não muda a
 * cadeia — comportamento default dos quatro perfis existentes.
 *
 * Semântica registrada no contrato da cadeia:
 *  - `cookieJar: true` preserva TODOS os pares `name=value` quando o header
 *    une vários `Set-Cookie` (Node/undici une com ", ").
 *  - `cookieJar` também aceita um objeto `{ seed: { '<hostname>': { '<nome>':
 *    '<valor>' } } }`: pré-popula o jar com esses pares, reenviados apenas a
 *    salto no MESMO hostname (mesma semântica do `cookieJar: true`). É o que
 *    entrega os cookies de liberação client-side do Vaca Torrent
 *    (`enc_liberado`/`enc_etapa1_*`) na vacadb.org sem alterar o transporte.
 *  - redirect `manual` e a resolução de magnet continuam funcionando.
 *
 * Registrado na lista explícita do `npm test` (package.json).
 */
import transport from '../resolvers/transport.js';

const HASH = '0123456789abcdef0123456789abcdef01234567';
const MAGNET = `magnet:?xt=urn:btih:${HASH}&dn=Filme`;

// Configuração mínima do laço de saltos; os testes só exercitam redirect e
// magnet (não meta-refresh nem nextProtectedUrl), então esses helpers são
// stubs inertes — a cadeia avança pelos 302.
const opts = {
  assertAllowedUrl: (u: unknown) => new URL(String(u)),
  decodeEntities: (s: unknown) => String(s),
  extractMagnet: (html: string): string | null => {
    const m = String(html).match(/magnet:\?[^"'<>\s]+/);
    return m ? m[0] : null;
  },
  nextProtectedUrl: () => null,
  extractMetaRefresh: () => null,
  maxHops: 10,
  timeoutMs: 5000,
  userAgent: 'UA/1.0',
};

// O transport.js (sem JSDoc/declaracao) infere "cookieJar?: boolean" do default
// "false" no destructuring, mas o contrato do seed (objeto { seed: { '<host>':
// { '<nome>': '<valor>' } } }) ainda nao esta na assinatura inferida — daí o
// cast explicito, concentrado aqui como manda a convencao.
const cookieJarSeed = { seed: { 'sys-a.example.com': { session: 'abc' } } } as any;
interface FetchCall {
  url: string;
  headers: Record<string, string> | null;
}

type ResponseSpec = { status?: number; headers?: Record<string, string>; body?: string };

// Resposta de fetch com `headers.get` que normaliza para minúsculo e lê a
// chave do mapa — igual ao estilo dos stubs já usados nos testes dos resolvers.
function makeResponse(spec: ResponseSpec) {
  const headers = spec.headers ?? {};
  const status = spec.status ?? 200;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => headers[String(name).toLowerCase()] ?? null },
    text: async () => spec.body ?? '',
  };
}

// Instala um dublê de fetch roteado por URL, gravando cada salto e os headers
// enviados, e devolve a função de restauração.
function makeChain(routes: Record<string, (ca: FetchCall) => ResponseSpec>) {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: any) => {
    const url = String(input);
    const headers = init?.headers ?? null;
    calls.push({ url, headers });
    const route = routes[url];
    if (!route) throw new Error(`fetch inesperado: ${url}`);
    return makeResponse(route({ url, headers }));
  }) as unknown as typeof globalThis.fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}


describe('transport cookieJar opt-in', () => {
  test('cookieJar:true reenvia Set-Cookie apenas a salto no mesmo hostname', async () => {
    const chain = makeChain({
      // Step1 em sys-a seta o cookie e redireciona para outro path do MESMO host.
      'https://sys-a.example.com/step1': () => ({
        status: 302,
        headers: { location: 'https://sys-a.example.com/step2', 'set-cookie': 'session=abc; Path=/; HttpOnly' },
      }),
      // Step2 (mesmo hostname de quem setou) redireciona para OUTRO host.
      'https://sys-a.example.com/step2': () => ({
        status: 302,
        headers: { location: 'https://sys-b.example.com/step3' },
      }),
      // Step3 (hostname diferente) devolve o magnet.
      'https://sys-b.example.com/step3': () => ({ status: 200, body: `<a href="${MAGNET}">x</a>` }),
    });

    try {
      const cookieArgs = { ...opts, cookieJar: true };
      const result = await transport.followProtectedUrl(
        'https://sys-a.example.com/step1',
        'https://sys-a.example.com/start',
        cookieArgs,
      );
      assert.equal(result, MAGNET, 'a cadeia termina no magnet');

      // A cadeia percorre exatamente os três saltos.
      assert.deepEqual(
        chain.calls.map((c) => c.url),
        ['https://sys-a.example.com/step1', 'https://sys-a.example.com/step2', 'https://sys-b.example.com/step3'],
      );

      // Mesmo hostname de quem emitiu o Set-Cookie: cookie reenviado.
      const sameHost = chain.calls.find((c) => c.url === 'https://sys-a.example.com/step2');
      assert.ok(sameHost, 'step2 foi requisitado');
      assert.equal(sameHost!.headers?.['Cookie'], 'session=abc', 'Saltar para o mesmo hostname reenvia o cookie');

      // Hostname diferente: o cookie NÃO vaza.
      const crossHost = chain.calls.find((c) => c.url === 'https://sys-b.example.com/step3');
      assert.ok(crossHost, 'step3 foi requisitado');
      assert.equal(
        crossHost!.headers?.['Cookie'],
        undefined,
        'saltar para hostname diferente não envia o cookie do host anterior',
      );
} finally {
      chain.restore();
    }
  });

  test('cookieJar:true preserva OS DOIS cookies quando o header une dois Set-Cookie', async () => {
    // Node/undici une vários `Set-Cookie` numa única string separada por ", ".
    // O jar deve relançar AMBOS no próximo salto do mesmo hostname.
    const chain = makeChain({
      'https://sys-a.example.com/step1': () => ({
        status: 302,
        headers: {
          location: 'https://sys-a.example.com/step2',
          'set-cookie': 'session=abc; Path=/, theme=dark; HttpOnly',
        },
      }),
      'https://sys-a.example.com/step2': () => ({ status: 200, body: `<a href="${MAGNET}">x</a>` }),
    });

    try {
      const cookieArgs = { ...opts, cookieJar: true };
      const result = await transport.followProtectedUrl('https://sys-a.example.com/step1', null, cookieArgs);
      assert.equal(result, MAGNET);

      const second = chain.calls.find((c) => c.url === 'https://sys-a.example.com/step2');
      assert.ok(second, 'step2 foi requisitado');
      const cookie = second!.headers?.['Cookie'] ?? '';
      assert.ok(cookie.includes('session=abc'), `session preservada: ${cookie}`);
      assert.ok(cookie.includes('theme=dark'), `theme preservado: ${cookie}`);
    } finally {
      chain.restore();
    }
  });

  test('cookieJar com seed pré-popula o jar e reenvia no MESMO hostname', async () => {
    const chain = makeChain({
      'https://sys-a.example.com/step1': () => ({
        status: 302,
        headers: { location: 'https://sys-a.example.com/step2' },
      }),
      'https://sys-a.example.com/step2': () => ({ status: 200, body: `<a href="${MAGNET}">x</a>` }),
    });

    try {
      const cookieArgs = { ...opts, cookieJar: cookieJarSeed };
      const result = await transport.followProtectedUrl(
        'https://sys-a.example.com/step1',
        'https://sys-a.example.com/start',
        cookieArgs,
      );
      assert.equal(result, MAGNET, 'a cadeia termina no magnet');

      const first = chain.calls.find((c) => c.url === 'https://sys-a.example.com/step1');
      assert.ok(first, 'step1 foi requisitado');
      assert.equal(first!.headers?.['Cookie'], 'session=abc', 'o seed já vai no primeiro salto do hostname');

      const second = chain.calls.find((c) => c.url === 'https://sys-a.example.com/step2');
      assert.ok(second, 'step2 foi requisitado');
      assert.equal(second!.headers?.['Cookie'], 'session=abc', 'saltar para o mesmo hostname reenvia o seed');
    } finally {
      chain.restore();
    }
  });

  test('cookieJar com seed não vaza para hostname diferente', async () => {
    const chain = makeChain({
      'https://sys-a.example.com/step1': () => ({
        status: 302,
        headers: { location: 'https://sys-b.example.com/step2' },
      }),
      'https://sys-b.example.com/step2': () => ({ status: 200, body: `<a href="${MAGNET}">x</a>` }),
    });

    try {
      const cookieArgs = { ...opts, cookieJar: cookieJarSeed };
      const result = await transport.followProtectedUrl('https://sys-a.example.com/step1', null, cookieArgs);
      assert.equal(result, MAGNET, 'a cadeia termina no magnet');

      const first = chain.calls.find((c) => c.url === 'https://sys-a.example.com/step1');
      assert.ok(first, 'step1 foi requisitado');
      assert.equal(first!.headers?.['Cookie'], 'session=abc', 'o seed existe no hostname conforme');

      const cross = chain.calls.find((c) => c.url === 'https://sys-b.example.com/step2');
      assert.ok(cross, 'step2 foi requisitado');
      assert.equal(cross!.headers?.['Cookie'], undefined, 'o seed não vaza para hostname diferente');
    } finally {
      chain.restore();
    }
  });

  test('cookieJar omitido mantém headers sem Cookie e não muda a cadeia', async () => {
    const chain = makeChain({
      'https://sys-a.example.com/step1': () => ({
        status: 302,
        headers: { location: 'https://sys-a.example.com/step2', 'set-cookie': 'session=abc; Path=/' },
      }),
      'https://sys-a.example.com/step2': () => ({ status: 200, body: `<a href="${MAGNET}">x</a>` }),
    });

    try {
      const cookieArgs = { ...opts, cookieJar: true };
      const result = await transport.followProtectedUrl('https://sys-a.example.com/step1', 'https://sys-a.example.com/start', opts);
      assert.equal(result, MAGNET, 'sem cookieJar a cadeia continua resolvendo o magnet');

      assert.deepEqual(
        chain.calls.map((c) => c.url),
        ['https://sys-a.example.com/step1', 'https://sys-a.example.com/step2'],
        'os mesmos saltos são percorridos',
      );

      for (const call of chain.calls) {
        assert.equal(call.headers?.['Cookie'], undefined, 'nenhum salto leva cabeçalho Cookie');
      }
    } finally {
      chain.restore();
    }
  });
});

describe('transport contrato existente (redirect/manual e magnet)', () => {
  test('302 para location magnet devolve o magnet normalizado sem re-buscar', async () => {
    const chain = makeChain({
      'https://sys-a.example.com/start': () => ({
        status: 302,
        // `MAGNET:` em maiúscula para exercitar a normalização p/ minúsculo.
        headers: { location: `MAGNET:?xt=urn:btih:${HASH}&dn=Filme` },
      }),
    });

    try {
      const cookieArgs = { ...opts, cookieJar: true };
      const result = await transport.followProtectedUrl('https://sys-a.example.com/start', null, opts);
      assert.equal(result, MAGNET, 'magnet normalizado para minúsculo');
      assert.equal(chain.calls.length, 1, 'o magnet não é buscado como URL — a cadeia para no redirect');
    } finally {
      chain.restore();
    }
  });

  test('200 com magnet no corpo extrai e normaliza', async () => {
    const chain = makeChain({
      'https://sys-a.example.com/start': () => ({ status: 200, body: `<a data-download="${MAGNET}">x</a>` }),
    });

    try {
      const cookieArgs = { ...opts, cookieJar: true };
      const result = await transport.followProtectedUrl('https://sys-a.example.com/start', null, opts);
      assert.equal(result, MAGNET);
    } finally {
      chain.restore();
    }
  });

  test('302 sem Location lança missing_redirect', async () => {
    const chain = makeChain({
      'https://sys-a.example.com/start': () => ({ status: 302, headers: {} }),
    });

    try {
      await assert.rejects(
        () => transport.followProtectedUrl('https://sys-a.example.com/start', null, opts),
        /missing_redirect/,
      );
    } finally {
      chain.restore();
    }
  });
});


