//! Porte de `remainingCheckBudget` (`src/utils/deadline.ts`).
//!
//! Tempo que a checagem de cache pode consumir antes do prazo da resposta,
//! deixando `margin` ms para filtro, assinatura HMAC e serialização.
//! `None` é sem teto (passe tardio usa o timeout completo do adaptador).
//! `Some(0)` é prazo vencido: quem chama degrada na hora para `known:false`.
//!
//! `now` e `margin` são obrigatórios. O default do TS (`Date.now()` e `0`)
//! fica no chamador.

/// Orçamento restante da checagem, em ms.
///
/// `None` quando `deadline_at` é `None`: sem teto (passe tardio).
/// `Some(0)` quando o prazo já venceu (`deadline - now - margin` ≤ 0).
pub fn remaining_check_budget(deadline_at: Option<i64>, now: i64, margin: i64) -> Option<i64> {
    let deadline_at = deadline_at?;
    // i128: a subtração do JS não estoura; em debug o `i64` estouraria.
    let left = i128::from(deadline_at) - i128::from(now) - i128::from(margin);
    Some(i64::try_from(left.max(0)).unwrap_or(i64::MAX))
}
