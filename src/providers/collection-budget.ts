/**
 * Casca fina de `collection-budget` — a decisão vive em
 * `adom_core::collection_budget` (napi `computeCollectionBudget`/
 * `computePriorityGrace`). O TS continua lendo `config.*` (é config do
 * operador, não regra) e passa os números; nada de fallback: o núcleo é
 * obrigatório.
 *
 * POR QUÊ (as decisões medidas que o núcleo preserva):
 *
 * - Orçamento de coleta menor que o `replyDeadline`: o resto do tempo é da
 *   checagem no debrid, que ainda roda em cima do que foi coletado.
 * - PLANO_MELHORIAS 4.3: o piso de 500ms é INTENCIONAL, não sobra de fatia
 *   fixa. Com metadados lentos (Cinemeta+TMDB) corroendo a reserva o valor
 *   calculado fica negativo; sem piso a coleta abriria mão de tentar e a
 *   resposta sairia de bandeja para known:false/lista vazia. Nunca estoura o
 *   `replyDeadline`: o `raceWithDeadline` corta `doSearch` no relógio absoluto,
 *   então o pior caso é a resposta chegar ATÉ 500ms mais perto do corte
 *   externo, nunca depois dele.
 * - A graça BR sai da reserva, mas nunca invade o piso configurado pro debrid
 *   (`debridCheckFloor`). O filtro de "só com itens no balde" fica no chamador
 *   (`graceRequiresItems`), não aqui.
 */
import config from '../config.js';
import { nativeCore } from '../utils/native-core.js';

/** Superfície do núcleo que esta casca consome. */
interface CollectionBudgetCore {
  computeCollectionBudget(
    deadlineAt: number | null,
    now: number,
    replyDeadline: number,
    debridReserve: number,
  ): number;
  computePriorityGrace(
    brPartialGrace: number,
    debridReserve: number,
    debridCheckFloor: number,
  ): number;
}

function core(): CollectionBudgetCore {
  return nativeCore<CollectionBudgetCore>();
}

/**
 * `now` é injetável apenas para teste determinístico; em produção é Date.now().
 */
function computeCollectionBudget(deadlineAt: number | null, now = Date.now()): number {
  return core().computeCollectionBudget(
    deadlineAt ?? null,
    now,
    config.replyDeadline,
    config.debridReserve,
  );
}

/** Janela extra da primeira fonte BR quando só chegaram globais (ms). */
function computePriorityGrace(): number {
  return core().computePriorityGrace(
    config.brPartialGrace,
    config.debridReserve,
    config.debridCheckFloor,
  );
}

export { computeCollectionBudget, computePriorityGrace };
