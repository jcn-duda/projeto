// Gravação da raspagem (plano "Raspagem total", Fase 3) — SÓ no caminho
// `CRAWL_DRY_RUN=false`. Reutiliza o fluxo existente da busca/colheita em vez
// de criar um paralelo (decisão `crawl.ingestion_reuse`): banco vivo
// (`captureItems`), filtro de título (`filterRelevantRaw` com o `matchContext`
// da obra), marcação de `passed_filter` (`markFilterResult`), índice de
// releases (`releaseIndex.record`) e a invalidação de listas prontas quando o
// índice passa a cobrir BR dublado (`brTransition` → `invalidateStreamsForObra`).
//
// Duas travas de desenho:
//
//   - `partial` do índice PRESERVA o registro existente e marca `true` quando
//     a obra ainda não tinha registro (mesma régua da sonda dirigida): uma
//     página de site não é cobertura completa da obra no índice, então ela não
//     pode destravar o fast-path como se cobrisse tudo.
//   - o `matchContext` vem do CATÁLOGO (Cinemeta/TMDB pelo IMDb já
//     identificado), nunca do título cru da página: é ele que dá a precisão do
//     filtro contra releases de outra obra no mesmo post (o caso "O Corvo The
//     Crow e Dual"). Sem nomes de catálogo, a gravação é RECUSADA (erro
//     retentável do motor) — admitir tudo seria contaminar o índice.
//
// Os colaboradores são injetáveis (fábrica) porque os módulos são namespaces
// ESM congelados: o teste prova o fio com dublês sem depender de patch de
// módulo. A instância de produção usa os módulos reais.
import { getMeta } from '../utils/cinemeta.js';
import * as tmdb from '../utils/tmdb.js';
import * as bank from '../utils/magnet-bank.js';
import * as releaseIndex from '../utils/release-index.js';
import { brTransition, invalidateStreamsForObra } from '../utils/br-gap.js';
import { extractInfoHash, filterRelevantRaw, resolveSearchNames } from '../utils/format.js';
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
  captureItems(items: readonly RawItem[], indexer: string, ctx: Record<string, unknown>): void;
  markFilterResult(
    all: Iterable<string>, surviving: Iterable<string>, ctx: Record<string, unknown>,
  ): void;
  lookupQuiet(imdb: string, location: { season?: number | null; episode?: number | null }): unknown[];
  isPartial(imdb: string, location: { season?: number | null; episode?: number | null }): boolean;
  record(
    imdb: string,
    location: { season?: number | null; episode?: number | null },
    items: unknown[],
    opts: { partial?: boolean },
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

/** Hashes de conteúdo de uma leva (o que o banco e o filtro indexam). */
function hashesOf(items: readonly RawItem[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(items) ? items : []) {
    const hash = String(extractInfoHash(item?.infoHash || item?.magnet || '') || '').toLowerCase();
    if (hash && !seen.has(hash)) {
      seen.add(hash);
      out.push(hash);
    }
  }
  return out;
}

export interface CrawlRecorder {
  record(siteId: string, obra: CrawlObra, releases: RawItem[]): Promise<RecordReport>;
}

/** Fábrica: o `deps` parcial completa com os módulos REAIS. */
export function createCrawlRecorder(deps: Partial<CrawlRecorderDeps> = {}): CrawlRecorder {
  const d: CrawlRecorderDeps = {
    captureItems: (items, indexer, ctx) => bank.captureItems(items, indexer, ctx as never),
    markFilterResult: (all, surviving, ctx) => bank.markFilterResult(all, surviving, ctx as never),
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
      // 1. Banco vivo: a página inteira entra ANTES do filtro (mesma régua da
      //    busca — o acervo guarda o que o site devolveu, o filtro só marca).
      d.captureItems(releases, siteId, { imdbId: obra.imdb, season: null, episode: null });
      // 2. Filtro de título estrito com o contexto da obra.
      const relevant = filterRelevantRaw(releases, context as never);
      // 3. `passed_filter`: as duas levas, como o stream-builder faria.
      d.markFilterResult(hashesOf(releases), hashesOf(relevant), {
        imdbId: obra.imdb, season: null, episode: null,
      });
      // 4. Índice: preserva `partial` existente; obra nova nasce parcial.
      const before = d.lookupQuiet(obra.imdb, location);
      const partial = d.isPartial(obra.imdb, location) || before.length === 0;
      const added = d.record(obra.imdb, location, relevant, { partial });
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
