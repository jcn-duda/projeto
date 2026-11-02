// Ação LOCAL do painel do crawler. As dependências entram por fábrica para o
// módulo não importar `crawler.ts`. "Reprocessar" e "Zerar site" vão ao sidecar
// (`dashboard-actions-crawl.ts`); `simulate` era a prévia por adaptador TS e, sem
// ele, responde `sem-adaptador` sem tocar fila. Sem `site`, vale o primeiro
// configurado.
import { knownSites, type CrawlerEffectiveConfig } from '../utils/crawler-live-schema.js';

export interface CrawlActionsDeps {
  effective(): CrawlerEffectiveConfig;
  isPaused(): boolean;
}

export interface SimulateResult {
  ok: boolean;
  reason?: string;
  site: string | null;
  label?: string;
  pages: number;
  results: Array<{ url: string; kind: string; releases: number; addedNew?: number; detail: string | null }>;
}

export function createCrawlActions(deps: CrawlActionsDeps) {
  // Os sites do MOTOR (`CRAWL_SITES` + os ligados no painel), a mesma lista do
  // `crawler.ts`. Validar só contra o `.env` recusava em silêncio toda ação de
  // site ligado pelo painel (o NerdFilmes da VPS): `requeued: 0` com HTTP 200.
  const siteIds = (): string[] => knownSites(deps.effective());

  /**
   * Site alvo da ação: o pedido ou o primeiro configurado —
   * SEMPRE validado contra os sites do motor. Uma ação quePROCESSA não pode
   * apontar para um id arbitrário: ela abriria o store, criaria runtime e
   * poderia tocar fila de um site que o operador nem configurou.
   */
  const targetSite = (requested?: string): { site: string; ok: boolean; reason?: string } => {
    const site = String(requested || siteIds()[0] || '');
    if (!site) return { site: '', ok: false, reason: 'sem-site' };
    if (!siteIds().includes(site)) return { site, ok: false, reason: 'site-desconhecido' };
    return { site, ok: true };
  };

  /** Sem adaptador TS: valida o alvo como antes e responde `sem-adaptador`. */
  async function simulate(_max?: number, siteId?: string): Promise<SimulateResult> {
    if (deps.isPaused()) return { ok: false, reason: 'pausado', site: null, pages: 0, results: [] };
    const target = targetSite(siteId);
    if (!target.ok) return { ok: false, reason: target.reason, site: target.site || null, pages: 0, results: [] };
    return { ok: false, reason: 'sem-adaptador', site: target.site, pages: 0, results: [] };
  }

  return { simulate };
}
