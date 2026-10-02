// Fatia de SÉRIE de uma página (plano "Raspagem total", Fase 7 v2) — o
// `status:'partial'` do `CrawlWorkResult`, que é um caminho com regras próprias:
// ele não "termina" a página, ele retoma. Saiu de `crawl-page.ts` porque esse
// arquivo está no teto de 400 linhas desde a Fase 8 e o bloco do `partial` é
// a única parte dele que não é o "terminar a página" — é o "continuar a série".
//
// A ORDEM aqui é o contrato inteiro e ela não pode ser reordenada:
//   1. ESTOURO — o progresso não avançou: `error series_stall` (backoff, e o
//      retry não fica-preso no mesmo ponto para sempre);
//   2. DRY-RUN — nada no acervo, `dry:1` no progresso (é o que o flip
//      true→false reenfileira) e a contagem DISCOBERTA acumulada na linha;
//   3. AO VIVO com releases — identifica UMA vez (o imdb da linha é reusado
//      nas retomadas), grava os grupos e SÓ ENTÃO marca o progresso: falha de
//      gravação não pode ter sido "paga" com avanço de progresso;
//   4. AO VIVO sem releases nesta fatia — só o progresso. Identificar aqui
//      gastaria TMDB à toa e `no-work` mataria trabalho que a retomada
//      ainda vai encontrar.
import config from '../config.js';
import * as store from '../utils/crawl-store.js';
import * as metrics from '../utils/metrics.js';
import * as log from '../utils/logger.js';
import { progressAdvanced, renderProgress, withDryFlag } from '../utils/crawl-store-rules.js';
import type { PageCollaborators, PageOutcome, PageProcessOptions } from './crawl-page.js';
import type { CrawlReleaseGroup, CrawlSite, CrawlUrlRow, CrawlWorkResult } from './crawl-types.js';
import type { RawItem } from '../../types/domain.js';

/**
 * Marcação de ERRO de página, compartilhada com o caminho de filme: é quem
 * carrega o `maxTries` (teto de tentativas da URL) e a métrica. Vive aqui
 * porque os dois caminhos precisam dela e este é o módulo mais interno.
 */
export function markPageError(row: CrawlUrlRow, message: string, opts: PageProcessOptions = {}): void {
  if (!opts.noPersist) {
    store.engine().markResult(
      row.site,
      row.url,
      { status: 'error', error: String(message || 'erro').slice(0, 300) },
      Date.now(),
      // Sem `retryBaseMs` explícito vale a base default do store (1 min), com
      // backoff exponencial e teto; `maxTries` põe a URL para dormir.
      { maxTries: opts.maxTries ?? config.crawl.maxTries },
    );
  }
  metrics.count('crawl.page.error');
}

export interface PartialSliceContext {
  site: CrawlSite;
  row: CrawlUrlRow;
  /** Resultado do adaptador com `status === 'partial'` (garantido pelo chamador). */
  result: CrawlWorkResult;
  opts: PageProcessOptions;
  collab: PageCollaborators;
  persist: boolean;
  dryRun: boolean;
}

/** Grupos declarados na página (`null` = página sem locação explícita). */
function groupsOf(result: CrawlWorkResult): CrawlReleaseGroup[] | null {
  return Array.isArray(result.groups) && result.groups.length ? result.groups : null;
}

/** Todas as releases da fatia, achatadas dos grupos. */
function releasesOf(groups: CrawlReleaseGroup[] | null): RawItem[] {
  return groups ? groups.flatMap((g) => (Array.isArray(g.releases) ? g.releases : [])) : [];
}

export async function processPartialSlice(ctx: PartialSliceContext): Promise<PageOutcome> {
  const { site, row, result, opts, collab, persist, dryRun } = ctx;
  const detail = String(result.error || 'parcial');
  metrics.count('crawl.page.partial');
  if (/^series_truncated/i.test(detail)) metrics.count('crawl.page.series-truncated');
  // 1) ESTOURO: o progresso não avançou em relação à coluna — refazer do mesmo
  //    ponto para sempre é falha de verdade. Vira `error series_stall`
  //    (tries++/backoff/give-up; o `applyResult` do erro preserva o progresso
  //    anterior pelo spread).
  if (!progressAdvanced(row.progress, result.progress ?? null)) {
    const message = `series_stall: progresso não avançou (${detail})`;
    markPageError(row, message, opts);
    metrics.count('crawl.page.partial.stall');
    log.warn(`[crawl] série estagnada (${row.url}):`, detail);
    return { kind: 'error', siteLevelError: false, releases: 0, detail: message, requestCost: result.requestCost };
  }
  const progressJson = renderProgress(result.progress!);
  if (dryRun) {
    // 2) DRY: nada no acervo; progresso com o flag `dry:1`. B1 pós-v2 (One
    //    Piece): a CONTAGEM DISCOBERTA acumula na linha — contador, NUNCA prova
    //    de gravação; o flip reseta, e sem ela a conclusão por resume viraria
    //    `no-torrent`.
    const discovered = releasesOf(groupsOf(result)).length;
    if (persist) {
      store.engine().markResult(site.id, row.url, {
        status: 'partial', imdb: result.imdb ?? row.imdb,
        releases: (Number(row.releases) || 0) + discovered,
        error: detail, progress: withDryFlag(progressJson),
      }, Date.now());
    }
    return { kind: 'partial', siteLevelError: false, releases: discovered, detail, requestCost: result.requestCost };
  }
  const groups = groupsOf(result);
  const releases = releasesOf(groups);
  // 3) AO VIVO, com releases: identifica (uma vez), grava os grupos e SÓ
  //    ENTÃO marca o progresso.
  if (releases.length > 0) {
    let imdb = result.imdb ?? row.imdb ?? null;
    if (!imdb) {
      const identification = await collab.identify({
        type: 'series',
        title: String(result.title || ''),
        year: result.year ?? null,
      });
      if (identification.outcome === 'identified') {
        imdb = identification.imdb;
      } else if (identification.outcome === 'unavailable') {
        // TMDB fora: retentável. markPageError preserva o progresso (spread).
        const message = `tmdb-indisponivel:${identification.reason}`;
        markPageError(row, message, opts);
        return { kind: 'error', siteLevelError: false, releases: releases.length, detail: message, requestCost: result.requestCost };
      } else {
        // Obra não identificada: terminal `no-work` (limpa progresso).
        // Gravação 0 (nada no acervo); o desfecho devolve o que foi visto.
        if (persist) {
          store.engine().markResult(site.id, row.url, { status: 'no-work', imdb: null, releases: 0 }, Date.now());
        }
        metrics.count('crawl.page.no-work');
        return { kind: 'no-work', siteLevelError: false, releases: releases.length, detail: identification.reason, requestCost: result.requestCost };
      }
    }
    let added = 0;
    try {
      const obra = {
        imdb: String(imdb),
        title: String(result.title || ''),
        year: result.year ?? null,
        kind: 'tv_show' as const,
      };
      for (const g of groups ?? []) {
        const report = await collab.record(site.id, obra, g.releases, { season: g.season, episode: g.episode });
        added += report.added;
      }
    } catch (err: unknown) {
      // Gravação falhou: erro retentável SEM avançar progresso — o retry refaz
      // os cards (merge idempotente no índice/banco).
      const message = log.errorMessage(err);
      markPageError(row, message, opts);
      log.warn(`[crawl] gravação falhou (${row.url}):`, message);
      return { kind: 'error', siteLevelError: false, releases: releases.length, detail: message, requestCost: result.requestCost };
    }
    if (persist) {
      // Acumula (F3): `releases` da linha é o TOTAL visto na série, e cada
      // marcação corresponde a uma fatia NOVA (o guarda de estagnação impede
      // remarcar a mesma) — sobrescrever com a fatia atual perdia as fatias
      // anteriores; fatia VAZIA preserva o acumulado.
      store.engine().markResult(site.id, row.url, {
        status: 'partial', imdb, releases: (Number(row.releases) || 0) + releases.length, error: detail, progress: progressJson,
      }, Date.now());
    }
    return { kind: 'partial', siteLevelError: false, releases: releases.length, addedNew: added, requestCost: result.requestCost, detail };
  }
  // 4) AO VIVO, sem releases nesta fatia: só o progresso. A contagem acumulada
  //    das fatias anteriores é PRESERVADA (F3): a conclusão por resume herda
  //    dela e o painel soma o total real.
  if (persist) {
    store.engine().markResult(site.id, row.url, {
      status: 'partial', imdb: row.imdb ?? null, releases: row.releases, error: detail, progress: progressJson,
    }, Date.now());
  }
  return { kind: 'partial', siteLevelError: false, releases: 0, requestCost: result.requestCost, detail };
}
