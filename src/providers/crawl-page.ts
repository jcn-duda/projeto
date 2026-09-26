// Processamento de UMA página da raspagem (plano "Raspagem total", Fase 3).
// O motor (crawler.ts) decide QUANDO; aqui acontece o trabalho: buscar a
// página no adaptador, identificar a obra que faltou (Fase 2) e marcar o
// resultado no store. A gravação em si (banco vivo/índice) é do recorder e só
// roda com `CRAWL_DRY_RUN=false`.
//
// Classificação dos desfechos, na ordem do vocabulário do store:
//   - exceção do adaptador ou `status:'error'` → `error` com backoff;
//   - `no-torrent` → `no-torrent` (não gasta TMDB: página sem magnet não tem
//     nada a atribuir; a obra volta a ser identificada se o layout mudar);
//   - `done` sem IMDb ancorado → `identifyWork`:
//       `identified`  → grava com o IMDb do TMDB;
//       `unavailable` → `error` (TMDB fora é retentável, NÃO é veredicto);
//       `unidentified`/`ambiguous` → `no-work` (obra errada é pior que nenhuma);
//   - `done` sem release nenhuma → `no-torrent` (defensivo; o adaptador do Vaca
//     já lança nesse caso, mas nenhum contrato deve mentir "página lida").
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
import type { CrawlSite, CrawlUrlRow } from './crawl-types.js';
import type { CrawlRecorder } from './crawl-recorder.js';

export interface PageOutcome {
  kind: 'done' | 'no-torrent' | 'no-work' | 'error';
  /** O erro prova o SITE fora/bloqueado (entra no streak de pausa). */
  siteLevelError: boolean;
  /** Releases válidas vistas na página (mesmo em `no-work`/erro de gravação). */
  releases: number;
  /** Releases efetivamente NOVAS no índice (só no caminho com gravação). */
  addedNew?: number;
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
}

export interface PageCollaborators {
  identify(input: { type: 'movie' | 'series'; title: string; year?: number | null }): Promise<IdentifyResult>;
  record: CrawlRecorder['record'];
}

const defaultCollaborators: PageCollaborators = {
  identify: identifyWork,
  record: (siteId, obra, releases) => recordCrawlReleases.record(siteId, obra, releases),
};

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
      result = await site.fetchWork(row.url);
    } catch (err: unknown) {
      const message = log.errorMessage(err);
      markError(row, message, opts);
      log.warn(`[crawl] página falhou (${row.url}):`, message);
      return { kind: 'error', siteLevelError: isSiteLevelError(message), releases: 0, detail: message };
    }

    if (result.status === 'error') {
      const message = String(result.error || 'erro da página');
      markError(row, message, opts);
      return { kind: 'error', siteLevelError: isSiteLevelError(message), releases: 0, detail: message };
    }

    if (result.status === 'no-torrent') {
      if (persist) {
        store.engine().markResult(site.id, row.url, { status: 'no-torrent', imdb: result.imdb ?? null, releases: 0 }, Date.now());
      }
      metrics.count('crawl.page.no-torrent');
      return { kind: 'no-torrent', siteLevelError: false, releases: 0 };
    }

    // status 'done': a página tem releases. Sem nenhuma, o honesto é
    // `no-torrent` — `done` com 0 releases mentiria "página lida".
    const releases = Array.isArray(result.releases) ? result.releases : [];
    const isSeries = result.type === 'series' || row.kind === 'tv_show';
    if (!releases.length) {
      if (persist) {
        store.engine().markResult(site.id, row.url, { status: 'no-torrent', imdb: result.imdb ?? null, releases: 0 }, Date.now());
      }
      metrics.count('crawl.page.no-torrent');
      return { kind: 'no-torrent', siteLevelError: false, releases: 0 };
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
        const message = `tmdb-indisponivel:${identification.reason}`;
        markError(row, message, opts);
        return { kind: 'error', siteLevelError: false, releases: releases.length, detail: message };
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
        return { kind: 'no-work', siteLevelError: false, releases: 0, detail: identification.reason };
      }
    }

    if (dryRun) {
      if (persist) {
        store.engine().markResult(site.id, row.url, { status: 'done', imdb, releases: releases.length }, Date.now());
      }
      metrics.count('crawl.page.done');
      return { kind: 'done', siteLevelError: false, releases: releases.length };
    }

    try {
      // `record` só resolve com o lote JÁ persistido no acervo (barreira do
      // recorder). Rejeição (ex.: flush falho) cai no catch como erro
      // retentável: a URL volta a `error` — nunca `done` sobre acervo que não
      // gravou.
      const report = await collab.record(site.id, {
        imdb: String(imdb),
        title: String(result.title || ''),
        year: result.year ?? null,
        kind: isSeries ? 'tv_show' : 'movie',
      }, releases);
      if (persist) {
        store.engine().markResult(site.id, row.url, { status: 'done', imdb, releases: releases.length }, Date.now());
      }
      metrics.count('crawl.page.done');
      return { kind: 'done', siteLevelError: false, releases: releases.length, addedNew: report.added };
    } catch (err: unknown) {
      const message = log.errorMessage(err);
      markError(row, message, opts);
      log.warn(`[crawl] gravação falhou (${row.url}):`, message);
      return { kind: 'error', siteLevelError: false, releases: releases.length, detail: message };
    }
  };
}

/** Instância de produção. */
export const processCrawlPage = createPageProcessor();
