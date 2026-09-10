import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Mesma ordem do br-resolvers.test.ts: config antes dos profiles para o
// dotenv do operador valer antes do require dos CommonJS.
import config from '../src/config.js';
import * as brResolvers from '../src/br-resolvers.js';
// A superfície do profile é maior que o ResolverProfile do shim (rssXml,
// releaseTitle com post, etc.); os testes exercitam a superfície real.
import redetorrentShim from '../redetorrent-resolver/server.js';
import redetorrentParsers from '../resolvers/profiles/redetorrent-parsers.js';
const redetorrent: any = redetorrentShim;
const parsers: any = redetorrentParsers;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixture = (name: any) =>
  fs.readFileSync(path.join(__dirname, 'fixtures', 'redetorrent', name), 'utf8');

const searchHtml = fixture('search-coringa.html');
const postHtml = fixture('post-coringa-delirio.html');
const postRenderedHtml = fixture('post-coringa-delirio-rendered.html');
const serieHtml = fixture('serie-fallout.html');

const SITE = 'https://www.redetorrent.xyz';
const POST_URL = `${SITE}/filmes/coringa-delirio-a-dois/`;
const SERIE_URL = `${SITE}/series/fallout/`;

describe('redetorrent: parse da busca', () => {
  test('parseSearchHtml extrai os posts com título, ano e type pelo path', () => {
    const posts = parsers.parseSearchHtml(searchHtml, SITE + '/');
    assert.ok(posts.length >= 2, `esperava >= 2 posts, veio ${posts.length}`);
    const delirio = posts.find((p: any) => p.url.includes('coringa-delirio-a-dois'));
    assert.ok(delirio, 'post do Coringa: Delírio a Dois ausente');
    assert.equal(delirio.title, 'Coringa: Delírio a Dois (2024)');
    assert.equal(delirio.year, 2024);
    assert.equal(delirio.type, 'Filme');
    const serie = posts.find((p: any) => String(p.url).includes('/series/'));
    if (serie) assert.equal(serie.type, 'Série');
    const coringa = posts.find((p: any) => p.url.endsWith('/filmes/coringa/'));
    assert.ok(coringa);
    assert.equal(coringa.title, 'Coringa (2019)');
  });

  test('parseSearchHtml resolve href relativo contra baseUrl', () => {
    const html = `<html><body><div class="listagem"><div class="item"> <a href="/filmes/coringa/" title="Coringa (2019)"><h2 class="item-titulo">Coringa (2019)</h2></a></div></div></body></html>`;
    const posts = parsers.parseSearchHtml(html, SITE + '/');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, `${SITE}/filmes/coringa/`);
    assert.equal(posts[0].type, 'Filme');
  });

  test('HTML vazio/nulo devolve lista vazia sem lançar', () => {
    assert.deepEqual(parsers.parseSearchHtml('', SITE + '/'), []);
    assert.deepEqual(parsers.parseSearchHtml(null, SITE + '/'), []);
  });

  test('selectSearchPosts filtra pela query e corta no limite', () => {
    const posts = redetorrent.selectSearchPosts(searchHtml, 'Coringa', null);
    assert.ok(posts.length >= 1);
    assert.ok(posts.every((p: any) => /coringa/i.test(p.title)));
  });

  test('Casa do Dragão: busca real devolve 0 (a fonte não tem a obra) e NÃO deixa passar o match por conteúdo', () => {
    // Evidência de 2026-09-10: "casa do dragao" no site devolve 1 card
    // ("O Mundo Mágico de Rufus") — match de CONTEÚDO do post, não de título;
    // o acervo /series/ (40 páginas varridas) não tem a série e os slugs
    // candidatos devolvem 404. O 0 em ~450ms é honesto: o card é cortado pelo
    // matchesResolverQuery ANTES de qualquer fetch de post.
    const casaDragaoHtml = fixture('search-casa-do-dragao.html');
    const brutos = parsers.parseSearchHtml(casaDragaoHtml, SITE + '/');
    assert.equal(brutos.length, 1);
    assert.match(brutos[0].title, /Rufus/);
    assert.equal(brutos[0].type, 'Filme');
    const posts = redetorrent.selectSearchPosts(casaDragaoHtml, 'Casa do Dragão', null);
    assert.equal(posts.length, 0);
  });
});

describe('redetorrent: extractMagnetHref', () => {
  test('magnet direto com btih 40 hex passa', () => {
    const magnet = 'magnet:?xt=urn:btih:a2d1aa3b66f73b9cd742c0b17bf5cbacbe83e2be&dn=Coringa';
    assert.equal(parsers.extractMagnetHref(magnet), magnet);
  });

  test('token systemads decodifica para o magnet; legenda https vira null', () => {
    const legenda = 'https://systemads.free.nf/noticia.php?token=aHR0cHM6Ly93d3cub3BlbnN1YnRpdGxlcy5vcmcvcGIvc3VidGl0bGVzLzEyODE2NDYzL2pva2VyLWZvbGllLWEtZGV1eC1wYg==';
    assert.equal(parsers.extractMagnetHref(legenda), null);
    const magnet = 'magnet:?xt=urn:btih:a2d1aa3b66f73b9cd742c0b17bf5cbacbe83e2be&dn=Coringa';
    const token = `https://systemads.free.nf/noticia.php?token=${Buffer.from(magnet).toString('base64')}`;
    assert.equal(parsers.extractMagnetHref(token), magnet);
  });

  test('btih que NÃO é 40 hex é descartado (direto e via token decodificado)', () => {
    assert.equal(
      parsers.extractMagnetHref('magnet:?xt=urn:btih:zzzz111122223333444455556666777788889999&dn=x'),
      null,
    );
    assert.equal(parsers.extractMagnetHref('magnet:?dn=sem-hash'), null);
    const inválido = 'magnet:?xt=urn:btih:zzzz111122223333444455556666777788889999&dn=x';
    const token = `https://systemads.free.nf/noticia.php?token=${Buffer.from(inválido).toString('base64')}`;
    assert.equal(parsers.extractMagnetHref(token), null);
    assert.equal(parsers.extractMagnetHref('https://www.opensubtitles.org/pb/subtitles/1'), null);
    assert.equal(parsers.extractMagnetHref(''), null);
  });
});

describe('redetorrent: parse do post de filme', () => {
  const links: any[] = parsers.parsePostLinks(postHtml, { url: POST_URL });

  test('extrai os 6 magnets diretos das tabelas do HTML cru', () => {
    assert.equal(links.length, 6);
    assert.ok(links.every((l) => /^magnet:\?xt=urn:btih:[0-9a-fA-F]{40}/.test(l.url)));
  });

  test('primeira linha WEBDL 1080p com tamanho e áudio dual', () => {
    const first = links[0];
    assert.equal(first.quality, 1080);
    // normalizeSource do núcleo canônica WEBDL → WEB-DL.
    assert.equal(first.source, 'WEB-DL');
    assert.equal(first.size, '3.68 GB');
    assert.equal(first.audio, 'dual');
    assert.match(
      first.url,
      /a2d1aa3b66f73b9cd742c0b17bf5cbacbe83e2be/,
      'a ordem das linhas deve seguir a ordem do post',
    );
  });

  test('tabela legendado classifica audio legendado', () => {
    const legendado = links.filter((l) => l.audio === 'legendado');
    assert.ok(legendado.length >= 1);
  });

  test('header com classes extras (class="tfs ...") classifica o áudio do bloco', () => {
    const row = `<tr class="tr-mv-list"><td class="td-mv-qua">WEBDL</td><td class="td-mv-res">1080p</td><td class="td-mv-tam">3.68 GB</td><td class="td-mv-idi">ptbr</td><td class="td-mv-leg"></td><td class="td-mv-dow"> <a href="magnet:?xt=urn:btih:a2d1aa3b66f73b9cd742c0b17bf5cbacbe83e2be&dn=x">magnet</a></td></tr>`;
    const html = `<table class="tbl-mv-list"><tbody><tr class="tbl-mv-tit"><th><div class="tfs theme-dark">Coringa <strong>Dual Áudio</strong> Torrent</div></th></tr>${row}</tbody></table>`;
    const parsed = parsers.parsePostLinks(html, { url: POST_URL });
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].audio, 'dublado', 'o header tf... (classe extra) precisa alimentar classifyAudio');
  });

  test('linha YTS sem célula de resolução tira a qualidade do dn do magnet', () => {
    const yts = links.find((l) => /yts/i.test(l.url));
    assert.ok(yts);
    assert.equal(yts.quality, 720);
  });

  test('âncora de legenda antes do magnet na linha não rouba a vaga', () => {
    const row = `<tr class="tr-mv-list"><td class="td-mv-qua">WEBDL</td><td class="td-mv-res">1080p</td><td class="td-mv-tam">3.68 GB</td><td class="td-mv-idi">ptbr, eng</td><td class="td-mv-leg">ptbr</td><td class="td-mv-dow"> <a href="https://www.opensubtitles.org/pb/subtitles/1">legenda</a> <a href="magnet:?xt=urn:btih:a2d1aa3b66f73b9cd742c0b17bf5cbacbe83e2be&dn=x&xl=3949990656">magnet</a></td></tr>`;
    const html = `<table class="tbl-mv-list"><tbody><tr class="tbl-mv-tit"><th><div class="tf">Coringa <strong>Dual Áudio</strong> Torrent</div></th></tr>${row}</tbody></table>`;
    const parsed = parsers.parsePostLinks(html, { url: POST_URL });
    assert.equal(parsed.length, 1);
    assert.match(parsed[0].url, /a2d1aa3b/);
  });

  test('HTML renderizado pelo FlareSolverr (tokens systemads) também entrega magnets', () => {
    const viaToken = parsers.parsePostLinks(postRenderedHtml, { url: POST_URL });
    // Os tokens base64 dos anchors systemads decodificam para os MESMOS
    // magnets do HTML cru; o link de legenda (https/opensubtitles) é ignorado.
    assert.ok(viaToken.length >= 3);
    assert.ok(viaToken.every((l: any) => l.url.startsWith('magnet:')));
    assert.ok(
      viaToken.some((l: any) => l.url.includes('a2d1aa3b66f73b9cd742c0b17bf5cbacbe83e2be')),
    );
  });

  test('HTML vazio/nulo devolve lista vazia sem lançar', () => {
    assert.deepEqual(parsers.parsePostLinks('', { url: POST_URL }), []);
    assert.deepEqual(parsers.parsePostLinks(null, { url: POST_URL }), []);
  });
});

describe('redetorrent: parse do post de série', () => {
  const links: any[] = parsers.parsePostLinks(serieHtml, { url: SERIE_URL });

  test('extrai um pack por temporada com a temporada marcada', () => {
    assert.equal(links.length, 2);
    assert.deepEqual(links.map((l) => l.season), [1, 2]);
    assert.ok(links[0].url.includes('b7efcb48193a4a9e11497d00930d754c0bf1c65b'));
  });

  test('qualidade vem do dn (célula de resolução não existe na tabela de série)', () => {
    assert.equal(links[0].quality, 720);
    assert.equal(links[1].quality, 720);
  });

  test('tamanho vem do xl do magnet quando a célula não publica tamanho', () => {
    assert.equal(links[0].size, '2.55 GB');
  });

  test('áudio desconhecido fica null (o post não declara áudio por linha)', () => {
    assert.equal(links[0].audio, null);
  });
});

describe('redetorrent: título da release e página sintética', () => {
  const links: any[] = parsers.parsePostLinks(postHtml, { url: POST_URL });
  const post = { url: POST_URL, title: 'Coringa: Delírio a Dois (2024)', year: 2024 };
  const searchPageHtml = parsers.createRedeSearchPageHtml();

  test('releaseTitle junta título limpo e atributos do botão', () => {
    const title = parsers.releaseTitle(post, links[0], 0);
    assert.match(title, /Coringa: Delírio a Dois \(2024\)/);
    assert.match(title, /1080p/);
    assert.match(title, /DUAL/i);
    assert.match(title, /3\.68 GB/);
  });

  test('searchPageHtml aponta o href DIRETO para o magnet (sem /resolve)', () => {
    const items = links.map((link, index) => ({ post, link, index, count: links.length }));
    const html = searchPageHtml(items);
    assert.equal(html.split('class="release"').length - 1, links.length);
    // O magnet entra ESCAPADO no atributo (& → &amp;) — verificação por
    // prefixo, que é o que importa: href sem /resolve, direto no magnet.
    const prefix = links[0].url.slice(0, 40).replace(/&/g, '&amp;');
    assert.ok(html.includes(`href="${prefix}`));
    assert.ok(!html.includes('/resolve'));
  });

  test('feed torznab publica o magnet no link sem download.before', () => {
    const items = links.map((link, index) => ({ post, link, index, count: links.length }));
    const xml = parsers.rssXml(items, 2000);
    assert.match(xml, /<link>magnet:\?xt=urn:btih:/);
    assert.match(xml, /<torznab:attr name="seeders" value="1"\/>/);
  });
});

describe('redetorrent: allowlist e filtros', () => {
  test('domínio do site passa; estranho é blocked_host', () => {
    assert.doesNotThrow(() =>
      redetorrent.assertAllowedUrl(`${SITE}/filmes/coringa/`),
    );
    assert.equal(redetorrent.isDetailHost('redetorrent.xyz'), true);
    assert.equal(redetorrent.isDetailHost('www.redetorrent.xyz'), true);
    assert.equal(redetorrent.isDetailHost('evil.org'), false);
    assert.throws(() => redetorrent.assertAllowedUrl('https://evil.org/post'), /blocked_host/);
    assert.throws(
      () => redetorrent.assertAllowedUrl('javascript:alert(1)'),
      /unsupported_protocol/,
    );
  });

  test('protetor systemads (ecozado do render do FlareSolverr) é reconhecido', () => {
    assert.equal(redetorrent.isProtectorHost('systemads.free.nf'), true);
    assert.equal(redetorrent.isProtectorHost('systemads1.com'), true);
    assert.equal(redetorrent.isProtectorHost('temreceita.com'), true);
  });

  test('normalizeQuery tira SxxEyy e o ano (o WP do site zera com token extra)', () => {
    assert.equal(parsers.normalizeQuery('Coringa 2019'), 'Coringa');
    assert.equal(parsers.normalizeQuery('Fallout S02'), 'Fallout');
    assert.equal(parsers.normalizeQuery('Série: Coringa'), 'Série Coringa');
  });

  test('temporada pedida casa com QUALQUER ordinal do post (post tem 1ª e 2ª)', () => {
    const post = { title: 'Fallout 1ª 2ª Temporada (2025)' };
    // Mesma forma que o perfil recebe: match da query (Sxx) em requestedSeasonFromQuery.
    const s = (n: number) => `Fallout S${String(n).padStart(2, '0')}`.match(/\b[Ss](\d{1,2})\b/);
    assert.equal(parsers.matchesSeasonSeason(post, s(1)), true);
    assert.equal(parsers.matchesSeasonSeason(post, s(2)), true);
    assert.equal(parsers.matchesSeasonSeason(post, s(3)), false);
    assert.equal(parsers.matchesSeasonSeason({ title: 'Coringa (2019)' }, s(2)), true);
  });
});

describe('redetorrent: busca (fetch dublê)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    redetorrent.postCache.clear();
    redetorrent.searchCache.clear();
    redetorrent.inFlight.clear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function stubFetch(htmlByPath: Record<string, string>, counter: { count: number }) {
    (globalThis.fetch as any) = (async (url: any) => {
      counter.count += 1;
      const target = String(url);
      const entry = Object.entries(htmlByPath).find(([needle]) => target.includes(needle));
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => (entry ? entry[1] : '<html></html>'),
      };
    });
  }

  test('searchPosts devolve releases com magnet direto por post encontrado', async () => {
    const counter = { count: 0 };
    stubFetch(
      { '/?s=': searchHtml, 'coringa-delirio-a-dois': postHtml, '/filmes/coringa/': postHtml },
      counter,
    );
    const items: any[] = await redetorrent.searchPosts('Coringa');
    assert.ok(items.length >= 2);
    assert.ok(items.every((item) => item.link.url.startsWith('magnet:')));
    // Posts e página de busca: mais de um fetch (um por post encontrado).
    assert.ok(counter.count >= 2);
  });

  test('searchPosts coalesce/busca em cache: segunda chamada não refaz fetch', async () => {
    const counter = { count: 0 };
    stubFetch(
      { '/?s=': searchHtml.replace(/coringa/g, 'fallout'), 'coringa-delirio-a-dois': serieHtml, '/filmes/coringa/': serieHtml },
      counter,
    );
    await redetorrent.searchPosts('Fallout');
    const depoisDaPrimeira = counter.count;
    await redetorrent.searchPosts('Fallout');
    assert.equal(counter.count, depoisDaPrimeira);
  });

  test('magnet direto é o ÚNICO caminho: sem /resolve nem compatibilidade', () => {
    for (const nome of ['resolveBest', 'resolveButton', 'collectLinks', 'magnetCache']) {
      assert.equal(redetorrent[nome], undefined, `${nome} não deveria ser exportado`);
    }
  });
});

describe('redetorrent: registro no addon', () => {
  test('porta e URL default configuradas', () => {
    assert.equal(config.resolvers.ports.redetorrent, 8705);
    assert.equal(
      new URL(config.resolvers.redetorrentUrl).hostname.replace(/^www\./, ''),
      'redetorrent.xyz',
    );
    const entry = brResolvers.RESOLVERS.find(
      (r) => r.name === 'redetorrent',
    );
    assert.ok(entry, 'redetorrent precisa estar na matriz RESOLVERS');
    assert.equal(entry.port, 8705);
    assert.equal(entry.siteEnv, 'REDETORRENT_URL');
  });

  test('host ativo do seletor bate com o default de config', () => {
    const host = (url: string) => new URL(String(url)).hostname.replace(/^www\./, '');
    assert.equal(host(redetorrent.siteSelector.url()), host(config.resolvers.redetorrentUrl));
  });
});
