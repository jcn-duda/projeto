// Processamento de UMA página da raspagem (plano "Raspagem total", Fase 3).
// O motor (crawler.ts) decide QUANDO; aqui acontece o trabalho: buscar a
// página no adaptador, identificar a obra que faltou (Fase 2) e marcar o
// resultado no store. A gravação em si (banco vivo/índice) é do recorder e só
// roda com `CRAWL_DRY_RUN=false`.
//
// Classificação dos desfechos, na ordem do vocabulário do store:
//   - exceção do adaptador ou `status:'error'` → `error` com backoff (a
//     exceção pode carregar o `requestCost` medido — F1);
//   - `no-torrent` → `no-torrent` (não gasta TMDB: página sem magnet não tem
//     nada a atribuir; a obra volta a ser identificada se o layout mudar);
//   - `partial` (Fase 7 v2) → grava os grupos ANTES de marcar o progresso, com
//     o progresso retomável; estouro vira `error series_stall` (backoff + escape
//     no "Reprocessar erros"); dry-run marca partial com `dry:1`, NADA no
//     acervo e a contagem DISCOBERTA acumula na linha (o flip reenfileira);
//   - `done` sem IMDb ancorado → `identifyWork`:
//       `identified`  → grava com o IMDb do TMDB;
//       `unavailable` → `error` (TMDB fora é retentável, NÃO é veredicto);
//       `unidentified`/`ambiguous` → `no-work` (obra errada é pior que nenhuma).
//       `no-work` é RESPOSTA da identificação, não falta dela: o desfecho
//       devolve as releases que o adaptador VIU e o `store` recebe 0 (nada
//       gravado — o que a fila precisa saber). Zero no desfecho fazia uma
//       página "sem obra" parecer uma página sem release;
//   - `done` sem release nenhuma → `no-torrent` (defensivo) — EXCETO quando a
//     linha tem progresso E contagem acumulada > 0: a leitura secou num passe
//     de resume e a série já foi colhida → `done` (ou `simulated` em dry);
//     resume com acumulado 0 nunca colheu e segue `no-torrent`;
//   - DRY-RUN com releases + obra identificada → `simulated` (NUNCA `done`; o flip reenfileira).
//
// Os colaboradores (identificação e gravação) são injetáveis: módulos são
// namespaces ESM congelados e o teste prova o fio sem patch de módulo.
import config from '../config.js';
import * as store from '../utils/crawl-store.js';
import { identifyWork } from './crawl-identify.js';
import { tvSeasonCount, type SeasonCountResult } from '../utils/tmdb-search.js';
import { recordCrawlReleases } from './crawl-recorder.js';
import { isSiteLevelError } from './crawl-pauses.js';
import { parseProgress } from '../utils/crawl-store-rules.js';
import { markPageError, processPartialSlice } from './crawl-page-partial.js';
import { isCrawlAborted } from './crawl-recorder.js';
import * as metrics from '../utils/metrics.js';
import * as log from '../utils/logger.js';
import type { IdentifyResult } from './crawl-identify.js';
import type { CrawlSite, CrawlUrlRow, CrawlSeriesLimits, CrawlReleaseGroup } from './crawl-types.js';
import type { CrawlRecorder } from './crawl-recorder.js';
import type { RawItem } from '../../types/domain.js';

export interface PageOutcome {
  kind: 'done' | 'no-torrent' | 'no-work' | 'error' | 'simulated' | 'partial';
  /** O erro prova o SITE fora/bloqueado (entra no streak de pausa). */
  siteLevelError: boolean;
  /**
   * Releases OBSERVADAS pelo adaptador (as únicas que a página tinha), não as
   * gravadas: em `no-work` e erro de gravação o `store` recebe 0.
   */
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
  /**
   * Cerca do passo (`crawl-site-runtime.ts`): quando `true`, o passo expirou e
   * NENHUMA escrita tardia pode tocar fila/índice/banco/progresso — a
   * recuperação do vigia já marcou a linha (ou vai marcar). Não aborta a rede
   * compartilhada (Cinemeta/TMDB): só barra os efeitos persistidos.
   */
  isAborted?: () => boolean;
}

export interface PageCollaborators {
  identify(input: { type: 'movie' | 'series'; title: string; year?: number | null; originalTitle?: string | null; season?: number | null }): Promise<IdentifyResult>;
  record: CrawlRecorder['record'];
  /** Temporadas da série no TMDB: decide o destino do pack sem temporada (`unlocated`). */
  seasonCount(imdb: string): Promise<SeasonCountResult>;
}

const defaultCollaborators: PageCollaborators = {
  identify: identifyWork,
  seasonCount: tvSeasonCount,
  record: (siteId, obra, releases, location, options) => recordCrawlReleases.record(siteId, obra, releases, location, options),
};

/**
 * Custo medido anexado ao erro (F1): o adaptador lança com `requestCost`
 * (`withRequestCost`) e o motor cobra o que foi gasto antes de falhar — não 1
 * por página. Ausente/inválido = undefined (o motor aplica o piso 1).
 */
export function requestCostOf(err: unknown): number | undefined {
  if (!err || (typeof err !== 'object' && typeof err !== 'function')) return undefined;
  try {
    const cost = (err as { requestCost?: unknown }).requestCost;
    return typeof cost === 'number' && Number.isInteger(cost) && cost >= 1 ? cost : undefined;
  } catch {
    return undefined;
  }
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
    // Cerca do passo: true = o passo expirou; nenhuma escrita persistente sai
    // daqui (a recuperação do vigia é quem marca a linha presa).
    const aborted = (): boolean => opts.isAborted?.() === true;
    let result: Awaited<ReturnType<CrawlSite['fetchWork']>>;
    try {
      // Retomada (Fase 7 v2): o progresso da linha (coluna `progress`) vai ao
      // adaptador — cards já feitos não são re-visados.
      result = await site.fetchWork(row.url, { kind: row.kind, series: opts.series, resume: parseProgress(row.progress) });
    } catch (err: unknown) {
      const message = log.errorMessage(err);
      markPageError(row, message, opts);
      log.warn(`[crawl] página falhou (${row.url}):`, message);
      // F1: o throw carrega o custo medido (`withRequestCost`) — cobra o que
      // foi gasto antes de falhar.
      return { kind: 'error', siteLevelError: isSiteLevelError(message), releases: 0, requestCost: requestCostOf(err), detail: message };
    }
    // Adaptador respondeu, mas o passo já expirou: NÃO trata o resultado (a
    // linha foi devolvida/marcada pela recuperação). Sai sem gravar.
    if (aborted()) return { kind: 'error', siteLevelError: false, releases: 0, detail: 'step-timeout' };

    if (result.status === 'error') {
      const message = String(result.error || 'erro da página');
      markPageError(row, message, opts);
      return { kind: 'error', siteLevelError: isSiteLevelError(message), releases: 0, detail: message, requestCost: result.requestCost };
    }

    if (result.status === 'no-torrent') {
      if (persist && !aborted()) {
        store.engine().markResult(site.id, row.url, { status: 'no-torrent', imdb: result.imdb ?? null, releases: 0 }, Date.now());
      }
      metrics.count('crawl.page.no-torrent');
      return { kind: 'no-torrent', siteLevelError: false, releases: 0, requestCost: result.requestCost };
    }

    // `partial` (Fase 7 v2): página de série lida até um teto. A ordem das
    // regras (estouro → dry → ao vivo) e a gravação ANTES da marcação do
    // progresso vivem em `crawl-page-partial.ts` — é o caminho que retoma a
    // série em vez de terminar a página.
    if (result.status === 'partial') {
      return processPartialSlice({ site, row, result, opts, collab, persist, dryRun });
    }

    // status 'done': a página tem releases. Sem nenhuma, o honesto é
    // `no-torrent` — `done` com 0 releases mentiria "página lida".
    // EXCEÇÃO (Fase 7 v2): a linha com progresso concluiu por resume e a
    // última fatia não tem release — a série JÁ foi colhida; `no-torrent`
    // apagaria a contagem e mentiria sobre o acervo. A exceção EXIGE contagem
    // acumulada > 0 (bug One Piece 2026-09-27): resume com ACUMULADO 0 nunca
    // colheu nada — o honesto é `no-torrent` (terminal nos dois modos). Em
    // dry-run com acúmulo, `simulated` (o flip reenfileira para gravar).
    // Série (Fase 7): os grupos são a verdade da página; a soma plana só
    // alimenta contadores. Filme (sem grupos) segue com o lote único na raiz.
    let groups: CrawlReleaseGroup[] | null = Array.isArray(result.groups) && result.groups.length
      ? result.groups
      : null;
    let releases: RawItem[] = groups
      ? groups.flatMap((g) => (Array.isArray(g.releases) ? g.releases : []))
      : (Array.isArray(result.releases) ? result.releases : []);
    const isSeries = result.type === 'series' || row.kind === 'tv_show';
    const unlocated = isSeries && Array.isArray(result.unlocated) ? result.unlocated : [];
    if (!releases.length && !unlocated.length) {
      const resumedConclusion = Boolean(row.progress && row.progress !== '')
        && (Number(row.releases) || 0) > 0;
      if (resumedConclusion) {
        if (persist && !aborted()) {
          store.engine().markResult(
            site.id, row.url,
            dryRun
              // A leitura secou no dry: `simulated` é o que o flip reenfileira;
              // a contagem da última visita com gravação é preservada.
              ? { status: 'simulated', imdb: result.imdb ?? row.imdb ?? null, releases: row.releases }
              // Sem `releases`: o `?? existing.releases` do terminal preserva
              // a contagem da última visita com gravação.
              : { status: 'done', imdb: result.imdb ?? row.imdb ?? null },
            Date.now(),
          );
        }
        metrics.count(dryRun ? 'crawl.page.simulated' : 'crawl.page.done');
        return {
          kind: dryRun ? 'simulated' : 'done',
          siteLevelError: false,
          releases: 0,
          requestCost: result.requestCost,
          detail: 'conclusão por retomada (última fatia sem release)',
        };
      }
      // Defensivo (M1): `done` sem release nenhuma vira `no-torrent`, e o
      // custo medido acompanha — nenhum desfecho pós-adaptador perde o que a
      // página gastou.
      if (persist && !aborted()) {
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
        originalTitle: result.originalTitle ?? null,
        season: result.season ?? null,
      });
      if (aborted()) return { kind: 'error', siteLevelError: false, releases: releases.length, detail: 'step-timeout', requestCost: result.requestCost };
      if (identification.outcome === 'identified') {
        imdb = identification.imdb;
      } else if (identification.outcome === 'unavailable') {
        // TMDB indisponível: retentável, não veredicto. Erro de página.
        // M1: o custo medido pelo adaptador acompanha TODOS os desfechos
        // pós-adaptador — uma série cara que falhou no TMDB custa o que custou.
        const message = `tmdb-indisponivel:${identification.reason}`;
        markPageError(row, message, opts);
        return { kind: 'error', siteLevelError: false, releases: releases.length, detail: message, requestCost: result.requestCost };
      } else {
        // `no-work` = resposta negativa da identificação (ver o cabeçalho).
        if (persist && !aborted()) {
          store.engine().markResult(
            site.id, row.url,
            { status: 'no-work', imdb: null, releases: 0 },
            Date.now(),
          );
        }
        metrics.count('crawl.page.no-work');
        log.debug(`[crawl] sem obra (${row.url}): ${identification.reason}`);
        return { kind: 'no-work', siteLevelError: false, releases: releases.length, detail: identification.reason, requestCost: result.requestCost };
      }
    }

    // Pack "Completo" sem temporada no `dn=`: só vira a temporada 1 de série com
    // UMA temporada no TMDB (Pucca, Hellsing). Com mais, não há como saber o que
    // ele cobre — fica fora, como antes. TMDB fora do ar é erro retentável.
    if (unlocated.length) {
      const count = await collab.seasonCount(String(imdb));
      if (aborted()) return { kind: 'error', siteLevelError: false, releases: releases.length, detail: 'step-timeout', requestCost: result.requestCost };
      if (!count.ok) {
        markPageError(row, 'tmdb-indisponivel:temporadas', opts);
        return { kind: 'error', siteLevelError: false, releases: releases.length, detail: 'tmdb-indisponivel:temporadas', requestCost: result.requestCost };
      }
      if (count.seasons === 1) {
        groups = [...(groups ?? []), { season: 1, episode: null, releases: unlocated }];
        releases = [...releases, ...unlocated];
      }
    }
    if (!releases.length) {
      if (persist && !aborted()) store.engine().markResult(site.id, row.url, { status: 'no-torrent', imdb, releases: 0 }, Date.now());
      metrics.count('crawl.page.no-torrent');
      return { kind: 'no-torrent', siteLevelError: false, releases: 0, requestCost: result.requestCost };
    }

    if (dryRun) {
      // Dry-run com releases + obra identificada NÃO é `done`: nada foi
      // gravado, e marcar done escondia páginas cuja gravação nunca aconteceria
      // — a carga se perdia no switch do dry-run. `simulated` é terminal na
      // fila até o motor reenfileirar (dryRun true→false, one-shot). As
      // no-torrent/no-work ACIMA continuam terminais de verdade: sem releases
      // ou sem obra não há nada a gravar, em nenhum modo.
      if (persist && !aborted()) {
        // Multi-passa (B2): acumulado das fatias secas + a fatia final —
        // sobrescrever pela última perderia descoberta já marcada (o flip
        // zera a linha; o passe ao vivo re-acumula sem somar seco+vivo).
        store.engine().markResult(site.id, row.url, {
          status: 'simulated', imdb,
          releases: (Number(row.releases) || 0) + releases.length,
        }, Date.now());
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
        // A cerca vai até o recorder: ele reconsulta ANTES de cada escrita
        // persistente (banco vivo/índice/invalidação).
        const report = await collab.record(site.id, obra, loc.items, { season: loc.season, episode: loc.episode }, { shouldAbort: opts.isAborted });
        added += report.added;
      }
      if (aborted()) return { kind: 'error', siteLevelError: false, releases: releases.length, detail: 'step-timeout', requestCost: result.requestCost };
      if (persist && !aborted()) {
        store.engine().markResult(site.id, row.url, { status: 'done', imdb, releases: releases.length }, Date.now());
      }
      metrics.count('crawl.page.done');
      return { kind: 'done', siteLevelError: false, releases: releases.length, addedNew: added, requestCost: result.requestCost };
    } catch (err: unknown) {
      // Passo expirado no meio da gravação: NÃO é erro da página (não grava
      // `error` aqui) — a recuperação do vigia marca a linha.
      if (isCrawlAborted(err)) return { kind: 'error', siteLevelError: false, releases: releases.length, detail: 'step-timeout', requestCost: result.requestCost };
      const message = log.errorMessage(err);
      markPageError(row, message, opts);
      log.warn(`[crawl] gravação falhou (${row.url}):`, message);
      return { kind: 'error', siteLevelError: false, releases: releases.length, detail: message, requestCost: result.requestCost };
    }
  };
}

/** Instância de produção. */
export const processCrawlPage = createPageProcessor();
