#!/usr/bin/env node
// Oráculo do golden do resolver Rust: roda o profile TS (dist/) sobre as
// fixtures e grava o que o Rust tem que reproduzir byte a byte.
//   DOTENV_CONFIG_PATH=test/fixtures/env-empty node scripts/rust/resolver-golden/comandotorrents.mjs
// Saída: rust/crates/adom-resolvers/tests/golden/comandotorrents.json
//
// SEM o caso `rss` (feed /api): o profile TS NÃO registra a rota —
// `createApiRoute` aparece em bludv, torrentdosfilmes, apachetorrent, hdrtorrents,
// redetorrent e nerdfilmes, mas não em `comandotorrents.ts` nem em
// `vacatorrent.ts`. Medido ao vivo no container (Rust em 8701): `/api?t=caps` e
// `/api?t=movie&q=duna` respondem 200 com um feed genérico do port, enquanto o
// TS devolveria 404. Nenhum consumidor cai aí — os cards Cardigann
// (`jackett-bludv/comandotorrents.yml`) apontam só `/search` e `/resolve`. Travar
// esse feed no golden exigiria primeiro acertar a rota no port, não exportar
// lógica que o TS não tem.
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
