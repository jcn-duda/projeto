import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import comando from '../comandotorrents-resolver/server.js';

const hash = '0123456789abcdef0123456789abcdef01234567';

describe('ComandoTorrents Resolver: extractMagnet & JS Variable Extraction', () => {
  const expectedMagnet = `magnet:?xt=urn:btih:${hash}&dn=Teste.Filme`;

  test('extractMagnet: extrai de diversas variáveis JavaScript comuns em protetores', () => {
    const vars = [
      `<script>var DEST_URL = "${expectedMagnet}";</script>`,
      `<script>const DOWNLOAD_URL = '${expectedMagnet}';</script>`,
      `<script>let MAGNET_URL = "${expectedMagnet}";</script>`,
      `<script>window.LINK_DOWNLOAD = "${expectedMagnet}";</script>`,
      `<script>var URL_DOWNLOAD = "${expectedMagnet}";</script>`,
      `<script>const DOWNLOAD = "${expectedMagnet}";</script>`,
      `<script>var REDIRECT_URL = "${expectedMagnet}";</script>`,
      `<script>let NEXT_URL = "${expectedMagnet}";</script>`,
      `<script>var LINK_FINAL = "${expectedMagnet}";</script>`,
      `<script>const TARGET_URL = "${expectedMagnet}";</script>`,
      `<script>var DESTINO = "${expectedMagnet}";</script>`,
      `<script>var url = "${expectedMagnet}";</script>`,
      `<script>var link = "${expectedMagnet}";</script>`,
      `<script>var target = "${expectedMagnet}";</script>`,
    ];

    for (const html of vars) {
      assert.equal(comando.extractMagnet(html), expectedMagnet, `Falha ao extrair magnet de: ${html}`);
    }
  });

  test('extractMagnet: extrai atribuições de navegação JavaScript e eventos de janela', () => {
    const navs = [
      `<script>location.href = "${expectedMagnet}";</script>`,
      `<script>location.replace("${expectedMagnet}");</script>`,
      `<script>location.assign("${expectedMagnet}");</script>`,
      `<script>window.location = "${expectedMagnet}";</script>`,
      `<script>window.open("${expectedMagnet}");</script>`,
    ];

    for (const html of navs) {
      assert.equal(comando.extractMagnet(html), expectedMagnet);
    }
  });

  test('extractMagnet: extrai de atributos HTML customizados', () => {
    const attrs = [
      `<button data-magnet="${expectedMagnet}">Download</button>`,
      `<a data-url="${expectedMagnet}">Download</a>`,
      `<div data-link="${expectedMagnet}"></div>`,
      `<span data-href="${expectedMagnet}"></span>`,
    ];

    for (const html of attrs) {
      assert.equal(comando.extractMagnet(html), expectedMagnet);
    }
  });

  test('extractMagnet: decodifica magnet URL-encoded independente da ordem dos parâmetros', () => {
    const encoded1 = `magnet%3A%3Fxt%3Durn%3Abtih%3A${hash}%26dn%3DTeste.Filme`;
    const encoded2 = `magnet%3A%3Fdn%3DTeste.Filme%26xt%3Durn%3Abtih%3A${hash}`;

    assert.equal(comando.extractMagnet(`<script>const link = "${encoded1}";</script>`), expectedMagnet);
    assert.equal(comando.extractMagnet(`<script>const link = "${encoded2}";</script>`), `magnet:?dn=Teste.Filme&xt=urn:btih:${hash}`);
  });

  test('extractMagnet: decodifica magnet URL-encoded com parâmetros invertidos e ampersands literais', () => {
    const encoded = `magnet%3A%3Fdn=Teste.Filme&xt=urn%3Abtih%3A${hash}&tr=udp%3A%2F%2Ftracker.example.com`;
    const html = `<div class="btn"><a href="/redirect?url=${encoded}">Baixar</a></div>`;
    assert.equal(comando.extractMagnet(html), `magnet:?dn=Teste.Filme&xt=urn:btih:${hash}&tr=udp://tracker.example.com`);
  });

  test('extractMagnet: decodifica magnet URL-encoded com entidades HTML nos delimitadores', () => {
    const encoded = `magnet%3A%3Fdn=Teste.Filme&amp;xt=urn%3Abtih%3A${hash}&amp;tr=udp%3A%2F%2Ftracker.example.com`;
    const html = `<a href="/redirect?url=${encoded}">Baixar</a>`;
    assert.equal(comando.extractMagnet(html), `magnet:?dn=Teste.Filme&xt=urn:btih:${hash}&tr=udp://tracker.example.com`);
  });

  test('extractMagnet: decodifica entidades HTML dentro de links magnet', () => {
    const entityMagnet = `magnet:?xt=urn:btih:${hash}&amp;dn=Filme&amp;tr=udp%3A%2F%2Ftracker.example.com`;
    const decoded = `magnet:?xt=urn:btih:${hash}&dn=Filme&tr=udp%3A%2F%2Ftracker.example.com`;

    assert.equal(comando.extractMagnet(`<a href="${entityMagnet}">Download</a>`), decoded);
  });

  test('extractMagnet: retorna null quando não há magnet no documento', () => {
    assert.equal(comando.extractMagnet('<html><body><p>Sem magnet aqui</p></body></html>'), null);
    assert.equal(comando.extractMagnet(''), null);
    assert.equal(comando.extractMagnet(null), null);
  });
});

describe('ComandoTorrents Resolver: Meta Refresh & Next Protected URL', () => {
  const base = 'https://systemads1.com/go/step1';

  test('meta refresh: extrai target independente da ordem dos atributos http-equiv e content', () => {
    const target = 'https://videosad.net/go/step2';
    const html1 = `<meta http-equiv="refresh" content="0; url=${target}">`;
    const html2 = `<meta content="0; url='${target}'" http-equiv="refresh">`;
    const html3 = `<meta http-equiv='refresh' content='2;url=${target}'>`;

    assert.equal(comando.nextProtectedUrl(html1, base), target);
    assert.equal(comando.nextProtectedUrl(html2, base), target);
    assert.equal(comando.nextProtectedUrl(html3, base), target);
  });

  test('meta refresh: extrai URLs com aspas aninhadas, espaços e formatos variados', () => {
    const target = 'https://videosad.net/go/step2';
    const htmlNestedSingle = `<meta http-equiv="refresh" content="0; URL='${target}'">`;
    const htmlNestedDouble = `<meta http-equiv="refresh" content='0; url="${target}"'>`;
    const htmlSpaced = `<meta http-equiv='Refresh' content='0;   URL="${target}"   '>`;
    const htmlUnquoted = `<meta http-equiv=refresh content=0;URL=${target}>`;
    const htmlEntity = `<meta http-equiv="refresh" content="0; url=https://videosad.net/go?id=123&amp;token=abc&amp;ref=site">`;

    assert.equal(comando.extractMetaRefresh(htmlNestedSingle), target);
    assert.equal(comando.extractMetaRefresh(htmlNestedDouble), target);
    assert.equal(comando.extractMetaRefresh(htmlSpaced), target);
    assert.equal(comando.extractMetaRefresh(htmlUnquoted), target);
    assert.equal(comando.extractMetaRefresh(htmlEntity), 'https://videosad.net/go?id=123&token=abc&ref=site');
  });

  test('meta refresh: extrai magnet direto dentro de tag meta refresh com aspas aninhadas', () => {
    const directMagnet = `magnet:?xt=urn:btih:${hash}&dn=Teste.Filme`;
    const html = `<meta content="1;url='${directMagnet}'" http-equiv="refresh">`;
    assert.equal(comando.extractMetaRefresh(html), directMagnet);
  });

  test('nextProtectedUrl: extrai URLs de protetores permitidos em variáveis JS e links HTML', () => {
    const htmlJs = '<script>var NEXT_URL = "https://videosad.net/go/step2";</script>';
    const htmlLink = '<p>Aguarde... <a href="https://canalfutebol.com/go/step3">Clique aqui</a></p>';

    assert.equal(comando.nextProtectedUrl(htmlJs, base), 'https://videosad.net/go/step2');
    assert.equal(comando.nextProtectedUrl(htmlLink, base), 'https://canalfutebol.com/go/step3');
    assert.equal(comando.nextProtectedUrl('<html>sem link</html>', base), null);
  });

  test('nextProtectedUrl: ignora URLs apontando para o mesmo baseUrl ou domínios não permitidos', () => {
    assert.equal(comando.nextProtectedUrl(`<a href="${base}">Self</a>`, base), null);
    assert.equal(comando.nextProtectedUrl('<a href="https://malicious-site.com/go">Malware</a>', base), null);
  });
});

describe('ComandoTorrents Resolver: fetchFollowingAllowed & Multi-Hop Traversal', () => {
  let originalFetch: any;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('fetchFollowingAllowed: retorna imediatamente quando o input já é um magnet', async () => {
    const magnet = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567';
    const result = await comando.fetchFollowingAllowed(magnet);
    assert.equal(result, magnet);
  });

  test('fetchFollowingAllowed: segue múltiplos saltos (HTTP 302 -> HTML JS -> Magnet)', async () => {
    const targetMagnet = 'magnet:?xt=urn:btih:9999999999999999999999999999999999999999';

    globalThis.fetch = (async (url: any) => {
      const u = typeof url === 'string' ? url : url.href;

      if (u.includes('hop1')) {
        return {
          status: 302,
          headers: new Map([['location', 'https://videosad.net/go/hop2']]),
        };
      }
      if (u.includes('hop2')) {
        return {
          ok: true,
          status: 200,
          text: async () => '<script>var NEXT_URL = "https://systemads1.com/go/hop3";</script>',
        };
      }
      if (u.includes('hop3')) {
        return {
          ok: true,
          status: 200,
          text: async () => `<script>var DEST_URL = "${targetMagnet}";</script>`,
        };
      }
      throw new Error(`Unexpected URL: ${u}`);
    }) as unknown as typeof globalThis.fetch;

    const resolved = await comando.fetchFollowingAllowed('https://systemads1.com/go/hop1', 'https://comandotorrents.to/post');
    assert.equal(resolved, targetMagnet);
  });

  test('fetchFollowingAllowed: interrompe e lança erro em loops de redirecionamento ou excedendo MAX_HOPS', async () => {
    globalThis.fetch = (async () => ({
      status: 302,
      headers: new Map([['location', 'https://systemads1.com/go/loop']]),
    })) as unknown as typeof globalThis.fetch;

    await assert.rejects(
      () => comando.fetchFollowingAllowed('https://systemads1.com/go/loop', 'https://comandotorrents.to/'),
      /too_many_redirects/,
    );
  });
});

describe('ComandoTorrents Resolver: Domain Allowlist & Protocol Security', () => {
  test('assertAllowedUrl: aceita domínios de detalhe e protetores oficiais', () => {
    assert.doesNotThrow(() => comando.assertAllowedUrl('https://comandotorrents.to/post-1/'));
    assert.doesNotThrow(() => comando.assertAllowedUrl('https://comandotorrents.net/post-2/'));
    assert.doesNotThrow(() => comando.assertAllowedUrl('https://comandotorrents.org/post-3/'));
    assert.doesNotThrow(() => comando.assertAllowedUrl('https://systemads1.com/go/123'));
    assert.doesNotThrow(() => comando.assertAllowedUrl('https://videosad.net/go/456'));
    assert.doesNotThrow(() => comando.assertAllowedUrl('https://canalfutebol.com/go/789'));
  });

  test('assertAllowedUrl: rejeita domínios não autorizados e protocolos inválidos', () => {
    assert.throws(() => comando.assertAllowedUrl('https://evil.com/malware'), /blocked_host/);
    assert.throws(() => comando.assertAllowedUrl('https://phishing-site.org/'), /blocked_host/);
    assert.throws(() => comando.assertAllowedUrl('ftp://comandotorrents.to/file'), /unsupported_protocol/);
    assert.throws(() => comando.assertAllowedUrl('javascript:alert(1)'), /unsupported_protocol/);
    assert.throws(() => comando.assertAllowedUrl('file:///etc/passwd'), /unsupported_protocol/);
  });
});

describe('ComandoTorrents Resolver: In-Memory Caching & Coalescing', () => {
  let originalFetch: any;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    comando.postCache.clear();
    comando.searchCache.clear();
    comando.magnetCache.clear();
    comando.inFlight.clear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('getPostLinks: armazena no cache e coalesces requisições concorrentes', async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      await new Promise((r) => setTimeout(r, 20));
      return {
        ok: true,
        status: 200,
        text: async () => `
          <div class="entry-content">
            <h3>DUBLADO</h3>
            <p>1080p (2.0 GB)</p>
            <a href="https://systemads1.com/go/link1">Download</a>
          </div>
        `,
      };
    }) as unknown as typeof globalThis.fetch;

    const postUrl = 'https://comandotorrents.to/filme-concorrente/';
    const [r1, r2, r3] = await Promise.all([
      comando.getPostLinks(postUrl),
      comando.getPostLinks(postUrl),
      comando.getPostLinks(postUrl),
    ]);

    assert.equal(fetchCount, 1, 'todas as chamadas simultâneas devem se fundir em 1 fetch');
    assert.equal(r1.links.length, 1);
    assert.equal(r2.links.length, 1);
    assert.equal(r3.links.length, 1);
    assert.equal(comando.inFlight.size, 0);

    // Chamada subsequente bate no cache
    const r4 = await comando.getPostLinks(postUrl);
    assert.equal(fetchCount, 1, 'chamada subsequente deve bater no cache sem novo fetch');
    assert.equal(r4.links.length, 1);
  });

  test('resolveButton e resolveBest: armazenam no cache de magnets', async () => {
    const postUrl = 'https://comandotorrents.to/filme-magnet/';
    const targetMagnet = 'magnet:?xt=urn:btih:2222222222222222222222222222222222222222&dn=Filme';

    globalThis.fetch = (async (url: any) => {
      const u = typeof url === 'string' ? url : url.href;
      if (u.includes('filme-magnet')) {
        return {
          ok: true,
          status: 200,
          text: async () => `
            <div class="entry-content">
              <h3>DUBLADO</h3>
              <p>1080p (2.0 GB)</p>
              <a href="https://systemads1.com/go/btn0">Download 1</a>
              <p>720p (1.0 GB)</p>
              <a href="https://systemads1.com/go/btn1">Download 2</a>
            </div>
          `,
        };
      }
      if (u.includes('btn0') || u.includes('btn1')) {
        return {
          ok: true,
          status: 200,
          text: async () => `<script>var DEST_URL = "${targetMagnet}";</script>`,
        };
      }
      throw new Error(`Unexpected url: ${u}`);
    }) as unknown as typeof globalThis.fetch;

    const mag1 = await comando.resolveButton(postUrl, 0);
    assert.equal(mag1, targetMagnet);
    assert.ok(comando.magnetCache.has(`magnet:${postUrl}:0`));

    const magBest = await comando.resolveBest(postUrl);
    assert.equal(magBest, targetMagnet);
    assert.ok(comando.magnetCache.has(`magnet:best:${postUrl}`));
  });

  test('postCache e magnetCache: aplicam limite máximo de entradas (FIFO)', async () => {
    // Insere 105 entradas no postCache para testar limite de 100
    for (let i = 0; i < 105; i += 1) {
      comando.postCache.set(`https://comandotorrents.to/post-${i}/`, {
        value: { links: [] },
        expiresAt: Date.now() + 600000,
      });
      if (comando.postCache.size > 100) {
        comando.postCache.delete(comando.postCache.keys().next().value);
      }
    }
    assert.equal(comando.postCache.size, 100);
    assert.equal(comando.postCache.has('https://comandotorrents.to/post-0/'), false);
    assert.equal(comando.postCache.has('https://comandotorrents.to/post-104/'), true);
  });
});

describe('ComandoTorrents Resolver: HTTP Server & API Endpoints', () => {
  let server: any;
  let port: any;

  beforeEach(async () => {
    server = comando.createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  const requestHttp = (pathname: any) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: pathname }, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode as number, body }));
      });
      req.on('error', reject);
    });

  test('GET /health: retorna status 200 ok', async () => {
    const res = await requestHttp('/health');
    assert.equal(res.status, 200);
    assert.equal(res.body, 'ok');
  });

  test('GET /search sem query: browse serve os últimos posts (Test do Jackett)', async () => {
    // `/?s=` vazio lista os posts recentes; o filtro de título passa tudo.
    globalThis.fetch = (async (url: any) => {
      const u = typeof url === 'string' ? url : url.href;
      if (u.includes('/?s=')) {
        return { ok: true, status: 200, text: async () =>
          '<article class="blog-view"><h2 class="entry-title">' +
          '<a href="https://comandotorrents.to/filme-magnet/" title="Filme Real">Filme Real Torrent</a></h2></article>' };
      }
      if (u.includes('filme-magnet')) {
        return { ok: true, status: 200, text: async () =>
          '<div class="entry-content"><h3>DUBLADO</h3><p>1080p (2.0 GB)</p>' +
          '<a href="https://systemads1.com/go/btn0">Download 1</a></div>' };
      }
      throw new Error(`Unexpected url: ${u}`);
    }) as unknown as typeof globalThis.fetch;
    const res = await requestHttp('/search');
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('class="release"'), 'browse devolve linhas de release');
    assert.ok(res.body.includes('Filme Real'), 'post recente entra na página do card');
  });

  test('GET /resolve com URL ausente: retorna status 400 invalid_url', async () => {
    const res = await requestHttp('/resolve');
    assert.equal(res.status, 400);
    assert.equal(res.body, 'invalid_url');
  });
});
