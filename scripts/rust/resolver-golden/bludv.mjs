#!/usr/bin/env node
// Oráculo do golden do resolver Rust: roda o profile TS (dist/) sobre as
// fixtures e grava o que o Rust tem que reproduzir byte a byte.
//   DOTENV_CONFIG_PATH=test/fixtures/env-empty node scripts/rust/resolver-golden/bludv.mjs
// Saída: rust/crates/adom-resolvers/tests/golden/bludv.json
//
// Fase 4: o BLUDV agora exporta o feed torznab (`createBludvRssXml`), então
// o golden traz o campo `rss` com o feed de cada post. O relógio é congelado
// no oráculo para o golden ser reprodutível (a data do post vem do HTML).
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

// Relógio congelado para o feed ser reprodutível. A data do pubDate vem do
// post (parsePostDate), mas quando o post não tem data, o TS usa new Date().
// Congelamos o relógio para o golden não mudar a cada execução.
const FROZEN_DATE = 'Sun, 01 Jan 2023 00:00:00 GMT';
const originalDate = globalThis.Date;
globalThis.Date = class extends originalDate {
  constructor(...args) {
    if (args.length === 0) return new originalDate(FROZEN_DATE);
    return new originalDate(...args);
  }
  static now() { return new originalDate(FROZEN_DATE).getTime(); }
  static parse(...args) { return originalDate.parse(...args); }
  static UTC(...args) { return originalDate.UTC(...args); }
};

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
  rssXml: (items, category) => {
    // O BLUDV exporta createBludvRssXml; usamos o selfUrl do resolver.
    const rssXml = site.createBludvRssXml ? site.createBludvRssXml({ selfUrl: 'http://bludv-resolver:8700' }) : null;
    return rssXml ? rssXml(items, category) : null;
  },
  cleanTitle: (title) => site.cleanPostTitle(title),
});

// Restaura o Date original.
globalThis.Date = originalDate;
