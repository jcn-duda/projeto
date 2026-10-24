// Ações LOCAIS do painel do crawler (Fase 4 do plano "Raspagem total"; Fase 8
// multi-site). Extraído do `crawler.ts` pela catraca de 400 linhas; as
// dependências entram por fábrica (closures) para o módulo não importar
// `crawler.ts` — sem ciclo e testável com uma fachada dublê.
//
// "Reprocessar erros" e "Zerar site" vão ao sidecar Rust, dono do `crawl.db`
// dos nove sites (`dashboard-actions-crawl.ts`). Aqui ficam:
//  - `simulate`: era a prévia em dry-run por um adaptador TS; sem adaptador TS
//    responde `sem-adaptador` (a mesma resposta que já dava) sem tocar fila;
//  - `reprocessNoWork`: devolve à fila o `no-work` do site — não é destrutiva.
// As duas são POR SITE e validadas contra os sites do motor; sem `site` no
// pedido, vale o primeiro configurado.
import * as store from '../utils/crawl-store.js';
import { knownSites, type CrawlerEffectiveConfig } from '../utils/crawler-live-schema.js';

export interface CrawlActionsDeps {
  effective(): CrawlerEffectiveConfig;
  isPaused(): boolean;
  count(name: string, value?: number): void;
}

export interface SimulateResult {
  ok: boolean;
  reason?: string;
  site: string | null;
  label?: string;
  pages: number;
  results: Array<{ url: string; kind: string; releases: number; addedNew?: number; detail: string | null }>;
}

/** Reprocessar: `ok:false` + `reason` quando o site foi recusado (nunca "0" mudo). */
export interface ReprocessResult {
  ok: boolean;
  site: string | null;
  requeued: number;
  reason?: string;
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

  /**
   * "Reprocessar sem obra": devolve à fila as páginas `no-work` do site. O
   * `no-work` é TERMINAL (resposta negativa da identificação), então sem esta
   * ação uma régua de identificação melhor só valia para página nova — as 28
   * páginas do NerdFilmes marcadas antes do título original (2026-09-28)
   * ficariam sem obra para sempre. A página é raspada de novo pelo motor
   * (ritmo, tetos e freio de tráfego valem), não identificada em lote aqui.
   */
  function reprocessNoWork(siteId?: string): ReprocessResult {
    const target = targetSite(siteId);
    if (!target.ok) return { ok: false, site: target.site || null, requeued: 0, reason: target.reason };
    const requeued = store.engine().requeueErrors(target.site, 'no-work');
    if (requeued) deps.count('crawl.reprocess.noWork', requeued);
    return { ok: true, site: target.site, requeued };
  }

  return { simulate, reprocessNoWork };
}
