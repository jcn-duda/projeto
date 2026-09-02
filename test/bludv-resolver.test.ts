import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Camada de resolução do bludv-resolver após a paridade com o comandotorrents:
 * extractMagnet/extractMetaRefresh ampliados, caches de busca e de magnet
 * (hit, TTL, FIFO, coalescing) e o fallback do resolvePost — tudo com
 * globalThis.fetch mockado, sem rede.
 */
import bludv from '../bludv-resolver/server.js';

const HASH = '0123456789abcdef0123456789abcdef01234567';
const toStr = (url: any) => (typeof url === 'string' ? url : url.href);
const okHtml = (html: any) => ({ ok: true, status: 200, text: async () => html });

describe('BluDV Resolver: extractMagnet ampliado', () => {
  const expectedMagnet = `magnet:?xt=urn:btih:${HASH}&dn=Teste.Filme`;

  test('extrai das variáveis novas dos protetores', () => {
    const vars = [
      `<script>var LINK_FINAL = "${expectedMagnet}";</script>`,
      `<script>const DESTINO = "${expectedMagnet}";</script>`,
      `<script>window.LINK_DOWNLOAD = "${expectedMagnet}";</script>`,
      `<script>var URL_DOWNLOAD = "${expectedMagnet}";</script>`,
      `<a data-download="${expectedMagnet}">Baixar</a>`,
    ];
    for (const html of vars) {
      assert.equal(bludv.extractMagnet(html), expectedMagnet, `Falha em: ${html}`);
    }
  });

  test('decodifica magnet encoded com & literal (ramo que o padrão antigo cortava)', () => {
    // O regex antigo parava no primeiro & e perdia dn/tr; e exigia xt primeiro.
    const encoded = `magnet%3A%3Fdn=Teste.Filme&xt=urn%3Abtih%3A${HASH}&tr=udp%3A%2F%2Ftracker.example.com`;
    assert.equal(
      bludv.extractMagnet(`<a href="/redirect?url=${encoded}">Baixar</a>`),
      `magnet:?dn=Teste.Filme&xt=urn:btih:${HASH}&tr=udp://tracker.example.com`,
    );
  });

  test('decodifica magnet encoded com parâmetros invertidos dentro de variável JS', () => {
    const encoded = `magnet%3A%3Fdn%3DTeste.Filme%26xt%3Durn%3Abtih%3A${HASH}`;
    assert.equal(
      bludv.extractMagnet(`<script>var LINK_FINAL = "${encoded}";</script>`),
      `magnet:?dn=Teste.Filme&xt=urn:btih:${HASH}`,
    );
  });
});

describe('BluDV Resolver: extractMetaRefresh', () => {
  const target = 'https://videosad.net/go/step2';

  test('aceita as três formas de aspas no content/url', () => {
    assert.equal(bludv.extractMetaRefresh(`<meta http-equiv="refresh" content="0; url=${target}">`), target);
    assert.equal(bludv.extractMetaRefresh(`<meta http-equiv='refresh' content='2;url=${target}'>`), target);
    assert.equal(bludv.extractMetaRefresh(`<meta http-equiv=refresh content=0;URL=${target}>`), target);
    // Aspas aninhadas e alvo com entidades também entram.
    assert.equal(bludv.extractMetaRefresh(`<meta content="0; url='${target}'" http-equiv="refresh">`), target);
    assert.equal(
      bludv.extractMetaRefresh(`<meta http-equiv="refresh" content="0; url=https://videosad.net/go?id=1&amp;token=x">`),
      'https://videosad.net/go?id=1&token=x',
    );
  });

  test('meta refresh com magnet direto devolve o magnet', () => {
    const magnet = `magnet:?xt=urn:btih:${HASH}&dn=Filme`;
    assert.equal(bludv.extractMetaRefresh(`<meta content="1;url='${magnet}'" http-equiv="refresh">`), magnet);
  });

  test('nextProtectedUrl usa o meta refresh como primeira tentativa', () => {
    const base = 'https://systemads1.com/go/step1';
    const html = `<meta http-equiv="refresh" content="0; url=${target}">`;
    assert.equal(bludv.nextProtectedUrl(html, base), target);
    // Host fora da allowlist não vira próximo salto.
    assert.equal(
      bludv.nextProtectedUrl(`<meta http-equiv="refresh" content="0; url=https://evil.com/x">`, base),
      null,
    );
  });
});

describe('BluDV Resolver: caches de magnet e de busca', () => {
  let originalFetch: any;
  let protectorHits: any;
  let siteHits: any;

  const POST_URL = 'https://bludvfilmes.xyz/filme-cache/';
  const POST_HTML = `
    <h3>DUAL ÁUDIO</h3>
    <p><a href="https://systemads1.com/go/btn0">1080p Dublado</a></p>
  `;
  const TARGET_MAGNET = `magnet:?xt=urn:btih:2222222222222222222222222222222222222222&dn=Filme`;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    protectorHits = 0;
    siteHits = 0;
    bludv.postCache.clear();
    bludv.searchCache.clear();
    bludv.magnetCache.clear();
    bludv.inFlight.clear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('resolveButton: hit, TTL e coalescing do magnetCache', async () => {
    globalThis.fetch = (async (url: any) => {
      const u = toStr(url);
      if (u.includes('filme-cache')) return okHtml(POST_HTML);
      if (u.includes('btn0')) {
        protectorHits += 1;
        await new Promise((r) => setTimeout(r, 15));
        return okHtml(`<script>var DEST_URL = "${TARGET_MAGNET}";</script>`);
      }
      throw new Error(`Unexpected url: ${u}`);
    }) as unknown as typeof globalThis.fetch;

    // Concorrência se funde: duas chamadas simultâneas, uma cadeia só.
    const [a, b] = await Promise.all([
      bludv.resolveButton(POST_URL, 0),
      bludv.resolveButton(POST_URL, 0),
    ]);
    assert.equal(a, TARGET_MAGNET);
    assert.equal(b, TARGET_MAGNET);
    assert.equal(protectorHits, 1, 'chamadas simultâneas coalescem');

    // Chamada seguinte bate no cache.
    const c = await bludv.resolveButton(POST_URL, 0);
    assert.equal(c, TARGET_MAGNET);
    assert.equal(protectorHits, 1, 'cache responde sem refazer a cadeia');

    // TTL vencido re-resolve.
    bludv.magnetCache.get(`magnet:${POST_URL}:0`).expiresAt = Date.now() - 1;
    await bludv.resolveButton(POST_URL, 0);
    assert.equal(protectorHits, 2, 'entrada vencida é re-resolvida');
    assert.equal(bludv.inFlight.size, 0);
  });

  test('magnetCache: aplica limite máximo de entradas (FIFO)', async () => {
    globalThis.fetch = (async (url: any) => {
      const u = toStr(url);
      if (u.includes('filme-cache')) return okHtml(POST_HTML);
      if (u.includes('btn0')) return okHtml(`<script>var DEST_URL = "${TARGET_MAGNET}";</script>`);
      throw new Error(`Unexpected url: ${u}`);
    }) as unknown as typeof globalThis.fetch;

    for (let i = 0; i < 500; i += 1) {
      bludv.magnetCache.set(`fake:${i}`, { value: 'magnet:?xt=urn:btih:x', expiresAt: Date.now() + 60000 });
    }
    await bludv.resolveButton(POST_URL, 0);

    assert.equal(bludv.magnetCache.size, 500, 'teto de 500 entradas');
    assert.equal(bludv.magnetCache.has('fake:0'), false, 'a entrada mais antiga sai');
    assert.ok(bludv.magnetCache.has(`magnet:${POST_URL}:0`));
  });

  test('searchPosts: hit e coalescing do searchCache', async () => {
    const SEARCH_HTML = `<div class="posts">
      <div class="post">
        <div class="title"><a href="https://bludvfilmes.xyz/post-cache/">Post Cache Torrent</a></div>
      </div>
    </div>`;
    const POST_WITH_MAGNET = `
      <h3>DUAL ÁUDIO</h3>
      <p><a href="magnet:?xt=urn:btih:5555555555555555555555555555555555555555&dn=c">1080p Dublado</a></p>
    `;
    globalThis.fetch = (async (url: any) => {
      const u = toStr(url);
      if (u.includes('/?s=')) {
        siteHits += 1;
        await new Promise((r) => setTimeout(r, 15));
        return okHtml(SEARCH_HTML);
      }
      if (u.includes('post-cache')) return okHtml(POST_WITH_MAGNET);
      throw new Error(`Unexpected url: ${u}`);
    }) as unknown as typeof globalThis.fetch;

    // Concorrência se funde em uma raspagem só.
    const [r1, r2] = await Promise.all([bludv.searchPosts('post cache'), bludv.searchPosts('post cache')]);
    assert.equal(r1.length, 1);
    assert.equal(r2.length, 1);
    assert.equal(siteHits, 1, 'buscas simultâneas raspam uma vez');

    // Segunda busca (dentro do TTL) não toca o site.
    const r3 = await bludv.searchPosts('post cache');
    assert.equal(r3.length, 1);
    assert.equal(siteHits, 1, 'cache responde sem re-raspar');

    // A normalização da query faz parte da chave.
    assert.ok(bludv.searchCache.has('search:post cache'));
  });

  test('searchPosts(""): browse do cardigann (Test do Jackett) serve os últimos posts', async () => {
    const HOME_HTML = '<div class="posts"><div class="post">' +
      '<div class="title"><a href="https://bludvfilmes.xyz/post-browse/">Post Browse Torrent</a></div></div></div>';
    const POST_WITH_MAGNET = '<h3>DUAL ÁUDIO</h3>' +
      '<p><a href="magnet:?xt=urn:btih:6666666666666666666666666666666666666666&dn=b">1080p Dublado</a></p>';
    let browseUrl = '';
    globalThis.fetch = (async (url: any) => {
      const u = toStr(url);
      if (u.includes('/?s=')) { browseUrl = u; return okHtml(HOME_HTML); }
      if (u.includes('post-browse')) return okHtml(POST_WITH_MAGNET);
      throw new Error(`Unexpected url: ${u}`);
    }) as unknown as typeof globalThis.fetch;

    const items = await bludv.searchPosts('');
    assert.equal(items.length, 1);
    assert.ok(browseUrl.endsWith('/?s='), 'browse consulta o arquivo do WordPress sem termo');
  });

  test('fetchText: 403 do Cloudflare cai no FlareSolverr e reusa a sessão', async () => {
    let siteFetches = 0;
    let flareCalls = 0;
    let lastHeaders: any;

    globalThis.fetch = (async (url: any, init: any) => {
      const u = toStr(url);
      if (u.includes('bludvfilmes')) {
        siteFetches += 1;
        lastHeaders = init?.headers;
        // 1ª tentativa do site: Cloudflare recusa (desafio JS); 2ª (com cookie)
        // devolve o HTML. O corpo do 403 traz o marcador do desafio para o
        // fetchText reconhecer e derivar ao FlareSolverr.
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
              // Cenário real do 301: o site resolve no domínio novo.
              url: 'https://bludvfilmes1.xyz/?s=exterminio',
              response: '<html>flare</html>',
              userAgent: 'FlareUA/1.0',
              cookies: [{ name: 'cf_clearance', value: 'abc123' }],
            },
          }),
        };
      }
      throw new Error(`Unexpected url: ${u}`);
    }) as unknown as typeof globalThis.fetch;

    const first = await bludv.fetchText('https://bludvfilmes.xyz/?s=exterminio');
    assert.equal(first, '<html>flare</html>', '403 vira response do FlareSolverr');
    assert.equal(flareCalls, 1, 'só um POST no FlareSolverr');
    assert.equal(siteFetches, 1, 'site foi tocado uma vez antes do 403');

    // Sessão memorizada Sob o host PEDIDO (bludvfilmes.xyz) mesmo o FlareSolverr
    // resolvendo no domínio novo — senão o 301 pagaria o browser toda vez.
    const session = bludv.getFlareSession('bludvfilmes.xyz');
    assert.ok(session, 'sessão cf_clearance guardada no host pedido');
    assert.equal(session.userAgent, 'FlareUA/1.0');
    assert.ok(session.cookies.includes('cf_clearance=abc123'));
    assert.ok(bludv.getFlareSession('bludvfilmes1.xyz'), 'sessão também no host resolvido');

    // Segunda chamada do MESMO host reusa o cookie no fetch direto (sem FlareSolverr).
    const second = await bludv.fetchText('https://bludvfilmes.xyz/?s=exterminio');
    assert.equal(second, '<html>resultado</html>');
    assert.equal(flareCalls, 1, 'não re-resolve com cookie válido');
    assert.equal(siteFetches, 2);
    assert.ok(
      String(lastHeaders?.['User-Agent']).includes('FlareUA') && String(lastHeaders?.['Cookie']).includes('cf_clearance'),
      'headers do fetch direto usam a sessão',
    );
  });

  test('fetchText: 403 sem desafio Cloudflare NÃO deriva e mantém erro diagnosticável', async () => {
    let flareCalls = 0;
    globalThis.fetch = (async (url: any) => {
      const u = toStr(url);
      if (u.includes('bludvfilmes')) {
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
      () => bludv.fetchText('https://bludvfilmes.xyz/?s=exterminio'),
      /http_403/,
      '403 sem challenge vira http_403 e não silencia em 0 resultados',
    );
    assert.equal(flareCalls, 0, 'FlareSolverr não é chamado sem desafio Cloudflare');
  });

  test('fetchTextViaFlare: página de erro do origin (522) é rejeitada, não devolvida', async () => {
    globalThis.fetch = (async (url: any) => {
      const u = toStr(url);
      if (u.includes('/v1')) {
        return {
          status: 200,
          ok: true,
          json: async () => ({
            status: 'ok',
            solution: {
              url: 'https://bludvfilmes1.xyz/?s=exterminio',
              status: 200,
              response: 'This page isn\u2019t working. HTTP ERROR 522',
              userAgent: 'FlareUA/1.0',
              cookies: [],
            },
          }),
        };
      }
      if (u.includes('bludvfilmes')) {
        return {
          status: 403,
          ok: false,
          headers: { get: () => null },
          text: async () => 'Just a moment...',
        };
      }
      throw new Error(`Unexpected url: ${u}`);
    }) as unknown as typeof globalThis.fetch;

    await assert.rejects(
      () => bludv.fetchText('https://bludvfilmes.xyz/?s=exterminio'),
      /flare_site_error_page/,
      'página de erro do Chromium é tratada como falha, não como 0 releases',
    );
  });
});
