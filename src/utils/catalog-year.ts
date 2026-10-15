// Ano de catálogo de filme quando Cinemeta e TMDB divergem. Extraído de
// `search-names.ts` pela catraca de 400 linhas.

// A Cinemeta às vezes publica o ano da estreia AMERICANA: "A Fistful of
// Dollars" sai 1967, o TMDB e todo post (BR e gringo) dizem 1964. Com o ±2 do
// filtro de filme, 1967 cortava as três releases reais e a lista ficava com
// 2 streams. Divergência de até 2 anos o ±2 já cobre, e aí nada muda; acima
// disso o `release_date` do TMDB (estreia mundial) é o ano que os sites usam.
function catalogYearOf(metaYear: number | string | null | undefined, tmdbYear: number | string | null | undefined) {
  const m = Number(String(metaYear ?? '').match(/(?:19|20)\d{2}/)?.[0] || 0);
  const t = Number(String(tmdbYear ?? '').match(/(?:19|20)\d{2}/)?.[0] || 0);
  if (m && t && Math.abs(m - t) > 2) return tmdbYear ?? null;
  return metaYear || tmdbYear || null;
}

/**
 * O ano que o `catalogYearOf` descartou, quando Cinemeta e TMDB divergem por
 * mais de 2: as releases usam os dois (Monster: global "2018", BR "2021").
 */
function catalogAltYearOf(metaYear: number | string | null | undefined, tmdbYear: number | string | null | undefined) {
  const chosen = catalogYearOf(metaYear, tmdbYear);
  const other = chosen === tmdbYear ? metaYear : tmdbYear;
  const a = Number(String(chosen ?? '').match(/(?:19|20)\d{2}/)?.[0] || 0);
  const b = Number(String(other ?? '').match(/(?:19|20)\d{2}/)?.[0] || 0);
  return a && b && Math.abs(a - b) > 2 ? b : null;
}

export { catalogYearOf, catalogAltYearOf };
