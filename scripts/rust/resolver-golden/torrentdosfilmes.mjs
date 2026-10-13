#!/usr/bin/env node
// Oráculo do golden do resolver Rust: roda o profile TS (dist/) sobre as
// fixtures e grava o que o Rust tem que reproduzir byte a byte.
//   DOTENV_CONFIG_PATH=test/fixtures/env-empty node scripts/rust/resolver-golden/torrentdosfilmes.mjs
// Saída: rust/crates/adom-resolvers/tests/golden/torrentdosfilmes.json
import path from 'node:path';
import { distImport, goldenRun, postTitleOf } from './lib.mjs';

const BASE_URL = 'https://torrentdosfilmes-v2.xyz';
const site = (await distImport('torrentdosfilmes-resolver/server.js')).default;

// Post sintético: título do <h1> da fixture e URL de detalhe no domínio do
// site (o tdf não publica poster na página de post).
const postOf = (name, html) => ({
  title: postTitleOf(html, name),
  url: `${BASE_URL}/${path.basename(name).replace(/\.html?$/, '')}/`,
  poster: null,
});

await goldenRun({
  site: 'torrentdosfilmes',
  searchFixtures: ['torrentdosfilmes-search.html'],
  parsePosts: (html) => site.parsePosts(html),
  postFixtures: [
    'torrentdosfilmes-post.html',
    'crawl/torrentdosfilmes/post-movie.html',
    'crawl/torrentdosfilmes/post-series.html',
  ],
  baseUrl: BASE_URL,
  postOf,
  postLinks: (html, postUrl) => site.parseDownloadLinks(html, postUrl),
  releaseTitle: (post, link, index) => site.releaseTitle(post, link, index),
  searchPageHtml: (items) => site.searchPageHtml(items),
  // Sem `cleanTitle`: o profile não exporta a limpeza própria (o título
  // limpo é coberto pelo golden de `releaseTitle`). Sem `rssXml`: o feed
  // compacto não é exportado pelo profile.
});
