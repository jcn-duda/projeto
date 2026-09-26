// Ações do painel do crawler (Fase 4 do plano "Raspagem total"): simular,
// reprocessar erros e zerar site. Extraído de `crawler.ts` pela catraca de 400
// linhas. As dependências do motor entram por fábrica (closures) para o módulo
// não importar `crawler.ts` — isso evita ciclo e mantém as ações testáveis com
// um motor dublê.
//
// Fronteiras de segurança:
//  - `simulate` processa em dry-run e com `noPersist`: NÃO grava acervo nem
//    `crawl.db`; a URL volta à fila (`requeueUrl`).
//  - `resetSite` só age sobre site da config VIVA (`CRAWL_SITES`) e apaga
//    apenas o estado daquele site em `crawl.db`.
import * as store from '../utils/crawl-store.js';
import { processCrawlPage } from './crawl-page.js';
import * as metrics from '../utils/metrics.js';
import * as log from '../utils/logger.js';
import type { CrawlerEffectiveConfig } from '../utils/crawler-live-schema.js';
import type { CrawlSite } from './crawl-types.js';

export interface CrawlActionsDeps {
  effective(): CrawlerEffectiveConfig;
  isBusy(): boolean;
  isPaused(): boolean;
  ensureSite(id: string): Promise<CrawlSite | null>;
  /** Descarta o ciclo aberto do site ativo (o "Zerar site" apaga a rodada). */
  forgetActiveRun(): void;
  count(name: string, value?: number): void;
}

export interface SimulateResult {
  ok: boolean;
  reason?: string;
  pages: number;
  results: Array<{ url: string; kind: string; releases: number; addedNew?: number; detail: string | null }>;
}

export function createCrawlActions(deps: CrawlActionsDeps) {
  const siteIds = (): string[] =>
    deps.effective().sites.map((s) => String(s || '')).filter(Boolean);

  async function simulate(max?: number): Promise<SimulateResult> {
    const live = deps.effective();
    if (deps.isBusy()) return { ok: false, reason: 'ocupado', pages: 0, results: [] };
    if (deps.isPaused()) return { ok: false, reason: 'pausado', pages: 0, results: [] };
    const siteId = String(live.sites[0] || '');
    if (!siteId) return { ok: false, reason: 'sem-site', pages: 0, results: [] };
    // Resolver o adaptador pode lançar (import dinâmico, fábrica dublê): a
    // simulação degrada para `sem-adaptador`, nunca deixa a requisição pendurada.
    let site: CrawlSite | null = null;
    try {
      site = await deps.ensureSite(siteId);
    } catch (err: unknown) {
      log.warn('[crawl] adaptador indisponível na simulação:', log.errorMessage(err));
      site = null;
    }
    if (!site) return { ok: false, reason: 'sem-adaptador', pages: 0, results: [] };

    const cap = Math.max(1, Math.min(50, Math.trunc(Number(max) || 20)));
    const results: SimulateResult['results'] = [];
    // Claims ficam `inflight` DURANTE a simulação (senão `takeNext` devolveria a
    // MESMA página) e voltam à fila no `finally` — a simulação não consome nada.
    // O `finally` roda mesmo com falha do adaptador depois do `takeNext`
    // (fetchWork/identify/record lançando): a URL reclamada nunca fica `inflight`
    // órfã, o mesmo sintoma que a retomada do `start` conserta no boot.
    const claimed: string[] = [];
    try {
      for (let i = 0; i < cap; i += 1) {
        const row = store.engine().takeNext(siteId, Date.now());
        if (!row) break;
        claimed.push(row.url);
        const outcome = await processCrawlPage(site, row, {
          dryRun: true, maxTries: live.maxTries, noPersist: true,
        });
        results.push({
          url: row.url, kind: outcome.kind, releases: outcome.releases,
          addedNew: outcome.addedNew, detail: outcome.detail ?? null,
        });
        // Site bloqueado: não martelar na simulação — para aqui.
        if (outcome.siteLevelError) break;
      }
    } catch (err: unknown) {
      // `processCrawlPage` normalmente devolve `error`; uma exceção crua de
      // colaborador/store não aborta em silêncio: a URL já volta à fila no
      // `finally` abaixo e o restante segue `pending`.
      log.warn('[crawl] simulação interrompida:', log.errorMessage(err));
    } finally {
      for (const url of claimed) store.engine().requeueUrl(siteId, url);
    }
    deps.count('crawl.simulate.pages', results.length);
    return { ok: true, pages: results.length, results };
  }

  /** "Reprocessar erros": zera tries/next_at do site (ou do site ativo). */
  function reprocessErrors(siteId?: string): { site: string | null; requeued: number } {
    const ids = siteIds();
    const site = String(siteId || ids[0] || '');
    if (!site || !ids.includes(site)) return { site: site || null, requeued: 0 };
    const requeued = store.engine().requeueErrors(site);
    if (requeued) deps.count('crawl.reprocess.errors', requeued);
    return { site, requeued };
  }

  /** "Zerar site" (destrutivo): apaga SÓ o estado daquele site em `crawl.db`. */
  function resetSite(siteId: string): { ok: boolean; site: string; urls: number; runs: number; error?: string } {
    const site = String(siteId || '');
    if (!site) return { ok: false, site, urls: 0, runs: 0, error: 'site obrigatório' };
    if (!siteIds().includes(site)) {
      return { ok: false, site, urls: 0, runs: 0, error: 'site não está na config viva (CRAWL_SITES)' };
    }
    deps.forgetActiveRun();
    const report = store.engine().clearSite(site);
    deps.count('crawl.reset.urls', report.urls);
    log.warn(`[crawl] site zerado: ${site} (${report.urls} URL(s), ${report.runs} rodada(s))`);
    return { ok: true, site, ...report };
  }

  return { simulate, reprocessErrors, resetSite };
}
