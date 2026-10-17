/**
 * Casca fina das decisões PURAS do fim da busca — a regra vive em
 * `adom_core::search_finish` (napi `commitDecision`, `latePromotionDecision`,
 * `debridRefreshSatisfied`, `staleRefreshEligible`). Nada de fallback: o núcleo
 * é obrigatório.
 *
 * O módulo DEIXOU de ser folha quando a decisão saiu daqui: o oráculo do golden
 * é o TypeScript autoritativo do worktree `../adom-esm`
 * (`npm run golden:search-commit:check`), e este arquivo só transporta fatos.
 * Igual às outras cascas, o núcleo não lê `config`, cache nem relógio.
 *
 * `debridKnown: undefined` é um estado REAL (a checagem no debrid nunca
 * respondeu) e vale "desconhecido", não "falso": cruza como `null` e o núcleo
 * lê o campo para decidir se a lista pode ser promovida a completa.
 */
import { nativeCore } from '../utils/native-core.js';
import { coreJson } from '../utils/native-json.js';

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

/** Superfície do núcleo que esta casca consome. */
interface FinishCore {
  commitDecision(inputJson: string): string;
  latePromotionDecision(inputJson: string): string;
  debridRefreshSatisfied(entryJson: string | null): boolean;
  staleRefreshEligible(entryJson: string | null, playable: boolean): boolean;
}

function core(): FinishCore {
  return nativeCore<FinishCore>();
}

/**
 * Entry do cache → JSON do núcleo; `null` é "sem entrada". Só os DOIS campos
 * que a régua lê (`partial`, `debridKnown`) cruzam: o entry inteiro carrega a
 * lista de streams e custaria a travessia de KBs no hit stale do SWR.
 */
function entryJson(entry: any): string | null {
  if (entry == null) return null;
  return coreJson({ partial: entry.partial, debridKnown: entry.debridKnown });
}

/**
 * Lista completa = tocável + coleta encerrada + debrid conferido + sem reserva.
 * Só a lista completa ganha o TTL cheio; o resto fica no TTL curto de 60 s para
 * a próxima abertura ter chance de reconsultar o vivo.
 */
function commitDecision(facts: CommitFacts): CommitDecision {
  return JSON.parse(core().commitDecision(coreJson({
    playable: facts.playable,
    partial: facts.partial,
    // `undefined` é estado REAL: cruza como `null`, o mesmo par do `None` Rust.
    debridKnown: facts.debridKnown === undefined ? null : facts.debridKnown,
    needsDebridRefresh: facts.needsDebridRefresh,
    hasFallback: facts.hasFallback,
    cacheTtl: facts.cacheTtl,
    fallbackStreamsTtl: facts.fallbackStreamsTtl,
  }))) as CommitDecision;
}

/**
 * Os degraus anteriores (`grew` → reconstruir; `partial` → nada; fase
 * divergente → nada) ficam no chamador porque ele só pode LER o cache depois
 * deles: `cache.get` apaga entrada expirada, e apagar num caso em que o TS
 * antigo nem consultava mudaria o comportamento.
 */
function latePromotionDecision(facts: LateFacts): LateDecision {
  // Curto-circuito PRESERVADO: o estado vivo só é perguntado no ramo que o
  // núcleo vai ler (`needsFallback` na reserva, `hasAnyFailure` na lista
  // vazia). O outro lado vai `false`; um stub sem uma das perguntas segue
  // válido, como no TS antigo (e o Rust nem lê o campo do outro ramo).
  let live: { needsFallback: boolean; hasAnyFailure: boolean } | null = null;
  if (facts.live && facts.hitPartial) {
    if (facts.hitFallback) {
      live = { needsFallback: facts.live.needsFallback(), hasAnyFailure: false };
    } else if (!facts.hitHasStreams) {
      live = { needsFallback: false, hasAnyFailure: facts.live.hasAnyFailure() };
    } else {
      live = { needsFallback: false, hasAnyFailure: false };
    }
  }
  return JSON.parse(core().latePromotionDecision(coreJson({
    hitPartial: facts.hitPartial,
    hitFallback: facts.hitFallback,
    hitHasStreams: facts.hitHasStreams,
    hitDebridKnown: facts.hitDebridKnown,
    live,
    cacheTtl: facts.cacheTtl,
  }))) as LateDecision;
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
  return core().debridRefreshSatisfied(entryJson(entry));
}

/**
 * O SWR só serve o que o `finish` promoveria a completa **e** que tem play de
 * verdade: aviso e parcial estenderiam o estado ruim em vez de consertá-lo.
 * `playable` vem do chamador (`hasPlayableStream`) para o teste ser o MESMO dos
 * dois lados.
 */
function staleRefreshEligible(entry: any, playable: boolean): boolean {
  return core().staleRefreshEligible(entryJson(entry), playable);
}

export { commitDecision, latePromotionDecision, debridRefreshSatisfied, staleRefreshEligible };
export type { CommitFacts, CommitDecision, LateFacts, LateDecision, LateAction };
