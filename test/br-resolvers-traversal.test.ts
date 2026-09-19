import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import config from '../src/config.js';
import bludv from '../bludv-resolver/server.js';
import comando from '../comandotorrents-resolver/server.js';
import nerd from '../nerdfilmes-resolver/server.js';
import tdf from '../torrentdosfilmes-resolver/server.js';
import vaca from '../vacatorrent-resolver/server.js';
import * as brResolvers from '../src/br-resolvers.js';

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
    // createSiteSelector lê a env em TEMPO DE CHAMADA (e aceita injeção via
    // options): os selectors criados aqui nascem com estes valores. Não há
    // singleton no require desde a Fase 3 — o que este teste não cria, não lê.
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

describe('load() embutido: oito resolvers, isolamento de env e falha por porta', () => {
  // Offset alto para não disputar 8700-8707 com uma instância real de pé na
  // mesma máquina (é o caso do ambiente de desenvolvimento).
  const OFFSET = 2400;
  const PORTAS = [8700, 8701, 8702, 8703, 8704, 8705, 8706, 8707].map((porta) => porta + OFFSET);
  const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // node:http de propósito, e não fetch: os testes acima dublam globalThis.fetch
  // e um dublê vazando para cá responderia por servidor que nem está de pé.
  const responde = (porta: number) =>
    new Promise<boolean>((resolve) => {
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

  /**
   * Prova real do isolamento de env: com o ambiente global envenenado, o
   * load embutido tem que subir as oito portas da CONFIG e o activeSite de
   * cada resolver tem que seguir a config — nunca a env. Também confere que o
   * carregador não muta/restaura o ambiente (o veneno continua lá depois).
   */
  async function comEnvEnvenenado(fn: () => Promise<void>) {
    const veneno: Record<string, string> = {
      PORT: '1',
      SELF_URL: 'http://poison.invalid:1',
      SITE_URL: 'https://poison.invalid',
      BLUDV_URL: 'https://poison.invalid',
      NERDFILMES_URL: 'https://poison.invalid',
      EXTRA_ALLOWED_PROTECTORS: 'poison.invalid',
    };
    const salvo: Record<string, string | undefined> = {};
    for (const chave of Object.keys(veneno)) salvo[chave] = process.env[chave];
    Object.assign(process.env, veneno);
    try {
      await fn();
    } finally {
      for (const chave of Object.keys(veneno)) {
        if (salvo[chave] === undefined) delete process.env[chave];
        else process.env[chave] = salvo[chave] as string;
      }
    }
  }

  const hostSemWww = (url: string) => new URL(String(url)).hostname.replace(/^www\./, '');

  test('abre as oito portas com env envenenado; activeSite segue a config', async () => {
    assert.equal(brResolvers.RESOLVERS.length, 8, 'cardinalidade da matriz RESOLVERS');
    try {
      await comEnvEnvenenado(async () => {
        assert.doesNotThrow(() =>
          brResolvers.load({ ...config.resolvers, embedded: true, host: '127.0.0.1', portOffset: OFFSET }));
        // O carregador não muta nem restaura o ambiente: o veneno permanece.
        assert.equal(process.env.PORT, '1');
        assert.equal(process.env.SITE_URL, 'https://poison.invalid');
        assert.equal(process.env.EXTRA_ALLOWED_PROTECTORS, 'poison.invalid');

        await settle(700);
        assert.deepEqual(
          await Promise.all(PORTAS.map(responde)),
          [true, true, true, true, true, true, true, true],
          'load() tem que abrir as oito portas da config',
        );

        for (const resolver of brResolvers.RESOLVERS) {
          const active = brResolvers.activeSite(resolver.name);
          assert.ok(active, `${resolver.name}: activeSite vazio`);
          assert.notEqual(active, 'https://poison.invalid', `${resolver.name}: ativo veio da env envenenada`);
          assert.equal(
            hostSemWww(String(active)),
            hostSemWww(resolver.siteUrl),
            `${resolver.name}: activeSite deve seguir a config`,
          );
        }
      });
    } finally {
      await brResolvers.closeAsync();
    }
  });

  test('porta ocupada (EADDRINUSE) não derruba os outros sete', async () => {
    const blocker = http.createServer(() => {});
    await new Promise<void>((resolve) => blocker.listen(PORTAS[0], '127.0.0.1', resolve));
    try {
      // O erro de listen é ASSÍNCRONO: load() não pode estourar nem virar
      // uncaughtException (o handler confina a falha ao resolver da porta).
      assert.doesNotThrow(() =>
        brResolvers.load({ ...config.resolvers, embedded: true, host: '127.0.0.1', portOffset: OFFSET }));
      await settle(700);
      const estados = await Promise.all(PORTAS.map(responde));
      assert.equal(estados[0], false, 'a porta ocupada não pode responder pelo resolvedor');
      assert.deepEqual(
        estados.slice(1),
        [true, true, true, true, true, true, true],
        'os outros sete resolvers têm que subir mesmo com uma porta ocupada',
      );
    } finally {
      await brResolvers.closeAsync();
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  test('close() derruba as oito e é idempotente', async () => {
    brResolvers.load({ ...config.resolvers, embedded: true, host: '127.0.0.1', portOffset: OFFSET });
    await settle(700);
    assert.deepEqual(await Promise.all(PORTAS.map(responde)), [true, true, true, true, true, true, true, true]);

    await brResolvers.closeAsync();
    assert.deepEqual(
      await Promise.all(PORTAS.map(responde)),
      [false, false, false, false, false, false, false, false],
      'close() tem que fechar as oito',
    );

    // O shutdown pode ser chamado duas vezes (SIGTERM seguido de SIGINT, ou o
    // fallback correndo junto): a segunda não pode estourar.
    assert.doesNotThrow(() => brResolvers.close());
  });
});

