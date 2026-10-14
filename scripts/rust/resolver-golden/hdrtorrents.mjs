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
//
// O feed torznab carimba `new Date().toUTCString()` em cada item (como o TS).
// Sem o relógio congelado, o golden mudaria a cada execução. O Rust recebe a
// data por parâmetro (`feed_with_date`), então a comparação do feed é byte a
// byte — mesmo modelo do apachetorrent.
import { distImport, goldenRun } from './lib.mjs';

const BASE = 'https://hdrtorrents.net';

// Relógio fixo: mesmo instante do golden do Apache (Date.UTC(2026, 9, 13, 12)).
// O feed torznab carimba `new Date().toUTCString()` em cada item; sem isto o
// golden mudaria a cada execução.
const FIXED_MS = Date.UTC(2026, 9, 13, 12, 0, 0);
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(FIXED_MS);
    else super(...args);
  }
  static now() {
    return FIXED_MS;
  }
};

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
  rssXml: (items, category) => parsers.hdrRssXml(items, category),
  cleanTitle: (title) => release.cleanPostTitle(title),
});
