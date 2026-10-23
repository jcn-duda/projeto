// ORÁCULO CONGELADO — NÃO É CÓDIGO DE PRODUÇÃO.
//
// Cópia de `src/providers/debrid-pipeline-types.ts` no commit c11cb720 (branch
// rust). O F4.4 remove `debrid-pipeline*`; o oráculo dos testes não pode
// depender desse arquivo. Os dois `import type` apontam para módulos que
// sobrevivem ao corte (observabilidade e trace), e são apagados em runtime.
import type { FirstObserverState } from './first-observer.js';
import type { StreamTraceState } from '../../../src/utils/stream-trace.js';

type WorkHintInput = { n: string[]; y: number | null } | null;

type CacheResultSignal = {
  known: boolean;
  needsFullRefresh: boolean;
  autofetchCount?: number;
  trustDropped?: number;
};

export interface ApplyDebridOptions {
  season?: number | null;
  episode?: number | null;
  imdbId?: string | null;
  searchKey?: string | null;
  deadlineAt?: number | null;
  /** Contagem de episódios por temporada (Cinemeta), para a média do pack. */
  meta?: { episodes?: Record<string, number> } | null;
  /**
   * Só a passada REIVINDICADA como primeira resposta observa as métricas
   * `search.first.*`. Refresh de SWR/background e recaches tardios vêm sem este
   * flag, então não podem inflar a métrica.
   */
  observeFirstPass?: boolean;
  /** Estado marginal do observador de primeira resposta (finalização no
   * `onSelected` do buildStreams mantém brFound/brCached/brHidden/brVisible
   * coerentes num único bloco). */
  firstObserver?: FirstObserverState | null;
  onCacheResult?: (result: CacheResultSignal) => void;
  workHint?: WorkHintInput;
  /** P5 — ledger observacional (criado pelo buildStreams/finish); os cortes do
   * debrid (pré-checagem e cachedOnly) entram nele. null => sem efeito. */
  trace?: StreamTraceState | null;
}
