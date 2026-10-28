//! Transições puras de recheck. Rede, timers e persistência pertencem ao worker.
//!
//! Duas escalas: por HASH ([`recheck_step`], com prova de posse na expiração) e
//! por LOTE ([`lot_outcome`], com o settle e o LRU). `unknown` nunca é prova de
//! morte — só ausência de resposta, que mantém os contadores como estão.

use adom_core::{expired_removal_allowed, ExpiredFacts};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecheckAction {
    Ready,
    Pending,
    Unknown,
    TerminalDead,
    TerminalStalled,
    TerminalProgress,
    RemoveExpired,
    SuppressExpired,
    ReleaseExpired,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecheckInput {
    pub cached: bool,
    pub status_ok: bool,
    pub state: Option<String>,
    pub stalled: bool,
    pub derived_stalled: bool,
    pub dead_streak: i64,
    pub stall_streak: i64,
    pub dead_threshold: i64,
    pub stall_threshold: i64,
    pub expired: bool,
    pub expired_facts: ExpiredFacts,
    pub remove_supported: bool,
    /// O status desse hash veio por id (`via === 'id'`), não por hash.
    pub via_id: bool,
    /// Knob `removeById`: só ele libera remover um torrent achado por id.
    pub remove_by_id_enabled: bool,
    pub id_present: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecheckStreaks {
    pub dead: i64,
    pub stalled: i64,
}

/// Atualiza contadores como a passagem do Node: morte e stall nativo têm
/// contadores independentes; falta de resposta mantém ambos. Um estado
/// observado sem sinal de morte/parada zera ambos, inclusive `unknown`
/// explícito do adaptador. Progresso derivado terminal limpa o lote fora daqui.
pub fn recheck_streaks(input: &RecheckInput) -> RecheckStreaks {
    let mut streaks = RecheckStreaks {
        dead: input.dead_streak,
        stalled: input.stall_streak,
    };
    if input.cached || input.state.as_deref() == Some("ready") {
        return RecheckStreaks {
            dead: 0,
            stalled: 0,
        };
    }
    if input.state.as_deref() == Some("dead") {
        streaks.dead = streaks.dead.saturating_add(1);
    } else if input.stalled && input.stall_threshold > 0 {
        streaks.stalled = streaks.stalled.saturating_add(1);
    } else if !input.derived_stalled && input.status_ok && input.state.is_some() {
        streaks = RecheckStreaks {
            dead: 0,
            stalled: 0,
        };
    }
    streaks
}

/// Aplica a precedência do recheck: cache/pronto, morte/parada e, por fim,
/// expiração com prova de posse. Um status desconhecido nunca é prova de morte.
pub fn recheck_step(input: &RecheckInput) -> RecheckAction {
    if input.cached || input.state.as_deref() == Some("ready") {
        return RecheckAction::Ready;
    }
    let dead = input.state.as_deref() == Some("dead");
    let native_stalled = !dead && input.stalled && input.stall_threshold > 0;
    if dead && input.dead_streak.saturating_add(1) >= input.dead_threshold.max(1) {
        return RecheckAction::TerminalDead;
    }
    if native_stalled && input.stall_streak.saturating_add(1) >= input.stall_threshold {
        return RecheckAction::TerminalStalled;
    }
    if !dead && !native_stalled && input.derived_stalled {
        return RecheckAction::TerminalProgress;
    }
    if input.expired {
        if !input.remove_supported || !input.id_present {
            return RecheckAction::ReleaseExpired;
        }
        // `policyOk` do TS: achado por hash remove sempre; por id, só com o knob.
        let policy_ok = !input.via_id || input.remove_by_id_enabled;
        if policy_ok && expired_removal_allowed(&input.expired_facts) {
            return RecheckAction::RemoveExpired;
        }
        return RecheckAction::SuppressExpired;
    }
    if !input.status_ok || input.state.is_none() {
        return RecheckAction::Unknown;
    }
    RecheckAction::Pending
}

/// Fatos do LOTE ao fim de uma varredura, já sem os hashes resolvidos.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LotFacts {
    /// Hashes ainda no lote.
    pub remaining: usize,
    pub is_settle: bool,
    pub attempts: i64,
    /// `autoFetchRecheckMax` efetivo.
    pub recheck_max: i64,
    /// `now - createdAt`, medido por quem tem relógio.
    pub age_ms: i64,
    /// Horizonte de settle já multiplicado (`autoFetchTtl * 1000`).
    pub settle_horizon_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LotOutcome {
    /// Lote assentou: `dropQueue` da busca. Só acontece com o lote vazio.
    Finished,
    /// Settle vencido: expira hash a hash, com prova de posse.
    Expired,
    /// Entrou em settle AGORA: roda o LRU e NÃO drena a fila.
    EnterSettle,
    /// Segue armado para a próxima passagem.
    Continue,
}

/// Ordem do `runRecheck` do Node, preservada: fim de lote, expiração do settle,
/// entrada em settle, continuação.
///
/// Entrar em settle NUNCA drena fila alguma: só evidência COMPROVADA repõe
/// (morto/parado nativo ou parada derivada). "Estar em settle" como motivo de
/// dreno era o dreno cego removido na Fase 0 e não volta por aqui.
pub fn lot_outcome(facts: LotFacts) -> LotOutcome {
    if facts.remaining == 0 {
        return LotOutcome::Finished;
    }
    if facts.is_settle && facts.age_ms >= facts.settle_horizon_ms {
        return LotOutcome::Expired;
    }
    if !facts.is_settle && facts.attempts >= facts.recheck_max {
        return LotOutcome::EnterSettle;
    }
    LotOutcome::Continue
}

/// Lote em estabilização visto pelo LRU (`manageSettleLru`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettleLotRef {
    pub search_key: String,
    pub created_at: i64,
    pub info_hashes: Vec<String>,
    /// Só lotes JÁ em settle entram no LRU; os demais passam intactos.
    pub is_settle: bool,
    /// Adapter DONO do lote, gravado no enqueue/recheck. A evicção usa ESTE id —
    /// nunca o adapter "corrente", que no contexto de outra request pode ser
    /// outro serviço e deixaria a memória de progresso do lote para trás. Vazio
    /// = limpeza impossível (não inventa chave).
    pub adapter_id: String,
}

/// Quais lotes em settle saem quando o número passa de `max_lots`.
///
/// Evicta os mais ANTIGOS primeiro (ordem de `createdAt`, estável como o `sort`
/// do Node). Cada lote devolvido deve ter o timer limpo, os holds liberados e a
/// memória de progresso limpa com o PRÓPRIO `adapter_id`, antes do delete —
/// sem isso o lote settleado ocuparia vaga e hold até o TTL.
pub fn settle_lru_evictions(lots: &[SettleLotRef], max_lots: usize) -> Vec<SettleLotRef> {
    let mut settle: Vec<&SettleLotRef> = lots.iter().filter(|lot| lot.is_settle).collect();
    if settle.len() <= max_lots {
        return Vec::new();
    }
    settle.sort_by_key(|lot| lot.created_at);
    let excess = settle.len() - max_lots;
    settle.into_iter().take(excess).cloned().collect()
}

#[cfg(test)]
#[path = "recheck_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "recheck_lot_tests.rs"]
mod lot_tests;
