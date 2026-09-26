// Adaptador de raspagem do Vaca (Fase 1 — somente leitura), contra FIXTURES
// REAIS capturadas ao vivo de vaqueirofilmes.com em 2026-09-25 (sem rede):
//
//   movie-page-torrent.html      /pt/movie/expresso-do-amanha/ — COM torrent
//                                (2 botões systemtech) e IMDb tt1706620;
//   movie-links-torrent.html     /movie-links/61616/ — Assistir + Download real;
//   movie-page-streaming.html    /pt/movie/diario-de-um-banana-2-rodrick-e-o-cara/ —
//                                só streaming, IMDb tt1650043;
//   movie-links-streaming.html   /movie-links/54688/ — SÓ o grupo Assistir;
//   movie-page-no-imdb.html      /pt/movie/um-dia-de-sorte-em-nova-york/ — SEM
//                                IMDb algum; movie-links 60009 com 1 botão;
//   sitemap-index.xml            índice Yoast íntegro (18 sitemaps, 11 de filmes);
//   movie-sitemap11.xml          sitemap de filmes ÍNTEGRO (118 URLs reais);
//   protector-processar.html     hop REAL do protetor (const next → t.co);
//   protector-tco.html           hop REAL do t.co (meta refresh → relay);
//   protector-final-magnet.txt   resposta FINAL REAL da cadeia (o magnet
//                                publicado, btih bd30a6e0…; os saltos entre o
//                                relay e o gate não foram capturados — o dublê
//                                responde a eles com esta resposta final real).
//
// O resolver é o PROFILE REAL (createResolver do vacatorrent), com o fetch
// dublê por baixo: parsers, protetores e extração de magnet são os de
// produção. Nada grava no banco de magnets e nada liga o crawler.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createResolver } from '../resolvers/profiles/vacatorrent.js';
import { createVacaCrawlSite, vacaCrawlSite } from '../src/providers/crawl-sites/vaca.js';
import type { VacaResolverSurface } from '../src/providers/crawl-sites/vaca.js';
import { instance as loadedResolver } from '../src/br-resolvers.js';
import { stubFetch, type FetchStub } from './helpers/stub.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, 'fixtures', 'crawl', 'vaca');
const fixture = (name: string) => fs.readFileSync(path.join(FIX, name), 'utf8');

const SITE = 'https://vaqueirofilmes.com';
const PAGE_TORRENT = `${SITE}/pt/movie/expresso-do-amanha/`;
const LINKS_TORRENT = `${SITE}/movie-links/61616/`;
const PAGE_STREAMING = `${SITE}/pt/movie/diario-de-um-banana-2-rodrick-e-o-cara/`;
const LINKS_STREAMING = `${SITE}/movie-links/54688/`;
const PAGE_NO_IMDB = `${SITE}/pt/movie/um-dia-de-sorte-em-nova-york/`;
const LINKS_NO_IMDB = `${SITE}/movie-links/60009/`;
/** btih REAL extraído da resposta final capturada da cadeia do protetor. */
const REAL_BTIH = 'bd30a6e0dcb86fcff13de9939364384623746072';

function resolverSurface(): VacaResolverSurface {
  const resolver = createResolver({
    port: 0,
    selfUrl: 'http://127.0.0.1:0',
    siteUrl: SITE,
    extraProtectors: [],
  });
  // O profile devolve a superfície completa; o adaptador declara o recorte que
  // usa — a atribuição direta é o teste de que a API do profile continua batendo.
  return resolver;
}

/** Dublê de fetch com as rotas dos fixtures; URL fora do mapa falha (rede fora). */
function stubRoutes(routes: Record<string, () => string>): FetchStub {
  return stubFetch((url) => {
    for (const [match, body] of Object.entries(routes)) {
      if (url.includes(match)) {
        return {
          ok: true,
          status: 200,
          // O transporte do protetor lê `headers.get('set-cookie')` em todo salto.
          headers: { get: () => null },
          text: async () => body(),
        };
      }
    }
    throw new Error(`fetch fora do mapa (sem rede): ${url}`);
  });
}

/** Rotas da cadeia completa do protetor para os botões reais dos fixtures. */
function protectorRoutes(): Record<string, () => string> {
  return {
    'systemtech.space/enc/go.php': () => fixture('protector-processar.html'),
    't.co/SFsPRm91bg': () => fixture('protector-tco.html'),
    // Relay/gate: resposta final REAL da cadeia (ver cabeçalho do arquivo).
    'systemtech.space/enc/relay.php': () => fixture('protector-final-magnet.txt'),
    'vacadb.org': () => fixture('protector-final-magnet.txt'),
  };
}

/** Mesma cadeia com o 1º botão real da página 61616 (id 4jcc…) falhando. */
function protectorRoutesFailingFirst(): Record<string, () => string> {
  return {
    'systemtech.space/enc/go.php?id=4jcc': () => { throw new Error('falha injetada no 1º botão'); },
    ...protectorRoutes(),
  };
}

describe('crawl-sites/vaca: discover (sitemap real, sem rede)', () => {
  test('lê o movie-sitemap íntegro: 118 obras com lastmod, acervo fora, resto do índice falho não derruba', async () => {
    const stub = stubRoutes({
      'sitemap_index.xml': () => fixture('sitemap-index.xml'),
      'movie-sitemap11.xml': () => fixture('movie-sitemap11.xml'),
    });
    try {
      const site = createVacaCrawlSite(resolverSurface());
      const urls = await site.discover();
      // O índice REAL lista 11 sitemaps de filme; só o 11 está no mapa — os
      // outros 10 falham no dublê e NÃO derrubam a descoberta (fail-open).
      assert.equal(urls.length, 118, 'todas as URLs do sitemap íntegro entram');
      assert.ok(urls.every((u) => u.kind === 'movie'), 'tipo movie');
      assert.ok(urls.every((u) => /^\/pt\/movie\/[^/]+\/$/.test(new URL(u.url).pathname)), 'só obra com slug');
      assert.ok(urls.every((u) => /^\d{4}-\d{2}-\d{2}T/.test(u.lastmod)), 'lastmod presente');
      assert.ok(urls.every((u) => u.lastmod.length > 0));
      const fetched = stub.calls.map((c) => c.url);
      assert.equal(fetched.filter((u) => u.includes('movie-sitemap11')).length, 1, 'sitemap íntegro lido uma vez');
      assert.ok(!fetched.some((u) => u.includes('tv_show-sitemap')), 'sitemap de série fora do piloto filme');
      assert.ok(!fetched.some((u) => /\/pt\/movie\//.test(u)), 'descoberta não visita páginas de obra');
    } finally {
      stub.restore();
    }
  });

  test('since filtra o incremental: só lastmod mais novo que o cursor volta', async () => {
    const stub = stubRoutes({
      'sitemap_index.xml': () => fixture('sitemap-index.xml'),
      'movie-sitemap11.xml': () => fixture('movie-sitemap11.xml'),
    });
    try {
      const site = createVacaCrawlSite(resolverSurface());
      const since = '2026-09-25T15:00:00+00:00';
      const urls = await site.discover(since);
      // Expectativa calculada do PRÓPRIO fixture (contagem independente): os
      // lastmod reais do sitemap decidem, não um número cravado à mão.
      const xml = fixture('movie-sitemap11.xml');
      const lastmods = [...xml.matchAll(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/g)].map((m) => m[1]);
      const expected = lastmods.filter((l) => Date.parse(l) > Date.parse(since)).length;
      assert.ok(expected > 0, 'fixture tem entradas novas');
      assert.equal(urls.length, expected);
      assert.ok(urls.every((u) => Date.parse(u.lastmod) > Date.parse(since)), 'nenhuma entrada velha');
    } finally {
      stub.restore();
    }
  });
});

describe('crawl-sites/vaca: fetchWork (páginas reais, cadeia real do protetor)', () => {
  test('filme COM torrent: obra, IMDb, release única com btih real e campos do RawItem', async () => {
    const stub = stubRoutes({
      [PAGE_TORRENT]: () => fixture('movie-page-torrent.html'),
      [LINKS_TORRENT]: () => fixture('movie-links-torrent.html'),
      ...protectorRoutes(),
    });
    try {
      const site = createVacaCrawlSite(resolverSurface());
      const result = await site.fetchWork(PAGE_TORRENT);
      assert.equal(result.status, 'done');
      assert.equal(result.title, 'Expresso do Amanhã');
      assert.equal(result.year, 2013);
      assert.equal(result.imdb, 'tt1706620');
      assert.equal(result.type, 'movie');
      // Os DOIS botões reais da página passam pela cadeia; o dublê serve a
      // MESMA resposta final real para ambos, então o dedupe por btih fica
      // com UM item (mesmo torrent anunciado duas vezes é um só).
      assert.equal(result.releases?.length, 1);
      const rel = result.releases![0];
      assert.equal(rel.indexer, 'vacatorrent', 'id do card do Jackett');
      assert.equal(rel.isBr, true, 'invariante 2: origem BR é campo do provider');
      assert.equal(rel.seeders, 1, 'invariante 3: fonte BR não publica swarm');
      assert.match(rel.magnet || '', new RegExp(`^magnet:\\?xt=urn:btih:${REAL_BTIH}`), 'magnet real da cadeia');
      assert.match(rel.title || '', /Expresso do Amanhã \(2013\)/, 'título com ano');
      assert.match(rel.title || '', /1080p/, 'qualidade do botão real');
      assert.match(rel.title || '', /DUAL/, '"Português | Inglês" do rótulo real');
      assert.match(rel.title || '', /2\.33 GB/, 'tamanho REAL do rótulo do botão');
      assert.equal(rel.size, Math.round(2.33 * 1024 ** 3), 'tamanho em bytes');
    } finally {
      stub.restore();
    }
  });

  test('página SÓ de streaming: no-torrent, IMDb presente, nenhum salto de protetor', async () => {
    const stub = stubRoutes({
      [PAGE_STREAMING]: () => fixture('movie-page-streaming.html'),
      [LINKS_STREAMING]: () => fixture('movie-links-streaming.html'),
      ...protectorRoutes(),
    });
    try {
      const site = createVacaCrawlSite(resolverSurface());
      const result = await site.fetchWork(PAGE_STREAMING);
      assert.equal(result.status, 'no-torrent');
      assert.equal(result.imdb, 'tt1650043');
      assert.equal(result.title, 'Diário de um Banana 2: Rodrick é o Cara');
      assert.equal(result.year, 2011);
      assert.equal(result.releases, undefined, 'sem magnet, sem release');
      const protectors = stub.calls.filter((c) => /systemtech|t\.co|vacadb/.test(c.url));
      assert.equal(protectors.length, 0, 'sem botão de download, o protetor nunca é acionado');
      assert.equal(stub.calls.length, 2, 'página + movie-links, nada além');
    } finally {
      stub.restore();
    }
  });

  test('página SEM IMDb: releases seguem; imdb null nunca vira chute', async () => {
    const stub = stubRoutes({
      [PAGE_NO_IMDB]: () => fixture('movie-page-no-imdb.html'),
      [LINKS_NO_IMDB]: () => fixture('movie-links-no-imdb.html'),
      ...protectorRoutes(),
    });
    try {
      const site = createVacaCrawlSite(resolverSurface());
      const result = await site.fetchWork(PAGE_NO_IMDB);
      assert.equal(result.status, 'done');
      assert.equal(result.imdb, null, 'sem IMDb na página: null (identificação é fase 2)');
      assert.equal(result.title, 'Um Dia de Sorte em Nova York');
      assert.equal(result.year, 2025);
      assert.equal(result.releases?.length, 1);
      assert.match(result.releases![0].magnet || '', new RegExp(`^magnet:\\?xt=urn:btih:${REAL_BTIH}`));
      assert.match(result.releases![0].title || '', /2\.54 GB/, 'rótulo real do botão 60009');
    } finally {
      stub.restore();
    }
  });

  test('um botão falhando não perde o outro; todos falhando é erro da página', async () => {
    const stub = stubRoutes({
      [PAGE_TORRENT]: () => fixture('movie-page-torrent.html'),
      [LINKS_TORRENT]: () => fixture('movie-links-torrent.html'),
      ...protectorRoutesFailingFirst(),
    });
    try {
      const site = createVacaCrawlSite(resolverSurface());
      const result = await site.fetchWork(PAGE_TORRENT);
      // O 1º botão (id 4jcc…) falha no dublê; o 2º (rwis…) percorre a cadeia.
      assert.equal(result.status, 'done', 'falha de UM botão não derruba a página');
      assert.equal(result.releases?.length, 1, 'release do botão que resolveu entra');
      // Agora TODOS falham: página vira erro (motor retenta), nunca no-torrent.
      const allFail = stubRoutes({
        [PAGE_TORRENT]: () => fixture('movie-page-torrent.html'),
        [LINKS_TORRENT]: () => fixture('movie-links-torrent.html'),
        'systemtech.space': () => { throw new Error('protetor fora'); },
      });
      try {
        const site2 = createVacaCrawlSite(resolverSurface());
        await assert.rejects(() => site2.fetchWork(PAGE_TORRENT), /protetor fora/);
      } finally {
        allFail.restore();
      }
    } finally {
      stub.restore();
    }
  });
});

describe('br-resolvers.instance: getter seguro (sem servidor, sem load)', () => {
  test('nome desconhecido e resolvedor não carregado devolvem null, nunca lançam', () => {
    assert.equal(loadedResolver('nao-existe'), null);
    assert.equal(loadedResolver('vacatorrent'), null, 'sem load() no processo de teste');
    assert.equal(loadedResolver(''), null);
  });

  test('vacaCrawlSite() sem resolver embutido falha com erro claro', () => {
    assert.throws(() => vacaCrawlSite(), /resolvedor embutido não carregado/);
  });
});
