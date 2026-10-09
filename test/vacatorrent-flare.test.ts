import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * FlareSolverr no perfil Vaca: o site responde 403 CF no fetch cru.
 * Espelha os contratos do bludv (desafio → Flare + reuso; 403 sem desafio
 * fica diagnosticável) e preserva o Accept JSON da busca AJAX.
 */
import { createResolver as createVacaResolver } from '../resolvers/profiles/vacatorrent.js';

const toStr = (url: any) => (typeof url === 'string' ? url : url.href);

describe('VacaTorrent: FlareSolverr (Cloudflare)', () => {
  let originalFetch: typeof globalThis.fetch;
  let vacaFlare: ReturnType<typeof createVacaResolver>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Instância fresca: a sessão cf_clearance não pode vazar entre testes.
    vacaFlare = createVacaResolver();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('fetchText: 403 do Cloudflare cai no FlareSolverr e reusa a sessão', async () => {
    let siteFetches = 0;
    let flareCalls = 0;
    let lastHeaders: Record<string, string> | undefined;

    globalThis.fetch = (async (url: any, init: any) => {
      const u = toStr(url);
      if (u.includes('vaqueirofilmes')) {
        siteFetches += 1;
        lastHeaders = init?.headers;
        return siteFetches === 1
          ? {
              status: 403,
              ok: false,
              headers: { get: () => null },
              text: async () => 'Just a moment... at https://challenges.cloudflare.com',
            }
          : {
              status: 200,
              ok: true,
              headers: { get: () => null },
              text: async () => '<html>resultado</html>',
            };
      }
      if (u.includes('/v1')) {
        flareCalls += 1;
        return {
          status: 200,
          ok: true,
          json: async () => ({
            status: 'ok',
            solution: {
              url: 'https://vaqueirofilmes.com/?s=coringa',
              response: '<html>flare</html>',
              userAgent: 'FlareUA/1.0',
              cookies: [{ name: 'cf_clearance', value: 'abc123' }],
            },
          }),
        };
      }
      throw new Error(`Unexpected url: ${u}`);
    }) as unknown as typeof globalThis.fetch;

    const first = await vacaFlare.fetchText('https://vaqueirofilmes.com/?s=coringa');
    assert.equal(first, '<html>flare</html>', '403 vira response do FlareSolverr');
    assert.equal(flareCalls, 1, 'só um POST no FlareSolverr');
    assert.equal(siteFetches, 1, 'site foi tocado uma vez antes do 403');

    const session = vacaFlare.getFlareSession('vaqueirofilmes.com');
    assert.ok(session, 'sessão cf_clearance guardada no host pedido');
    assert.equal(session.userAgent, 'FlareUA/1.0');
    assert.ok(session.cookies.includes('cf_clearance=abc123'));

    // Segunda chamada do MESMO host reusa o cookie no fetch direto (sem Flare).
    const second = await vacaFlare.fetchText('https://vaqueirofilmes.com/?s=coringa');
    assert.equal(second, '<html>resultado</html>');
    assert.equal(flareCalls, 1, 'não re-resolve com cookie válido');
    assert.equal(siteFetches, 2);
    assert.ok(
      String(lastHeaders?.['User-Agent']).includes('FlareUA')
        && String(lastHeaders?.['Cookie']).includes('cf_clearance'),
      'headers do fetch direto usam a sessão',
    );
  });

  test('fetchText: 403 sem desafio Cloudflare NÃO deriva e mantém erro diagnosticável', async () => {
    let flareCalls = 0;
    globalThis.fetch = (async (url: any) => {
      const u = toStr(url);
      if (u.includes('vaqueirofilmes')) {
        return {
          status: 403,
          ok: false,
          headers: { get: () => null },
          text: async () => '<html>Access denied</html>',
        };
      }
      if (u.includes('/v1')) {
        flareCalls += 1;
        throw new Error('não deve chamar o FlareSolverr');
      }
      throw new Error(`Unexpected url: ${u}`);
    }) as unknown as typeof globalThis.fetch;

    await assert.rejects(
      () => vacaFlare.fetchText('https://vaqueirofilmes.com/?s=coringa'),
      /http_403/,
      '403 sem challenge vira http_403 e não silencia em 0 resultados',
    );
    assert.equal(flareCalls, 0, 'FlareSolverr não é chamado sem desafio Cloudflare');
  });

  test('fetchText: Accept customizado (AJAX) sobrevive ao buildFlareHeaders', async () => {
    let lastHeaders: Record<string, string> | undefined;
    globalThis.fetch = (async (_url: any, init: any) => {
      lastHeaders = init?.headers;
      return {
        status: 200,
        ok: true,
        headers: { get: () => null },
        text: async () => '[]',
      };
    }) as unknown as typeof globalThis.fetch;

    await vacaFlare.fetchText(
      'https://vaqueirofilmes.com/wp-admin/admin-ajax.php?action=search_posts&s=x',
      'application/json, text/html, */*',
    );
    assert.equal(
      lastHeaders?.Accept,
      'application/json, text/html, */*',
      'AJAX search_posts não perde o Accept JSON',
    );
  });

  test('fetchText: FlareSolverr com Accept JSON desembrulha o body HTML', async () => {
    globalThis.fetch = (async (url: any) => {
      const u = toStr(url);
      if (u.includes('vaqueirofilmes')) {
        return {
          status: 403,
          ok: false,
          headers: { get: () => null },
          text: async () => 'Just a moment... challenges.cloudflare.com',
        };
      }
      if (u.includes('/v1')) {
        return {
          status: 200,
          ok: true,
          json: async () => ({
            status: 'ok',
            solution: {
              url: 'https://vaqueirofilmes.com/wp-admin/admin-ajax.php?action=search_posts&s=Coringa',
              response: '<html><head></head><body>[{"title":"Coringa","link":"https://vaqueirofilmes.com/pt/movie/coringa/","type":"Filme","year":"2019"}]</body></html>',
              userAgent: 'FlareUA/1.0',
              cookies: [{ name: 'cf_clearance', value: 'xyz' }],
            },
          }),
        };
      }
      throw new Error(`Unexpected url: ${u}`);
    }) as unknown as typeof globalThis.fetch;

    const text = await vacaFlare.fetchText(
      'https://vaqueirofilmes.com/wp-admin/admin-ajax.php?action=search_posts&s=Coringa',
      'application/json, text/html, */*',
    );
    assert.equal(
      text,
      '[{"title":"Coringa","link":"https://vaqueirofilmes.com/pt/movie/coringa/","type":"Filme","year":"2019"}]',
      'JSON da AJAX sai limpo do envelope HTML do FlareSolverr',
    );
    assert.ok(Array.isArray(JSON.parse(text)), 'resultado é JSON parseável');
  });

  for (const status of [200, 503]) {
    test(`fetchText: challenge real HTTP ${status} recupera com um único Flare`, async (t) => {
      let calls = 0;
      t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
        assert.ok(init.signal instanceof AbortSignal, 'toda chamada tem prazo');
        if (++calls === 1) return new Response(
          '<html><title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/h/g"></script></html>',
          { status },
        );
        assert.equal(calls, 2, 'não há retry em laço');
        return Response.json({ status: 'ok', solution: { status: 200, response: '[]' } });
      });
      assert.equal(await vacaFlare.fetchText('https://vaqueirofilmes.com/pt/', 'application/json'), '[]');
      assert.equal(calls, 2);
    });
  }

  test('fetchText: cf-mitigated explícito basta mesmo com corpo vazio', async (t) => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => ++calls === 1
      ? new Response('', { status: 200, headers: { 'cf-mitigated': 'challenge' } })
      : Response.json({ status: 'ok', solution: { response: '[]' } }));
    assert.equal(await vacaFlare.fetchText('https://vaqueirofilmes.com/pt/'), '[]');
    assert.equal(calls, 2);
  });

  test('fetchText: status genérico e menção textual ao Cloudflare não disparam Flare', async (t) => {
    for (const status of [200, 403, 429, 500, 503, 522]) {
      let calls = 0;
      const body = '<html><h1>Just a moment no cinema</h1><p>Cloudflare</p></html>';
      t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(body, { status }); });
      if (status === 200) assert.equal(await vacaFlare.fetchText('https://vaqueirofilmes.com/pt/'), body);
      else await assert.rejects(vacaFlare.fetchText('https://vaqueirofilmes.com/pt/'), new RegExp(`http_${status}`));
      assert.equal(calls, 1, `HTTP ${status} sem evidência de challenge não paga Flare`);
      t.mock.restoreAll();
    }
  });

  test('fetchText: Flare devolvendo challenge HTTP 200 falha sem loop nem sessão ruim', async (t) => {
    let calls = 0;
    const challenge = '<html><title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/h/g"></script></html>';
    t.mock.method(globalThis, 'fetch', async () => ++calls === 1
      ? new Response(challenge, { status: 403 })
      : Response.json({ status: 'ok', solution: {
        status: 200, response: challenge, cookies: [{ name: 'cf_clearance', value: 'teste' }],
      } }));
    await assert.rejects(vacaFlare.fetchText('https://vaqueirofilmes.com/pt/'), /vacatorrent:.*desafio/i);
    assert.equal(calls, 2);
    assert.equal(vacaFlare.getFlareSession('vaqueirofilmes.com'), null);
  });

  test('fetchText: JavaScript Detections não confunde página válida com challenge', async (t) => {
    for (const viaFlare of [false, true]) {
      for (const path of ['scripts/jsd/main.js', 'h/b/scripts/jsd/main.js']) {
        let calls = 0;
        const body = `<html><title>Coringa</title><script src="/cdn-cgi/challenge-platform/${path}"></script><body>Links disponíveis</body></html>`;
        t.mock.method(globalThis, 'fetch', async () => {
          calls++;
          if (!viaFlare) return new Response(body);
          if (calls === 1) return new Response('', { status: 403, headers: { 'cf-mitigated': 'challenge' } });
          return Response.json({ status: 'ok', solution: { response: body } });
        });
        assert.equal(await vacaFlare.fetchText('https://vaqueirofilmes.com/pt/'), body);
        assert.equal(calls, viaFlare ? 2 : 1);
        t.mock.restoreAll();
      }
    }
  });

  for (const wrap of ['body', 'pre', 'body-pre', 'chromium']) {
    test(`fetchText: JSON em ${wrap} decodifica entidades sem destruir aspas ou sinais`, async (t) => {
      const json = JSON.stringify([{ title: 'A "Vaca" <3 & Cia', link: '/pt/movie/vaca/', type: 'Filme' }]);
      const encoded = vacaFlare.escapeHtml(json);
      const inner = wrap.includes('pre') || wrap === 'chromium' ? `<pre style="white-space: pre-wrap">${encoded}</pre>` : encoded;
      const formatter = wrap === 'chromium' ? '<div class="json-formatter-container"><label><input type="checkbox">Pretty-print</label></div>' : '';
      const html = wrap === 'pre' ? inner : `<html><head></head><body>${inner}${formatter}</body></html>`;
      let calls = 0;
      t.mock.method(globalThis, 'fetch', async () => ++calls === 1
        ? new Response('Just a moment... challenges.cloudflare.com', { status: 403 })
        : Response.json({ status: 'ok', solution: { response: html } }));
      assert.equal(await vacaFlare.fetchText('https://vaqueirofilmes.com/pt/', 'application/json'), json);
    });
  }

  test('fetchText: JSON cru preserva entidades literais e títulos que mencionam challenge', async (t) => {
    const json = JSON.stringify([{ title: 'Just a moment &quot; cf-chl', link: '/pt/movie/vaca/' }]);
    t.mock.method(globalThis, 'fetch', async () => new Response(json));
    assert.equal(await vacaFlare.fetchText('https://vaqueirofilmes.com/pt/', 'application/json'), json);
  });

  test('fetchText: erro WordPress HTTP 200 falha tanto direto quanto após Flare', async (t) => {
    for (const viaFlare of [false, true]) {
      let calls = 0;
      const wp = '<html><title>WordPress › Erro</title><body id="error-page"><div class="wp-die-message">Ocorreu um erro crítico neste site.</div></body></html>';
      t.mock.method(globalThis, 'fetch', async () => {
        calls++;
        if (!viaFlare) return new Response(wp);
        if (calls === 1) return new Response('Just a moment... challenges.cloudflare.com', { status: 403 });
        return Response.json({ status: 'ok', solution: { response: wp } });
      });
      await assert.rejects(vacaFlare.fetchText('https://vaqueirofilmes.com/pt/'), /vacatorrent:.*WordPress/i);
      assert.equal(calls, viaFlare ? 2 : 1);
      t.mock.restoreAll();
    }
  });
});
