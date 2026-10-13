#!/usr/bin/env node
// Oráculo do golden do resolver Rust (NerdFilmes): roda o profile TS (dist/)
// sobre as fixtures e grava o que o Rust tem que reproduzir byte a byte.
//   ADOM_DIST="<dist>" DOTENV_CONFIG_PATH=test/fixtures/env-empty node scripts/rust/resolver-golden/nerdfilmes.mjs
// Saídas: rust/crates/adom-resolvers/tests/golden/nerdfilmes.json (goldenRun)
// e rust/crates/adom-resolvers/tests/golden/nerdfilmes-date.json (parsePostDate,
// que o golden de goldenRun não exercita: o post do oráculo não carrega data).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { distImport, fixture, goldenRun } from './lib.mjs';

const site = (await distImport('nerdfilmes-resolver/server.js')).default;

const postFixtures = [
  'nerdfilmes-post.html',
  'nerdfilmes-post-linkphp.html',
  'nerdfilmes-linkphp-gate.html',
  'crawl/nerdfilmes/post-movie.html',
  'crawl/nerdfilmes/post-series.html',
  'crawl/nerdfilmes/post-no-buttons.html',
];

await goldenRun({
  site: 'nerdfilmes',
  searchFixtures: ['nerdfilmes-search.html'],
  parsePosts: (html) => site.parsePosts(html),
  postFixtures,
  baseUrl: 'https://www.xfilmeshd.org',
  postLinks: (html, postUrl) => site.parseDownloadLinks(html, postUrl),
  releaseTitle: (post, link, index) => site.releaseTitle(post, link, index),
  searchPageHtml: (items) => site.searchPageHtml(items),
  cleanTitle: (title) => site.cleanPostTitle(title),
});

// Datas: fixtures reais + casos sintéticos (precedência meta > JSON-LD, fuso,
// data só com dia, datas que o JS rejeita).
const dateCases = [
  ...postFixtures.map((name) => fixture(name)),
  '<meta property="article:published_time" content="2024-05-01T10:00:00-03:00">',
  '<meta property="article:published_time" content="2024-05-01T10:00:00.123Z">',
  '<meta name="datePublished" content="2023-01-02">',
  '<script>{"datePublished":"2022-12-31T23:59:59+00:00"}</script>',
  '<meta property="article:published_time" content="ontem"><script>{"datePublished":"2020-01-01"}</script>',
  '<meta property="article:published_time" content="2024-13-01">',
  '<meta property="article:published_time" content="2024-02-30T08:30:00+05:30">',
  '<p>sem data</p>',
];
const dateOut = { cases: dateCases.map((html) => ({ html, date: site.parsePostDate(html) })) };
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../rust/crates/adom-resolvers/tests/golden');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'nerdfilmes-date.json'), `${JSON.stringify(dateOut)}\n`);
console.log(`[golden] nerdfilmes-date: ${dateOut.cases.length} caso(s) de data`);
