//! Porte de `src/providers/collection-budget.ts`.
//!
//! As duas funções são PURAS: os valores de config entram por parâmetro (o TS
//! lê `config.*` dentro delas; aqui quem lê é o chamador). O piso é intencional
//! e está documentado no fonte — não "consertar".

use crate::reply_budget::remaining_check_budget;

/// Orçamento de coleta dentro do prazo da resposta. Menor que o
/// `reply_deadline`: o resto do tempo é da checagem no debrid, que ainda precisa
/// rodar em cima do que foi coletado.
///
/// PLANO_MELHORIAS 4.3: o piso de 500ms é intencional, não sobra de fatia fixa.
/// Quando metadados lentos (Cinemeta+TMDB) já corroeram a reserva, o valor
/// calculado fica negativo — sem piso, a coleta abriria mão de tentar e a
/// resposta sairia de bandeja para known:false/lista vazia. Isso NUNCA estoura o
/// `replyDeadline`: o `raceWithDeadline` de `findStreams` corta `doSearch` no
/// relógio absoluto (mesmo `deadline_at`), independente do que este orçamento
/// interno decide — o pior caso é a resposta chegar ATÉ 500ms mais perto do
/// corte externo, nunca depois dele.
///
/// Sem `deadline_at` (passe tardio/sem prazo) o piso é 1000ms e a conta é
/// `reply_deadline - debrid_reserve`.
pub fn compute_collection_budget(
    deadline_at: Option<i64>,
    now: i64,
    reply_deadline: i64,
    debrid_reserve: i64,
) -> i64 {
    match deadline_at {
        None => reply_deadline.saturating_sub(debrid_reserve).max(1000),
        // `?? 0`: sem teto de checagem o restante conta como 0.
        Some(_) => {
            let remaining = remaining_check_budget(deadline_at, now, 0).unwrap_or(0);
            remaining.saturating_sub(debrid_reserve).max(500)
        }
    }
}

/// Janela extra concedida à primeira fonte BR quando, findado o orçamento, só
/// chegaram globais. A graça sai da reserva, mas nunca invade o piso configurado
/// pro debrid. No caso medido de Disclosure Day, a primeira fonte BR chegava
/// pouco depois dos 5s; sem esta janela a UI ficava para sempre com os globais
/// do passe parcial. Série também precisa dela (medido em A Casa do Dragão: os
/// BR terminavam a 5,9-8,7s e o E01 dublado nunca entrava na primeira
/// resposta) — mas o filtro de "só com itens no balde" mora no chamador, via
/// `graceRequiresItems`: esta função só devolve o número de milissegundos.
pub fn compute_priority_grace(
    br_partial_grace: i64,
    debrid_reserve: i64,
    debrid_check_floor: i64,
) -> i64 {
    br_partial_grace.min(debrid_reserve.saturating_sub(debrid_check_floor).max(0))
}
