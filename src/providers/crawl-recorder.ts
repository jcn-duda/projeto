// Gravação da raspagem (plano "Raspagem total", Fase 3) — SÓ no caminho
// `CRAWL_DRY_RUN=false`. Reutiliza o fluxo existente da busca/colheita em vez
// de criar um paralelo (decisão `crawl.ingestion_reuse`): banco vivo
// (`captureAndMarkFilter` atômico), filtro de título (`filterRelevantRaw`),
// índice (`releaseIndex.record`) e invalidação BR (`brTransition`).
//
// Travas: `partial` preservado/`keepPartial`; contexto só do CATÁLOGO (sem
// nomes → erro retentável). Persistência: `captureAndMark` atômico (false =
// fila cheia → `crawl.record.queueDropped`, zero push) depois `flushBarrier`
// (`ok:false` → `crawl.record.flushFailed`). Sem pre-flush (corrida com a
// busca ao vivo). Colaboradores injetáveis para teste.
import { getMeta } from '../utils/cinemeta.js';
import * as tmdb from '../utils/tmdb.js';
import * as bank from '../utils/magnet-bank.js';
import * as releaseIndex from '../utils/release-index.js';
import { brTransition, invalidateStreamsForObra } from '../utils/br-gap.js';
import { filterRelevantRaw, resolveSearchNames } from '../utils/format.js';
import { captureAndMarkFilter } from './magnet-bank-hook.js';
import * as metrics from '../utils/metrics.js';
import type { MatchContext, RawItem } from '../../types/domain.js';

/** Obra de uma página já identificada (o motor não grava obra sem IMDb). */
export interface CrawlObra {
  imdb: string;
  title: string;
  year: number | null;
  kind: 'movie' | 'tv_show';
}

export interface RecordReport {
  /** Releases que sobreviveram ao filtro (as que foram ao índice). */
  kept: number;
  /** Releases efetivamente novas no índice. */
  added: number;
  /** `br`/`upgrade` quando o índice passou a cobrir dublado (senão `none`). */
  transition: 'none' | 'br' | 'upgrade';
  /** Listas `streams:vN` invalidadas nesta obra. */
  cleared: number;
}

/** Colaboradores do recorder — trocáveis em teste (ver cabeçalho). */
export interface CrawlRecorderDeps {
  /**
   * Capture + passed_filter ATOMICAMENTE. `false` = fila cheia (nada
   * enfileirado — sem half-write). Reusa a ponte da busca (`captureAndMarkFilter`).
   */
  captureAndMark(
    entered: readonly RawItem[],
    survivors: readonly RawItem[],
    indexer: string,
    ctx: Record<string, unknown>,
  ): boolean;
  /** Barreira de persistência do banco vivo: `ok:false` = o lote não gravou. */
  flush(): { ok: boolean; written: number };
  lookupQuiet(imdb: string, location: { season?: number | null; episode?: number | null }): unknown[];
  isPartial(imdb: string, location: { season?: number | null; episode?: number | null }): boolean;
  record(
    imdb: string,
    location: { season?: number | null; episode?: number | null },
    items: unknown[],
    opts: { partial?: boolean; keepPartial?: boolean },
  ): number;
  transition(before: unknown[] | null | undefined, after: unknown[] | null | undefined): 'none' | 'br' | 'upgrade';
  invalidate(imdb: string): number;
  buildContext(obra: CrawlObra): Promise<MatchContext | null>;
  count(name: string, value?: number): void;
}

/** Contexto da obra pelo CATÁLOGO; `null` quando nem Cinemeta nem TMDB dão
 * nome — recusar é mais seguro que admitir tudo (ver cabeçalho). */
async function defaultBuildContext(obra: CrawlObra): Promise<MatchContext | null> {
  const type = obra.kind === 'tv_show' ? 'series' : 'movie';
  const [meta, titles] = await Promise.all([getMeta(type, obra.imdb), tmdb.getTitles(obra.imdb)]);
  const resolved = resolveSearchNames({ meta, titles, imdbId: obra.imdb });
  if (!resolved.names.length) return null;
  return {
    names: resolved.names,
    year: resolved.year ?? obra.year,
    isSeries: obra.kind === 'tv_show',
    // Vaca é o piloto (filme). Série usa o mesmo esqueleto da colheita; a
    // temporada/episódio chegam na fase que abrir adaptador de série.
    season: null,
    episode: null,
  };
}

export interface CrawlRecorder {
  record(siteId: string, obra: CrawlObra, releases: RawItem[]): Promise<RecordReport>;
}

/** Fábrica: o `deps` parcial completa com os módulos REAIS. */
export function createCrawlRecorder(deps: Partial<CrawlRecorderDeps> = {}): CrawlRecorder {
  const d: CrawlRecorderDeps = {
    captureAndMark: (entered, survivors, indexer, ctx) =>
      captureAndMarkFilter(entered, survivors, indexer, ctx as never),
    flush: () => bank.flushBarrier(),
    lookupQuiet: (imdb, location) => releaseIndex.lookupQuiet(imdb, location),
    isPartial: (imdb, location) => releaseIndex.isPartial(imdb, location),
    record: (imdb, location, items, opts) => releaseIndex.record(imdb, location, items, opts),
    transition: (before, after) => brTransition(before as never, after as never),
    invalidate: (imdb) => invalidateStreamsForObra(imdb),
    buildContext: defaultBuildContext,
    count: (name, value) => metrics.count(name, value),
    ...deps,
  };

  return {
    async record(siteId: string, obra: CrawlObra, releases: RawItem[]): Promise<RecordReport> {
      const context = await d.buildContext(obra);
      if (!context) throw new Error('catalogo-sem-nomes');
      const location = {};
      const ctx = { imdbId: obra.imdb, season: null, episode: null };
      // 1. Filtro de título estrito com o contexto da obra.
      const relevant = filterRelevantRaw(releases, context as never);
      // 2. Banco vivo: capture+filter atômicos (página inteira entra; filtro marca).
      if (!d.captureAndMark(releases, relevant, siteId, ctx)) {
        d.count('crawl.record.queueDropped');
        throw new Error('magnetbank-queue-dropped');
      }
      // 3. Barreira: sem persistência confirmada, a página NÃO marca `done`.
      const flushed = d.flush();
      if (!flushed.ok) {
        d.count('crawl.record.flushFailed');
        throw new Error('magnetbank-flush-falhou');
      }
      // 4. Índice: preserva `partial` existente; obra nova nasce parcial.
      const before = d.lookupQuiet(obra.imdb, location);
      const partial = d.isPartial(obra.imdb, location) || before.length === 0;
      const added = d.record(obra.imdb, location, relevant, { partial, keepPartial: true });
      // 5. Transição BR invalida listas prontas da obra.
      const after = d.lookupQuiet(obra.imdb, location);
      const transition = d.transition(before, after);
      const cleared = transition === 'none' ? 0 : d.invalidate(obra.imdb);
      d.count('crawl.record.added', added);
      if (cleared > 0) d.count('crawl.record.invalidated', cleared);
      return { kept: relevant.length, added, transition, cleared };
    },
  };
}

/** Instância de produção (módulos reais). */
export const recordCrawlReleases = createCrawlRecorder();
