import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// O config importa 'dotenv/config' (lê o .env do operador). Importar ANTES
// dos profiles faz o dotenv rodar primeiro e o env do operador valer para
// todos — senão os profiles veem o env vazio (default hardcoded) enquanto o
// config vê o .env, e o domínio ativo diverge quando o .env tem *Url.
import config from '../src/config.js';
import bludv from '../bludv-resolver/server.js';
import comando from '../comandotorrents-resolver/server.js';
import nerd from '../nerdfilmes-resolver/server.js';
import tdf from '../torrentdosfilmes-resolver/server.js';
import vaca from '../vacatorrent-resolver/server.js';
import * as brResolvers from '../src/br-resolvers.js';

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
    assert.doesNotThrow(() => nerd.assertAllowedUrl('https://www.filmesviatorrents.net/?s=teste'));
    assert.doesNotThrow(() => nerd.assertAllowedUrl('https://filmesviatorrents.net/?s=teste'));
    assert.equal(nerd.isDetailHost('filmesviatorrents.net'), true);
    assert.equal(nerd.isDetailHost('www.filmesviatorrents.net'), true);
    assert.equal(nerd.isDetailHost('WWW.FILMESVIATORRENTS.NET'), true);
    assert.equal(nerd.isDetailHost('nerdviatorrents.net'), true);
    assert.equal(nerd.isDetailHost('www.nerdviatorrents.net'), true);
    assert.equal(nerd.isDetailHost('xnerdfilmes.net'), true);
    assert.equal(nerd.isDetailHost('www.xnerdfilmes.net'), true);
    assert.equal(nerd.isDetailHost('nerdfilmestorrent.com'), true);
    assert.equal(nerd.isDetailHost('nerdfilmestorrent.org'), true);
    assert.equal(nerd.isDetailHost('videosad.net'), false);
    assert.equal(nerd.isDetailHost('google.com'), false);
    assert.equal(nerd.isDetailHost('fakefilmesviatorrents.net'), false);
    assert.equal(nerd.isDetailHost('filmesviatorrents.net.evil.com'), false);
    assert.throws(() => nerd.assertAllowedUrl('ftp://www.filmesviatorrents.net/file'), /unsupported_protocol/);
    assert.throws(() => nerd.assertAllowedUrl('javascript:alert(1)'), /unsupported_protocol/);
    assert.throws(
      () => nerd.assertAllowedUrl('https://dominio-novo.example/post'),
      /blocked_host:dominio-novo\.example/,
    );
    assert.throws(
      () => nerd.assertAllowedUrl('https://fakefilmesviatorrents.net/post'),
      /blocked_host:fakefilmesviatorrents\.net/,
    );
    assert.throws(
      () => nerd.assertAllowedUrl('https://filmesviatorrents.net.evil.com/post'),
      /blocked_host:filmesviatorrents\.net\.evil\.com/,
    );
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
    nerd.cache.clear();
    nerd.inFlight.clear();
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

    let nerdFetchCount = 0;
    globalThis.fetch = (async () => {
      nerdFetchCount += 1;
      await new Promise((r) => setTimeout(r, 15));
      return {
        ok: true,
        status: 200,
        text: async () => '<div><a href="https://systemads1.com/go/nerd">Download</a></div>',
      };
    }) as unknown as typeof globalThis.fetch;

    const nerdUrl = 'https://www.filmesviatorrents.net/filme-nerd/';
    const [n1, n2] = await Promise.all([
      nerd.getPostLinks(nerdUrl),
      nerd.getPostLinks(nerdUrl),
    ]);
    assert.equal(nerdFetchCount, 1, 'chamadas concorrentes ao nerdfilmes no novo domínio devem coalescer');
    assert.equal(nerd.inFlight.size, 0);
    assert.equal(n1.links[0].url, 'https://systemads1.com/go/nerd');
    assert.equal(n2.links[0].url, 'https://systemads1.com/go/nerd');
  });
});

describe('Feature 3: Standardized siteEnv Configuration & src/config.js', () => {
  test('brResolvers exporta matriz RESOLVERS com 5 entradas padronizadas', () => {
    assert.equal(brResolvers.RESOLVERS.length, 5);
    const names = brResolvers.RESOLVERS.map((r) => r.name);
    assert.deepEqual(names, ['bludv', 'comandotorrents', 'nerdfilmes', 'torrentdosfilmes', 'vacatorrent']);

    const envs = brResolvers.RESOLVERS.map((r) => r.siteEnv);
    assert.deepEqual(envs, [
      'BLUDV_URL',
      'COMANDOTORRENTS_URL',
      'NERDFILMES_URL',
      'TORRENTDOSFILMES_URL',
      'VACATORRENT_URL',
    ]);
  });

  test('src/config.js contém seção resolvers com URLs e extraProtectors', () => {
    assert.ok(config.resolvers);
    assert.equal(typeof config.resolvers.embedded, 'boolean');
    assert.ok(config.resolvers.host);
    assert.deepEqual(config.resolvers.ports, {
      bludv: 8700,
      comandotorrents: 8701,
      nerdfilmes: 8702,
      torrentdosfilmes: 8703,
      vacatorrent: 8704,
    });
    assert.ok(config.resolvers.bludvUrl);
    assert.ok(config.resolvers.comandotorrentsUrl);
    assert.ok(config.resolvers.nerdfilmesUrl);
    assert.ok(config.resolvers.torrentdosfilmesUrl);
    assert.ok(config.resolvers.vacatorrentUrl);
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
    assert.equal(host(vaca.siteSelector.url()), host(config.resolvers.vacatorrentUrl));
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

describe('Protetores: lista base compartilhada', () => {
  // Host de protetor fora da lista não vira botão: o post é lido, os links
  // existem e a fonte devolve 0 releases em silêncio. Foi o que aconteceu com
  // o nerdfilmes em 2026-09-03, quando o site trocou systemads1.com por
  // temreceita.com — comandotorrents/tdf/bludv seguiram entregando e só essa
  // fonte zerou, o que faz o sintoma parecer parser quebrado.
  const perfis: Array<[string, any]> = [
    ['bludv', bludv], ['comandotorrents', comando], ['nerdfilmes', nerd],
    ['torrentdosfilmes', tdf], ['vacatorrent', vaca],
  ];

  test('temreceita.com é protetor reconhecido em todos os perfis', () => {
    for (const [nome, perfil] of perfis) {
      assert.equal(perfil.isProtectorHost('temreceita.com'), true, `${nome}: apex`);
      assert.equal(perfil.isProtectorHost('www.temreceita.com'), true, `${nome}: subdomínio`);
      assert.doesNotThrow(
        () => perfil.assertAllowedUrl('https://www.temreceita.com/link.php?id=abc'),
        `${nome}: URL do protetor passa na allowlist`,
      );
    }
  });

  test('confusão de sufixo não passa por protetor', () => {
    for (const [nome, perfil] of perfis) {
      assert.equal(perfil.isProtectorHost('faketemreceita.com'), false, `${nome}: prefixo colado`);
      assert.equal(perfil.isProtectorHost('temreceita.com.evil.org'), false, `${nome}: sufixo estendido`);
      assert.throws(
        () => perfil.assertAllowedUrl('https://temreceita.com.evil.org/link.php'),
        /blocked_host/,
        `${nome}: sufixo estendido é bloqueado`,
      );
    }
  });
});
