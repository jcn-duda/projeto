#!/usr/bin/env node
// Oráculo do golden do resolver Rust: roda o profile TS (dist/) sobre as
// fixtures e grava o que o Rust tem que reproduzir byte a byte.
//   DOTENV_CONFIG_PATH=test/fixtures/env-empty node scripts/rust/resolver-golden/comandotorrents.mjs
// Saída: rust/crates/adom-resolvers/tests/golden/comandotorrents.json
import { distImport, goldenRun } from './lib.mjs';

const site = (await distImport('comandotorrents-resolver/server.js')).default;

await goldenRun({
  site: 'comandotorrents',
  searchFixtures: ['comandotorrents-search.html', 'comandotorrents-search-extended.html'],
  parsePosts: (html) => site.parsePosts(html),
  postFixtures: [
    'comandotorrents-post.html',
    'comandotorrents-movie-complex.html',
    'comandotorrents-legendado-only.html',
    'comandotorrents-series-episodic.html',
    'comandotorrents-series-multiseason.html',
  ],
  baseUrl: 'https://comandotorrents.to',
  postLinks: (html, postUrl) => site.parseDownloadLinks(html, postUrl),
  releaseTitle: (post, link, index) => site.releaseTitle(post, link, index),
  searchPageHtml: (items) => site.searchPageHtml(items),
  cleanTitle: (title) => site.cleanPostTitle(title),
});
