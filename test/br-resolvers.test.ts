import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import bludv from '../bludv-resolver/server.js';
import comando from '../comandotorrents-resolver/server.js';
import nerd from '../nerdfilmes-resolver/server.js';
import tdf from '../torrentdosfilmes-resolver/server.js';
import * as brResolvers from '../src/br-resolvers.js';
import config from '../src/config.js';

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
  let originalFetch: any;

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
    globalThis.fetch = (async (url: any) => {
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
    }) as unknown as typeof globalThis.fetch;

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
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return {
        ok: true,
        status: 200,
        text: async () => '<div class="post-single"><a href="https://systemads1.com/go/test">Link</a></div>',
      };
    }) as unknown as typeof globalThis.fetch;

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
    globalThis.fetch = (async () => {
      fetchCount += 1;
      await new Promise((r) => setTimeout(r, 20));
      return {
        ok: true,
        status: 200,
        text: async () => '<div class="post-single"><a href="https://systemads1.com/go/concurrent">Link</a></div>',
      };
    }) as unknown as typeof globalThis.fetch;

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
    globalThis.fetch = (async () => {
      ctFetchCount += 1;
      await new Promise((r) => setTimeout(r, 15));
      return {
        ok: true,
        status: 200,
        text: async () => '<article class="blog-view"><a href="https://videosad.net/go/ct">Download</a></article>',
      };
    }) as unknown as typeof globalThis.fetch;

    const ctUrl = 'https://comandotorrents.to/filme-ct/';
    await Promise.all([
      comando.getPostLinks(ctUrl),
      comando.getPostLinks(ctUrl),
      comando.getPostLinks(ctUrl),
    ]);
    assert.equal(ctFetchCount, 1);
    assert.equal(comando.inFlight.size, 0);

    let tdfFetchCount = 0;
    globalThis.fetch = (async () => {
      tdfFetchCount += 1;
      await new Promise((r) => setTimeout(r, 15));
      return {
        ok: true,
        status: 200,
        text: async () => '<div><a href="https://systemads1.com/go/tdf">Download</a></div>',
      };
    }) as unknown as typeof globalThis.fetch;

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

  // A invariante que faltava. `config.resolvers.*Url` não era lido por
  // ninguém: no modo embutido (o padrão) cada resolvedor caía no default
  // hardcoded do próprio server.js, então os dois podiam divergir em silêncio
  // e trocar o domínio em config.ts não mudava nada. Sem env, os dois lados
  // têm que resolver para o MESMO host.
  test('o domínio ativo de cada resolvedor bate com o default de config.js', () => {
    const host = (url: string) => new URL(String(url)).hostname.replace(/^www\./, '');
    assert.equal(host(bludv.siteSelector.url()), host(config.resolvers.bludvUrl));
    assert.equal(host(comando.siteSelector.url()), host(config.resolvers.comandotorrentsUrl));
    assert.equal(host(nerd.siteSelector.url()), host(config.resolvers.nerdfilmesUrl));
    assert.equal(host(tdf.siteSelector.url()), host(config.resolvers.torrentdosfilmesUrl));
  });

  // BLUDV_URL alimenta DOIS consumidores: o resolvedor embutido e o scraper
  // direto (src/providers/bludv.ts). Os defaults tinham divergido
  // (bludvfilmes.xyz x bludv.net) -- sem a env, cada um buscava em um site.
  test('bludv: resolvedor embutido e scraper direto apontam para o mesmo site', () => {
    const host = (url: string) => new URL(String(url)).hostname.replace(/^www\./, '');
    assert.equal(host(config.bludv.baseUrl), host(config.resolvers.bludvUrl));
  });

  // O painel mostrava a env crua: null com o default valendo, e o host antigo
  // depois que o failover troca de domínio.
  test('activeSite devolve o host configurado mesmo sem env e sem carga', () => {
    for (const resolver of brResolvers.RESOLVERS) {
      const active = brResolvers.activeSite(resolver.name);
      assert.ok(active, `activeSite('${resolver.name}') não pode ser vazio`);
    }
    assert.equal(brResolvers.activeSite('inexistente'), null);
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
    globalThis.fetch = (async (url: any) => {
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
    }) as unknown as typeof globalThis.fetch;

    const resolved = await bludv.fetchFollowingAllowed('https://systemads1.com/go/step1', 'https://bludvfilmes.xyz/post');
    assert.equal(resolved, expectedMagnet);
  });

  test('fetchFollowingAllowed: interrompe e lança erro quando atinge loop de redirecionamentos', async () => {
    globalThis.fetch = (async () => ({
      status: 302,
      headers: new Map([['location', 'https://systemads1.com/go/loop']]),
    })) as unknown as typeof globalThis.fetch;

    await assert.rejects(
      () => bludv.fetchFollowingAllowed('https://systemads1.com/go/loop', 'https://bludvfilmes.xyz/'),
      /too_many_redirects/,
    );
  });
});

describe('Feature 5: Failover dinâmico de domínio (siteSelector)', () => {
  let originalFetch: any;
  let savedTtl: any;
  let savedFails: any;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    savedTtl = process.env.BR_DOMAIN_PROBE_TTL_MS;
    savedFails = process.env.BR_DOMAIN_FAILS_BEFORE_PROBE;
    // A factory lê a env NA CRIAÇÃO: instâncias de teste nascem com estes
    // valores, enquanto o singleton (criado no require) segue com os do
    // operador — o teste não vaza estado para o resto da suíte.
    process.env.BR_DOMAIN_FAILS_BEFORE_PROBE = '2';
    process.env.BR_DOMAIN_PROBE_TTL_MS = String(30 * 60_000);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const [chave, valor] of Object.entries({
      BR_DOMAIN_PROBE_TTL_MS: savedTtl,
      BR_DOMAIN_FAILS_BEFORE_PROBE: savedFails,
    })) {
      if (valor === undefined) delete process.env[chave];
      else process.env[chave] = valor;
    }
  });

  test('isNetworkError: só DNS/conexão/timeout conta como falha de domínio', () => {
    assert.equal(bludv.isNetworkError(new Error('http_503')), false);
    assert.equal(bludv.isNetworkError(new Error('blocked_host')), false);
    assert.equal(bludv.isNetworkError(new Error('no_magnet')), false);
    assert.equal(bludv.isNetworkError(new TypeError('fetch failed')), true);
    assert.equal(
      bludv.isNetworkError(new Error('The operation was aborted due to timeout')),
      true,
    );
    assert.equal(bludv.isNetworkError(null), false);
  });

  test('probe troca para o primeiro candidato vivo após N falhas de rede', async () => {
    const hits: string[] = [];
    globalThis.fetch = (async (url: any) => {
      const target = String(url);
      hits.push(target);
      if (target.startsWith('https://down.example')) throw new TypeError('fetch failed');
      return { ok: true, status: 200, text: async () => '' };
    }) as unknown as typeof globalThis.fetch;

    const selector = bludv.createSiteSelector(
      '[test]',
      '',
      'https://down.example',
      ['live-a.example', 'live-b.example'],
    );
    const changes: string[] = [];
    selector.onDomainChange((url: any) => changes.push(url));

    assert.equal(selector.url(), 'https://down.example');

    await selector.noteFailure();
    assert.equal(selector.url(), 'https://down.example');
    assert.equal(hits.length, 0, 'abaixo do limiar de falhas não há probe');

    await selector.noteFailure(); // 2ª falha: dispara o probe
    assert.equal(selector.url(), 'https://live-a.example');
    assert.deepEqual(changes, ['https://live-a.example']);
    assert.ok(
      hits.some((url) => url.startsWith('https://live-a.example/?s=')),
      'probe usa a busca WordPress /?s=',
    );
  });

  test('TTL do vencedor: falhas dentro da imunidade não re-sondam', async () => {
    let probes = 0;
    globalThis.fetch = (async (url: any) => {
      const target = String(url);
      if (target.includes('/?s=teste')) probes += 1;
      if (target.startsWith('https://a.example')) throw new TypeError('fetch failed');
      return { ok: true, status: 200, text: async () => '' };
    }) as unknown as typeof globalThis.fetch;

    const selector = tdf.createSiteSelector('[test]', '', 'https://a.example', ['b.example']);
    await selector.noteFailure();
    await selector.noteFailure();
    assert.equal(selector.url(), 'https://b.example');
    // Uma rodada de probe = um fetch por candidato até o primeiro vivo (o
    // primário morto também é sondado: se ele voltar, volta a ser o escolhido).
    assert.equal(probes, 2);

    // O mirror também "cai": sem nova rodada enquanto o TTL do último probe
    // não expirar — sondar de novo não ressuscita site caído.
    await selector.noteFailure();
    await selector.noteFailure();
    await selector.noteFailure();
    assert.equal(selector.url(), 'https://b.example');
    assert.equal(probes, 2, 'sem novo probe dentro do TTL');
  });

  test('todos os candidatos caídos: mantém o domínio atual', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof globalThis.fetch;

    const selector = nerd.createSiteSelector('[test]', '', 'https://x.example', ['y.example']);
    await selector.noteFailure();
    await selector.noteFailure(); // probe roda, ninguém responde
    assert.equal(selector.url(), 'https://x.example');
  });

  test('hosts(): csv, fallbacks e dedupe alimentam a allowlist', () => {
    const selector = comando.createSiteSelector(
      '[test]',
      'https://csv1.example/, https://csv2.example',
      'https://primario.example',
      ['mirror.example', 'primario.example'],
    );
    assert.deepEqual(selector.hosts(), [
      'primario.example',
      'csv1.example',
      'csv2.example',
      'mirror.example',
    ]);
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
  const responde = (porta: any) =>
    new Promise((resolve) => {
      const req = http.get(
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
