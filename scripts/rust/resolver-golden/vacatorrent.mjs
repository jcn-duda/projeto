#!/usr/bin/env node
// Oráculo do golden do resolver Rust do VacaTorrent: roda o profile TS (dist/)
// sobre as fixtures e grava o que o Rust tem que reproduzir byte a byte.
//   DOTENV_CONFIG_PATH=test/fixtures/env-empty node scripts/rust/resolver-golden/vacatorrent.mjs
// Saída: rust/crates/adom-resolvers/tests/golden/vacatorrent.json. Além do formato do
// goldenRun, o campo `shapes` leva as funções de forma (link da página de botões,
// URL do season-internal, cards de temporada e título do batch).
//
// SEM o caso `rss` (feed /api), pelo mesmo motivo do comando: o profile TS não
// registra `createApiRoute` (só bludv, tdf, apache, hdr, rede e nerd registram).
// Medido ao vivo no container (Rust em 8704): `/api?t=caps` e
// `/api?t=movie&q=duna` devolvem 200 com o feed genérico do port, onde o TS
// devolveria 404; `jackett-bludv/vacatorrent.yml` só consulta `/search` e
// `/resolve`, então nada no pipeline cai nessa rota.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { distImport, fixture, goldenRun, linkJson, postJson, postTitleOf } from './lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT = path.join(ROOT, 'rust/crates/adom-resolvers/tests/golden/vacatorrent.json');
const BASE = 'https://vaqueirofilmes1.com';
const SEASON_BASE = 'https://vaqueirofilmes.com/pt/season-internal/?show=62658';

const site = (await distImport('vacatorrent-resolver/server.js')).default;

// Post sintético por página: título e ano vêm do catálogo da busca, não da página.
const POSTS = {
  'vacatorrent/movie-links.html': {
    title: 'Um Dia de Sorte em Nova York',
    url: `${BASE}/pt/movie/um-dia-de-sorte-em-nova-york/`,
    poster: 'https://vaqueirofilmes.com/wp-content/uploads/2026/07/poster-1453422-150x150.webp',
    year: 2025,
  },
  'vacatorrent/batch.html': {
    title: 'BATCH – Sacrifício de Sangue S05',
    url: `${BASE}/batch/batch-sacrificio-de-sangue-s05/`,
    poster: null,
    year: null,
  },
  'vacatorrent/season-episodes.html': {
    title: 'Outer Banks',
    url: `${BASE}/tv/outer-banks/season/temporada-1/`,
    poster: null,
    year: 2020,
  },
};

const PAGES = [
  'movie-links.html',
  'batch.html',
  'season-episodes.html',
  'movie-page.html',
  'season-internal.html',
  'go.php.html',
  'tv-shows.html',
].map((n) => `vacatorrent/${n}`);

await goldenRun({
  site: 'vacatorrent',
  searchFixtures: ['vacatorrent/search-dia-d.json', 'vacatorrent/search-exterminio.json'],
  parsePosts: (text) => site.parseSearchJson(text, BASE),
  postFixtures: PAGES,
  baseUrl: BASE,
  postOf: (name, html) => POSTS[name] ?? {
    title: postTitleOf(html, name),
    url: `${BASE}/${path.basename(name, '.html')}/`,
    poster: null,
    year: null,
  },
  postLinks: (html, postUrl) => site.parseDownloadLinks(html, postUrl),
  releaseTitle: (post, link, index) => site.releaseTitle(post, link, index),
  searchPageHtml: (items) => site.searchPageHtml(items),
  cleanTitle: (title) => site.cleanMarkTitle(title),
});

// Formas de página: cada caso traz a entrada (fixture ou html literal) e a saída do TS.
const page = (name) => fixture(`vacatorrent/${name}`);
const shapes = {
  movie_links: ['movie-page.html', 'movie-links.html'].map((n) => ({
    fixture: `vacatorrent/${n}`, html: null, base: BASE,
    out: site.extractMovieLinks(page(n), BASE),
  })),
  series_internal_url: ['tv-shows.html', 'movie-page.html', 'batch.html'].map((n) => ({
    fixture: `vacatorrent/${n}`, html: null, base: BASE,
    out: site.seriesSeasonInternalUrl(page(n), BASE),
  })),
  season_internal: [{
    fixture: 'vacatorrent/season-internal.html', html: null, base: SEASON_BASE,
    out: site.parseSeasonInternal(page('season-internal.html'), SEASON_BASE),
  }],
  batch_title: [
    { fixture: 'vacatorrent/batch.html', html: null, out: site.extractBatchTitle(page('batch.html')) },
    { fixture: null, html: '<h2>Pack 4ordf Temporada</h2>', out: site.extractBatchTitle('<h2>Pack 4ordf Temporada</h2>') },
    { fixture: null, html: '<h1 class="bl-hero-title">BATCH – The Boys 4&ordf; Temporada</h1>', out: site.extractBatchTitle('<h1 class="bl-hero-title">BATCH – The Boys 4&ordf; Temporada</h1>') },
  ],
};

// Séries: o profile passa `season` e `realTitle` (batch) como opções do coletor.
// Saída: botões e títulos desse caminho, que o golden do post sem opções não cobre.
const withOptions = [
  { name: 'vacatorrent/batch.html', season: 5, realTitle: 'The Boys 4ª Temporada' },
  { name: 'vacatorrent/season-episodes.html', season: 1, realTitle: null },
].map(({ name, season, realTitle }) => {
  const post = POSTS[name];
  const options = { season, realTitle };
  const links = site.parseDownloadLinks(fixture(name), post.url, options);
  return {
    fixture: name,
    post: postJson(post),
    season,
    real_title: realTitle,
    links: links.map(linkJson),
    titles: links.map((link, index) => site.releaseTitle(post, link, index)),
  };
});

const golden = JSON.parse(fs.readFileSync(OUT, 'utf8'));
golden.shapes = { ...shapes, links_with_options: withOptions };
fs.writeFileSync(OUT, `${JSON.stringify(golden)}\n`);
console.log(`[golden] vacatorrent: formas ${Object.values(shapes).reduce((n, c) => n + c.length, 0)} caso(s) -> ${path.relative(ROOT, OUT)}`);
