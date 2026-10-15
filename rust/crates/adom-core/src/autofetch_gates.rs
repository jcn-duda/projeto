//! Porte puro de `src/providers/autofetch-gates.ts` — a tabela de decisão dos
//! portões do Chupim (autofetch). Módulo PURO: classifica qual portão fechou e
//! diz o que a desistência precisa liberar. Não adquire lock, não segura hash,
//! não escreve fila, não faz rede — os efeitos colaterais continuam em Node; o
//! runner injeta aqui apenas os FATOS já medidos (`EnqueueGates`).
//!
//! No TS as checagens entram como closures com efeito (`tryLock`, `trySlot`,
//! `tryObraCap`, `tryBudget`); aqui elas viram campos `bool` pré-avaliados, e a
//! classificação reproduz EXATAMENTE a ordem dos `return` de `enqueueAutofetch`.

/// Motivo pelo qual um candidato não foi enfileirado nesta busca.
///
/// As 9 variantes espelham, uma a uma, a união `SkipReason` do TS. A ordem de
/// declaração é a ordem dos portões (invariante), mas o que decide é
/// [`classify_enqueue`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SkipReason {
    /// Chupim pausado (kill-switch ao vivo).
    Paused,
    /// Hash na blacklist de mortas (janela de 24h).
    Dead,
    /// Hash já toca no cache do debrid nesta conta.
    AlreadyCached,
    /// Marcador de enqueue anterior ainda ativo (janela de ~6h).
    Marker,
    /// O MESMO hash está sendo enfileirado agora (lock em voo).
    InFlight,
    /// Vaga da busca esgotada (teto por chamada).
    SearchSlotBusy,
    /// Teto por OBRA fechado (Fase 2).
    ObraCap,
    /// Conta cheia (gate do adaptador, memo quente).
    AccountGate,
    /// Orçamento horário de enqueues esgotado.
    Budget,
}

impl SkipReason {
    /// Rótulo estável — o mesmo texto do `SkipReason` do TS. É o que alimenta o
    /// contador `autofetch.skip.<motivo>`, o trace e a tabela de rollback.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Paused => "paused",
            Self::Dead => "dead",
            Self::AlreadyCached => "already-cached",
            Self::Marker => "marker",
            Self::InFlight => "in-flight",
            Self::SearchSlotBusy => "search-slot-busy",
            Self::ObraCap => "obra-cap",
            Self::AccountGate => "account-gate",
            Self::Budget => "budget",
        }
    }

    /// Interpreta o rótulo do TS. `None` para texto desconhecido (o `noteSkip`
    /// em Node cai em `"unknown"`, que NÃO é um portão — fica de fora daqui).
    pub fn parse(label: &str) -> Option<Self> {
        Some(match label {
            "paused" => Self::Paused,
            "dead" => Self::Dead,
            "already-cached" => Self::AlreadyCached,
            "marker" => Self::Marker,
            "in-flight" => Self::InFlight,
            "search-slot-busy" => Self::SearchSlotBusy,
            "obra-cap" => Self::ObraCap,
            "account-gate" => Self::AccountGate,
            "budget" => Self::Budget,
            _ => return None,
        })
    }

    /// Todas as variantes, na ordem dos portões. Útil para varrer a tabela.
    pub const ALL: [SkipReason; 9] = [
        Self::Paused,
        Self::Dead,
        Self::AlreadyCached,
        Self::Marker,
        Self::InFlight,
        Self::SearchSlotBusy,
        Self::ObraCap,
        Self::AccountGate,
        Self::Budget,
    ];
}

/// Rótulo do motivo para o trace — espelho direto de [`SkipReason::as_str`].
///
/// Mantida como função livre porque o contrato do porte pede um ponto único
/// (`skip_reason_label`) para o formato do motivo no registro de desistência.
pub fn skip_reason_label(reason: SkipReason) -> &'static str {
    reason.as_str()
}

/// O que uma desistência pode precisar liberar. Espelha o `RollbackAction` do
/// TS (`'obra' | 'lock' | 'slot' | 'hold'`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RollbackAction {
    /// Devolve a reserva do teto por obra (`releaseObra`).
    Obra,
    /// Solta o lock em voo do hash (`autofetch.release`).
    Lock,
    /// Devolve a vaga da busca (`releaseSearchSlot`).
    Slot,
    /// Libera o hold recém-criado (`held.release`).
    Hold,
}

impl RollbackAction {
    /// Rótulo estável — o mesmo texto do `RollbackAction` do TS.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Obra => "obra",
            Self::Lock => "lock",
            Self::Slot => "slot",
            Self::Hold => "hold",
        }
    }
}

/// Fatos dos portões, na ordem EXATA de `enqueueAutofetch`.
///
/// Cada campo é o valor de retorno da closure correspondente no TS:
/// - os "positivos" (`is_paused`, `is_dead`, `is_cached`, `marker_active`,
///   `account_blocked`) fecham o portão quando valem `true`;
/// - os "try" (`lock_acquired`, `slot_acquired`, `obra_cap_granted`,
///   `budget_granted`) fecham o portão quando valem `false` (a aquisição
///   falhou).
///
/// `Default` = caminho feliz: nenhum portão bloqueia e todas as aquisições
/// passam, então [`classify_enqueue`] devolve `None`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EnqueueGates {
    /// `isPaused()` — Chupim pausado.
    pub is_paused: bool,
    /// `isDead()` — hash na blacklist de mortas.
    pub is_dead: bool,
    /// `isCached()` — hash já toca no cache.
    pub is_cached: bool,
    /// `markerActive()` — marcador de enqueue anterior ativo.
    pub marker_active: bool,
    /// `tryLock()` — `false` = lock em voo (in-flight).
    pub lock_acquired: bool,
    /// `trySlot()` — `false` = vaga da busca esgotada.
    pub slot_acquired: bool,
    /// `tryObraCap()` — `false` = teto por obra fechado.
    pub obra_cap_granted: bool,
    /// `accountBlocked()` — conta cheia.
    pub account_blocked: bool,
    /// `tryBudget()` — `false` = orçamento horário esgotado.
    pub budget_granted: bool,
}

impl Default for EnqueueGates {
    fn default() -> Self {
        Self {
            is_paused: false,
            is_dead: false,
            is_cached: false,
            marker_active: false,
            // As aquisições nascem concedidas: o caminho feliz não bloqueia.
            lock_acquired: true,
            slot_acquired: true,
            obra_cap_granted: true,
            account_blocked: false,
            budget_granted: true,
        }
    }
}

/// Decide QUAL portão fechou, na ORDEM EXATA dos `return` de `enqueueAutofetch`.
///
/// ORDEM SAGRADA (não reordenar — o primeiro que bloqueia vence):
/// `paused → dead → already-cached → marker → in-flight → search-slot-busy →
///  obra-cap → account-gate → budget`.
///
/// O teto por obra vem DEPOIS de lock/slot e ANTES de account/gate/budget: ele
/// já é uma reserva, então os portões seguintes (que não enfileiram) precisam
/// liberá-la no rollback — daí `Obra` aparecer na tabela a partir de
/// `account-gate`.
///
/// Devolve `None` quando todos os portões passam (candidato enfileirável).
pub fn classify_enqueue(gates: &EnqueueGates) -> Option<SkipReason> {
    if gates.is_paused {
        return Some(SkipReason::Paused);
    }
    if gates.is_dead {
        return Some(SkipReason::Dead);
    }
    if gates.is_cached {
        return Some(SkipReason::AlreadyCached);
    }
    if gates.marker_active {
        return Some(SkipReason::Marker);
    }
    if !gates.lock_acquired {
        return Some(SkipReason::InFlight);
    }
    if !gates.slot_acquired {
        return Some(SkipReason::SearchSlotBusy);
    }
    if !gates.obra_cap_granted {
        return Some(SkipReason::ObraCap);
    }
    if gates.account_blocked {
        return Some(SkipReason::AccountGate);
    }
    if !gates.budget_granted {
        return Some(SkipReason::Budget);
    }
    None
}

/// O que cada desistência precisa liberar, na ordem dos `return` de hoje.
///
/// Reproduz EXATAMENTE a tabela `ENQUEUE_ROLLBACK` do TS, com a correção H2
/// (2026-09-01) já incorporada: `marker` libera o hold recém-criado.
///
/// - `paused`/`dead`/`already-cached`/`marker` → só o `hold` (nada foi adquirido
///   além da proteção da seleção desta busca).
/// - `in-flight` → NADA: o lock está em voo, o MESMO hash está sendo baixado
///   agora; soltar o hold o reabriria à limpeza no meio do download.
/// - `search-slot-busy` → `lock` + `hold` (a vaga não foi concedida, mas o lock
///   sim).
/// - `obra-cap` → `lock` + `slot` + `hold` (a reserva da obra NÃO foi concedida,
///   então nada dela a liberar).
/// - `account-gate`/`budget` → `obra` + `lock` + `slot` + `hold` (a reserva da
///   obra foi concedida e precisa voltar, senão fica presa até o lease vencer).
pub fn rollback_for(reason: SkipReason) -> &'static [RollbackAction] {
    use RollbackAction::{Hold, Lock, Obra, Slot};
    match reason {
        SkipReason::Paused => &[Hold],
        SkipReason::Dead => &[Hold],
        SkipReason::AlreadyCached => &[Hold],
        SkipReason::Marker => &[Hold],
        SkipReason::InFlight => &[],
        SkipReason::SearchSlotBusy => &[Lock, Hold],
        SkipReason::ObraCap => &[Lock, Slot, Hold],
        SkipReason::AccountGate => &[Obra, Lock, Slot, Hold],
        SkipReason::Budget => &[Obra, Lock, Slot, Hold],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Gates que fecham apenas o portão `reason` (todos os anteriores passam).
    fn only(reason: SkipReason) -> EnqueueGates {
        let mut g = EnqueueGates::default();
        match reason {
            SkipReason::Paused => g.is_paused = true,
            SkipReason::Dead => g.is_dead = true,
            SkipReason::AlreadyCached => g.is_cached = true,
            SkipReason::Marker => g.marker_active = true,
            SkipReason::InFlight => g.lock_acquired = false,
            SkipReason::SearchSlotBusy => g.slot_acquired = false,
            SkipReason::ObraCap => g.obra_cap_granted = false,
            SkipReason::AccountGate => g.account_blocked = true,
            SkipReason::Budget => g.budget_granted = false,
        }
        g
    }

    #[test]
    fn caminho_feliz_nao_bloqueia() {
        assert_eq!(classify_enqueue(&EnqueueGates::default()), None);
    }

    #[test]
    fn cada_portao_isolado_classifica_o_motivo_correto() {
        for reason in SkipReason::ALL {
            assert_eq!(classify_enqueue(&only(reason)), Some(reason));
        }
    }

    #[test]
    fn primeiro_portao_que_bloqueia_vence() {
        // Todos os portões fechados ao mesmo tempo: `paused` é o primeiro.
        let g = EnqueueGates {
            is_paused: true,
            is_dead: true,
            is_cached: true,
            marker_active: true,
            lock_acquired: false,
            slot_acquired: false,
            obra_cap_granted: false,
            account_blocked: true,
            budget_granted: false,
        };
        assert_eq!(classify_enqueue(&g), Some(SkipReason::Paused));
    }

    #[test]
    fn ordem_entre_portoes_vizinhos_e_preservada() {
        // `dead` antes de `already-cached`.
        let mut g = only(SkipReason::AlreadyCached);
        g.is_dead = true;
        assert_eq!(classify_enqueue(&g), Some(SkipReason::Dead));
        // `obra-cap` antes de `account-gate`.
        let mut g = only(SkipReason::AccountGate);
        g.obra_cap_granted = false;
        assert_eq!(classify_enqueue(&g), Some(SkipReason::ObraCap));
        // `account-gate` antes de `budget`.
        let mut g = only(SkipReason::Budget);
        g.account_blocked = true;
        assert_eq!(classify_enqueue(&g), Some(SkipReason::AccountGate));
    }

    #[test]
    fn rotulos_batem_com_o_ts() {
        let esperados = [
            "paused",
            "dead",
            "already-cached",
            "marker",
            "in-flight",
            "search-slot-busy",
            "obra-cap",
            "account-gate",
            "budget",
        ];
        for (reason, rotulo) in SkipReason::ALL.iter().zip(esperados) {
            assert_eq!(reason.as_str(), rotulo);
            assert_eq!(skip_reason_label(*reason), rotulo);
            assert_eq!(SkipReason::parse(rotulo), Some(*reason));
        }
        assert_eq!(SkipReason::parse("unknown"), None);
    }

    #[test]
    fn tabela_de_rollback_bate_com_o_ts() {
        use RollbackAction::{Hold, Lock, Obra, Slot};
        assert_eq!(rollback_for(SkipReason::Paused), &[Hold]);
        assert_eq!(rollback_for(SkipReason::Dead), &[Hold]);
        assert_eq!(rollback_for(SkipReason::AlreadyCached), &[Hold]);
        assert_eq!(rollback_for(SkipReason::Marker), &[Hold]);
        assert_eq!(rollback_for(SkipReason::InFlight), &[] as &[RollbackAction]);
        assert_eq!(rollback_for(SkipReason::SearchSlotBusy), &[Lock, Hold]);
        assert_eq!(rollback_for(SkipReason::ObraCap), &[Lock, Slot, Hold]);
        assert_eq!(
            rollback_for(SkipReason::AccountGate),
            &[Obra, Lock, Slot, Hold]
        );
        assert_eq!(rollback_for(SkipReason::Budget), &[Obra, Lock, Slot, Hold]);
    }
}
