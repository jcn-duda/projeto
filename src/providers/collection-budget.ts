import config from '../config.js';
import { remainingCheckBudget } from '../utils/deadline.js';

/**
 * Orçamento de coleta dentro do prazo da resposta. Menor que o `replyDeadline`:
 * o resto do tempo é da checagem no debrid, que ainda precisa rodar em cima do
 * que foi coletado.
 *
 * PLANO_MELHORIAS 4.3: o piso de 500ms é intencional, não sobra de fatia fixa.
 * Quando metadados lentos (Cinemeta+TMDB) já corroeram a reserva, o valor
 * calculado fica negativo — sem piso, a coleta abriria mão de tentar e a
 * resposta sairia de bandeja para known:false/lista vazia. Isso NUNCA estoura o
 * `replyDeadline`: o `raceWithDeadline` de `findStreams` corta `doSearch` no
 * relógio absoluto (mesmo `deadlineAt`), independente do que este orçamento
 * interno decide — o pior caso é a resposta chegar ATÉ 500ms mais perto do corte
 * externo, nunca depois dele. Trocar por 0 no lugar do piso não evita esse corte
 * (o relógio externo já protege), só troca uma tentativa de coleta real por
 * known:false garantido — pior para o usuário.
 *
 * `now` é injetável apenas para teste determinístico; em produção é Date.now().
 */
function computeCollectionBudget(deadlineAt: number | null, now = Date.now()): number {
  return deadlineAt == null
    ? Math.max(1000, config.replyDeadline - config.debridReserve)
    : Math.max(500, (remainingCheckBudget(deadlineAt, now) ?? 0) - config.debridReserve);
}

/**
 * Janela extra concedida à primeira fonte BR quando, findado o orçamento, só
 * chegaram globais. A graça sai da reserva, mas nunca invade o piso configurado
 * pro debrid. No caso medido de Disclosure Day, a primeira fonte BR chegava
 * pouco depois dos 5s; sem esta janela a UI ficava para sempre com os globais do
 * passe parcial. Série também precisa dela (medido em A Casa do Dragão: os BR
 * terminavam a 5,9-8,7s e o E01 dublado nunca entrava na primeira resposta) —
 * mas o filtro de "só com itens no balde" (balde vazio cai no fallback de pack)
 * mora no chamador, via `graceRequiresItems`, não aqui: esta função só devolve
 * o número de milissegundos da janela.
 */
function computePriorityGrace(): number {
  return Math.min(
    config.brPartialGrace,
    Math.max(0, config.debridReserve - config.debridCheckFloor),
  );
}

export { computeCollectionBudget, computePriorityGrace };
