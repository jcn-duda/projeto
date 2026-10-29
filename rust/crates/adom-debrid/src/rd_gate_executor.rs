//! Executor assíncrono para o estado AIMD. Ainda não está ligado ao play nem
//! ao worker; todos os escritores devem compartilhar a mesma instância.
//! Não conectar à rede antes de definir e testar quarentena/reconciliação para
//! timeout incerto: o servidor pode continuar processando após o job terminar.

use std::collections::HashSet;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use adom_core::GatePriority;
use tokio::sync::Notify;

use crate::rd_scheduler::{RdAdmission, RdGrant, RdOutcome, RdScheduler, RdSchedulerConfig};

struct State {
    scheduler: RdScheduler,
    granted: HashSet<(String, u64)>,
}

struct Inner {
    state: Mutex<State>,
    changed: Notify,
}

#[derive(Clone)]
pub struct RdGateExecutor {
    inner: Arc<Inner>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CooldownDenied;

#[derive(Debug)]
pub enum RdRunError {
    Cooldown,
    Task(tokio::task::JoinError),
}

impl RdGateExecutor {
    /// Duas handles apontam para o MESMO executor (mesmo `RdScheduler`). O
    /// boot usa isto para provar que worker e warmer compartilham o gate.
    pub fn same_instance(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner)
    }

    pub fn new(config: RdSchedulerConfig) -> Self {
        Self {
            inner: Arc::new(Inner {
                state: Mutex::new(State {
                    scheduler: RdScheduler::new(config),
                    granted: HashSet::new(),
                }),
                changed: Notify::new(),
            }),
        }
    }

    /// O job e o permit passam para uma tarefa independente. Cancelar a
    /// espera do chamador não cancela uma escrita já enviada nem abre outra
    /// vaga antes da conclusão do job. O timeout/resultado HTTP continua sendo
    /// responsabilidade da operação; erros ambíguos exigem reconciliação.
    pub async fn run<J, F, T>(
        &self,
        account: &str,
        priority: GatePriority,
        job: J,
    ) -> Result<T, RdRunError>
    where
        J: FnOnce() -> F + Send + 'static,
        F: Future<Output = (T, RdOutcome)> + Send + 'static,
        T: Send + 'static,
    {
        let permit = self
            .acquire(account, priority)
            .await
            .map_err(|_| RdRunError::Cooldown)?;
        tokio::spawn(async move {
            let (result, outcome) = job().await;
            permit.finish(outcome);
            result
        })
        .await
        .map_err(RdRunError::Task)
    }

    /// A chave é um identificador de conta já anonimizado, nunca a API key.
    /// Cancelar a espera remove a fila ou solta a concessão já feita.
    async fn acquire(
        &self,
        account: &str,
        priority: GatePriority,
    ) -> Result<RdPermit, CooldownDenied> {
        let admission = {
            let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
            state.scheduler.admit(account, priority, now_ms())
        };
        let order = match admission {
            RdAdmission::Denied => return Err(CooldownDenied),
            RdAdmission::Bypass => {
                return Ok(RdPermit {
                    inner: self.inner.clone(),
                    account: account.into(),
                    order: None,
                })
            }
            RdAdmission::Queued(order) => order,
        };
        let mut waiter = Waiting {
            inner: self.inner.clone(),
            account: account.into(),
            order,
            armed: true,
        };
        self.inner.changed.notify_waiters();
        loop {
            let notified = self.inner.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let (mine, wait) = {
                let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
                let next = state.scheduler.next(account, now_ms());
                let wait = match next {
                    RdGrant::Granted(id) => {
                        state.granted.insert((account.into(), id));
                        self.inner.changed.notify_waiters();
                        None
                    }
                    RdGrant::Wait(until) => Some((until - now_ms()).max(0.0)),
                    _ => None,
                };
                (state.granted.remove(&(account.into(), order)), wait)
            };
            if mine {
                waiter.armed = false;
                return Ok(RdPermit {
                    inner: self.inner.clone(),
                    account: account.into(),
                    order: Some(order),
                });
            }
            match wait {
                Some(ms) => {
                    tokio::select! { _ = &mut notified => {}, _ = tokio::time::sleep(Duration::from_secs_f64((ms / 1000.0).min(86_400.0))) => {} }
                }
                None => notified.await,
            }
        }
    }
}

struct Waiting {
    inner: Arc<Inner>,
    account: String,
    order: u64,
    armed: bool,
}
impl Drop for Waiting {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.granted.remove(&(self.account.clone(), self.order)) {
            state
                .scheduler
                .finish(&self.account, self.order, RdOutcome::Error, now_ms());
        } else {
            state.scheduler.cancel(&self.account, self.order);
        }
        drop(state);
        self.inner.changed.notify_waiters();
    }
}

/// Ao cancelar o future que detém o permit, Drop libera a conta sem marcar
/// sucesso. Uma resposta 429 deve ser entregue explicitamente ao `finish`.
pub struct RdPermit {
    inner: Arc<Inner>,
    account: String,
    order: Option<u64>,
}
impl RdPermit {
    pub fn finish(mut self, outcome: RdOutcome) {
        self.complete(outcome);
    }
    fn complete(&mut self, outcome: RdOutcome) {
        let Some(order) = self.order.take() else {
            return;
        };
        let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        state
            .scheduler
            .finish(&self.account, order, outcome, now_ms());
        drop(state);
        self.inner.changed.notify_waiters();
    }
}
impl Drop for RdPermit {
    fn drop(&mut self) {
        self.complete(RdOutcome::Error);
    }
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as f64
}

#[cfg(test)]
#[path = "rd_gate_executor_tests.rs"]
mod tests;
