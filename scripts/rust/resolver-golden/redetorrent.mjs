#!/usr/bin/env node
// Oráculo do golden do resolver Rust: roda o profile TS (dist/) sobre as
// fixtures do Rede Torrent e grava o que o Rust tem que reproduzir byte a byte.
//   DOTENV_CONFIG_PATH=test/fixtures/env-empty node scripts/rust/resolver-golden/redetorrent.mjs
// Saída: rust/crates/adom-resolvers/tests/golden/redetorrent.json
import { distImport, goldenRun, postTitleOf } from './lib.mjs';

const BASE = 'https://www.redetorrent.xyz';
// Data fixa no post: sem ela o feed usa o relógio e o golden não reproduz.
const POST_DATE = 'Mon, 01 Jan 2024 00:00:00 GMT';

const site = (await distImport('redetorrent-resolver/server.js')).default;

await goldenRun({
  site: 'redetorrent',
  searchFixtures: ['redetorrent/search-coringa.html', 'redetorrent/search-casa-do-dragao.html'],
  parsePosts: (html) => site.parseSearchHtml(html, BASE),
  postFixtures: [
    'redetorrent/post-coringa-delirio.html',
    'redetorrent/post-coringa-delirio-rendered.html',
    'redetorrent/serie-fallout.html',
    'redetorrent/formato-desconhecido.html',
  ],
  baseUrl: BASE,
  postOf: (name, html) => ({
    title: postTitleOf(html, name),
    url: `${BASE}/${name.replace(/^.*\//, '').replace(/\.html?$/, '')}/`,
    poster: null,
    date: POST_DATE,
  }),
  postLinks: (html, postUrl) => site.parsePostLinks(html, postUrl),
  releaseTitle: (post, link, index) => site.releaseTitle(post, link, index),
  searchPageHtml: (items) => site.searchPageHtml(items),
  rssXml: (items, category) => site.rssXml(items, category),
  cleanTitle: (title) => site.cleanPostTitle(title),
});
