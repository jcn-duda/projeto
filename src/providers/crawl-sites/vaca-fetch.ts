// Fetch do crawl do Vaca: `fetchTextCrawl` do profile (direto → FlareSolverr só
// com desafio do Cloudflare) quando existe; senão o `fetchTextDirect` de
// sempre. Módulo próprio para vaca.ts e vaca-series.ts importarem sem ciclo.
import type { VacaResolverSurface } from './vaca.js';

export function crawlFetch(
  surface: VacaResolverSurface,
  url: string,
  accept?: string,
  hooks?: { onRequest?: () => void },
): Promise<string> {
  const fn = surface.fetchTextCrawl ?? surface.fetchTextDirect;
  return fn.call(surface, url, accept, hooks);
}
