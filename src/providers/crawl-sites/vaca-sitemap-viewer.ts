// Sitemap do Yoast lido pelo FlareSolverr: o Chromium renderiza o XSL e devolve a
// TABELA HTML do viewer ("XML Sitemap"), sem nenhum `<loc>`. O fetch direto com a
// sessão quente devolve o XML cru; as duas formas alternam conforme a sessão
// (mesma situação do RedeTorrent). Linhas: `<tr><td><a href="URL">URL</a></td>
// [<td>N imagens</td>]<td>2026-10-01 16:05 +00:00</td></tr>`.
const VIEWER_ROW_RE = /<tr>\s*<td>\s*<a\s+href="([^"]+)"[^>]*>[^<]*<\/a>\s*<\/td>(?:\s*<td>\s*\d+\s*<\/td>)?\s*<td>\s*(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})\s*([+-]\d{2}:?\d{2}|Z)?\s*<\/td>\s*<\/tr>/gi;

/** Pares loc/lastmod da tabela do viewer. O `lastmod` perde os segundos (vira
 * `:00`): fica ≤ ao real, então o corte incremental re-admite linhas em vez de
 * pular acervo. */
export function parseViewerEntries(html: string): { loc: string; lastmod: string }[] {
  const out: { loc: string; lastmod: string }[] = [];
  for (const m of String(html || '').matchAll(VIEWER_ROW_RE)) {
    const tz = m[4] && m[4] !== 'Z' ? (m[4].includes(':') ? m[4] : `${m[4].slice(0, 3)}:${m[4].slice(3)}`) : '+00:00';
    out.push({ loc: m[1].replace(/&amp;/g, '&'), lastmod: `${m[2]}T${m[3]}:00${tz}` });
  }
  return out;
}
