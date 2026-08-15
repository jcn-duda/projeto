const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const bludv = require('../bludv-resolver/server');
const comando = require('../comandotorrents-resolver/server');
const nerd = require('../nerdfilmes-resolver/server');
const tdf = require('../torrentdosfilmes-resolver/server');
const brResolvers = require('../src/br-resolvers');
const config = require('../src/config');

describe('Feature 1: Dynamic Domain Validation', () => {
  test('bludv: valida domínios padrão, subdomínios e fallbacks', () => {
    assert.doesNotThrow(() => bludv.assertAllowedUrl('https://bludvfilmes.xyz/post-1/'));
    assert.doesNotThrow(() => bludv.assertAllowedUrl('https://sub.bludv.net/post-2/'));
    assert.doesNotThrow(() => bludv.assertAllowedUrl('https://bludv.to/post-3/'));
    assert.doesNotThrow(() => bludv.assertAllowedUrl('https://systemads1.com/go/123'));
    assert.equal(bludv.isDetailHost('bludvfilmes.xyz'), true);
    assert.equal(bludv.isDetailHost('sub.bludv.net'), true);
    assert.equal(bludv.isDetailHost('bludv.to'), true);
    assert.equal(bludv.isDetailHost('systemads1.com'), false); // protetor não é post de detalhe
  });

  test('comandotorrents: valida domínios permitidos e rejeita hosts estranhos', () => {
    assert.doesNotThrow(() => comando.assertAllowedUrl('https://comandotorrents.to/filme-1/'));
    assert.doesNotThrow(() => comando.assertAllowedUrl('https://comandotorrents.net/filme-2/'));
    assert.equal(comando.isDetailHost('comandotorrents.to'), true);
    assert.equal(comando.isDetailHost('comandotorrents.net'), true);
    assert.equal(comando.isDetailHost('malicious-site.com'), false);

    assert.throws(() => comando.assertAllowedUrl('https://evil.org/malware'), /blocked_host/);
    assert.throws(() => comando.assertAllowedUrl('ftp://comandotorrents.to/file'), /unsupported_protocol/);
    assert.throws(() => comando.assertAllowedUrl('javascript:alert(1)'), /unsupported_protocol/);
  });

  test('nerdfilmes: isDetailHost aceita mirrors históricos e rejeita protetores ou domínios de terceiros', () => {
    assert.equal(nerd.isDetailHost('xnerdfilmes.net'), true);
    assert.equal(nerd.isDetailHost('www.xnerdfilmes.net'), true);
    assert.equal(nerd.isDetailHost('nerdfilmestorrent.com'), true);
    assert.equal(nerd.isDetailHost('nerdfilmestorrent.org'), true);
    assert.equal(nerd.isDetailHost('videosad.net'), false);
    assert.equal(nerd.isDetailHost('google.com'), false);
  });

  test('torrentdosfilmes: isDetailHost e assertAllowedUrl tratam domínios e protocolos com segurança', () => {
    assert.equal(tdf.isDetailHost('torrentdosfilmes-v2.xyz'), true);
    assert.equal(tdf.isDetailHost('torrentdosfilmes.com'), true);
    assert.equal(tdf.isDetailHost('canalfutebol.com'), false);
    assert.doesNotThrow(() => tdf.assertAllowedUrl('https://torrentdosfilmes-v2.xyz/post/'));
    assert.throws(() => tdf.assertAllowedUrl('http://unknown-tracker.com/'), /blocked_host/);
  });
});

describe('Feature 2: In-Memory Caching & Request Coalescing', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    bludv.postCache.clear();
    bludv.inFlight.clear();
    comando.postCache.clear();
    comando.inFlight.clear();
    tdf.postCache.clear();
    tdf.inFlight.clear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('bludv: getPostLinks armazena no cache e evita requisições redundantes', async () => {
    let fetchCount = 0;
    globalThis.fetch = async (url) => {
      fetchCount += 1;
      return {
        ok: true,
        status: 200,
        text: async () => `
          <div class="post-single">
            <h3>VERSÃO MKV DUAL ÁUDIO</h3>
            <p>1080p (2.0 GB)</p>
            <a href="https://systemads1.com/go/link1">Magnet-Link</a>
          </div>
        `,
      };
    };

    const postUrl = 'https://bludvfilmes.xyz/filme-teste/';
    const res1 = await bludv.getPostLinks(postUrl);
    const res2 = await bludv.getPostLinks(postUrl);

    assert.equal(fetchCount, 1, 'segunda chamada deve bater no cache sem disparar fetch');
    assert.equal(res1.links.length, 1);
    assert.equal(res2.links.length, 1);
    assert.equal(res1.links[0].url, 'https://systemads1.com/go/link1');
  });

  test('bludv: getPostLinks expira após TTL e efetua nova busca', async () => {
    let fetchCount = 0;
    globalThis.fetch = async () => {
      fetchCount += 1;
      return {
        ok: true,
        status: 200,
        text: async () => '<div class="post-single"><a href="https://systemads1.com/go/test">Link</a></div>',
      };
    };

    const postUrl = 'https://bludvfilmes.xyz/filme-expiravel/';
    await bludv.getPostLinks(postUrl);
    assert.equal(fetchCount, 1);

    // Simula expiração forçando expiresAt no passado
    const entry = bludv.postCache.get(new URL(postUrl).href);
    assert.ok(entry);
    entry.expiresAt = Date.now() - 1000;

    await bludv.getPostLinks(postUrl);
    assert.equal(fetchCount, 2, 'após expiração do TTL, deve realizar novo fetch');
  });

  test('bludv: getPostLinks coalesces requisições concorrentes via inFlight', async () => {
    let fetchCount = 0;
    globalThis.fetch = async () => {
      fetchCount += 1;
      await new Promise((r) => setTimeout(r, 20));
      return {
        ok: true,
        status: 200,
        text: async () => '<div class="post-single"><a href="https://systemads1.com/go/concurrent">Link</a></div>',
      };
    };

    const postUrl = 'https://bludvfilmes.xyz/filme-concorrente/';
    const [r1, r2, r3, r4, r5] = await Promise.all([
      bludv.getPostLinks(postUrl),
      bludv.getPostLinks(postUrl),
      bludv.getPostLinks(postUrl),
      bludv.getPostLinks(postUrl),
      bludv.getPostLinks(postUrl),
    ]);

    assert.equal(fetchCount, 1, 'todas as 5 requisições concorrentes devem se fundir em 1 fetch');
    assert.equal(r1.links[0].url, 'https://systemads1.com/go/concurrent');
    assert.equal(r5.links[0].url, 'https://systemads1.com/go/concurrent');
    assert.equal(bludv.inFlight.size, 0, 'inFlight map deve ser limpo no finally');
  });

  test('comandotorrents e torrentdosfilmes: inFlight coalescing para requisições concorrentes', async () => {
    let ctFetchCount = 0;
    globalThis.fetch = async () => {
      ctFetchCount += 1;
      await new Promise((r) => setTimeout(r, 15));
      return {
        ok: true,
        status: 200,
        text: async () => '<article class="blog-view"><a href="https://videosad.net/go/ct">Download</a></article>',
      };
    };

    const ctUrl = 'https://comandotorrents.to/filme-ct/';
    await Promise.all([
      comando.getPostLinks(ctUrl),
      comando.getPostLinks(ctUrl),
      comando.getPostLinks(ctUrl),
    ]);
    assert.equal(ctFetchCount, 1);
    assert.equal(comando.inFlight.size, 0);

    let tdfFetchCount = 0;
    globalThis.fetch = async () => {
      tdfFetchCount += 1;
      await new Promise((r) => setTimeout(r, 15));
      return {
        ok: true,
        status: 200,
        text: async () => '<div><a href="https://systemads1.com/go/tdf">Download</a></div>',
      };
    };

    const tdfUrl = 'https://torrentdosfilmes-v2.xyz/filme-tdf/';
    await Promise.all([
      tdf.getPostLinks(tdfUrl),
      tdf.getPostLinks(tdfUrl),
    ]);
    assert.equal(tdfFetchCount, 1);
    assert.equal(tdf.inFlight.size, 0);
  });
});

describe('Feature 3: Standardized siteEnv Configuration & src/config.js', () => {
  test('brResolvers exporta matriz RESOLVERS com 4 entradas padronizadas', () => {
    assert.equal(brResolvers.RESOLVERS.length, 4);
    const names = brResolvers.RESOLVERS.map((r) => r.name);
    assert.deepEqual(names, ['bludv', 'comandotorrents', 'nerdfilmes', 'torrentdosfilmes']);

    const envs = brResolvers.RESOLVERS.map((r) => r.siteEnv);
    assert.deepEqual(envs, [
      'BLUDV_URL',
      'COMANDOTORRENTS_URL',
      'NERDFILMES_URL',
      'TORRENTDOSFILMES_URL',
    ]);
  });

  test('src/config.js contém seção resolvers com URLs e extraProtectors', () => {
    assert.ok(config.resolvers);
    assert.equal(typeof config.resolvers.embedded, 'boolean');
    assert.ok(config.resolvers.host);
    assert.ok(config.resolvers.bludvUrl);
    assert.ok(config.resolvers.comandotorrentsUrl);
    assert.ok(config.resolvers.nerdfilmesUrl);
    assert.ok(config.resolvers.torrentdosfilmesUrl);
    assert.ok(Array.isArray(config.resolvers.extraProtectors));
  });
});

describe('Feature 4: Universal extractMagnet & Link Protector Traversal', () => {
  test('extractMagnet: extrai variáveis JavaScript com magnet', () => {
    const hash = '0123456789abcdef0123456789abcdef01234567';
    const targetMagnet = `magnet:?xt=urn:btih:${hash}&dn=Teste`;

    const htmlDest = `<script>var DEST_URL = "${targetMagnet}";</script>`;
    const htmlDownload = `<script>const DOWNLOAD_URL = '${targetMagnet}';</script>`;
    const htmlMagnetVar = `<script>let MAGNET_URL = "${targetMagnet}";</script>`;
    const htmlUrlVar = `<script>var url = "${targetMagnet}";</script>`;
    const htmlLinkVar = `<script>window.link = "${targetMagnet}";</script>`;
    const htmlTargetVar = `<script>const target = "${targetMagnet}";</script>`;

    assert.equal(bludv.extractMagnet(htmlDest), targetMagnet);
    assert.equal(comando.extractMagnet(htmlDownload), targetMagnet);
    assert.equal(nerd.extractMagnet(htmlMagnetVar), targetMagnet);
    assert.equal(tdf.extractMagnet(htmlUrlVar), targetMagnet);
    assert.equal(bludv.extractMagnet(htmlLinkVar), targetMagnet);
    assert.equal(comando.extractMagnet(htmlTargetVar), targetMagnet);
  });

  test('extractMagnet: extrai navegação JavaScript e atributos HTML', () => {
    const magnet = 'magnet:?xt=urn:btih:abcdefabcdefabcdefabcdefabcdefabcdefabcd';
    const htmlNav1 = `<script>location.href = "${magnet}";</script>`;
    const htmlNav2 = `<script>window.open("${magnet}");</script>`;
    const htmlAttr1 = `<button data-magnet="${magnet}">Baixar</button>`;
    const htmlAttr2 = `<div data-url="${magnet}"></div>`;

    assert.equal(bludv.extractMagnet(htmlNav1), magnet);
    assert.equal(nerd.extractMagnet(htmlNav2), magnet);
    assert.equal(tdf.extractMagnet(htmlAttr1), magnet);
    assert.equal(comando.extractMagnet(htmlAttr2), magnet);
  });

  test('extractMagnet: decodifica magnet URL-encoded', () => {
    const encoded = 'magnet%3A%3Fxt%3Durn%3Abtih%3A1122334455667788990011223344556677889900%26dn%3DObra';
    const expected = 'magnet:?xt=urn:btih:1122334455667788990011223344556677889900&dn=Obra';
    const html = `<script>const encoded = "${encoded}";</script>`;

    assert.equal(bludv.extractMagnet(html), expected);
    assert.equal(nerd.extractMagnet(html), expected);
  });

  test('nextProtectedUrl: detecta próximo salto em variável JS e link HTML', () => {
    const base = 'https://systemads1.com/go/step1';
    const htmlJs = '<script>var DEST_URL = "https://videosad.net/go/step2";</script>';
    const htmlLink = '<p>Carregando... <a href="https://canalfutebol.com/go/step3">Clique aqui</a></p>';

    assert.equal(bludv.nextProtectedUrl(htmlJs, base), 'https://videosad.net/go/step2');
    assert.equal(nerd.nextProtectedUrl(htmlLink, base), 'https://canalfutebol.com/go/step3');
    assert.equal(tdf.nextProtectedUrl('<html>sem link</html>', base), null);
  });

  test('fetchFollowingAllowed: segue múltiplos saltos até encontrar o magnet', async () => {
    const expectedMagnet = 'magnet:?xt=urn:btih:deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

    let step = 0;
    globalThis.fetch = async (url) => {
      const u = typeof url === 'string' ? url : url.href;
      step += 1;

      if (u.includes('step1')) {
        // Salto 1: Retorna HTML apontando para salto 2
        return {
          ok: true,
          status: 200,
          text: async () => '<script>var NEXT_URL = "https://systemads1.com/go/step2";</script>',
        };
      }
      if (u.includes('step2')) {
        // Salto 2: Retorna 302 redirecionando para salto 3
        return {
          status: 302,
          headers: new Map([['location', 'https://videosad.net/go/step3']]),
        };
      }
      if (u.includes('step3')) {
        // Salto 3: Retorna HTML final com o magnet
        return {
          ok: true,
          status: 200,
          text: async () => `<script>var DEST_URL = "${expectedMagnet}";</script>`,
        };
      }
      throw new Error(`Unexpected url: ${u}`);
    };

    const resolved = await bludv.fetchFollowingAllowed('https://systemads1.com/go/step1', 'https://bludvfilmes.xyz/post');
    assert.equal(resolved, expectedMagnet);
  });

  test('fetchFollowingAllowed: interrompe e lança erro quando atinge loop de redirecionamentos', async () => {
    globalThis.fetch = async () => ({
      status: 302,
      headers: new Map([['location', 'https://systemads1.com/go/loop']]),
    });

    await assert.rejects(
      () => bludv.fetchFollowingAllowed('https://systemads1.com/go/loop', 'https://bludvfilmes.xyz/'),
      /too_many_redirects/,
    );
  });
});

describe('Encerramento: load() sobe os quatro e close() os derruba', () => {
  // O shutdown do addon chama brResolvers.close(). Se ele não fechar de fato,
  // o `server.close()` do Express drena e o processo fica preso nesses quatro
  // sockets até o timeout de 5s do fallback — e no Docker, até o SIGKILL.
  //
  // O offset existe para não disputar as portas 8700-8703 com uma instância
  // real de pé na mesma máquina (é o caso do ambiente de desenvolvimento).
  const OFFSET = 1200;
  const PORTAS = [8700, 8701, 8702, 8703].map((p) => p + OFFSET);

  // node:http de propósito, e não fetch: os testes acima dublam globalThis.fetch
  // e um dublê vazando para cá responderia por servidor que nem está de pé.
  const responde = (porta) =>
    new Promise((resolve) => {
      const req = require('node:http').get(
        { host: '127.0.0.1', port: porta, path: '/health', timeout: 1500 },
        (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        },
      );
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve(false));
    });

  test('as quatro portas respondem depois do load e param depois do close', async () => {
    const saved = {
      offset: process.env.BR_RESOLVERS_PORT_OFFSET,
      host: process.env.BR_RESOLVERS_HOST,
      embedded: process.env.BR_RESOLVERS_EMBEDDED,
    };
    process.env.BR_RESOLVERS_PORT_OFFSET = String(OFFSET);
    process.env.BR_RESOLVERS_HOST = '127.0.0.1';
    process.env.BR_RESOLVERS_EMBEDDED = 'true';

    try {
      brResolvers.load();
      await new Promise((r) => setTimeout(r, 500));
      assert.deepEqual(
        await Promise.all(PORTAS.map(responde)),
        [true, true, true, true],
        'load() tem que abrir os quatro',
      );

      brResolvers.close();
      await new Promise((r) => setTimeout(r, 500));
      assert.deepEqual(
        await Promise.all(PORTAS.map(responde)),
        [false, false, false, false],
        'close() tem que fechar os quatro',
      );

      // O shutdown pode ser chamado duas vezes (SIGTERM seguido de SIGINT, ou o
      // fallback correndo junto): a segunda não pode estourar.
      assert.doesNotThrow(() => brResolvers.close());
    } finally {
      brResolvers.close();
      for (const [chave, valor] of Object.entries({
        BR_RESOLVERS_PORT_OFFSET: saved.offset,
        BR_RESOLVERS_HOST: saved.host,
        BR_RESOLVERS_EMBEDDED: saved.embedded,
      })) {
        if (valor === undefined) delete process.env[chave];
        else process.env[chave] = valor;
      }
    }
  });
});
