#!/usr/bin/env node
// Oráculo do golden do resolver Rust: roda o profile TS (dist/) sobre as
// fixtures e grava o que o Rust tem que reproduzir byte a byte.
//   ADOM_DIST="E:/stremio adom/dist" DOTENV_CONFIG_PATH=test/fixtures/env-empty node scripts/rust/resolver-golden/bludv.mjs
// Saída: rust/crates/adom-resolvers/tests/golden/bludv.json
//
// O BLUDV não exporta o feed torznab (`createBludvRssXml` fica interno ao
// perfil), então não há gancho `rssXml`: o golden não traz o campo `rss`.
import path from 'node:path';
import { distImport, goldenRun, postTitleOf } from './lib.mjs';

const site = (await distImport('bludv-resolver/server.js')).default;
const BASE_URL = 'https://bludvfilmes.xyz';

// Post sintético com data (a página HTML do card mostra `post.date` quando
// existe) e poster com `&` (valida o escape do atributo src).
function postOf(name, html) {
  const slug = name.replace(/\.(html?|json)$/, '').replace(/[^a-z0-9-]+/gi, '-');
  const date = html.match(/(\d{2}\/\d{2}\/\d{4})/);
  return {
    title: postTitleOf(html, path.basename(name)),
    url: `${BASE_URL}/${slug}/`,
    poster: '/wp-content/uploads/capa&poster.jpg',
    date: date ? date[1] : null,
  };
}

await goldenRun({
  site: 'bludv',
  searchFixtures: ['bludv-search.html'],
  parsePosts: (html) => site.parsePosts(html),
  postFixtures: [
    'bludv-post.html',
    'crawl/bludv/post-movie.html',
    'crawl/bludv/post-series.html',
  ],
  baseUrl: BASE_URL,
  postOf,
  postLinks: (html, postUrl) => site.parseDownloadLinks(html, postUrl),
  releaseTitle: (post, link, index) => site.releaseTitle(post, link, index),
  searchPageHtml: (items) => site.searchPageHtml(items),
  cleanTitle: (title) => site.cleanPostTitle(title),
});
