// Ações do painel do crawler (Fase 4 do plano "Raspagem total"; Fase 8
// multi-site): simular, reprocessar erros e zerar site. Extraído do
// `crawler.ts` pela catraca de 400 linhas. As dependências do motor entram por
// fábrica (closures) para o módulo não importar `crawler.ts` — isso evita
// ciclo e mantém as ações testáveis com um motor dublê.
//
// Fronteiras de segurança:
//  - `simulate` processa em dry-run e com `noPersist`: NÃO grava acervo nem
//    `crawl.db`; a URL volta à fila (`requeueUrl`).
//  - `resetSite` só age sobre site da config VIVA (`CRAWL_SITES`) e apaga
//    apenas o estado daquele site em `crawl.db`;
//  - na Fase 8 todas as três são POR SITE: sem `site` no pedido, vale o site
//    ativo (o que o painel mostra), nunca "o primeiro da lista" às cegas.
import * as store from '../utils/crawl-store.js';
import { processCrawlPage } from './crawl-page.js';
import { knownSites, siteConfigOf, type CrawlerEffectiveConfig } from '../utils/crawler-live-schema.js';
import { PROBE_STATE_KEY } from './crawl-probe-gate.js';
import * as metrics from '../utils/metrics.js';
import * as log from '../utils/logger.js';
import type { CrawlSite } from './crawl-types.js';

export interface CrawlActionsDeps {
  effective(): CrawlerEffectiveConfig;
  isBusy(): boolean;
  isPaused(): boolean;
  ensureSite(id: string): Promise<CrawlSite | null>;
  /** Rótulo do site (o relatório de simulação mostra). */
  siteLabel(id: string): string;
  /** Site que serviu a última requisição (alvo padrão das ações). */
  activeSiteId(): string;
  /** Descarta a rodada/ciclo abertos do site (o "Zerar site" apaga a rodada). */
  forgetRun(siteId: string): void;
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
   * Site alvo da ação: o pedido, o site ativo, ou o primeiro configurado —
   * SEMPRE validado contra os sites do motor. Uma ação quePROCESSA não pode
   * apontar para um id arbitrário: ela abriria o store, criaria runtime e
   * poderia tocar fila de um site que o operador nem configurou.
   */
  const targetSite = (requested?: string): { site: string; ok: boolean; reason?: string } => {
    const site = String(requested || deps.activeSiteId() || siteIds()[0] || '');
    if (!site) return { site: '', ok: false, reason: 'sem-site' };
    if (!siteIds().includes(site)) return { site, ok: false, reason: 'site-desconhecido' };
    return { site, ok: true };
  };

  async function simulate(max?: number, siteId?: string): Promise<SimulateResult> {
    const live = deps.effective();
    if (deps.isBusy()) return { ok: false, reason: 'ocupado', site: null, pages: 0, results: [] };
    if (deps.isPaused()) return { ok: false, reason: 'pausado', site: null, pages: 0, results: [] };
    const target = targetSite(siteId);
    const site_ = target.site;
    if (!target.ok) return { ok: false, reason: target.reason, site: site_ || null, pages: 0, results: [] };
    const cfg = siteConfigOf(live, site_);
    // Resolver o adaptador pode lançar (import dinâmico, fábrica dublê): a
    // simulação degrada para `sem-adaptador`, nunca deixa a requisição pendurada.
    let site: CrawlSite | null = null;
    try {
      site = await deps.ensureSite(site_);
    } catch (err: unknown) {
      log.warn('[crawl] adaptador indisponível na simulação:', log.errorMessage(err));
      site = null;
    }
    if (!site) return { ok: false, reason: 'sem-adaptador', site: site_, pages: 0, results: [] };

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
        const row = store.engine().takeNext(site_, Date.now());
        if (!row) break;
        claimed.push(row.url);
        // Dry-run e `noPersist` são do SITE: a simulação nunca grava, mesmo que
        // o site esteja com dry-run desligado (é uma prévia, não a carga).
        const outcome = await processCrawlPage(site, row, {
          dryRun: true, maxTries: cfg.maxTries, noPersist: true,
          series: {
            enabled: cfg.seriesEnabled === true,
            maxCards: cfg.seriesMaxCards,
            maxButtons: cfg.seriesMaxButtons,
          },
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
      for (const url of claimed) store.engine().requeueUrl(site_, url);
    }
    deps.count('crawl.simulate.pages', results.length);
    return { ok: true, site: site_, label: deps.siteLabel(site_), pages: results.length, results };
  }

  /** "Reprocessar erros": zera tries/next_at do site pedido (ou do ativo). */
  function reprocessErrors(siteId?: string): ReprocessResult {
    const target = targetSite(siteId);
    if (!target.ok) return { ok: false, site: target.site || null, requeued: 0, reason: target.reason };
    const requeued = store.engine().requeueErrors(target.site);
    if (requeued) deps.count('crawl.reprocess.errors', requeued);
    return { ok: true, site: target.site, requeued };
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

  /**
   * "Zerar site" (destrutivo): apaga SÓ o estado daquele site em `crawl.db`
   * (fila e rodadas). O VEREDITO DA SONDA é preservado: ele é uma medição
   * cara (40 requisições) sobre o site, não estado de fila — apagá-lo
   * trancaria o site no gate (`CRAWL_REQUIRE_PROBE=true`) sem que o operador
   * tivesse pedido uma reamostragem. Para reamostrar de propósito, a sonda
   * reescreve o veredito.
   */
  function resetSite(siteId: string): { ok: boolean; site: string; urls: number; runs: number; probeVerdict?: string | null; error?: string } {
    const site = String(siteId || '');
    if (!site) return { ok: false, site, urls: 0, runs: 0, error: 'site obrigatório' };
    if (!siteIds().includes(site)) {
      return { ok: false, site, urls: 0, runs: 0, error: 'site não está no motor (CRAWL_SITES nem ligado no painel)' };
    }
    deps.forgetRun(site);
    const verdict = readVerdictRaw(site);
    const report = store.engine().clearSite(site);
    if (verdict != null) store.engine().setState(site, PROBE_STATE_KEY, verdict);
    deps.count('crawl.reset.urls', report.urls);
    log.warn(`[crawl] site zerado: ${site} (${report.urls} URL(s), ${report.runs} rodada(s)${verdict != null ? ', veredito da sonda preservado' : ''})`);
    return { ok: true, site, ...report, probeVerdict: verdict };
  }

  return { simulate, reprocessErrors, reprocessNoWork, resetSite };
}

/** Lê o veredito CRU da sonda (o gate é que valida; aqui só se preserva). */
function readVerdictRaw(site: string): string | null {
  try {
    return store.engine().getState(site, PROBE_STATE_KEY);
  } catch (err: unknown) {
    log.warn('[crawl] veredito da sonda ilegível no reset:', log.errorMessage(err));
    return null;
  }
}
