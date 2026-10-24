#!/usr/bin/env node
// Oráculo do golden do resolver Rust do Apache Torrent: roda o profile TS (dist/)
// sobre as fixtures e grava o que o Rust tem que reproduzir.
//   DOTENV_CONFIG_PATH=test/fixtures/env-empty node scripts/rust/resolver-golden/apachetorrent.mjs
// Saídas (em rust/crates/adom-resolvers/tests/golden/):
//   apachetorrent.json        busca, botões, títulos, página HTML e feed torznab
//   apachetorrent-token.json  extractSearchToken (token do form da home)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { distImport, fixture, goldenRun, linkJson, postJson } from './lib.mjs';

const BASE = 'https://apachetorrents.com';
const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../rust/crates/adom-resolvers/tests/golden');
const site = (await distImport('apachetorrent-resolver/server.js')).default;

// Relógio fixo: o feed torznab carimba `new Date().toUTCString()` em cada item.
// Sem isto o golden mudaria a cada execução. O Rust recebe a data por parâmetro
// (`feed_with_date`), então a comparação do feed continua byte a byte.
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

await goldenRun({
  site: 'apachetorrent',
  searchFixtures: ['apachetorrent/busca-coringa.html'],
  parsePosts: (html) => site.parseSearchHtml(html, BASE),
  postFixtures: [
    'apachetorrent/post-coringa-delirio.html',
    'crawl/apachetorrent/post-filme.html',
    'crawl/apachetorrent/post-serie.html',
    'crawl/apachetorrent/post-serie-desenho.html',
  ],
  baseUrl: BASE,
  postLinks: (html, postUrl) => site.parsePostMagnets(html, postUrl),
  releaseTitle: (post, link, index) => site.releaseTitle(post, link, index),
  searchPageHtml: (items) => site.createApacheSearchPageHtml()(items),
  rssXml: (items, category) => site.apacheRssXml(items, category),
  cleanTitle: (title) => site.cleanPostTitle(title),
});

// O golden de títulos do lib só varia áudio em dublado/legendado/desconhecido,
// mas o Apache também publica "dual" (tag DUAL). Acrescenta essas combinações,
// calculadas pelo releaseTitle do TS, ao mesmo golden.
const goldenFile = path.join(OUT_DIR, 'apachetorrent.json');
const golden = JSON.parse(fs.readFileSync(goldenFile, 'utf8'));
const titleSources = [...new Set([...golden.titles, ...golden.posts].map((t) => (t.post ?? t).title))];
for (const title of titleSources) {
  const post = { title, url: `${BASE}/x/` };
  for (const quality of [null, 1080, 2160])
    for (const source of [null, 'WEB-DL', 'BLU-RAY'])
      for (const size of [null, '2.4 GB'])
        for (const [episode, episodeLast] of [[null, null], [5, null], [5, 7]])
          for (const index of [null, 2]) {
            const link = { url: 'magnet:?xt=urn:btih:x', quality, audio: 'dual', source, size, episode, episodeLast };
            golden.titles.push({ post: postJson(post), link: linkJson(link), index, out: site.releaseTitle(post, link, index) });
          }
}
fs.writeFileSync(goldenFile, `${JSON.stringify(golden)}\n`);
console.log(`[golden] apachetorrent: +${golden.titles.length} título(s) com áudio dual (total ${golden.titles.length})`);

// Token do form da home: fixture real e casos de borda do parser por tag.
const tokenCases = [
  { label: 'home.html', fixture: 'apachetorrent/home.html' },
  { label: 'busca-coringa.html (sem token)', fixture: 'apachetorrent/busca-coringa.html' },
  { label: 'html vazio', html: '' },
  { label: 'value antes do name', html: '<input value="abc123" name="token">' },
  { label: 'value vazio na primeira tag', html: '<input name="token" value=""><input name="token" value="depois">' },
  { label: 'nomes e valor em maiusculas com entidade', html: '<INPUT NAME="TOKEN" VALUE="x&amp;y">' },
  { label: 'espacos e entidade no valor', html: '<input type="hidden" name="token" value=" a&amp;b ">' },
  { label: 'data-name tambem casa (\\b)', html: '<input data-name="token" value="zz"><input name="token" value="ok">' },
  { label: 'sem input de token', html: '<form><input name="busca"></form>' },
  // O TS testa o valor CRU (`if (value)`) e só depois dá trim: vira "" e não null.
  { label: 'valor so com espacos', html: '<input name="token" value="   ">' },
];
const tokens = tokenCases.map((c) => {
  const html = c.fixture ? fixture(c.fixture) : c.html;
  return { label: c.label, fixture: c.fixture ?? null, html: c.fixture ? null : c.html, token: site.extractSearchToken(html) };
});
fs.writeFileSync(path.join(OUT_DIR, 'apachetorrent-token.json'), `${JSON.stringify({ site: 'apachetorrent', cases: tokens })}\n`);
console.log(`[golden] apachetorrent-token: ${tokens.length} caso(s) → apachetorrent-token.json`);
