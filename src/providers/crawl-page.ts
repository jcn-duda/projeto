// Processamento de UMA página da raspagem (plano "Raspagem total", Fase 3).
// O motor (crawler.ts) decide QUANDO; aqui acontece o trabalho: buscar a
// página no adaptador, identificar a obra que faltou (Fase 2) e marcar o
// resultado no store. A gravação em si (banco vivo/índice) é do recorder e só
// roda com `CRAWL_DRY_RUN=false`.
//
// Classificação dos desfechos, na ordem do vocabulário do store:
//   - exceção do adaptador ou `status:'error'` → `error` com backoff (a
//     exceção pode carregar o `requestCost` medido — F1 — e `series_truncated`
//     ganha métrica própria — F5);
//   - M1: TODO desfecho pós-adaptador (error/no-torrent/no-work/done/simulated)
//     carrega o `requestCost` medido pela página — o motor cobra o real no
//     teto horário, inclusive quando a falha vem depois (TMDB, defensivos);
//   - `no-torrent` → `no-torrent` (não gasta TMDB: página sem magnet não tem
//     nada a atribuir; a obra volta a ser identificada se o layout mudar);
//   - `done` sem IMDb ancorado → `identifyWork`:
//       `identified`  → grava com o IMDb do TMDB;
//       `unavailable` → `error` (TMDB fora é retentável, NÃO é veredicto);
//       `unidentified`/`ambiguous` → `no-work` (obra errada é pior que nenhuma);
//   - `done` sem release nenhuma → `no-torrent` (defensivo; o adaptador do Vaca
//     já lança nesse caso, mas nenhum contrato deve mentir "página lida");
//   - DRY-RUN com releases + obra identificada → `simulated` (NUNCA `done`:
//     nada foi gravado; o motor reenfileira quando o dry-run desliga).
//
// Os colaboradores (identificação e gravação) são injetáveis: módulos são
// namespaces ESM congelados e o teste prova o fio sem patch de módulo.
import config from '../config.js';
import * as store from '../utils/crawl-store.js';
import { identifyWork } from './crawl-identify.js';
import { recordCrawlReleases } from './crawl-recorder.js';
import { isSiteLevelError } from './crawl-pauses.js';
import * as metrics from '../utils/metrics.js';
import * as log from '../utils/logger.js';
import type { IdentifyResult } from './crawl-identify.js';
import type { CrawlSite, CrawlUrlRow, CrawlSeriesLimits, CrawlReleaseGroup } from './crawl-types.js';
import type { CrawlRecorder } from './crawl-recorder.js';
import type { RawItem } from '../../types/domain.js';

export interface PageOutcome {
  kind: 'done' | 'no-torrent' | 'no-work' | 'error' | 'simulated';
  /** O erro prova o SITE fora/bloqueado (entra no streak de pausa). */
  siteLevelError: boolean;
  /** Releases válidas vistas na página (mesmo em `no-work`/erro de gravação). */
  releases: number;
  /** Releases efetivamente NOVAS no índice (só no caminho com gravação). */
  addedNew?: number;
  /**
   * Custo REAL de requisições da página (Fase 7, séries). O motor soma no
   * teto por hora — uma página que custou 12 requests não pode caber como 1.
   * Ausente = 1 (a página em si).
   */
  requestCost?: number;
  /** Motivo curto para log/painel (nunca credencial). */
  detail?: string;
}

/** Parâmetros do processamento que vêm da config VIVA do motor (snapshot do
 * tick). O default cai no `config.crawl` estático para os testes e para quem
 * chama sem motor. `noPersist` é da simulação: processa sem gravar NADA no
 * `crawl.db` — a URL volta à fila depois (ver `crawler.simulate`). */
export interface PageProcessOptions {
  dryRun?: boolean;
  maxTries?: number;
  noPersist?: boolean;
  /** Fase 7: limites/flag da descoberta e do processamento de série. */
  series?: CrawlSeriesLimits;
}

export interface PageCollaborators {
  identify(input: { type: 'movie' | 'series'; title: string; year?: number | null }): Promise<IdentifyResult>;
  record: CrawlRecorder['record'];
}

const defaultCollaborators: PageCollaborators = {
  identify: identifyWork,
  record: (siteId, obra, releases, location) => recordCrawlReleases.record(siteId, obra, releases, location),
};

/**
 * Custo medido anexado ao erro (F1): o adaptador lança com `requestCost`
 * (`withRequestCost`) e o motor cobra o que foi gasto antes de falhar — não 1
 * por página. Ausente/inválido = undefined (o motor aplica o piso 1).
 */
function requestCostOf(err: unknown): number | undefined {
  const c = (err as { requestCost?: unknown } | null)?.requestCost;
  return typeof c === 'number' && Number.isFinite(c) && c >= 1 ? Math.trunc(c) : undefined;
}

function markError(row: CrawlUrlRow, message: string, opts: PageProcessOptions = {}): void {
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
  // F5: página de série cortada pelo teto (series_truncated) é métrica
  // própria — o recorte não pode se misturar com erro de rede no diagnóstico.
  // O freio anti-loop é o `maxTries` do motor: a URL dorme até o operador
  // levantar `CRAWL_SERIES_MAX_*` e usar "Reprocessar erros".
  if (/^series_truncated/i.test(String(message || ''))) metrics.count('crawl.page.series-truncated');
  metrics.count('crawl.page.error');
}

/** Fábrica: o teste injeta `identify`/`record` dublês; produção usa os reais. */
export function createPageProcessor(overrides: Partial<PageCollaborators> = {}) {
  const collab: PageCollaborators = { ...defaultCollaborators, ...overrides };
  return async function processPage(
    site: CrawlSite,
    row: CrawlUrlRow,
    opts: PageProcessOptions = {},
  ): Promise<PageOutcome> {
    const persist = !opts.noPersist;
    const dryRun = opts.dryRun ?? config.crawl.dryRun;
    let result: Awaited<ReturnType<CrawlSite['fetchWork']>>;
    try {
      result = await site.fetchWork(row.url, { kind: row.kind, series: opts.series });
    } catch (err: unknown) {
      const message = log.errorMessage(err);
      markError(row, message, opts);
      log.warn(`[crawl] página falhou (${row.url}):`, message);
      // F1: o throw carrega o custo medido (`withRequestCost`) — cobra o que
      // foi gasto antes de falhar.
      return { kind: 'error', siteLevelError: isSiteLevelError(message), releases: 0, requestCost: requestCostOf(err), detail: message };
    }

    if (result.status === 'error') {
      const message = String(result.error || 'erro da página');
      markError(row, message, opts);
      return { kind: 'error', siteLevelError: isSiteLevelError(message), releases: 0, detail: message, requestCost: result.requestCost };
    }

    if (result.status === 'no-torrent') {
      if (persist) {
        store.engine().markResult(site.id, row.url, { status: 'no-torrent', imdb: result.imdb ?? null, releases: 0 }, Date.now());
      }
      metrics.count('crawl.page.no-torrent');
      return { kind: 'no-torrent', siteLevelError: false, releases: 0, requestCost: result.requestCost };
    }

    // status 'done': a página tem releases. Sem nenhuma, o honesto é
    // `no-torrent` — `done` com 0 releases mentiria "página lida".
    // Série (Fase 7): os grupos são a verdade da página; a soma plana só
    // alimenta contadores. Filme (sem grupos) segue com o lote único na raiz.
    const groups: CrawlReleaseGroup[] | null = Array.isArray(result.groups) && result.groups.length
      ? result.groups
      : null;
    const releases: RawItem[] = groups
      ? groups.flatMap((g) => (Array.isArray(g.releases) ? g.releases : []))
      : (Array.isArray(result.releases) ? result.releases : []);
    const isSeries = result.type === 'series' || row.kind === 'tv_show';
    if (!releases.length) {
      // Defensivo (M1): `done` sem release nenhuma vira `no-torrent`, e o
      // custo medido acompanha — nenhum desfecho pós-adaptador perde o que a
      // página gastou.
      if (persist) {
        store.engine().markResult(site.id, row.url, { status: 'no-torrent', imdb: result.imdb ?? null, releases: 0 }, Date.now());
      }
      metrics.count('crawl.page.no-torrent');
      return { kind: 'no-torrent', siteLevelError: false, releases: 0, requestCost: result.requestCost };
    }

    let imdb = result.imdb ?? null;
    if (!imdb) {
      const identification = await collab.identify({
        type: isSeries ? 'series' : 'movie',
        title: String(result.title || ''),
        year: result.year ?? null,
      });
      if (identification.outcome === 'identified') {
        imdb = identification.imdb;
      } else if (identification.outcome === 'unavailable') {
        // TMDB indisponível: retentável, não veredicto. Erro de página.
        // M1: o custo medido pelo adaptador acompanha TODOS os desfechos
        // pós-adaptador — uma série cara que falhou no TMDB custa o que custou.
        const message = `tmdb-indisponivel:${identification.reason}`;
        markError(row, message, opts);
        return { kind: 'error', siteLevelError: false, releases: releases.length, detail: message, requestCost: result.requestCost };
      } else {
        if (persist) {
          store.engine().markResult(
            site.id, row.url,
            { status: 'no-work', imdb: null, releases: 0 },
            Date.now(),
          );
        }
        metrics.count('crawl.page.no-work');
        log.debug(`[crawl] sem obra (${row.url}): ${identification.reason}`);
        return { kind: 'no-work', siteLevelError: false, releases: 0, detail: identification.reason, requestCost: result.requestCost };
      }
    }

    if (dryRun) {
      // Dry-run com releases + obra identificada NÃO é `done`: nada foi
      // gravado, e marcar done escondia páginas cuja gravação nunca aconteceria
      // — a carga se perdia no switch do dry-run. `simulated` é terminal na
      // fila até o motor reenfileirar (dryRun true→false, one-shot). As
      // no-torrent/no-work ACIMA continuam terminais de verdade: sem releases
      // ou sem obra não há nada a gravar, em nenhum modo.
      if (persist) {
        store.engine().markResult(site.id, row.url, { status: 'simulated', imdb, releases: releases.length }, Date.now());
      }
      metrics.count('crawl.page.simulated');
      return { kind: 'simulated', siteLevelError: false, releases: releases.length, requestCost: result.requestCost };
    }

    // Gravação. Filme: um lote na raiz. Série: UM registro por locação
    // declarada (S/E, S, raiz) — cada grupo na chave que o cobre, sempre
    // partial+keepPartial (uma página NUNCA prova cobertura completa da obra).
    // Um grupo falho é erro retentável: as locações já gravadas são merge
    // idempotente no índice/banco, o retry só refaz o que faltou.
    const locations: Array<{ season: number | null; episode: number | null; items: RawItem[] }> = groups
      ? groups.map((g) => ({ season: g.season, episode: g.episode, items: g.releases }))
      : [{ season: null, episode: null, items: releases }];
    let added = 0;
    try {
      // `record` só resolve com o lote JÁ persistido no acervo (barreira do
      // recorder). Rejeição (ex.: flush falho) cai no catch como erro
      // retentável: a URL volta a `error` — nunca `done` sobre acervo que não
      // gravou.
      const obra = {
        imdb: String(imdb),
        title: String(result.title || ''),
        year: result.year ?? null,
        kind: isSeries ? 'tv_show' as const : 'movie' as const,
      };
      for (const loc of locations) {
        const report = await collab.record(site.id, obra, loc.items, { season: loc.season, episode: loc.episode });
        added += report.added;
      }
      if (persist) {
        store.engine().markResult(site.id, row.url, { status: 'done', imdb, releases: releases.length }, Date.now());
      }
      metrics.count('crawl.page.done');
      return { kind: 'done', siteLevelError: false, releases: releases.length, addedNew: added, requestCost: result.requestCost };
    } catch (err: unknown) {
      const message = log.errorMessage(err);
      markError(row, message, opts);
      log.warn(`[crawl] gravação falhou (${row.url}):`, message);
      return { kind: 'error', siteLevelError: false, releases: releases.length, detail: message, requestCost: result.requestCost };
    }
  };
}

/** Instância de produção. */
export const processCrawlPage = createPageProcessor();
