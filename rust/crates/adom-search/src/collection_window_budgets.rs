use adom_core::{compute_collection_budget, compute_priority_grace};

/// Valores de config que governam a janela.
///
/// Defaults = os do `src/config/search.ts`: `REPLY_DEADLINE_MS` 9200,
/// `DEBRID_RESERVE_MS` 4500, `DEBRID_CHECK_FLOOR_MS` 1500,
/// `BR_PARTIAL_GRACE_MS` 1500 e `SEARCH_TIMEOUT_MS` 8000 (total próprio de
/// cada tarefa BR).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CollectBudgets {
    /// Prazo de resposta deste cliente (`reply_deadline_ms` já escolheu).
    pub reply_deadline_ms: i64,
    /// Reserva da checagem de debrid (`DEBRID_RESERVE_MS`): sai do prazo ANTES
    /// de se calcular o orçamento de coleta.
    pub debrid_reserve_ms: i64,
    /// Piso que a graça BR nunca pode invadir (`DEBRID_CHECK_FLOOR_MS`).
    pub debrid_check_floor_ms: i64,
    /// Janela extra da primeira fonte BR (`BR_PARTIAL_GRACE_MS`).
    pub br_partial_grace_ms: i64,
    /// Total PRÓPRIO de cada tarefa BR (`SEARCH_TIMEOUT_MS`): fonte BR não
    /// compete com os globais pelo orçamento da resposta.
    pub br_total_ms: i64,
}

impl Default for CollectBudgets {
    fn default() -> Self {
        CollectBudgets {
            reply_deadline_ms: 9200,
            debrid_reserve_ms: 4500,
            debrid_check_floor_ms: 1500,
            br_partial_grace_ms: 1500,
            br_total_ms: 8000,
        }
    }
}

impl CollectBudgets {
    /// Orçamento de coleta dentro do prazo da resposta — fórmula única no
    /// núcleo (`adom_core::collection_budget`), com piso 500ms (com prazo) /
    /// 1000ms (sem prazo). O `DEBRID_RESERVE_MS` já foi subtraído aqui: a
    /// coleta NUNCA come o tempo da checagem de debrid.
    pub fn collection_budget(&self, deadline_at: Option<i64>, now: i64) -> i64 {
        compute_collection_budget(
            deadline_at,
            now,
            self.reply_deadline_ms,
            self.debrid_reserve_ms,
        )
    }

    /// Graça da primeira fonte BR, recortada de dentro da reserva e nunca
    /// abaixo do piso do debrid — fórmula do núcleo.
    pub fn priority_grace(&self) -> i64 {
        compute_priority_grace(
            self.br_partial_grace_ms,
            self.debrid_reserve_ms,
            self.debrid_check_floor_ms,
        )
    }

    /// Prazo ABSOLUTO (relógio, ms desde a época) de uma tarefa BR: total
    /// próprio (`searchTimeout`), cortado pelo prazo da resposta quando este
    /// vence antes. Fonte BR não usa o orçamento dos globais — o corte dela é
    /// `min(deadline, now + br_total)`, exatamente o padrão de
    /// `search-multiwork.ts` (`TMDB_COLLECTION_TIMEOUT_MS`).
    pub fn br_deadline(&self, deadline_at: Option<i64>, now: i64) -> i64 {
        let own = now.saturating_add(self.br_total_ms);
        match deadline_at {
            Some(d) => d.min(own),
            None => own,
        }
    }

    /// Milissegundos que a tarefa BR ainda tem a partir de `now`.
    pub fn br_budget_ms(&self, deadline_at: Option<i64>, now: i64) -> i64 {
        self.br_deadline(deadline_at, now)
            .saturating_sub(now)
            .max(0)
    }
}

/// Deadline ABSOLUTO de um salto (degrau sequencial de cascata: fallback EN,
/// variante arábica, franquia, multiobra, original). O degrau herda o teto da
/// tarefa: `min(deadline_at, now + cap_ms)`. Sem teto (`None`), vale só o cap.
///
/// O salto nunca ESTICA a tarefa: quando `deadline_at` vence antes do cap, o
/// prazo absoluto é o da resposta — quem executa corta no relógio e devolve o
/// que deu tempo de coletar (devolução parcial).
pub fn jump_deadline(deadline_at: Option<i64>, now: i64, cap_ms: i64) -> Option<i64> {
    let capped = now.saturating_add(cap_ms);
    Some(match deadline_at {
        Some(d) => d.min(capped),
        None => capped,
    })
}
