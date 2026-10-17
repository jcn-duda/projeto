/**
 * Decisões PURAS do fim da busca: o que gravar no cache (`commitDecision`), o
 * que fazer quando a coleta tardia termina (`latePromotionDecision`) e quando a
 * entrada cacheada pode ser servida velha (`staleRefreshEligible`).
 *
 * Extraído de `search-orchestrator.ts` (`finish`) e `search-late-promoter.ts`
 * sem mudar comportamento: até aqui essas regras eram closures sobre `config`,
 * `cache` e o writer, e por isso não tinham oráculo possível — nem golden. Com
 * elas em funções sem efeito, o TS vira oráculo (`dist`, golden) e o núcleo
 * Rust assume a decisão (`adom-core::search_finish`).
 *
 * O módulo é folha de propósito: NENHUM import. Quem lê o cache, a config e o
 * relógio é o chamador, que passa os fatos prontos. `undefined` em
 * `debridKnown` é um estado REAL (a checagem no debrid nunca respondeu) e vale
 * "desconhecido", não "falso": o `finish` o lê para decidir se a lista pode ser
 * promovida a completa.
 */

/** Fatos do `finish` que decidem a gravação. */
interface CommitFacts {
  /** `hasPlayableStream(streams)`: a lista tem url ou infoHash de verdade. */
  playable: boolean;
  /** Parcial de COLETA (fontes lentas ainda não chegaram). */
  partial: boolean;
  /** `undefined` = a checagem no debrid nunca respondeu. */
  debridKnown: boolean | undefined;
  /** O debrid sinalizou que a checagem precisa ser refeita. */
  needsDebridRefresh: boolean;
  /** A lista carrega reserva (fallback do banco ou foto 📦 do índice). */
  hasFallback: boolean;
  cacheTtl: number;
  fallbackStreamsTtl: number;
}

interface CommitDecision {
  /** `false` = não grava nada (cache desligado para reserva). */
  write: boolean;
  /** TTL em segundos da entrada, quando `write`. */
  ttl: number;
  /** `partial` GRAVADO: reserva é sempre parcial, por definição. */
  partial: boolean;
  /** `debridKnown` a gravar (o mesmo que entra em `complete`). */
  debridKnown: boolean;
}

/**
 * Lista completa = tocável + coleta encerrada + debrid conferido + sem reserva.
 * Só a lista completa ganha o TTL cheio; o resto fica no TTL curto de 60 s para
 * a próxima abertura ter chance de reconsultar o vivo.
 */
function commitDecision(facts: CommitFacts): CommitDecision {
  const debridKnown = facts.debridKnown !== undefined
    ? Boolean(facts.debridKnown && !facts.needsDebridRefresh)
    : !facts.needsDebridRefresh;
  const complete = facts.playable && !facts.partial && debridKnown && !facts.hasFallback;
  // TTL da reserva RESPEITA o CACHE_TTL: cache desligado (<=0) não grava, e o
  // teto nunca passa do TTL normal (o menor dos dois vence).
  const fallbackTtl = Math.min(facts.cacheTtl, facts.fallbackStreamsTtl);
  if (facts.hasFallback && fallbackTtl <= 0) {
    return { write: false, ttl: 0, partial: true, debridKnown };
  }
  const ttl = facts.hasFallback
    ? fallbackTtl
    : complete
      ? facts.cacheTtl
      : Math.min(facts.cacheTtl, 60);
  return { write: true, ttl, partial: facts.hasFallback ? true : facts.partial, debridKnown };
}

/** O que fazer com a entrada quando a coleta tardia termina sem novidade. */
type LateAction = 'promote' | 'forget' | 'none';

/**
 * Visão só-leitura do estado dos indexers vivos. As duas perguntas são MÉTODOS
 * (e não booleanos) de propósito: o TS antigo só chamava `needsFallback()` no
 * ramo da reserva e só chamava `hasAnyFailure()` no ramo da lista vazia. Um
 * stub de teste (ou um estado caro) que não implemente uma delas continua
 * funcionando — desde que a chamada fique no ramo certo.
 */
interface LateLive {
  needsFallback(): boolean;
  hasAnyFailure(): boolean;
}

interface LateFacts {
  /** `hit.partial` da entrada cacheada. */
  hitPartial: boolean;
  /** `hit.fallback` — a entrada nasceu de reserva do banco. */
  hitFallback: boolean;
  /** `hit.streams.length > 0`. */
  hitHasStreams: boolean;
  /** `hit.debridKnown === true`. */
  hitDebridKnown: boolean;
  /** Estado dos indexers vivos, ou `null` (busca sem coleta ao vivo). */
  live: LateLive | null;
  cacheTtl: number;
}

interface LateDecision {
  action: LateAction;
  /**
   * Motivo estável da decisão — o chamador loga esta string em vez de repetir a
   * condição, e o Rust grava o MESMO texto no log da busca.
   */
  reason: 'entrada_nao_parcial' | 'reserva_viva' | 'sem_resposta_dos_indexers' | 'reserva_invalida' | 'promover';
  /** TTL quando `promote`. */
  ttl: number;
  /** `debridKnown` a gravar quando `promote`. */
  debridKnown: boolean;
}

/**
 * Os degraus anteriores (`grew` → reconstruir; `partial` → nada; fase
 * divergente → nada) ficam no chamador porque ele só pode LER o cache depois
 * deles: `cache.get` apaga entrada expirada, e apagar num caso em que o TS
 * antigo nem consultava mudaria o comportamento.
 *
 * Aqui ficam os ramos que dependem do que foi lido:
 * - reserva sem falha viva → invalidar (`forget`), a próxima abertura reconstrói;
 * - reserva com falha viva → manter o TTL curto (`none`);
 * - lista vazia com indexer falho → `none` (vazio não é "sem resultado", é "sem
 *   resposta"; promover congelaria o vazio por CACHE_TTL);
 * - resto → `promote`, sem refazer a checagem do debrid: `debridKnown` é
 *   copiado como está, porque promessa de completude da COLETA não é promessa
 *   de ⚡.
 */
function latePromotionDecision(facts: LateFacts): LateDecision {
  const none = (reason: LateDecision['reason']): LateDecision => ({
    action: 'none', reason, ttl: 0, debridKnown: facts.hitDebridKnown,
  });
  if (!facts.hitPartial) return none('entrada_nao_parcial');
  if (facts.hitFallback) {
    return facts.live && !facts.live.needsFallback()
      ? { action: 'forget', reason: 'reserva_invalida', ttl: 0, debridKnown: facts.hitDebridKnown }
      : none('reserva_viva');
  }
  if (!facts.hitHasStreams && facts.live?.hasAnyFailure()) return none('sem_resposta_dos_indexers');
  return {
    action: 'promote',
    reason: 'promover',
    ttl: facts.hitDebridKnown ? facts.cacheTtl : Math.min(facts.cacheTtl, 60),
    debridKnown: facts.hitDebridKnown,
  };
}

/**
 * O refresh sem teto (do passe tardio) só pode ser dispensado quando a entrada
 * nasceu de uma checagem CONFIÁVEL do debrid. `partial:false` sozinho não prova
 * isso: ele diz que a coleta acabou, não que alguém perguntou ao debrid.
 *
 * Entrada antiga (gravada antes do campo existir) não tem `debridKnown` e cai
 * em `false` de propósito: paga UMA checagem tardia e se corrige sozinha.
 */
function debridRefreshSatisfied(entry: any): boolean {
  return Boolean(entry && entry.partial === false && entry.debridKnown === true);
}

/**
 * O SWR só serve o que o `finish` promoveria a completa **e** que tem play de
 * verdade: aviso e parcial estenderiam o estado ruim em vez de consertá-lo.
 * `playable` vem do chamador (`hasPlayableStream`) para este módulo continuar
 * sem import e para o teste ser o MESMO dos dois lados.
 */
function staleRefreshEligible(entry: any, playable: boolean): boolean {
  return debridRefreshSatisfied(entry) && playable;
}

export { commitDecision, latePromotionDecision, debridRefreshSatisfied, staleRefreshEligible };
export type { CommitFacts, CommitDecision, LateFacts, LateDecision, LateAction };
