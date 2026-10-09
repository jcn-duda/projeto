import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Ponte Cardigann do Apache Torrent: o card aponta para o resolver local
// (8706) e o magnet sai direto da linha sintética. O grosso dos parsers mora em
// br-parsers-apachetorrent.test.ts; aqui ficam os contratos do YAML e da página
// sintética que o details/download do card consomem.
import apachetorrentShim from '../apachetorrent-resolver/server.js';
import * as apachetorrentParsers from '../resolvers/profiles/apachetorrent-parsers.js';
const apachetorrent: any = apachetorrentShim;
const parsers: any = apachetorrentParsers;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixture = (name: any) =>
  fs.readFileSync(path.join(__dirname, 'fixtures', 'apachetorrent', name), 'utf8');

const postHtml = fixture('post-coringa-delirio.html');
const SITE = 'https://apachetorrents.com';
const POST_URL = `${SITE}/coringa-delirio-a-dois-baixar-torrent/`;

const yml = fs.readFileSync(
  path.join(__dirname, '..', 'jackett-bludv', 'apachetorrent-cardigann.yml'),
  'utf8',
);

// Blocos de campo: cortam na próxima chave a 4 espaços (comentários a 6
// espaços ficam DENTRO do bloco do próprio campo).
const field = (name: string) =>
  yml.split(/\n    (?=[a-zA-Z])/).find((chunk) => chunk.startsWith(`${name}:`)) || '';

describe('apachetorrent: definição Cardigann', () => {
  test('id próprio não colide com o indexer C# stock aposentado', () => {
    assert.match(yml, /^id:\s*apachetorrent-cardigann$/m);
    assert.match(yml, /^name:\s*Apache Torrent$/m);
    assert.match(yml, /^language:\s*pt-BR$/m);
    assert.match(yml, /^type:\s*public$/m);
    assert.match(yml, /^settings:\s*\[\]$/m);
    assert.match(yml, /^\s*-\s*https:\/\/apachetorrents\.com\/$/m);
  });

  test('path aponta para o resolver local na 8706 (sem strip de SxxEyy no yml)', () => {
    assert.match(yml, /http:\/\/127\.0\.0\.1:8706\/search\?q=\{\{ \.Query\.Keywords \}\}/);
    assert.doesNotMatch(yml, /8705/);
    // O addon tira SxxEyy/ano (bareTitleIndexers); o yml só limpa ":"/espaços.
    assert.doesNotMatch(yml, /S\\d\{1,2\}/);
  });

  test('rows e fields leem a página sintética (magnet no href do título)', () => {
    assert.match(yml, /selector:\s*"div\.posts > div\.release"/);
    assert.match(field('download'), /selector:\s*"div\.title > a"/);
    assert.match(field('download'), /attribute:\s*href/);
    // Magnet direto: sem download.before nem /dl.
    assert.doesNotMatch(yml, /^\s*download\.before:/m);
    assert.doesNotMatch(yml, /\/dl\?/);
  });

  test('details lê o HREF do post (div.post > a) e date usa now', () => {
    const detailsBlock = field('details');
    assert.match(detailsBlock, /selector:\s*"div\.post > a"/);
    assert.match(detailsBlock, /attribute:\s*href/);
    assert.doesNotMatch(detailsBlock, /selector:\s*"div\.description"/);
    assert.match(field('date'), /text:\s*now/);
  });

  test('size aceita o sentinela KB e seeders é neutro 1', () => {
    assert.match(field('size'), /GB\|MB\|TB\|KB/);
    assert.match(field('seeders'), /text:\s*1/);
    assert.match(field('leechers'), /text:\s*0/);
    assert.match(field('downloadvolumefactor'), /text:\s*0/);
    assert.match(field('uploadvolumefactor'), /text:\s*1/);
  });

  test('caps expõe media em Movies e TV com allowrawsearch', () => {
    assert.match(yml, /allowrawsearch:\s*true/);
    assert.match(yml, /search:\s*\[q\]/);
    assert.match(yml, /tv-search:\s*\[q, season, ep\]/);
    assert.equal(yml.split('id: media, cat:').length - 1, 2);
  });
});

describe('apachetorrent: página sintética expõe post.url para o details do cardigann', () => {
  const links: any[] = parsers.parsePostMagnets(postHtml, POST_URL);
  const post = { url: POST_URL, title: 'Coringa - Delírio a Dois Torrent Dublado / Dual Áudio', year: 2024 };
  const searchPageHtml = parsers.createApacheSearchPageHtml();

  test('post.url tem elemento próprio (div.post > a) com o href intacto', () => {
    const items = links.map((link: any, index: number) => ({ post, link, index, count: links.length }));
    const html = searchPageHtml(items);
    assert.ok(html.includes(`<div class="post"><a href="${POST_URL}">`));
    const prefix = links[0].url.slice(0, 40).replace(/&/g, '&amp;');
    assert.ok(html.includes(`href="${prefix}`));
    assert.ok(!html.includes('/resolve'));
  });

  test('a description da linha carrega a versão/desc do bloco do magnet', () => {
    const items = links.map((link: any, index: number) => ({ post, link, index, count: links.length }));
    const html = searchPageHtml(items);
    assert.ok(html.includes('VERSÃO DUBLADA'));
    assert.ok(html.includes('DOWNLOAD TORRENT LEGENDADO 5.1 MKV 720P'));
  });

  test('o profile expõe a superfície usada pelo card (siteSelector/fetchSearchHtml)', () => {
    assert.equal(typeof apachetorrent.siteSelector.url, 'function');
    assert.equal(typeof apachetorrent.parsePostMagnets, 'function');
  });
});
