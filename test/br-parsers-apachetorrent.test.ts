import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Parsers puros do Apache Torrent: token da sessão no home, cards da busca e
// magnets do post. O grosso da suíte do perfil (sessão/refresh/rotas) mora em
// apachetorrent-resolver.test.ts.
import apachetorrentShim from '../apachetorrent-resolver/server.js';
import * as apachetorrentParsers from '../resolvers/profiles/apachetorrent-parsers.js';
const apachetorrent: any = apachetorrentShim;
const parsers: any = apachetorrentParsers;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixture = (name: any) =>
  fs.readFileSync(path.join(__dirname, 'fixtures', 'apachetorrent', name), 'utf8');

const homeHtml = fixture('home.html');
const searchHtml = fixture('busca-coringa.html');
const postHtml = fixture('post-coringa-delirio.html');

const SITE = 'https://apachetorrents.com';
const POST_URL = `${SITE}/coringa-delirio-a-dois-baixar-torrent/`;

describe('apachetorrent: token da sessão', () => {
  test('extrai o hidden input[name=token] do home real', () => {
    assert.equal(parsers.extractSearchToken(homeHtml), '97e7097dcaa4eed613be82c95985116c');
  });

  test('aceita value antes de name e ignora hp_bot_check (honeypot)', () => {
    const reversed = '<input value="abc123" type="hidden" name="token">';
    assert.equal(parsers.extractSearchToken(reversed), 'abc123');
    const onlyHoneypot = '<input type="text" name="hp_bot_check" value="">';
    assert.equal(parsers.extractSearchToken(onlyHoneypot), null);
  });

  test('HTML vazio/nulo devolve null sem lançar', () => {
    assert.equal(parsers.extractSearchToken(''), null);
    assert.equal(parsers.extractSearchToken(null), null);
  });
});

describe('apachetorrent: parse da busca', () => {
  test('parseSearchHtml extrai os 13 cards com título, ano e tipo', () => {
    const posts = parsers.parseSearchHtml(searchHtml, SITE + '/');
    assert.equal(posts.length, 13);
    const delirio = posts.find((p: any) => p.url.includes('coringa-delirio-a-dois-baixar-torrent'));
    assert.ok(delirio, 'card do Coringa: Delírio a Dois ausente');
    // O atributo title não carrega o marcador "(Filme de 2024)".
    assert.equal(delirio.title, 'Coringa - Delírio a Dois Torrent Dublado / Dual Áudio');
    assert.equal(delirio.year, 2024);
    assert.equal(delirio.type, 'Filme');
  });

  test('parseSearchHtml resolve href relativo contra baseUrl', () => {
    const html = `<div class="capa-item"><h2 class="capa-titulo"><a href="/filme-x-baixar-torrent/" title="Filme X Torrent Dublado">Filme X Torrent Dublado <br/>(Filme de 2019)</a></h2></div>`;
    const posts = parsers.parseSearchHtml(html, SITE + '/');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, `${SITE}/filme-x-baixar-torrent/`);
    assert.equal(posts[0].year, 2019);
    assert.equal(posts[0].type, 'Filme');
  });

  test('HTML vazio/nulo devolve lista vazia sem lançar', () => {
    assert.deepEqual(parsers.parseSearchHtml('', SITE + '/'), []);
    assert.deepEqual(parsers.parseSearchHtml(null, SITE + '/'), []);
  });

  test('selectSearchPosts corta os "parecidos" (Corina/Corinthians) antes do fetch do post', () => {
    const posts = apachetorrent.selectSearchPosts(searchHtml, 'Coringa', null);
    assert.ok(posts.length >= 1);
    assert.ok(posts.every((p: any) => /coringa/i.test(p.title)), 'só card com Coringa no título');
    assert.ok(posts.length < 13, 'o pré-filtro precisa derrubar os cards não relacionados');
    assert.ok(!posts.some((p: any) => /Corina, Uma/i.test(p.title)));
  });
});

describe('apachetorrent: parse dos magnets do post', () => {
  const links: any[] = parsers.parsePostMagnets(postHtml, POST_URL);

  test('extrai os 8 magnets (o bloco de legendas externas não conta)', () => {
    assert.equal(links.length, 8);
    assert.ok(links.every((l: any) => /^magnet:\?xt=urn:btih:/.test(l.url)));
    // Hash de 40 hex e hashes de 32 base32 convivem no mesmo post.
    assert.ok(links.some((l: any) => l.url.includes('12163fe413e64a3bca43017fe086ffdc3394206b')));
    assert.ok(links.some((l: any) => l.url.includes('N3QCEH477EQDT5YMESSWCDFTKCDR5WE7')));
  });

  test('primeiro bloco VERSÃO DUBLADA é dual 1080p com WEB-DL do dn', () => {
    const first = links[0];
    assert.equal(first.quality, 1080);
    assert.equal(first.audio, 'dual');
    assert.equal(first.source, 'WEB-DL');
    assert.equal(first.size, null);
    assert.equal(first.description, 'VERSÃO DUBLADA — DOWNLOAD TORRENT DUAL ÁUDIO 5.1 MKV 1080P');
  });

  test('bloco VERSÃO LEGENDADA classifica legendado e acha o source no dn', () => {
    const segundo = links[1];
    assert.equal(segundo.audio, 'legendado');
    assert.equal(segundo.quality, 720);
    assert.equal(segundo.source, 'WEBRIP');
  });

  test('4K ULTRA HD vira 2160 (o "4K" à direita vence o "HD" do meio)', () => {
    const quatroK = links.filter((l: any) => l.quality === 2160);
    assert.ok(quatroK.length >= 3);
    assert.ok(quatroK.every((l: any) => l.audio === 'legendado'));
  });

  test('HTML vazio/nulo devolve lista vazia sem lançar', () => {
    assert.deepEqual(parsers.parsePostMagnets('', POST_URL), []);
    assert.deepEqual(parsers.parsePostMagnets(null, POST_URL), []);
  });
});

describe('apachetorrent: normalização de query e áudio', () => {
  test('normalizeQuery tira diacríticos e ":", preserva caixa e ano', () => {
    assert.equal(parsers.normalizeQuery('Extermínio: A Evolução'), 'Exterminio A Evolucao');
    assert.equal(parsers.normalizeQuery('  Coringa   2019 '), 'Coringa 2019');
  });

  test('classifyAudio: LEGENDADA vence; DUAL vence DUBLADA; sem marcador é null', () => {
    assert.equal(parsers.classifyAudio('VERSÃO LEGENDADA DOWNLOAD TORRENT DUAL ÁUDIO'), 'legendado');
    assert.equal(parsers.classifyAudio('VERSÃO DUBLADA DOWNLOAD TORRENT DUAL ÁUDIO 5.1'), 'dual');
    assert.equal(parsers.classifyAudio('VERSÃO DUBLADA DOWNLOAD TORRENT'), 'dublado');
    assert.equal(parsers.classifyAudio('DOWNLOAD TORRENT 1080P'), null);
  });
});

describe('apachetorrent: título da release e página sintética', () => {
  const links: any[] = parsers.parsePostMagnets(postHtml, POST_URL);
  const post = { url: POST_URL, title: 'Coringa - Delírio a Dois Torrent Dublado / Dual Áudio', year: 2024 };
  const searchPageHtml = parsers.createApacheSearchPageHtml();

  test('releaseTitle junta o título limpo e os atributos do magnet', () => {
    const title = parsers.releaseTitle(post, links[0], 0);
    assert.match(title, /^Coringa - Delírio a Dois \[/);
    assert.match(title, /1080p/);
    assert.match(title, /DUAL/);
    assert.ok(!/Torrent/.test(title), `título ainda tem Torrent: ${title}`);
  });

  test('searchPageHtml aponta o href DIRETO para o magnet (sem /resolve)', () => {
    const items = links.map((link: any, index: number) => ({ post, link, index, count: links.length }));
    const html = searchPageHtml(items);
    assert.equal(html.split('class="release"').length - 1, links.length);
    const prefix = links[0].url.slice(0, 40).replace(/&/g, '&amp;');
    assert.ok(html.includes(`href="${prefix}`));
    assert.ok(!html.includes('/resolve'));
    assert.ok(html.includes(`<div class="post"><a href="${POST_URL}">`));
    assert.ok(html.includes('<div class="size">1 KB</div>'));
  });

  test('feed torznab publica o magnet no link sem download.before', () => {
    const items = links.map((link: any, index: number) => ({ post, link, index, count: links.length }));
    const xml = parsers.apacheRssXml(items, 2000);
    assert.match(xml, /<link>magnet:\?xt=urn:btih:/);
    assert.match(xml, /<torznab:attr name="seeders" value="1"\/>/);
  });
});

describe('apachetorrent: allowlist dos dois domínios', () => {
  test('plural e singular passam; estranho é blocked_host', () => {
    assert.doesNotThrow(() => apachetorrent.assertAllowedUrl(`${SITE}/post/`));
    assert.doesNotThrow(() => apachetorrent.assertAllowedUrl('https://apachetorrent.com/post/'));
    assert.equal(apachetorrent.isDetailHost('apachetorrents.com'), true);
    assert.equal(apachetorrent.isDetailHost('apachetorrent.com'), true);
    assert.equal(apachetorrent.isDetailHost('evil.org'), false);
    assert.throws(() => apachetorrent.assertAllowedUrl('https://evil.org/post'), /blocked_host/);
  });

  test('os dois hosts entram como candidatos do seletor', () => {
    const hosts: string[] = apachetorrent.siteSelector.hosts();
    assert.ok(hosts.includes('apachetorrents.com'), `hosts: ${hosts.join(', ')}`);
    assert.ok(hosts.includes('apachetorrent.com'), `hosts: ${hosts.join(', ')}`);
  });
});
