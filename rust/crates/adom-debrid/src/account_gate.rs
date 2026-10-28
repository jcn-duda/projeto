//! Gate local e não bloqueante para a ocupação da conta no autofetch.
//!
//! A chamada quente consulta apenas o memo e, quando aplicável, o piso do
//! inventário pronto. Memo frio/vencido sempre libera a chamada atual e agenda
//! no máximo um refresh por chave em background. Falha ou medição inválida
//! não cria bloqueio. A chave deve ser `adapter:accountScope` (nunca API key).

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::runtime::Handle;

#[derive(Clone, Debug)]
pub struct AccountGateInput {
    /// Identidade não secreta e estável, normalmente `adapter:accountScope`.
    pub key: String,
    /// Piso do gate para adapters sem occupancy explícito.
    pub pause_at: f64,
    /// Validade do memo em milissegundos.
    pub refresh_ms: u64,
    /// `true` quando a medição fornece ocupação e limite reais.
    pub occupancy_supported: bool,
    /// Número de magnets prontos já memoizado; só é um piso de ocupação para
    /// adapters sem `occupancy` e nunca pode liberar uma conta.
    pub ready_inventory_count: Option<usize>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AccountGateMeasurement {
    pub used: f64,
    /// Obrigatório para `occupancy_supported`; ignorado nos demais adapters.
    pub max: Option<f64>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AccountGateMemo {
    pub used: f64,
    pub max: f64,
    pub blocked: bool,
    pub at_ms: u64,
}

pub trait GateClock: Send + Sync + 'static {
    fn now_ms(&self) -> u64;
}

#[derive(Default)]
pub struct SystemGateClock;

impl GateClock for SystemGateClock {
    fn now_ms(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }
}

#[derive(Default)]
struct State {
    memo: HashMap<String, AccountGateMemo>,
    in_flight: HashSet<String>,
}

pub struct AccountGate {
    state: Arc<Mutex<State>>,
    clock: Arc<dyn GateClock>,
}

impl Default for AccountGate {
    fn default() -> Self {
        Self::new(Arc::new(SystemGateClock))
    }
}

impl AccountGate {
    pub fn new(clock: Arc<dyn GateClock>) -> Self {
        Self {
            state: Arc::new(Mutex::new(State::default())),
            clock,
        }
    }

    /// Consulta local e fail-open. `refresh` só é chamado em background quando
    /// o memo está frio/vencido e nunca é aguardado pelo chamador.
    pub fn blocked<F, Fut>(&self, input: AccountGateInput, refresh: F) -> bool
    where
        F: FnOnce() -> Fut + Send + 'static,
        Fut: Future<Output = Option<AccountGateMeasurement>> + Send + 'static,
    {
        let now = self.clock.now_ms();
        if input.key.is_empty() || !input.pause_at.is_finite() || input.pause_at <= 0.0 {
            return false;
        }

        // O inventário pronto é subconjunto da conta inteira: pode provar
        // ocupação acima do piso, mas nunca provar que há espaço livre.
        if !input.occupancy_supported
            && input
                .ready_inventory_count
                .is_some_and(|count| count as f64 >= input.pause_at)
        {
            return true;
        }

        let key = input.key.clone();
        let should_refresh = {
            let mut state = self.state.lock().unwrap_or_else(|err| err.into_inner());
            if let Some(memo) = state.memo.get(&key) {
                if now.saturating_sub(memo.at_ms) < input.refresh_ms {
                    return memo.blocked;
                }
            }
            if !state.in_flight.insert(key.clone()) {
                return false;
            }
            true
        };
        if !should_refresh {
            return false;
        }

        let Ok(handle) = Handle::try_current() else {
            self.state
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .in_flight
                .remove(&key);
            return false;
        };
        let state = self.state.clone();
        let clock = self.clock.clone();
        handle.spawn(async move {
            let measurement = refresh().await;
            let mut state = state.lock().unwrap_or_else(|err| err.into_inner());
            state.in_flight.remove(&key);
            let Some(measurement) = measurement else {
                return;
            };
            if !measurement.used.is_finite() {
                return;
            }
            let max = if input.occupancy_supported {
                let Some(max) = measurement.max.filter(|max| max.is_finite() && *max > 0.0) else {
                    return;
                };
                max
            } else {
                input.pause_at
            };
            state.memo.insert(
                key,
                AccountGateMemo {
                    used: measurement.used,
                    max,
                    blocked: measurement.used >= max,
                    at_ms: clock.now_ms(),
                },
            );
        });
        false
    }

    /// Diagnóstico local; não inicia refresh e nunca expõe a chave guardada.
    pub fn memo(&self, key: &str) -> Option<AccountGateMemo> {
        self.state
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .memo
            .get(key)
            .copied()
    }

    pub fn in_flight(&self, key: &str) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .in_flight
            .contains(key)
    }

    pub fn clear(&self) {
        let mut state = self.state.lock().unwrap_or_else(|err| err.into_inner());
        state.memo.clear();
        state.in_flight.clear();
    }
}

#[cfg(test)]
#[path = "account_gate_tests.rs"]
mod tests;
