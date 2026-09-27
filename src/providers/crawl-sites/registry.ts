// Registro de adaptadores do motor de raspagem. Extraído de `crawler.ts`
// pela catraca de linhas: quem SABE resolver o site (fábrica de teste vence;
// produção resolve o Vaca por import dinâmico) e quem memoiza o adaptador
// ativo (o motor é serial — um site por vez). Sem estado de ritmo/fila aqui:
// isso é do motor.
import * as log from '../../utils/logger.js';
import type { CrawlSite } from '../crawl-types.js';

let testSiteFactory: ((id: string) => CrawlSite | null) | null = null;
let activeSite: CrawlSite | null = null;
let activeSiteId = '';
let adapterWarned = false;

/** Injeta fábrica de teste (o motor nunca toca o Vaca real nos testes). */
export function setFactoryForTest(factory: ((id: string) => CrawlSite | null) | null): void {
  testSiteFactory = factory;
  activeSite = null;
  activeSiteId = '';
  adapterWarned = false;
}

/** Site ativo memoizado (o status do painel o usa como "site ativo"). */
export function active(): { site: CrawlSite | null; id: string } {
  return { site: activeSite, id: activeSiteId };
}

/** Esquece o memo do adaptador (reset de teste). */
export function forgetActive(): void {
  activeSite = null;
  activeSiteId = '';
}

/** Garante o adaptador do site ativo (resolve uma vez e memoiza). */
export async function ensureActiveSite(siteId: string): Promise<CrawlSite | null> {
  if (activeSite && activeSiteId === siteId) return activeSite;
  try {
    const site = testSiteFactory
      ? testSiteFactory(siteId)
      : siteId === 'vacatorrent'
        ? ((await import('./vaca.js')).vacaCrawlSite())
        : null;
    if (!site) {
      if (!adapterWarned) { adapterWarned = true; log.warn(`[crawl] site sem adaptador: ${siteId}`); }
      return null;
    }
    activeSite = site;
    activeSiteId = siteId;
    adapterWarned = false;
    return site;
  } catch (err: unknown) {
    if (!adapterWarned) {
      adapterWarned = true;
      log.error(`[crawl] adaptador ${siteId} indisponível:`, log.errorMessage(err));
    }
    return null;
  }
}
