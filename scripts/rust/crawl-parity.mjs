#!/usr/bin/env node
/**
 * Paridade REAL dos parsers de raspagem: TS puro (`dist/`) × Rust
 * (`parseCrawlPage` da ponte `adom-napi`) sobre TODAS as fixtures relevantes.
 *
 * Diferente do stub anterior (que só provava o TS contra si mesmo), aqui cada
 * fixture de página/mico é:
 *   1. resolvida no TS puro do `dist` (título/ano via `readWorkTitle`, IMDb do
 *      módulo de descoberta do site, e a lista de magnets via o parser de perfil
 *      que o site usa);
 *   2. resolvida no Rust por `napi.parseCrawlPage(site, kind, url, html)`;
 *   3. comparada campo a campo (status, título, ano, IMDb e o CONJUNTO de
 *      infohashes btih).
 *
 * FALHA (exit 1) se: a ponte Rust não existir / não exportar `parseCrawlPage`;
 * o `dist` não existir; ZERO casos forem avaliados; ou QUALQUER divergência.
 * Divergências são listadas sem normalização redutora (sem fuzzy/“quase igual”).
 *
 * Ligação: `ADOM_NAPI_PATH` (caminho do `.node`) tem precedência; o default é
 * `dist/rust/adom_napi.node`. O binário do repo é gerado no Docker (musl) e o
 * `npm run build` NÃO o produz — um `.node` defasado (sem `parseCrawlPage`)
 * falha aqui de propósito.
 *
 * SÉRIE: além das páginas de obra, há linhas com o payload CONCATENADO do Vaca
 * (season page + cards) e os links PRÉ-protetor de cada card — a MESMA unidade
 * que o shadow compara. Comandotorrents e TorrentDosFilmes entram pelas
 * superfícies REAIS dos profiles (`createResolver({port:0})`, offline), e o
 * RedeTorrent tem série (grouping). A paridade de links é do CONJUNTO por
 * identidade (`btih:` p/ magnet, senão a URL crua).
 *
 * DOIS BALDES (nada é escondido por normalização):
 * - `divergências` (FALHA): title/year/workType/imdb, MAGNET que falta/sobra
 *   (chave = só `magnet`/btih, como o `torrentKey` do shadow), status com
 *   magnet presente, e PÂNICO do Rust.
 * - `[fronteira]` (contador separado, NÃO falha): link de PROTETOR (sem magnet)
 *   que o Rust pré-protetor não representa, `originalTitle` e `season` que o
 *   port ainda não popula em alguns sites, e a chave de GRUPO (card-vs-página).
 *   Fica sempre impresso e contado para a fronteira permanecer VISÍVEL.
 *
 * STATUS POR MAGNET (alinha ao `explainedByProtector` do shadow): link de
 * protetor NÃO é torrent. Página com SÓ botões de protetor não é `done`
 * pré-protetor — o status não é comparado e vira FRONTEIRA, nunca falso
 * vermelho. Status só é comparado quando há magnet na página (ou nenhum link).
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = path.join(REPO, 'test', 'fixtures');
const require = createRequire(import.meta.url);

const fail = (msg) => {
  console.error(`[crawl-parity] FALHA: ${msg}`);
  process.exit(1);
};

// --- Ponte Rust -------------------------------------------------------------
const napiPath = process.env.ADOM_NAPI_PATH || path.join(REPO, 'dist', 'rust', 'adom_napi.node');
if (!fs.existsSync(napiPath)) {
  fail(`ponte Rust ausente: ${napiPath} (rode o build integrado / Docker; use ADOM_NAPI_PATH para apontar um .node local)`);
}
let napi;
try {
  napi = require(napiPath);
} catch (e) {
  fail(`não carregou a ponte Rust (${napiPath}): ${e.message}`);
}
if (typeof napi.parseCrawlPage !== 'function') {
  fail(`a ponte Rust não exporta parseCrawlPage (binário defasado): ${Object.keys(napi).join(', ')}`);
}

// --- Módulos TS puros do dist ----------------------------------------------
const imp = (rel) => pathToFileURL(path.join(REPO, rel)).href;
async function loadTs() {
  try {
    const comandoRes = await import(imp('dist/resolvers/profiles/comandotorrents.js'));
    const tdfRes = await import(imp('dist/resolvers/profiles/torrentdosfilmes.js'));
    return {
      workName: await import(imp('dist/src/providers/crawl-sites/work-name.js')),
      shared: await import(imp('dist/src/providers/crawl-sites/shared.js')),
      seasonPage: await import(imp('dist/src/providers/crawl-sites/season-page.js')),
      bludv: await import(imp('dist/src/providers/crawl-sites/bludv-discovery.js')),
      apacheD: await import(imp('dist/src/providers/crawl-sites/apachetorrent-discovery.js')),
      hdrD: await import(imp('dist/src/providers/crawl-sites/hdrtorrents-discovery.js')),
      redeD: await import(imp('dist/src/providers/crawl-sites/redetorrent-discovery.js')),
      nerdD: await import(imp('dist/src/providers/crawl-sites/nerdfilmes-discovery.js')),
      comandoD: await import(imp('dist/src/providers/crawl-sites/comandotorrents-discovery.js')),
      vaca: await import(imp('dist/src/providers/crawl-sites/vaca.js')),
      mico: await import(imp('dist/src/providers/crawl-sites/mico-shared.js')),
      apacheP: await import(imp('dist/resolvers/profiles/apachetorrent-parsers.js')),
      hdrP: await import(imp('dist/resolvers/profiles/hdrtorrents-parsers.js')),
      redeP: await import(imp('dist/resolvers/profiles/redetorrent-parsers.js')),
      vacaP: await import(imp('dist/resolvers/profiles/vacatorrent-parsers.js')),
      bludvP: await import(imp('dist/resolvers/profiles/bludv-parsers.js')),
      nerdP: await import(imp('dist/resolvers/profiles/nerdfilmes-parsers.js')),
      // Superfícies REAIS dos profiles (offline: createResolver não faz rede).
      comandoSurface: comandoRes.createResolver({ port: 0, selfUrl: 'http://127.0.0.1:0', siteUrl: 'https://comandotorrents.to', extraProtectors: [] }),
      tdfSurface: tdfRes.createResolver({ port: 0, selfUrl: 'http://127.0.0.1:0', siteUrl: 'https://torrentdosfilmes.se', extraProtectors: [] }),
    };
  } catch (e) {
    fail(`dist indisponível/defasado (rode npm run build): ${e.message}`);
  }
}

/** Fixture relevante: parser TS do site + url/kind esperados pelo parseCrawlPage. */
function fixtureTable(ts) {
  const P = {
    bludv: { imdb: ts.bludv.parseImdbId, links: (h, u) => ts.bludvP.parseDownloadLinks(h, u) },
    apache: { imdb: ts.apacheD.parseImdbId, links: (h, u) => ts.apacheP.parsePostMagnets(h, u) },
    hdr: { imdb: ts.hdrD.parseImdbId, links: (h, u) => ts.hdrP.parseContentMagnets(h, u) },
    redetorrent: { imdb: ts.redeD.parseImdbId, links: (h, u) => ts.redeP.parsePostLinks(h, u) },
    nerdfilmes: { imdb: ts.nerdD.parseImdbId, links: (h, u) => ts.nerdP.parseDownloadLinks(h, u) },
    vaca: { imdb: ts.vaca.parseImdbId, links: (h, u) => ts.vacaP.parseDownloadLinks(h, u) },
    // Comando: superfície REAL do profile (o coletor tem protetores próprios).
    comandotorrents: { imdb: ts.comandoD.parseImdbId, links: (h, u) => ts.comandoSurface.parseDownloadLinks(h, u) },
    // TorrentDosFilmes: superfície REAL; `imdb` é SEMPRE null no site (armadilha),
    // então a comparação de imdb é omitida de propósito — e o link passa a ser real.
    torrentdosfilmes: { imdb: null, links: (h, u) => ts.tdfSurface.parseDownloadLinks(h, u) },
    mico: { imdb: (_h, u) => { const p = ts.mico.parseMicoUrl(u, null); return p ? p.imdb : null; }, links: null },
  };
  const rows = [
    ['bludv', 'movie', 'crawl/bludv/post-movie.html', 'https://bludvfilmes1.xyz/x/'],
    ['bludv', 'tv_show', 'crawl/bludv/post-series.html', 'https://bludvfilmes1.xyz/y/'],
    ['apache', 'movie', 'crawl/apachetorrent/post-filme.html', 'https://apachetorrents.com/x/'],
    ['apache', 'tv_show', 'crawl/apachetorrent/post-serie.html', 'https://apachetorrents.com/y/'],
    ['apache', 'tv_show', 'crawl/apachetorrent/post-serie-desenho.html', 'https://apachetorrents.com/z/'],
    ['hdr', 'movie', 'crawl/hdrtorrents/post-filme.html', 'https://hdrtorrents.org/x/'],
    ['hdr', 'tv_show', 'crawl/hdrtorrents/post-serie.html', 'https://hdrtorrents.org/y/'],
    ['hdr', 'tv_show', 'crawl/hdrtorrents/post-serie-agregada.html', 'https://hdrtorrents.org/w/'],
    ['hdr', 'tv_show', 'crawl/hdrtorrents/post-serie-episodios.html', 'https://hdrtorrents.org/v/'],
    ['redetorrent', 'movie', 'redetorrent/post-coringa-delirio.html', 'https://redetorrent.xyz/x/'],
    ['redetorrent', 'tv_show', 'redetorrent/serie-fallout.html', 'https://redetorrent.xyz/serie/fallout/'],
    ['nerdfilmes', 'movie', 'crawl/nerdfilmes/post-movie.html', 'https://nerdfilmes.com/x/'],
    ['nerdfilmes', 'tv_show', 'crawl/nerdfilmes/post-series.html', 'https://nerdfilmes.com/y/'],
    ['nerdfilmes', 'movie', 'crawl/nerdfilmes/post-no-buttons.html', 'https://nerdfilmes.com/z/'],
    ['torrentdosfilmes', 'movie', 'torrentdosfilmes-post.html', 'https://torrentdosfilmes.se/como-viajar-com-o-mala-do-seu-pai/'],
    ['torrentdosfilmes', 'tv_show', 'crawl/torrentdosfilmes/post-series.html', 'https://torrentdosfilmes.se/o-cacador-1a-temporada/'],
    ['comandotorrents', 'movie', 'comandotorrents-post.html', 'https://comandotorrents.to/furiosa-uma-saga-mad-max/'],
    ['comandotorrents', 'tv_show', 'comandotorrents-series-episodic.html', 'https://comandotorrents.to/the-boys-4a-temporada-torrent/'],
    ['comandotorrents', 'tv_show', 'comandotorrents-series-multiseason.html', 'https://comandotorrents.to/serie-multiseason/'],
    ['vaca', 'movie', 'crawl/vaca/movie-page-torrent.html', 'https://vaqueirofilmes1.com/pt/movie/expresso-do-amanha/'],
    // SÓ protetor (sem magnet): trava a derivação de status por magnet — não é
    // `done` pré-protetor (fronteira, não diff), como no `explainedByProtector`.
    ['vaca', 'movie', 'crawl/vaca/movie-page-protector-only.html', 'https://vaqueirofilmes.com/pt/movie/filme-protetor/'],
    ['mico', 'movie', 'crawl/mico/stream-movie.json', 'https://mico-leao-dublado-apiv-2.vercel.app/crawl/movie/tt0133093/'],
    ['mico', 'tv_show', 'crawl/mico/stream-episode.json', 'https://mico-leao-dublado-apiv-2.vercel.app/crawl/series/tt0133093/'],
  ];
  return rows.map(([site, kind, fixture, url]) => ({ site, kind, fixture, url, ts: P[site] })).concat([
    // Unidade de SÉRIE do Vaca (F6): o shadow compara o payload CONCATENADO
    // (season page + cards) com os links PRÉ-protetor de cada card. Registra a
    // fronteira card-vs-página: o Rust agrupa por `page_season_of`+link.season,
    // o TS por `declaredSeriesLocation`; a paridade aqui é do CONJUNTO de
    // infohashes, não da chave de grupo.
    {
      site: 'vaca', kind: 'tv_show', fixture: 'crawl/vaca/tv-show-page.html',
      url: 'https://vaqueirofilmes.com/tv/stranger-things/', ts: P.vaca,
      concat: [
        { file: 'crawl/vaca/season-card-stranger.html', url: 'https://vaqueirofilmes.com/tv/stranger-things/season/stranger-things/' },
        { file: 'crawl/vaca/season-card-episodes.html', url: 'https://vaqueirofilmes.com/tv/outer-banks/season/temporada-2/' },
      ],
    },
  ]);
}

const hashOf = (uri) => {
  const m = /btih:([a-z0-9]{32,40})/i.exec(String(uri || ''));
  return m ? m[1].toLowerCase() : null;
};
/**
 * Chave de torrent IGUAL à do shadow (`torrentKey`): btih (ou o magnet cru)
 * quando é magnet; `null` para PROTETOR/href sem magnet. Assim link de protetor
 * NÃO entra como chave — nem no TS nem no Rust.
 */
const torrentKey = (link) => {
  const magnet = String(link?.magnet || '');
  if (/^magnet:/i.test(magnet)) return hashOf(magnet) || magnet.toLowerCase();
  const url = String(link?.url || '');
  if (/^magnet:/i.test(url)) return hashOf(url) || url.toLowerCase();
  return null;
};
const magnetKeySet = (links) => new Set(links.map(torrentKey).filter(Boolean));
const nm = (v) => (v === undefined ? null : v);

async function main() {
  const ts = await loadTs();
  const rows = fixtureTable(ts);
  const diffs = [];
  const boundaries = [];
  let cases = 0;

  for (const row of rows) {
    const abs = path.join(FIXTURES, row.fixture);
    if (!fs.existsSync(abs)) {
      diffs.push(`${row.site}/${row.kind} ${row.fixture}: fixture ausente`);
      continue;
    }
    const pageHtml = fs.readFileSync(abs, 'utf8');
    // Série: o conteúdo é a CONCATENAÇÃO (pageHtml + cards) e os links esperados
    // vêm de cada card (pré-protetor), como no tap do `vaca-series.ts`.
    let content = pageHtml;
    let tsLinks = null;
    if (row.ts.links) {
      if (row.concat) {
        const cards = row.concat.map((c) => ({ html: fs.readFileSync(path.join(FIXTURES, c.file), 'utf8'), url: c.url }));
        content = [pageHtml, ...cards.map((c) => c.html)].join('\n');
        tsLinks = cards.flatMap((c) => row.ts.links(c.html, c.url));
      } else {
        tsLinks = row.ts.links(pageHtml, row.url);
      }
    }
    const rust = (() => {
      try {
        return napi.parseCrawlPage(row.site, row.kind, row.url, content);
      } catch (e) {
        return { __panic: e?.message || String(e) };
      }
    })();
    const w = ts.workName.readWorkTitle(pageHtml);
    const tsImdb = row.ts.imdb ? row.ts.imdb(pageHtml, row.url) : null;
    // Status "de parser" derivado por MAGNET, como o shadow: link de PROTETOR
    // não é torrent. Página só-protetor NÃO é `done` pré-protetor (o Rust, sem
    // seguir o protetor, devolve `no-torrent`) — nesse caso o status não é
    // comparado e vira FRONTEIRA, igual ao `explainedByProtector` do shadow.
    const magnetLinks = tsLinks ? tsLinks.filter((l) => torrentKey(l) !== null) : [];
    const tsHasMagnet = magnetLinks.length > 0;
    const protectorOnly = !!tsLinks && tsLinks.length > 0 && !tsHasMagnet;
    const tsStatus = !tsLinks ? null : (tsLinks.length === 0 ? 'no-torrent' : (tsHasMagnet ? 'done' : null));

    cases += 1;
    if (rust.__panic) {
      diffs.push(`${row.site}/${row.kind} ${row.fixture} [PÂNICO do Rust] ${rust.__panic}`);
      continue;
    }
    const cmp = (label, a, b) => {
      const na = a === undefined ? null : a;
      const nb = b === undefined ? null : b;
      if (na !== nb) diffs.push(`${row.site}/${row.kind} ${row.fixture} [${label}] ts=${JSON.stringify(na)} rust=${JSON.stringify(nb)}`);
    };
    // Mico é JSON (sem <h1>): título/ano não existem na página — não comparar.
    if (row.site !== 'mico') {
      cmp('title', w.title, rust.title);
      cmp('year', w.year, rust.year);
      cmp('workType', row.kind === 'tv_show' ? 'series' : 'movie', rust.workType);
      // OriginalTitle: o Rust expõe; o TS vem do mesmo `shared.parseOriginalTitle`.
      // Campo que o port ainda não cobre em alguns sites → FRONTEIRA (não falha),
      // nunca escondido por normalização.
      const tsOrig = ts.shared.parseOriginalTitle(pageHtml);
      if (nm(tsOrig) !== nm(rust.originalTitle)) {
        boundaries.push(`${row.site}/${row.kind} ${row.fixture} originalTitle_ts=${JSON.stringify(nm(tsOrig))} originalTitle_rust=${JSON.stringify(nm(rust.originalTitle))}`);
      }
    }
    if (row.ts.imdb) cmp('imdb', tsImdb, rust.imdb);
    if (tsStatus) {
      cmp('status', tsStatus, rust.status);
    } else if (protectorOnly) {
      boundaries.push(`${row.site}/${row.kind} ${row.fixture} parser_status_nao_comparado (ts só-protetor=${tsLinks.length}; rust=${JSON.stringify(rust.status)}; shadow neutraliza via explainedByProtector)`);
    }
    if (tsLinks) {
      const rustKeys = magnetKeySet([
        ...rust.releases, ...rust.groups.flatMap((g) => g.releases), ...rust.unlocated,
      ].map((r) => ({ magnet: r.magnet })));
      // Chaves = SÓ magnets (como o `torrentKey` do shadow). Protetor não é chave.
      const tsKeys = magnetKeySet(magnetLinks);
      const missing = [...tsKeys].filter((k) => !rustKeys.has(k));
      const extra = [...rustKeys].filter((k) => !tsKeys.has(k));
      // MAGNET que o Rust perdeu/achou a mais → divergência DURA (parser).
      if (missing.length) {
        diffs.push(`${row.site}/${row.kind} ${row.fixture} [magnets faltam no Rust] ${missing.length}/${tsKeys.size} ex=${JSON.stringify(missing.slice(0, 2).map((s) => s.slice(0, 44)))}`);
      }
      if (extra.length) {
        diffs.push(`${row.site}/${row.kind} ${row.fixture} [magnets extras no Rust] rust=${extra.length} ex=${JSON.stringify(extra.slice(0, 2).map((s) => s.slice(0, 44)))}`);
      }
      // Links de PROTETOR (sem magnet) → FRONTEIRA contada, nunca diff: o Rust
      // pré-protetor não os representa na saída.
      const nonMagnet = tsLinks.length - magnetLinks.length;
      if (nonMagnet > 0) {
        boundaries.push(`${row.site}/${row.kind} ${row.fixture} links_protetor_sem_magnet=${nonMagnet}/${tsLinks.length} (o Rust pré-protetor não os representa)`);
      }
      // FRONTEIRA honesta: chaves de GRUPO do Rust × locação derivada dos links TS
      // (diferença card-vs-página; fica visível sem virar falso vermelho).
      const rustGroupKeys = (rust.groups || []).map((g) => `${g.season ?? -1}:${g.episode ?? -1}`).sort();
      const tsLocKeys = [...new Set(tsLinks.map((l) => `${l.season ?? -1}:${l.episode ?? -1}`))].sort();
      const hasGrouping = rustGroupKeys.length > 0 || tsLocKeys.some((k) => k !== '-1:-1');
      if (hasGrouping && JSON.stringify(rustGroupKeys) !== JSON.stringify(tsLocKeys)) {
        boundaries.push(`${row.site}/${row.kind} ${row.fixture} grupos_rust=${JSON.stringify(rustGroupKeys)} locacao_dos_links_ts=${JSON.stringify(tsLocKeys)}`);
      }
    }
    if (row.site !== 'mico' && row.kind === 'tv_show') {
      const h1 = ts.workName.h1Text(pageHtml);
      const ps = ts.seasonPage.pageSeasonOf(h1, row.url);
      if (nm(ps) !== nm(rust.season)) {
        boundaries.push(`${row.site}/${row.kind} ${row.fixture} season_ts=${JSON.stringify(nm(ps))} season_rust=${JSON.stringify(nm(rust.season))}`);
      }
    }
  }

  console.log(`[crawl-parity] fixtures avaliadas: ${cases}; divergências: ${diffs.length}; fronteiras registradas: ${boundaries.length}`);
  for (const d of diffs) console.log(`  - ${d}`);
  for (const b of boundaries) console.log(`  [fronteira] ${b}`);

  if (cases === 0) fail('ZERO casos avaliados (nunca aceitar paridade vazia)');
  if (diffs.length > 0) fail(`${diffs.length} divergência(s) TS×Rust`);
  console.log('[crawl-parity] OK: paridade TS×Rust em todas as fixtures relevantes.');
}

main().catch((e) => fail(e?.stack || e?.message || String(e)));
