#!/usr/bin/env node
/**
 * Constrói o corpus do golden `crawl-parsers` de forma REPRODUTÍVEL.
 *
 * Casos referenciam FIXTURES REAIS do repositório (`test/fixtures/...`) por
 * caminho, então os dados de entrada são versionados e determinísticos; os
 * parâmetros sintéticos (regex/strings/URLs) são literais. Rodar
 * `node scripts/golden/build-corpus-crawl-parsers.mjs` regrava o corpus.
 *
 * Cobertura POR OP é travada fail-closed em `crawl-parsers-validation.mjs`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(REPO, 'scripts', 'golden', 'corpus-crawl-parsers.json');

const cases = [];
const add = (id, op, rest = {}) => cases.push({ id, input: JSON.stringify({ op, ...rest }) });

const POSTS = {
  'bludv-movie': 'crawl/bludv/post-movie.html',
  'bludv-series': 'crawl/bludv/post-series.html',
  'apache-filme': 'crawl/apachetorrent/post-filme.html',
  'apache-serie': 'crawl/apachetorrent/post-serie.html',
  'hdr-filme': 'crawl/hdrtorrents/post-filme.html',
  'hdr-serie': 'crawl/hdrtorrents/post-serie.html',
  'hdr-agregada': 'crawl/hdrtorrents/post-serie-agregada.html',
  'nerd-movie': 'crawl/nerdfilmes/post-movie.html',
  'nerd-series': 'crawl/nerdfilmes/post-series.html',
  'tdf-movie': 'crawl/torrentdosfilmes/post-movie.html',
  'tdf-series': 'crawl/torrentdosfilmes/post-series.html',
  'vaca-movie': 'crawl/vaca/movie-page-torrent.html',
  'vaca-links': 'crawl/vaca/movie-links-torrent.html',
  'vaca-tv': 'crawl/vaca/tv-show-page.html',
  'rede-coringa': 'redetorrent/post-coringa-delirio.html',
  'rede-fallout': 'redetorrent/serie-fallout.html',
};

// ---- work_name -------------------------------------------------------------
for (const [k, f] of Object.entries(POSTS)) add(`rwt-${k}`, 'readWorkTitle', { fixture: f });
for (const k of ['bludv-movie', 'hdr-filme', 'rede-coringa', 'vaca-movie']) add(`h1-${k}`, 'h1Text', { fixture: POSTS[k] });
for (const raw of ['Matrix (1999) Dublado', 'O Filme 2020', 'Sem Ano Aqui', 'Duna 2021 1080p']) {
  add(`spy-${raw}`.replace(/\s/g, '_'), 'splitParenYear', { raw });
}
for (const text of ['Matrix (1999) Dublado', 'Filme Top (2016)', 'Série Completa']) {
  add(`cwn-${text}`.replace(/\s/g, '_'), 'cleanWorkName', { text });
}
for (const k of ['bludv-movie', 'hdr-filme', 'rede-coringa', 'tdf-movie']) add(`ficha-${k}`, 'fichaYear', { fixture: POSTS[k] });

// ---- shared ----------------------------------------------------------------
for (const k of ['bludv-movie', 'hdr-filme', 'rede-coringa', 'nerd-series']) add(`pty-${k}`, 'parseTitleYear', { fixture: POSTS[k] });
for (const k of ['bludv-movie', 'hdr-filme', 'rede-coringa']) add(`pot-${k}`, 'parseOriginalTitle', { fixture: POSTS[k] });
for (const magnet of [
  'magnet:?xt=urn:btih:ABCDEF1234567890ABCDEF1234567890ABCDEF12&dn=x',
  'magnet:?xt=urn:btih:zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz&dn=y',
  'não é magnet',
]) add(`mh-${magnet.length}-${magnet.slice(-6)}`, 'magnetHash', { magnet });
for (const suffix of ['https://www.imdb.com/title/tt0133093/', '/title/tt1/', 'nada']) {
  add(`iwr-${suffix.length}`, 'isImdbWidgetReference', { suffix });
}

// ---- season_page -----------------------------------------------------------
for (const [h1, url] of [
  ['Temporada 2', 'https://x/series/y-2a-temporada'],
  ['Série Completa', 'https://x/series/y-1a-temporada'],
  ['Sem marcador', 'https://x/series/y'],
]) add(`pso-${url.slice(-20)}`.replace(/[^a-zA-Z0-9-]/g, '_'), 'pageSeasonOf', { h1, url });

// ---- mico ------------------------------------------------------------------
for (const skip of [0, 999, 1000, 1050]) add(`stride-${skip}`, 'strideAt', { skip });
for (const [tt, now, periodDays] of [['tt0133093', Date.UTC(2026, 0, 1), 3], ['tt1', Date.UTC(2026, 5, 15), 7], ['tt3416744', Date.UTC(2026, 11, 31), 1]]) {
  add(`blm-${tt}-${periodDays}`, 'bucketLastmod', { tt, now, periodDays });
}
for (const url of [
  'https://mico-leao-dublado-apiv-2.vercel.app/crawl/movie/tt0133093/',
  'https://mico-leao-dublado-apiv-2.vercel.app/crawl/series/tt1234567/',
  'https://exemplo/x',
]) add(`pmu-${url.slice(-18)}`.replace(/[^a-zA-Z0-9-]/g, '_'), 'parseMicoUrl', { url });
for (const [kind, tt] of [['movie', 'tt0133093'], ['series', 'tt1234567']]) add(`syn-${kind}-${tt}`, 'syntheticUrl', { kind, tt });

// ---- sitemap guard ---------------------------------------------------------
const SITEMAPS = {
  'bludv-recorte': 'crawl/bludv/post-sitemap-recorte.xml',
  'comando': 'crawl/comandotorrents/post-sitemap.xml',
  'nerd': 'crawl/nerdfilmes/post-sitemap.xml',
  'tdf': 'crawl/torrentdosfilmes/post-sitemap.xml',
  'vaca-min': 'crawl/vaca/movie-sitemap-min.xml',
};
for (const [k, f] of Object.entries(SITEMAPS)) add(`xml-${k}`, 'isXmlSitemapShape', { fixture: f });
for (const k of ['vaca-min', 'comando', 'nerd']) add(`vacaShape-${k}`, 'isVacaSitemapShape', { fixture: SITEMAPS[k] });
add('parse-sitemap-entries-bludv', 'parseSitemapEntries', { site: 'bludv', fixture: SITEMAPS['bludv-recorte'] });
add('parse-sitemap-entries-comando', 'parseSitemapEntries', { site: 'comando', fixture: SITEMAPS.comando });
add('parse-sitemap-entries-nerd', 'parseSitemapEntries', { site: 'nerd', fixture: SITEMAPS.nerd });
add('parse-sitemap-entries-tdf', 'parseSitemapEntries', { site: 'tdf', fixture: SITEMAPS.tdf });
add('parse-sitemap-rows-rede-movies', 'parseSitemapRows', { fixture: 'redetorrent/movies-sitemap.html' });
add('parse-sitemap-rows-rede-index', 'parseSitemapRows', { fixture: 'redetorrent/sitemap-index.html' });

// ---- imdb ids --------------------------------------------------------------
for (const [site, fixture] of [
  ['vaca', POSTS['vaca-movie']], ['bludv', POSTS['bludv-movie']], ['hdr', POSTS['hdr-filme']],
  ['apache', POSTS['apache-filme']], ['rede', POSTS['rede-coringa']], ['nerd', POSTS['nerd-series']],
]) add(`imdb-${site}`, 'parseImdbId', { site, fixture });

// ---- listing ---------------------------------------------------------------
add('apache-cards-1', 'apacheParseListingCards', { fixture: 'crawl/apachetorrent/pagina-1-cheia.html', baseUrl: 'https://apachetorrent.com' });
add('apache-cards-2', 'apacheParseListingCards', { fixture: 'crawl/apachetorrent/pagina-fim-calcanhar.html', baseUrl: 'https://apachetorrent.com' });
add('hdr-count-1', 'hdrCountListingCards', { fixture: 'crawl/hdrtorrents/pagina-1-cheia.html' });
add('hdr-count-2', 'hdrCountListingCards', { fixture: 'crawl/hdrtorrents/pagina-fim-calcanhar.html' });

// ---- size ------------------------------------------------------------------
for (const text of ['2.5 GB', '1,01 GB', '700 MB', '1 KB', 'sem tamanho', '']) add(`size-${text || 'empty'}`.replace(/[^a-zA-Z0-9-]/g, '_'), 'parseSize', { text });

// ---- links -----------------------------------------------------------------
const APACHE_POST = 'crawl/apachetorrent/post-filme.html';
const HDR_POST = 'crawl/hdrtorrents/post-filme.html';
const REDE_POST = 'redetorrent/post-coringa-delirio.html';
const VACA_LINKS = 'crawl/vaca/movie-links-torrent.html';
add('ppm-apache-filme', 'parsePostMagnets', { fixture: APACHE_POST, url: 'https://apachetorrent.com' });
add('ppm-apache-serie', 'parsePostMagnets', { fixture: 'crawl/apachetorrent/post-serie.html', url: 'https://apachetorrent.com' });
add('ppm-apache-desenho', 'parsePostMagnets', { fixture: 'crawl/apachetorrent/post-serie-desenho.html', url: 'https://apachetorrent.com' });
add('pcm-hdr-filme', 'parseContentMagnets', { fixture: HDR_POST, url: 'https://hdrtorrents.org' });
add('pcm-hdr-serie', 'parseContentMagnets', { fixture: 'crawl/hdrtorrents/post-serie.html', url: 'https://hdrtorrents.org' });
add('pcm-hdr-episodios', 'parseContentMagnets', { fixture: 'crawl/hdrtorrents/post-serie-episodios.html', url: 'https://hdrtorrents.org' });
add('ppl-rede-coringa', 'parsePostLinks', { fixture: REDE_POST, url: 'https://redetorrent.xyz' });
add('ppl-rede-fallout', 'parsePostLinks', { fixture: 'redetorrent/serie-fallout.html', url: 'https://redetorrent.xyz' });
add('pdl-vaca-links', 'parseDownloadLinks', { fixture: VACA_LINKS, url: 'https://vacatorrent.com/x/' });
add('pdl-vaca-links-alt', 'parseDownloadLinks', { fixture: VACA_LINKS, url: 'https://vacatorrent.com/y/' });

// ---- unidade de SÉRIE do Vaca (season page + cards concatenados) -----------
// F6: a unidade de série (season-internal → cards → link/episódio) não pode
// passar sem medição. Cobre o parser de cards, a locação por EVIDÊNCIA e o
// agrupamento por locação declarada.
add('psi-stranger', 'parseSeasonInternal', { fixture: 'crawl/vaca/season-internal-stranger.html', baseUrl: 'https://vaqueirofilmes.com/tv/stranger-things/season/stranger-things/' });
add('psi-mixed', 'parseSeasonInternal', { fixture: 'crawl/vaca/season-internal-mixed.html', baseUrl: 'https://vaqueirofilmes.com/tv/outer-banks/season/temporada-2/' });
for (const [slug, url] of [
  ['straight', 'https://vaqueirofilmes.com/tv/x/season/temporada-4/'],
  ['ordinal-a', 'https://vaqueirofilmes.com/tv/x/season/1a-temporada/'],
  ['ordinal-o', 'https://vaqueirofilmes.com/tv/x/season/3o-temporada/'],
  ['batch', 'https://vaqueirofilmes.com/tv/x/batch/'],
]) add(`sfcs-${slug}`, 'seasonFromCardSlug', { url });
const EVIDENCE = {
  'dn-wins': { cardSeason: 1, cardTitle: 'Temporada 1', isBatch: false, realTitle: null, dn: 'Show.S04E02.1080p.DUBLADO', linkEpisode: 3 },
  'dn-complete': { cardSeason: 2, cardTitle: 'x', isBatch: true, realTitle: null, dn: 'Show.Complete.1080p', linkEpisode: null },
  'dn-season-no-ep': { cardSeason: null, cardTitle: '', isBatch: true, realTitle: null, dn: 'Show.4a.Temporada.1080p', linkEpisode: 5 },
  'title-declares': { cardSeason: null, cardTitle: '4a Temporada', isBatch: true, realTitle: null, dn: null, linkEpisode: null },
  'cardseason-fallback': { cardSeason: 3, cardTitle: 'x', isBatch: false, realTitle: null, dn: null, linkEpisode: 2 },
  'trailing-digit': { cardSeason: null, cardTitle: 'East Blue1', isBatch: false, realTitle: null, dn: null, linkEpisode: 1 },
  'root-none': { cardSeason: null, cardTitle: '', isBatch: false, realTitle: null, dn: null, linkEpisode: null },
  'encoded-ordinal': { cardSeason: null, cardTitle: '4&ordf; Temporada', isBatch: true, realTitle: null, dn: null, linkEpisode: null },
  'mangled-ordinal': { cardSeason: null, cardTitle: '4ordf Temporada', isBatch: true, realTitle: null, dn: null, linkEpisode: null },
};
for (const [id, ev] of Object.entries(EVIDENCE)) add(`dsl-${id}`, 'declaredSeriesLocation', ev);

const GROUP_ENTRIES = [
  { release: { title: 'Serie S01E01 1080p Dublado', magnet: 'magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, request: { season: 1, episode: 1 } },
  { release: { title: 'Serie S02 COMPLETA 1080p', magnet: 'magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }, request: { season: 2, episode: null } },
  { release: { title: 'Serie Sem Marcador', magnet: 'magnet:?xt=urn:btih:cccccccccccccccccccccccccccccccccccccccc' }, request: { season: null, episode: null } },
];
add('gsr-by-title', 'groupSeriesReleases', { entries: GROUP_ENTRIES, year: '2020' });
add('gsr-by-declared', 'groupSeriesReleases', { entries: GROUP_ENTRIES, year: '2020', byDeclaredLocation: true });
add('gsr-no-year', 'groupSeriesReleases', { entries: GROUP_ENTRIES, year: null });
add('gsr-live-action-year', 'groupSeriesReleases', {
  entries: [{ release: { title: 'Serie Live Action 2026 S01', magnet: 'magnet:?xt=urn:btih:dddddddddddddddddddddddddddddddddddddddd' }, request: { season: 1, episode: 1 } }],
  year: '2019',
});
for (const text of ['4&ordf; Temporada', '4ordf Temporada', 'Show &amp; Filme']) add(`dev-${text}`.replace(/[^a-zA-Z0-9-]/g, '_'), 'decodeEvidence', { text });
for (const text of ['4ordf', 'Show &amp; x']) add(`rme-${text}`.replace(/[^a-zA-Z0-9-]/g, '_'), 'repairMangledEntities', { text });
// Card da série: o MESMO `parse_download_links` do filme roda no HTML de cada
// card (parser unificado) — o card é a unidade que faltava medir.
add('pdl-vaca-card-stranger', 'parseDownloadLinks', { fixture: 'crawl/vaca/season-card-stranger.html', url: 'https://vaqueirofilmes.com/tv/stranger-things/season/stranger-things/' });
add('pdl-vaca-card-episodes', 'parseDownloadLinks', { fixture: 'crawl/vaca/season-card-episodes.html', url: 'https://vaqueirofilmes.com/tv/outer-banks/season/temporada-2/' });
// Lista BASE de protetores (resolvers/protector.ts) + systemtech.space do Vaca:
// exercita systemads1.com/systemads.net/videosad.net/canalfutebol.com/
// temreceita.com, um host FORA da lista (controle) e um magnet direto.
add('pdl-vaca-protector-base', 'parseDownloadLinks', { fixture: 'crawl/vaca/protector-hosts.html', url: 'https://vaqueirofilmes.com/movie-links/1/' });

// ---- Mico: parser de streams (parseMicoPage) -------------------------------
const MICO_URL = 'https://mico-leao-dublado-apiv-2.vercel.app/crawl/movie/tt0133093/';
const H = (c) => c.repeat(40);
add('mico-dedupe-e-normaliza', 'parseMicoPage', {
  kind: 'movie', url: MICO_URL,
  streams: { streams: [
    { infoHash: H('a'), title: 'Filme Um' },
    { infoHash: H('a'), title: 'Filme Um (dup)' },
    { infoHash: 'invalido', title: 'Sem hash' },
    { infoHash: H('B'), title: 'Filme Dois\nlinha extra' },
    { infoHash: H('c') },
  ] },
});
add('mico-invalid-hash', 'parseMicoPage', { kind: 'movie', url: MICO_URL, streams: { streams: [{ infoHash: 'zz', title: 'X' }] } });
add('mico-no-title', 'parseMicoPage', { kind: 'movie', url: MICO_URL, streams: { streams: [{ infoHash: H('d') }] } });
add('mico-uppercase', 'parseMicoPage', { kind: 'movie', url: MICO_URL, streams: { streams: [{ infoHash: H('E'), title: 'Filme Maiúsculo' }] } });
add('mico-name-fallback', 'parseMicoPage', { kind: 'movie', url: MICO_URL, streams: { streams: [{ infoHash: H('f'), name: 'Via Nome' }] } });
add('mico-empty', 'parseMicoPage', { kind: 'movie', url: MICO_URL, streams: { streams: [] } });
add('mico-emoji-title', 'parseMicoPage', { kind: 'movie', url: MICO_URL, streams: { streams: [{ infoHash: H('1'), title: 'Filme Emoji 👥 12 💾 1.5 GB (brazilian, eng)' }] } });

// ---- agrupamento por locação (seasonPageGroups / seriesRowGroups) ----------
const GRS = [
  { release: { title: 'Serie S01E01 1080p DUBLADO', magnet: 'magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } },
  { release: { title: 'Serie S01 COMPLETA 1080p', magnet: 'magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } },
  { release: { title: 'Serie Sem Marcador', magnet: 'magnet:?xt=urn:btih:cccccccccccccccccccccccccccccccccccccccc' } },
];
add('spg-season1', 'seasonPageGroups', { releases: GRS.map((x) => x.release), page: { season: 1, title: 'Serie 1a Temporada' } });
add('spg-no-season', 'seasonPageGroups', { releases: GRS.map((x) => x.release), page: { season: null, title: 'Serie' } });
add('srg-rowseason', 'seriesRowGroups', { rows: GRS.map((x, i) => ({ release: x.release, rowSeason: i === 0 ? 1 : (i === 1 ? 2 : null) })) });
add('srg-dn-wins', 'seriesRowGroups', { rows: [{ release: { title: 'Pack S04 1080p', magnet: 'magnet:?xt=urn:btih:dddddddddddddddddddddddddddddddddddddddd' }, rowSeason: 1 }] });
add('unlocated-basic', 'unlocatedReleases', { releases: GRS.map((x) => x.release), groups: [{ season: 1, episode: 1, releases: [GRS[0].release] }] });

fs.writeFileSync(OUT, `${JSON.stringify({ config: { floorPolicy: 'crawl-parsers-validation.mjs' }, cases }, null, 2)}\n`, 'utf8');
console.log(`[corpus] crawl-parsers: ${cases.length} casos -> ${path.relative(REPO, OUT)}`);
