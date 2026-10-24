// Estado vivo de falha por indexer durante UMA coleta (Etapa 4).
//
// Puro e sem I/O: quem o produz é o `onQueryResult` do `jackett.search`; quem o
// lê é o fallback do banco de magnets no build. Existe por dois motivos:
//
// 1. "Pendente no prazo conta como falho" — no instante da resposta, um indexer
//    que ainda não respondeu é tratado como indisponível e o fallback pode
//    cobri-lo. O estado guarda o `pending` separado do `failed` justamente para
//    o callback TARDIO poder removê-lo: quando a consulta responde (mesmo `[]`
//    válido), o indexer sai do conjunto e a reconstrução do lote deixa de
//    injetar o fallback dele.
// 2. O ramo agregado `/all` não publica falha por indexer: ele emite um evento
//    SINTÉTICO ('*all*'). Em erro, o estado marca `allState='error'` e o
//    fallback deriva os indexers candidatos das SOURCES do banco para a obra —
//    nunca de uma config possivelmente vazia. Resposta VÁLIDA (mesmo vazia) não
//    dispara fallback.
//
// 3. "Vazio suspeito" — resposta VÁLIDA sem nenhum item que passe no filtro de
//    título (`relevant: 0`) não é falha, mas é o sintoma de site que trocou de
//    domínio/layout e passou a devolver vazio (ou a homepage) sem erro. O
//    indexer fica em `empty` e o fallback o cobre SÓ com o acervo que já
//    passou no filtro daquela obra. Qualquer resposta com item relevante na
//    mesma coleta (`served`) desfaz a suspeita.
//
// `ignoreBreaker`/`recordStatus:false` (varredura pt-BR) NÃO alimentam este
// estado: é o chamador que decide onde ligar o `onQueryResult`.

/** Id sintético do ramo agregado `/all`. */
export const ALL_QUERY_INDEXER = '*all*';

/** Motivo objetivo de uma consulta não respondida. */
export type LiveFailReason = 'error' | 'breaker' | 'source';

export interface LiveQueryResult {
  indexer: string;
  responded: boolean;
  reason?: string;
  /** Itens desta consulta que passaram no filtro de título; ausente = não medido. */
  relevant?: number;
}

type AllState = 'unknown' | 'pending' | 'ok' | 'error';

export interface LiveIndexerState {
  /** Consultas vivas ainda em voo (contam como falha até responderem). */
  readonly pending: Set<string>;
  /** Indexers que responderam FALHA (error/breaker/source). */
  readonly failed: Map<string, string>;
  /** Responderam válido mas SEM item relevante (vazio suspeito). */
  readonly empty: Set<string>;
  /** Entregaram ao menos um item relevante nesta coleta. */
  readonly served: Set<string>;
  /** Estado do ramo agregado `/all`. */
  allState(): AllState;
  /** Marca as consultas que estão começando (pending). */
  noteStart(indexers: readonly string[]): void;
  /** Resultado de UMA consulta por indexer. `responded:true` limpa a falha. */
  noteResult(info: LiveQueryResult): void;
  /** Marca o início do ramo agregado `/all`. */
  noteAllStart(): void;
  /** Resultado sintético do `/all`: `true` = resposta válida (não dispara). */
  noteAllResult(responded: boolean): void;
  /** Indexers a cobrir AGORA: falhos + pendentes (pendente conta como falho). */
  failedIndexers(): Set<string>;
  /** O ramo agregado está falho/pendente? Nesse caso todos são candidatos. */
  allFailed(): boolean;
  /** Vazios suspeitos que não falharam: cobertos só com acervo já aprovado. */
  suspectIndexers(): Set<string>;
  /** Há falha PROVADA (por indexer ou agregada)? Vazio suspeito não conta. */
  hasAnyFailure(): boolean;
  /** Falha provada OU vazio suspeito: o banco deve ser consultado/mantido. */
  needsFallback(): boolean;
  /** Sanitiza para teste/log. */
  snapshot(): { failed: string[]; pending: string[]; empty: string[]; all: AllState };
}

export function createLiveIndexerState(): LiveIndexerState {
  const pending = new Set<string>();
  const failed = new Map<string, string>();
  const empty = new Set<string>();
  const served = new Set<string>();
  let all: AllState = 'unknown';

  return {
    pending,
    failed,
    empty,
    served,
    allState: () => all,
    noteStart(indexers) {
      for (const id of indexers || []) {
        const key = String(id || '').toLowerCase();
        if (!key) continue;
        // Já resolvido nesta coleta não volta para pending: o mesmo indexer pode
        // aparecer em tasks diferentes (main + varredura) e a última resposta
        // não pode reabrir a falha.
        if (!failed.has(key)) pending.add(key);
      }
    },
    noteResult(info) {
      const key = String(info?.indexer || '').toLowerCase();
      if (!key) return;
      if (key === ALL_QUERY_INDEXER) {
        all = info.responded ? 'ok' : 'error';
        return;
      }
      pending.delete(key);
      if (info.responded) {
        failed.delete(key);
        if (typeof info.relevant === 'number') {
          if (info.relevant > 0) {
            served.add(key);
            empty.delete(key);
          } else if (!served.has(key)) {
            empty.add(key);
          }
        }
      } else {
        failed.set(key, String(info.reason || 'error'));
      }
    },
    noteAllStart() {
      if (all !== 'ok' && all !== 'error') all = 'pending';
    },
    noteAllResult(responded) {
      all = responded ? 'ok' : 'error';
    },
    failedIndexers() {
      const out = new Set<string>(failed.keys());
      for (const key of pending) out.add(key);
      return out;
    },
    allFailed() {
      return all === 'error' || all === 'pending';
    },
    suspectIndexers() {
      const out = new Set<string>();
      for (const key of empty) if (!failed.has(key) && !pending.has(key)) out.add(key);
      return out;
    },
    hasAnyFailure() {
      return this.failedIndexers().size > 0 || this.allFailed();
    },
    needsFallback() {
      return this.hasAnyFailure() || this.suspectIndexers().size > 0;
    },
    snapshot() {
      return { failed: [...failed.keys()].sort(), pending: [...pending].sort(), empty: [...empty].sort(), all };
    },
  };
}

/**
 * Une o estado de VÁRIAS coletas da mesma obra (resposta prioritária +
 * enriquecimento do índice/pack). O fallback precisa da união: um indexer que
 * falhou só no enriquecimento ainda é uma fonte perdida para aquela obra.
 * `allFailed` vence se qualquer coleta agregada falhou/pendeu.
 */
export function mergeLiveIndexerStates(states: Array<LiveIndexerState | null | undefined>): LiveIndexerState {
  const merged = createLiveIndexerState();
  let all: AllState = 'unknown';
  // Ordem importa: vazios primeiro, depois quem serviu (desfaz a suspeita em
  // qualquer coleta), e só então falhas/pendentes, que vencem os dois.
  for (const state of states) for (const indexer of state?.empty || []) merged.noteResult({ indexer, responded: true, relevant: 0 });
  for (const state of states) for (const indexer of state?.served || []) merged.noteResult({ indexer, responded: true, relevant: 1 });
  for (const state of states) {
    if (!state) continue;
    for (const [indexer, reason] of state.failed) merged.noteResult({ indexer, responded: false, reason });
    for (const indexer of state.pending) merged.noteStart([indexer]);
    const a = state.allState();
    if (a === 'error') all = 'error';
    else if (a === 'pending' && all !== 'error') all = 'pending';
    else if (a === 'ok' && all === 'unknown') all = 'ok';
  }
  if (all === 'error') merged.noteAllResult(false);
  else if (all === 'pending') merged.noteAllStart();
  else if (all === 'ok') merged.noteAllResult(true);
  return merged;
}
