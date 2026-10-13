#!/usr/bin/env node
// Oráculo do golden do resolver Rust: roda o profile TS (dist/) sobre as
// fixtures e grava o que o Rust tem que reproduzir byte a byte.
//   DOTENV_CONFIG_PATH=test/fixtures/env-empty node scripts/rust/resolver-golden/hdrtorrents.mjs
// Saída: rust/crates/adom-resolvers/tests/golden/hdrtorrents.json
//
// O HDR não expõe a página sintética no objeto do resolver: ela vem da
// factory `createHDRSearchPageHtml` do módulo de parsers (mesmo código que a
// busca viva usa). A listagem é `parseListingHtml(html, baseUrl)`, com a
// origem explícita, porque o profile a recebe do seletor de domínio.
import { distImport, goldenRun } from './lib.mjs';

const BASE = 'https://hdrtorrents.net';
const site = (await distImport('hdrtorrents-resolver/server.js')).default;
const parsers = await distImport('resolvers/profiles/hdrtorrents-parsers.js');
const release = await distImport('resolvers/release-format.js');
const searchPageHtml = parsers.createHDRSearchPageHtml();

await goldenRun({
  site: 'hdrtorrents',
  searchFixtures: [
    'crawl/hdrtorrents/pagina-1-cheia.html',
    'crawl/hdrtorrents/pagina-fim-calcanhar.html',
    'crawl/hdrtorrents/pagina-fora-de-faixa.html',
  ],
  parsePosts: (html) => site.parseListingHtml(html, BASE),
  postFixtures: [
    'crawl/hdrtorrents/post-filme.html',
    'crawl/hdrtorrents/post-serie.html',
    'crawl/hdrtorrents/post-serie-agregada.html',
    'crawl/hdrtorrents/post-serie-episodios.html',
  ],
  baseUrl: BASE,
  postLinks: (html, postUrl) => site.parseContentMagnets(html, postUrl),
  releaseTitle: (post, link, index) => site.releaseTitle(post, link, index),
  searchPageHtml: (items) => searchPageHtml(items),
  cleanTitle: (title) => release.cleanPostTitle(title),
});
