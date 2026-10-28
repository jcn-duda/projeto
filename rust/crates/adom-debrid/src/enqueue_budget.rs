//! Orçamento deslizante de enqueues por hora, por `adapter:account`
//! (porte de `checkAndRecordBudget`, `blockBudget`, `budgetBlockedUntil` e
//! `resetBudget` de `src/providers/autofetch.ts`).
//!
//! Puro em memória e SEM relógio interno: o `now_ms` vem do chamador, então o
//! worker decide a hora e os testes não dependem de tempo real. A chave é
//! `adapter:accountScope` (hash da chave), nunca a API key.
//!
//! Duas decisões que o TS não tinha explícitas e aqui são contrato:
//! - `limit = None` libera sempre (o teto vivo do painel é resolvido por quem
//!   chama, não dentro do contador) e ainda assim registra o carimbo, para o
//!   teto poder ser ligado no meio da janela.
//! - Recusa NÃO registra carimbo; só o enqueue aceito consome orçamento.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// Janela deslizante do orçamento: 1 hora, igual ao TS.
pub const WINDOW_MS: i64 = 3_600_000;

#[derive(Default)]
struct State {
    hourly: HashMap<String, Vec<i64>>,
    blocked_until: HashMap<String, i64>,
}

/// Contador compartilhável entre o worker e o painel; clones enxergam o mesmo
/// estado (o `Arc` é o dono).
#[derive(Clone, Default)]
pub struct EnqueueBudget {
    state: Arc<Mutex<State>>,
}

impl EnqueueBudget {
    pub fn new() -> Self {
        Self::default()
    }

    /// `true` quando o enqueue pode acontecer agora; o carimbo entra na mesma
    /// chamada (o TS faz igual). `limit` `None` = sem teto.
    pub fn check_and_record(
        &self,
        adapter: &str,
        account: &str,
        limit: Option<usize>,
        now_ms: i64,
    ) -> bool {
        if adapter.is_empty() || account.is_empty() {
            return true;
        }
        let key = budget_key(adapter, account);
        let mut state = self.state.lock().unwrap_or_else(|err| err.into_inner());
        let stamps = state.hourly.entry(key).or_default();
        // `t > now - 1h`, como o TS: carimbo exatamente na borda já expirou.
        let floor = now_ms.saturating_sub(WINDOW_MS);
        stamps.retain(|at| *at > floor);
        if limit.is_some_and(|max| stamps.len() >= max) {
            return false;
        }
        stamps.push(now_ms);
        true
    }

    /// Pausa a drenagem quando o limite horário já foi consumido. Backoff não
    /// positivo ou chave vazia não bloqueiam (o TS também ignora).
    pub fn block_budget(&self, adapter: &str, account: &str, backoff_ms: i64, now_ms: i64) {
        if adapter.is_empty() || account.is_empty() || backoff_ms <= 0 {
            return;
        }
        let key = budget_key(adapter, account);
        let until = now_ms.saturating_add(backoff_ms);
        self.state
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .blocked_until
            .insert(key, until);
    }

    /// `0` quando não há bloqueio vigente; o vencido é esquecido na leitura.
    pub fn budget_blocked_until(&self, adapter: &str, account: &str, now_ms: i64) -> i64 {
        let key = budget_key(adapter, account);
        let mut state = self.state.lock().unwrap_or_else(|err| err.into_inner());
        match state.blocked_until.get(&key).copied() {
            Some(until) if until > now_ms => until,
            Some(_) => {
                state.blocked_until.remove(&key);
                0
            }
            None => 0,
        }
    }

    /// Com `adapter` E `account` limpa só aquela chave; qualquer outro par limpa
    /// tudo (mesmo contrato do `resetBudget(adapterId?, account?)`).
    pub fn reset_budget(&self, adapter: Option<&str>, account: Option<&str>) {
        let mut state = self.state.lock().unwrap_or_else(|err| err.into_inner());
        if let (Some(adapter), Some(account)) = (adapter, account) {
            let key = budget_key(adapter, account);
            state.hourly.remove(&key);
            state.blocked_until.remove(&key);
            return;
        }
        state.hourly.clear();
        state.blocked_until.clear();
    }

    /// Diagnóstico (`snapshot` do TS): carimbos vivos na janela, já podados.
    pub fn used(&self, adapter: &str, account: &str, now_ms: i64) -> usize {
        let key = budget_key(adapter, account);
        let mut state = self.state.lock().unwrap_or_else(|err| err.into_inner());
        let Some(stamps) = state.hourly.get_mut(&key) else {
            return 0;
        };
        let floor = now_ms.saturating_sub(WINDOW_MS);
        stamps.retain(|at| *at > floor);
        stamps.len()
    }
}

fn budget_key(adapter: &str, account: &str) -> String {
    format!("{adapter}:{account}")
}

#[cfg(test)]
#[path = "enqueue_budget_tests.rs"]
mod tests;
