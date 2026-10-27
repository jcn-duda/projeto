//! Estado do agendador AIMD do Real-Debrid por conta. Sem rede nem timers:
//! o executor futuro chama `admit`, `next` e `finish` num único dono.
//! Enquanto o executor de play/cleanup não compartilhar esta instância, não
//! ligar operações do worker: gates independentes não serializam a conta.

use adom_core::{
    admit, initial_state, next_grant, on_finished, on_rate_limit, on_success, AdmitAction,
    GatePriority, GateState, GrantAction,
};
use std::collections::HashMap;

#[derive(Clone, Copy, Debug)]
pub struct RdSchedulerConfig {
    pub min_gap_ms: f64,
    pub max_gap_ms: f64,
    pub cooldown_ms: f64,
    pub play_max_wait_ms: f64,
    pub success_threshold: i64,
    pub enabled: bool,
}

#[derive(Debug, PartialEq)]
pub enum RdAdmission {
    Bypass,
    Denied,
    Queued(u64),
}
#[derive(Debug, PartialEq)]
pub enum RdGrant {
    Idle,
    Busy,
    Wait(f64),
    Granted(u64),
}
#[derive(Clone, Copy, Debug)]
pub enum RdOutcome {
    Success,
    RateLimit(Option<f64>),
    Error,
}

pub struct RdScheduler {
    config: RdSchedulerConfig,
    accounts: HashMap<String, GateState>,
    active: HashMap<String, u64>,
}

#[cfg(test)]
#[path = "rd_scheduler_tests.rs"]
mod tests;

impl RdScheduler {
    pub fn new(config: RdSchedulerConfig) -> Self {
        Self {
            config,
            accounts: HashMap::new(),
            active: HashMap::new(),
        }
    }

    /// Ordem é sequencial por conta; nenhum segredo deve ser usado como chave.
    pub fn admit(&mut self, account: &str, priority: GatePriority, now: f64) -> RdAdmission {
        let state = self
            .accounts
            .entry(account.into())
            .or_insert_with(|| initial_state(self.config.min_gap_ms, self.config.max_gap_ms));
        let order = state.next_order;
        let result = admit(
            state,
            self.config.enabled,
            priority,
            now,
            self.config.play_max_wait_ms,
        );
        *state = result.state;
        match result.action {
            AdmitAction::Passthrough => RdAdmission::Bypass,
            AdmitAction::Deny => RdAdmission::Denied,
            AdmitAction::Enqueue => RdAdmission::Queued(order),
        }
    }

    /// Deve ser chamado após cada admissão, finalização, cancelamento ou prazo.
    pub fn next(&mut self, account: &str, now: f64) -> RdGrant {
        let Some(state) = self.accounts.get_mut(account) else {
            return RdGrant::Idle;
        };
        let result = next_grant(state, now, self.config.enabled);
        *state = result.state;
        match result.action {
            GrantAction::Idle => RdGrant::Idle,
            GrantAction::Busy => RdGrant::Busy,
            GrantAction::Wait => RdGrant::Wait(result.until.expect("wait com prazo")),
            GrantAction::Grant => {
                let order = result.order.expect("grant com ordem");
                self.active.insert(account.into(), order);
                RdGrant::Granted(order)
            }
        }
    }

    /// Só para job efetivamente concedido; o executor deve chamar também em
    /// cancelamento/erro para não deixar a conta permanentemente ocupada.
    pub fn finish(&mut self, account: &str, order: u64, outcome: RdOutcome, now: f64) -> bool {
        if self.active.get(account).copied() != Some(order) {
            return false;
        }
        let Some(state) = self.accounts.get_mut(account) else {
            return false;
        };
        if !state.busy {
            return false;
        }
        *state = match outcome {
            RdOutcome::Success => on_success(
                state,
                self.config.success_threshold.max(1),
                self.config.min_gap_ms,
                self.config.max_gap_ms,
            ),
            RdOutcome::RateLimit(retry) => {
                on_rate_limit(
                    state,
                    now,
                    self.config.min_gap_ms,
                    self.config.max_gap_ms,
                    self.config.cooldown_ms,
                    retry,
                )
                .state
            }
            RdOutcome::Error => state.clone(),
        };
        *state = on_finished(state, now);
        self.active.remove(account);
        true
    }

    /// Cancela somente uma espera ainda não concedida; nunca preempta o job.
    pub fn cancel(&mut self, account: &str, order: u64) -> bool {
        let Some(state) = self.accounts.get_mut(account) else {
            return false;
        };
        for queue in [
            &mut state.queues.play,
            &mut state.queues.cleanup,
            &mut state.queues.autofetch,
            &mut state.queues.probe,
        ] {
            let before = queue.len();
            queue.retain(|w| w.order != order);
            if queue.len() != before {
                return true;
            }
        }
        false
    }

    pub fn snapshot(&self, account: &str) -> Option<&GateState> {
        self.accounts.get(account)
    }
}
