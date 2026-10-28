// Tipos do pipeline de debrid congelado. Só o `dub-audit` do oráculo consome
// `ApplyDebridOptions` (o tail de áudio de produção é nativo desde a T3-L7a),
// por isso o tipo saiu de `src/providers/`.
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
  onCacheResult?: (result: CacheResultSignal) => void;
  workHint?: WorkHintInput;
  /** P5 — ledger observacional (criado pelo buildStreams/finish); os cortes do
   * debrid (pré-checagem e cachedOnly) entram nele. null => sem efeito. */
  trace?: StreamTraceState | null;
}
