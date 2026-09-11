/** Estado do observador de primeira resposta, por execução de `doSearch`. */
export interface FirstObserverState {
  /** Execução elegível (busca síncrona de requisição real). Pode ser promovida
   * por coalescing prefetch→foreground. */
  eligible: boolean;
  /** A passada first foi reclamada atomicamente no início do `finish`. */
  firstClaimed: boolean;
  /** A passada first CONCLUIU dentro do prazo e teve as métricas finalizadas. */
  firstCounted: boolean;
  maxBrVisible: number;
  /** BR no pool imediatamente antes do applyDebrid (funil), estagiado para a
   * finalização única e coerente das métricas first no `onSelected`. */
  pendingBrFound: number;
  pendingBrCached: number;
  pendingBrHidden: number;
  /** Início da EXECUÇÃO (criação do observador). É a base do timer
   * `search.first.total`: se um prefetch for promovido por coalescing, inclui o
   * head-start anterior à requisição foreground — mede o trabalho frio total,
   * não apenas quanto aquele caller esperou. */
  timingStartedAt: number;
  /** Duração em ms do passo de metadados (Cinemeta+TMDB). Seta-se uma vez; null
   * até o estagio acontecer. */
  pendingMetadata: number | null;
  /** Soma dos envelopes de coleta GLOBAL entre invocações sequenciais de
   * collectRaw (busca por episódio + fallback de pack). null até a primeira
   * coleta global com prazo. */
  pendingGlobal: number | null;
  /** Soma dos envelopes de coleta BR (mesma semântica de acumulação). */
  pendingBr: number | null;
  /** Duração da checagem de debrid do passo de resposta. Seta-se uma vez; null
   * até o `applyDebrid` do passo de resposta rodar. */
  pendingDebrid: number | null;
}

/** Fábrica do estado do observador de primeira resposta, por execução. */
export function createFirstObserver(eligible: boolean): FirstObserverState {
  return {
    eligible,
    firstClaimed: false,
    firstCounted: false,
    maxBrVisible: 0,
    pendingBrFound: 0,
    pendingBrCached: 0,
    pendingBrHidden: 0,
    timingStartedAt: Date.now(),
    pendingMetadata: null,
    pendingGlobal: null,
    pendingBr: null,
    pendingDebrid: null,
  };
}

/**
 * I0 — estagia um trecho de tempo da PRIMEIRA resposta no estado do observador
 * SEM emitir métrica sozinho: os valores só são comitados no `finish` da
 * resposta first, no MESMO denominador de `search.first.responses`. `metadata`
 * e `debrid` SETAM (são passos únicos); `global` e `br` ACUMULAM entre
 * invocações sequenciais de `collectRaw` (episódio + fallback de pack), porque
 * cada invocação é um envelope do início ao fim daquela coleta.
 *
 * Estaga mesmo com `eligible` false de propósito: uma execução de prefetch
 * (background) pode ser promovida a foreground pelo coalescing ANTES do
 * `finish`, e os timers registrados no meio do caminho não podem ser perdidos.
 * Só para de estagiar quando a primeira resposta já foi contada — recaches
 * tardios não podem virar timers first.
 */
export function stageFirstTiming(
  state: FirstObserverState | null | undefined,
  stage: 'metadata' | 'global' | 'br' | 'debrid',
  ms: number,
): void {
  if (!state || state.firstCounted) return;
  if (!Number.isFinite(ms) || ms < 0) return;
  if (stage === 'global' || stage === 'br') {
    const key = stage === 'global' ? 'pendingGlobal' : 'pendingBr';
    state[key] = (state[key] ?? 0) + ms;
  } else {
    const key = stage === 'metadata' ? 'pendingMetadata' : 'pendingDebrid';
    state[key] = ms;
  }
}

/**
 * I0 — classifica uma passada do `finish` como a primeira resposta (fria),
 * um recache tardio (late) ou nada (execução não elegível, ou recache que
 * correu enquanto o first ainda estava em voo e portanto não pode contar).
 * Puro e testável. `late` reporta o DELTA positivo acima do máximo de BR
 * visíveis já visto — nunca o total repetido, então múltiplos recaches não
 * inflam `brLate`. Não expõe dado sensível, apenas números do corte final. A
 * aplicação de métricas e a atualização do estado ficam com quem chama.
 */
export function firstObserverStep(
  state: FirstObserverState | null | undefined,
  opts: { observeFirstPass: boolean; observeLatePass: boolean; brVisible: number },
): { kind: 'none' | 'first' | 'late'; delta: number } {
  if (!state) return { kind: 'none', delta: 0 };
  // Execução não elegível (SWR/background) nunca observa — mesmo que um
  // chamador passasse flags por engano.
  if (state.eligible === false) return { kind: 'none', delta: 0 };
  // A passada first só existe para a reclamada (observeFirstPass) e ainda não
  // contada. Recache antes do first confirmar (firstCounted=false) cai no none.
  if (opts.observeFirstPass && !state.firstCounted) {
    return { kind: 'first', delta: Math.max(0, opts.brVisible) };
  }
  if (opts.observeLatePass && state.firstCounted) {
    return { kind: 'late', delta: Math.max(0, opts.brVisible - (state.maxBrVisible || 0)) };
  }
  return { kind: 'none', delta: 0 };
}

/**
 * I0 — reclama a passada first ATOMICAMENTE no início de uma passada do
 * `finish`, antes de qualquer await/build. Só uma busca síncrona real com prazo
 * de resposta presente (`hasDeadline`) pode; recaches sem prazo NUNCA reclamam.
 * `firstClaimed` é mutado de forma síncrona, fechando a corrida de um recache
 * que terminasse antes do first confirmar (esse recache só conta late quando o
 * first CONCLUI com `firstCounted`). Puro e testável.
 */
export function firstObserverClaim(
  state: FirstObserverState | null | undefined,
  hasDeadline: boolean,
): { observeFirstPass: boolean; observeLatePass: boolean } {
  if (!state) return { observeFirstPass: false, observeLatePass: false };
  let observeFirstPass = false;
  let observeLatePass = false;
  if (hasDeadline && state.eligible && !state.firstClaimed) {
    state.firstClaimed = true;
    observeFirstPass = true;
  } else if (!hasDeadline && state.firstCounted) {
    observeLatePass = true;
  }
  return { observeFirstPass, observeLatePass };
}

/**
 * I0 — promove a elegibilidade da primeira resposta de uma execução em voo
 * quando uma REQUISIÇÃO REAL (foreground) coalesce sobre uma busca de
 * pré-aquecimento (background). Um coalescing foreground→background é um no-op:
 * a background NÃO desce o eligible já promovido. Nunca toca `firstClaimed` nem
 * contadores — só autoriza a passada first a ser reclamada depois.
 */
export function promoteFirstObserverEligible(
  state: FirstObserverState | null | undefined,
  foreground: boolean,
): void {
  if (!state || !foreground) return;
  state.eligible = true;
}
