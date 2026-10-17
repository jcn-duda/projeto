/**
 * Casca fina de `search-plan` — a decisão vive em `adom_core::search_plan`
 * (napi `planJackettQueries`/`liveIndexers`/`ptSweepIndexers`/
 * `ptSweepQueryFor`/`dubbedSweepQueryFor`). Nada de fallback aqui: o núcleo é
 * obrigatório.
 *
 * POR QUÊ (as decisões medidas que o núcleo preserva):
 *
 * - Quem estoura o orçamento de coleta não pode compartilhar Promise: um
 *   NerdFilmes de 7,4s segurava o BLUDV (e um redetorrent de 20s segurava o
 *   TPB) fora do balde até depois dos ~6,5s. Globais de teto curto continuam
 *   agrupados — cabem no prazo. `ptBrIndexers` só decide a query em pt-BR.
 * - A varredura pt-BR tem DOIS caminhos: inline (`recordStatus:false`, respeita
 *   o breaker) e tardia (`ignoreBreaker:true`). A task inline é marca
 *   ESTRUTURAL (`sweep:true`), não comparação de texto — uma task BR isolada
 *   cuja query coincide com a raiz da varredura continua sendo consulta
 *   PRINCIPAL e precisa alimentar `onQueryResult`/status.
 * - Index-only ficam fora do plano ao vivo (a exceção `exempt` mantém o 1337x):
 *   latência de 8–31s contra orçamento de 20s, e a busca ao vivo serve do
 *   índice. `ptSweepIndexers` também os exclui.
 * - Ver `rust/crates/adom-core/src/search_plan.rs` para a regra completa; o
 *   golden `search-plan` bate caso a caso com o TS do branch `esm`.
 */
import { nativeCore } from '../utils/native-core.js';

interface SearchPlanTask {
  query: string;
  indexers: string[];
  /** Grafia arábica da sequência (só no indexer BR). */
  variant?: string;
  /** Query original como fallback (só BR+ptQuery). */
  fallback?: string;
  /** Raiz da franquia, degrau após o título sem ano (só BR com sequência). */
  franchise?: string;
  /**
   * Título original da obra (TMDB), degrau de último recurso. A regra de quem o
   * executa (queryIndexer): global recebe sempre; BR só sem fallback pt-BR.
   */
  original?: string;
  /** Raiz da coleção multiobra (TMDB), degrau SEQUENCIAL só no indexer BR. */
  multiWork?: string;
  /** Marca ESTRUTURAL da task de varredura pt-BR agrupada (só os globais). */
  sweep?: boolean;
}

/** Superfície do núcleo que esta casca consome. */
interface SearchPlanCore {
  planJackettQueries(input: string): string;
  liveIndexers(input: string): string;
  ptSweepIndexers(input: string): string;
  ptSweepQuery(titlePt: string | null): string;
  ptSweepQueryFor(input: string): string | null;
  dubbedSweepQueryFor(input: string): string | null;
}

function core(): SearchPlanCore {
  return nativeCore<SearchPlanCore>();
}

function planJackettQueries(
  query: string,
  ptQuery: string | null,
  selectedIndexers: string[],
  ptBrIndexers: string[],
  isolateIndexers: string[] = [],
  sweepQuery: string | null = null,
  originalQuery: string | null = null,
  multiWorkQuery: string | null = null,
): SearchPlanTask[] {
  return JSON.parse(core().planJackettQueries(JSON.stringify({
    query,
    ptQuery,
    selectedIndexers,
    ptBrIndexers,
    isolateIndexers,
    sweepQuery,
    originalQuery,
    multiWorkQuery,
  }))) as SearchPlanTask[];
}

function ptSweepIndexers(
  selectedIndexers: string[],
  ptBrIndexers: string[],
  indexOnlyIndexers: string[] = [],
): string[] {
  return JSON.parse(core().ptSweepIndexers(JSON.stringify({
    selectedIndexers,
    ptBrIndexers,
    indexOnlyIndexers,
  }))) as string[];
}

function liveIndexers(
  selectedIndexers: string[],
  indexOnlyIndexers: string[] = [],
  exemptIndexers: string[] = [],
): string[] {
  return JSON.parse(core().liveIndexers(JSON.stringify({
    selectedIndexers,
    indexOnlyIndexers,
    exemptIndexers,
  }))) as string[];
}

function ptSweepQuery(titlePt: string | null | undefined): string {
  // A raiz pt é a MESMA do inventário da conta (`franchiseRoot` no núcleo);
  // duplicar a regra faria os dois caminhos divergirem. Sem o gate de
  // `ptSweepQueryFor` ("pt difere do original").
  return core().ptSweepQuery(titlePt ?? null);
}

function ptSweepQueryFor({ titles }: { titles?: any }): string | null {
  return core().ptSweepQueryFor(JSON.stringify({ titles: titles ?? null }));
}

function dubbedSweepQueryFor({ titles }: { titles?: any }): string | null {
  return core().dubbedSweepQueryFor(JSON.stringify({ titles: titles ?? null }));
}

export { planJackettQueries, ptSweepIndexers, ptSweepQuery, ptSweepQueryFor, dubbedSweepQueryFor, liveIndexers };
