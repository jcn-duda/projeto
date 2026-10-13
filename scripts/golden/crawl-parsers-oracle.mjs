#!/usr/bin/env node
/**
 * Oráculo do golden `crawl-parsers` — parsers puros do raspador (fases C0/C1).
 *
 * Mede a saída REAL do `dist` vivo dos módulos:
 * - `crawl-sites/work-name.ts` (`readWorkTitle`, `h1Text`, `splitParenYear`,
 *   `cleanWorkName`, `fichaYear`)
 * - `crawl-sites/shared.ts` (`parseTitleYear`, `parseOriginalTitle`, `magnetHash`,
 *   `isImdbWidgetReference`)
 * - `crawl-sites/season-page.ts` (`pageSeasonOf`)
 * - `crawl-sites/mico-shared.ts` (`strideAt`, `bucketLastmod`, `parseMicoUrl`,
 *   `syntheticUrl`)
 * - `crawl-sites/sitemap-guard.ts` (`isXmlSitemapShape`, `isVacaSitemapShape`)
 * - `*-discovery.ts` (`parseSitemapEntries`, `parseSitemapRows`, `parseImdbId`,
 *   `parseListingCards`, `countListingCards`)
 * - `resolvers/profiles/*-parsers.ts` (`parsePostMagnets`, `parseContentMagnets`,
 *   `parsePostLinks`, `parseDownloadLinks`)
 * - `resolvers/text.ts` (`parseSize`, `repairMangledEntities`)
 * - unidade de SÉRIE do Vaca: `vacatorrent-parsers.parseSeasonInternal` (cards),
 *   `vaca-series-locate.{decodeEvidence,seasonFromCardSlug,declaredSeriesLocation,
 *   groupSeriesReleases}` — a locação por EVIDÊNCIA (dn × título × slug) que a
 *   unidade de série usava sem medição.
 * - agrupamento por locação: `season-page.{seasonPageGroups,seriesRowGroups,
 *   unlocatedReleases}` (página que declara temporada × página agregadora).
 * - Mico `parseMicoPage`: mede o parser REAL de streams (`providers/mico.ts::
 *   fetchMicoStreams`, com `fetch` dublado) — dedupe por infoHash, hash 40-hex,
 *   normalização de caixa e título.
 *
 * Os `input` referenciam FIXTURES REAIS do repositório por caminho relativo
 * (`test/fixtures/...`), lidas do checkout — reprodutíveis e versionadas. Nunca
 * reimplementa o TS: cada `op` chama a função exportada real. A saída é uma
 * string canônica (JSON de chaves ordenadas ou escalar) para comparação byte a
 * byte com o teste Rust.
 *
 * RENOME DOCUMENTADO: `parseSitemapRows` do RedeTorrent devolve `url`; o Rust
 * usa `SitemapEntry { loc, lastmod }`. O oráculo mapeia `loc ?? url` para o campo
 * canônico `loc` — é troca de NOME, não de valor (o `lastmod` continua cru).
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const outPath = process.argv[3];
const imp = (rel) => import(pathToFileURL(path.join(job.repo, rel)).href);
const fixture = (rel) => fs.readFileSync(path.join(job.repo, 'test', 'fixtures', rel), 'utf8');

const wname = await imp('dist/src/providers/crawl-sites/work-name.js');
const shared = await imp('dist/src/providers/crawl-sites/shared.js');
const sp = await imp('dist/src/providers/crawl-sites/season-page.js');
const mico = await imp('dist/src/providers/crawl-sites/mico-shared.js');
const guard = await imp('dist/src/providers/crawl-sites/sitemap-guard.js');
const bludvD = await imp('dist/src/providers/crawl-sites/bludv-discovery.js');
const comandoD = await imp('dist/src/providers/crawl-sites/comandotorrents-discovery.js');
const nerdD = await imp('dist/src/providers/crawl-sites/nerdfilmes-discovery.js');
const tdfD = await imp('dist/src/providers/crawl-sites/torrentdosfilmes-discovery.js');
const redeD = await imp('dist/src/providers/crawl-sites/redetorrent-discovery.js');
const hdrD = await imp('dist/src/providers/crawl-sites/hdrtorrents-discovery.js');
const apacheD = await imp('dist/src/providers/crawl-sites/apachetorrent-discovery.js');
const vaca = await imp('dist/src/providers/crawl-sites/vaca.js');
const apacheP = await imp('dist/resolvers/profiles/apachetorrent-parsers.js');
const hdrP = await imp('dist/resolvers/profiles/hdrtorrents-parsers.js');
const redeP = await imp('dist/resolvers/profiles/redetorrent-parsers.js');
const vacaP = await imp('dist/resolvers/profiles/vacatorrent-parsers.js');
const vacaLoc = await imp('dist/src/providers/crawl-sites/vaca-series-locate.js');
const micoProv = await imp('dist/src/providers/mico.js');
const textmod = await imp('dist/resolvers/text.js');

function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = sortDeep(v[k]);
    return o;
  }
  return v;
}
const stable = (v) => JSON.stringify(sortDeep(v));
const bit = (v) => (v ? '1' : '0');
const numStr = (v) => (v === null || v === undefined ? 'null' : String(v));

const SITEMAP_MODS = { bludv: bludvD, comando: comandoD, nerd: nerdD, tdf: tdfD };
const IMDB_MODS = { bludv: bludvD, comando: comandoD, nerd: nerdD, tdf: tdfD, rede: redeD, hdr: hdrD, apache: apacheD, vaca };

const entries = (list, toLoc = (e) => e.loc) => stable(list.map((e) => ({ loc: toLoc(e) ?? '', lastmod: e.lastmod ?? '' })));
/** Campos comuns a todos os perfis de link; ausente → null. */
const canonLinks = (links) => stable(links.map((l) => ({
  url: l.url, quality: l.quality ?? null, size: l.size ?? null, audio: l.audio ?? null,
  source: l.source ?? null, episode: l.episode ?? null, season: l.season ?? null,
})));

/**
 * Mede o parser REAL de streams do Mico (`mico.ts::fetchMicoStreams`) sem rede:
 * o `fetch` global é dublado para devolver o JSON do corpus, e o mapa de
 * streams/dedupe/hash/título é o do TS. Nada é reimplementado aqui.
 */
async function micoItemsOf(streamsObj) {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => streamsObj,
  });
  try {
    const { items } = await micoProv.fetchMicoStreams('https://mico-leao-dublado-apiv-2.vercel.app/crawl/movie/tt0133093/', 5000);
    return items;
  } finally {
    globalThis.fetch = orig;
  }
}

const cases = await Promise.all(job.cases.map(async (c) => {
  const r = JSON.parse(c.input);
  let out;
  switch (r.op) {
    case 'readWorkTitle': {
      const w = wname.readWorkTitle(fixture(r.fixture));
      out = stable({ title: w.title, year: w.year ?? null });
      break;
    }
    case 'h1Text':
      out = wname.h1Text(fixture(r.fixture));
      break;
    case 'splitParenYear': {
      const s = wname.splitParenYear(r.raw);
      out = stable({ rest: s.rest, year: s.year ?? null });
      break;
    }
    case 'cleanWorkName':
      out = wname.cleanWorkName(r.text);
      break;
    case 'fichaYear':
      out = numStr(wname.fichaYear(fixture(r.fixture)) ?? null);
      break;
    case 'parseTitleYear': {
      const t = shared.parseTitleYear(fixture(r.fixture));
      out = stable({ title: t.title, year: t.year ?? null });
      break;
    }
    case 'parseOriginalTitle':
      out = shared.parseOriginalTitle(fixture(r.fixture)) ?? 'null';
      break;
    case 'magnetHash':
      out = shared.magnetHash(r.magnet) ?? 'null';
      break;
    case 'isImdbWidgetReference':
      out = bit(shared.isImdbWidgetReference(r.suffix));
      break;
    case 'pageSeasonOf':
      out = numStr(sp.pageSeasonOf(r.h1, r.url) ?? null);
      break;
    case 'strideAt':
      out = numStr(mico.strideAt(r.skip));
      break;
    case 'bucketLastmod':
      out = mico.bucketLastmod(r.tt, r.now, r.periodDays);
      break;
    case 'parseMicoUrl': {
      const p = mico.parseMicoUrl(r.url, r.base);
      out = p ? stable({ imdb: p.imdb, kind: p.kind }) : 'null';
      break;
    }
    case 'syntheticUrl':
      out = mico.syntheticUrl(r.kind, r.tt, r.base);
      break;
    case 'isXmlSitemapShape':
      out = bit(guard.isXmlSitemapShape(fixture(r.fixture)));
      break;
    case 'isVacaSitemapShape':
      out = bit(guard.isVacaSitemapShape(fixture(r.fixture)));
      break;
    case 'parseSitemapEntries':
      out = entries(SITEMAP_MODS[r.site].parseSitemapEntries(fixture(r.fixture)));
      break;
    case 'parseSitemapRows':
      out = entries(redeD.parseSitemapRows(fixture(r.fixture)), (e) => e.loc ?? e.url);
      break;
    case 'parseImdbId':
      out = IMDB_MODS[r.site].parseImdbId(fixture(r.fixture)) ?? 'null';
      break;
    case 'apacheParseListingCards': {
      const cards = apacheD.parseListingCards(fixture(r.fixture), r.baseUrl);
      out = stable(cards.map((c) => ({ kind: c.kind, url: c.url })));
      break;
    }
    case 'hdrCountListingCards':
      out = numStr(hdrD.countListingCards(fixture(r.fixture)));
      break;
    case 'parseSize':
      out = numStr(textmod.parseSize(r.text) ?? null);
      break;
    case 'parsePostMagnets':
      out = canonLinks(apacheP.parsePostMagnets(fixture(r.fixture), r.url));
      break;
    case 'parseContentMagnets':
      out = canonLinks(hdrP.parseContentMagnets(fixture(r.fixture), r.url));
      break;
    case 'parsePostLinks':
      out = canonLinks(redeP.parsePostLinks(fixture(r.fixture), r.url));
      break;
    case 'parseDownloadLinks':
      out = canonLinks(vacaP.parseDownloadLinks(fixture(r.fixture), r.url, r.opts));
      break;
    // --- unidade de SÉRIE do Vaca (season page + cards concatenados) ---------
    case 'parseSeasonInternal': {
      const cards = vacaP.parseSeasonInternal(fixture(r.fixture), r.baseUrl);
      out = stable(cards.map((c) => ({ isBatch: !!c.isBatch, season: c.season ?? null, title: c.title, url: c.url })));
      break;
    }
    case 'seasonFromCardSlug':
      out = numStr(vacaLoc.seasonFromCardSlug(r.url) ?? null);
      break;
    case 'declaredSeriesLocation': {
      const l = vacaLoc.declaredSeriesLocation({
        cardSeason: r.cardSeason ?? null, cardTitle: r.cardTitle ?? '', isBatch: !!r.isBatch,
        realTitle: r.realTitle ?? null, dn: r.dn ?? null, linkEpisode: r.linkEpisode ?? null,
      });
      out = stable({ episode: l.episode ?? null, season: l.season ?? null });
      break;
    }
    case 'groupSeriesReleases': {
      const groups = vacaLoc.groupSeriesReleases(r.entries, { year: r.year ?? null, byDeclaredLocation: !!r.byDeclaredLocation });
      out = stable(groups.map((g) => ({ episode: g.episode ?? null, n: g.releases.length, season: g.season ?? null })));
      break;
    }
    case 'decodeEvidence':
      out = vacaLoc.decodeEvidence(r.text);
      break;
    case 'repairMangledEntities':
      out = textmod.repairMangledEntities(r.text);
      break;
    // --- agrupamento por locação (season page / página agregadora) -----------
    case 'seasonPageGroups': {
      const groups = sp.seasonPageGroups(r.releases, { season: r.page.season ?? null, title: r.page.title ?? '' });
      out = stable(groups.map((g) => ({ episode: g.episode ?? null, n: g.releases.length, season: g.season ?? null })));
      break;
    }
    case 'seriesRowGroups': {
      const groups = sp.seriesRowGroups(r.rows.map((x) => ({ release: x.release, rowSeason: x.rowSeason ?? null })));
      out = stable(groups.map((g) => ({ episode: g.episode ?? null, n: g.releases.length, season: g.season ?? null })));
      break;
    }
    case 'unlocatedReleases': {
      // `unlocatedReleases` do TS compara por IDENTIDADE de objeto (o uso real
      // passa o MESMO array); o corpus serializa cópias, então religamos cada
      // release de grupo ao objeto de `releases` pelo magnet antes de medir —
      // senão a régua de identidade do TS puniria um artefato do próprio corpus.
      const releases = r.releases;
      const groups = (r.groups ?? []).map((g) => ({
        season: g.season ?? null,
        episode: g.episode ?? null,
        releases: (g.releases ?? []).map((gr) => releases.find((x) => x.magnet === gr.magnet) ?? gr),
      }));
      const rest = sp.unlocatedReleases(releases, groups);
      out = stable(rest.map((x) => x.title));
      break;
    }
    // --- Mico: parser de streams (mapStream + dedupe por infoHash) -----------
    case 'parseMicoPage': {
      const items = await micoItemsOf(r.streams);
      const p = mico.parseMicoUrl(r.url, null);
      out = stable({
        imdb: p ? p.imdb : null,
        status: items.length ? 'done' : 'no-torrent',
        releases: items.map((x) => ({ hash: String(x.infoHash || '').toLowerCase(), title: x.title })),
      });
      break;
    }
    default:
      throw new Error(`op desconhecida: ${r.op}`);
  }
  if (typeof out !== 'string') throw new Error(`saída não-string no caso ${c.id}`);
  return { id: c.id, out };
}));

fs.writeFileSync(outPath, JSON.stringify({ ok: true, cases }));
