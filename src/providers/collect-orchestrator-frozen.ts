// Fachada do replay congelado (Fase 1) da coleta.
//
// O corpo real continua em `collectRawLive`; aqui só se decide entre executar a
// coleta e devolver o lote gravado. A chave inclui query/escopo porque a MESMA
// busca chama a coleta várias vezes (principal, pack, varredura pt-BR).
//
// Fica em arquivo próprio para a catraca de linhas (400): o reexport em
// `collect-orchestrator.ts` mantém o caminho público dos callers.
import type { MatchContext } from '../../types/domain.js';
import type { FirstObserverState } from './stream-builder.js';
import type { StreamTraceState } from '../utils/stream-trace.js';
import type { LiveIndexerState } from './live-indexer-state.js';
import * as frozen from '../utils/stream-frozen.js';
import { collectRawLive } from './collect-orchestrator.js';

export async function collectRaw(
  query: string,
  type: string,
  imdbId: string,
  ptQuery: string | null,
  matchContext: MatchContext,
  onLate: ((items: any[], grew: boolean, partial?: boolean, live?: LiveIndexerState | null) => any) | null,
  sweepQuery: string | null = null,
  deadlineAt: number | null = null,
  taskScope: 'all' | 'priority' | 'nonpriority' = 'all',
  firstObserver?: FirstObserverState | null,
  trace?: StreamTraceState | null,
  originalQuery: string | null = null,
  multiWorkQuery: string | null = null,
  skipSources: ReadonlySet<string> = new Set(),
  readOnly = false,
  indexersOverride: string[] | null = null,
) {
  return frozen.aroundCollect(
    {
      imdb: imdbId,
      type,
      season: matchContext?.season ?? null,
      episode: matchContext?.episode ?? null,
      scope: taskScope,
      query,
      ptQuery,
    },
    () => collectRawLive(
      query, type, imdbId, ptQuery, matchContext, onLate, sweepQuery, deadlineAt,
      taskScope, firstObserver, trace, originalQuery, multiWorkQuery, skipSources,
      readOnly, indexersOverride,
    ),
  );
}
