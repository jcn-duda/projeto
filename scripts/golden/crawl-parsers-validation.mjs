#!/usr/bin/env node
/**
 * Travamento FAIL-CLOSED de cobertura do corpus do golden `crawl-parsers`.
 * Exclusivo de `dump-crawl-parsers.mjs`. Cada `op` tem piso explícito de casos;
 * op ausente/abaixo do piso derruba a geração ANTES de medir/escrever (vale em
 * `--check` e em `--force`). Reduzir um piso é decisão consciente.
 *
 * Pisos vigentes (138 casos): readWorkTitle 16, h1Text 4, splitParenYear 4,
 * cleanWorkName 3, fichaYear 4, parseTitleYear 4, parseOriginalTitle 3,
 * magnetHash 3, isImdbWidgetReference 3, pageSeasonOf 3, strideAt 4,
 * bucketLastmod 3, parseMicoUrl 3, syntheticUrl 2, isXmlSitemapShape 5,
 * isVacaSitemapShape 3, parseSitemapEntries 4, parseSitemapRows 2, parseImdbId 6,
 * apacheParseListingCards 2, hdrCountListingCards 2, parseSize 6,
 * parsePostMagnets 3, parseContentMagnets 3, parsePostLinks 2, parseDownloadLinks 5,
 * parseSeasonInternal 2, seasonFromCardSlug 4, declaredSeriesLocation 9,
 * groupSeriesReleases 4, decodeEvidence 3, repairMangledEntities 2,
 * seasonPageGroups 2, seriesRowGroups 2, unlocatedReleases 1, parseMicoPage 7.
 */

export const OPS = [
  'readWorkTitle', 'h1Text', 'splitParenYear', 'cleanWorkName', 'fichaYear', 'parseTitleYear',
  'parseOriginalTitle', 'magnetHash', 'isImdbWidgetReference', 'pageSeasonOf', 'strideAt',
  'bucketLastmod', 'parseMicoUrl', 'syntheticUrl', 'isXmlSitemapShape', 'isVacaSitemapShape',
  'parseSitemapEntries', 'parseSitemapRows', 'parseImdbId', 'apacheParseListingCards',
  'hdrCountListingCards', 'parseSize', 'parsePostMagnets', 'parseContentMagnets', 'parsePostLinks',
  'parseDownloadLinks', 'parseSeasonInternal', 'seasonFromCardSlug', 'declaredSeriesLocation',
  'groupSeriesReleases', 'decodeEvidence', 'repairMangledEntities',
  'seasonPageGroups', 'seriesRowGroups', 'unlocatedReleases', 'parseMicoPage',
];

export const OP_MIN_CASES = {
  readWorkTitle: 16,
  h1Text: 4,
  splitParenYear: 4,
  cleanWorkName: 3,
  fichaYear: 4,
  parseTitleYear: 4,
  parseOriginalTitle: 3,
  magnetHash: 3,
  isImdbWidgetReference: 3,
  pageSeasonOf: 3,
  strideAt: 4,
  bucketLastmod: 3,
  parseMicoUrl: 3,
  syntheticUrl: 2,
  isXmlSitemapShape: 5,
  isVacaSitemapShape: 3,
  parseSitemapEntries: 4,
  parseSitemapRows: 2,
  parseImdbId: 6,
  apacheParseListingCards: 2,
  hdrCountListingCards: 2,
  parseSize: 6,
  parsePostMagnets: 3,
  parseContentMagnets: 3,
  parsePostLinks: 2,
  parseDownloadLinks: 5,
  parseSeasonInternal: 2,
  seasonFromCardSlug: 4,
  declaredSeriesLocation: 9,
  groupSeriesReleases: 4,
  decodeEvidence: 3,
  repairMangledEntities: 2,
  seasonPageGroups: 2,
  seriesRowGroups: 2,
  unlocatedReleases: 1,
  parseMicoPage: 7,
};

export function opCoverageViolations(cases) {
  const counts = new Map(OPS.map((op) => [op, 0]));
  for (const c of cases) {
    let op;
    try { op = JSON.parse(c?.input)?.op; } catch { continue; }
    if (typeof op !== 'string') continue;
    counts.set(op, (counts.get(op) ?? 0) + 1);
  }
  const violations = [];
  for (const op of OPS) {
    const min = OP_MIN_CASES[op];
    if (typeof min !== 'number') { violations.push(`op ${op} sem piso explícito`); continue; }
    const got = counts.get(op) ?? 0;
    if (got < min) violations.push(`op ${op}: ${got} caso(s) < piso ${min}`);
  }
  for (const op of Object.keys(OP_MIN_CASES)) {
    if (!OPS.includes(op)) violations.push(`piso definido para op ausente de OPS: ${op}`);
  }
  for (const op of counts.keys()) {
    if (!OPS.includes(op) && counts.get(op) > 0) violations.push(`op desconhecida no corpus: ${op}`);
  }
  return violations;
}
