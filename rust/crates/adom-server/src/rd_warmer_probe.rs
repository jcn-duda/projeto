//! Sonda do `rd_warmer`: `RealDebridAutofetch` (intent + gate AIMD) e UMA
//! listagem de `/torrents` para classificar e limpar.
//!
//! # Por que não existe backoff aqui
//!
//! Rate limit, cooldown e quarentena são do `RdGateExecutor`/`RdScheduler`
//! (`adom-debrid`): `enqueue` já passa por eles. Este módulo só traduz o
//! resultado em [`WarmSignal`] e PARA o lote no primeiro sinal de gate — dois
//! backoffs na mesma conta fariam o AIMD mentir.
//!
//! # O que conta como prova
//!
//! `enqueue` devolve `Some(id)` quando o RD chega em `downloaded`, selecionou
//! arquivos ou já tinha seleção — só `downloaded` prova cache. Então o lote faz
//! UMA leitura de `/torrents` e classifica; `downloading`/`unknown` não mexem no
//! ledger (⚡ falso é pior que ⚡ ausente). O `remove` devolve a conta ao estado
//! anterior: o aquecimento não deixa magnet órfão.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use adom_core::{account_scope, PlayHint};
use adom_debrid::rd_gate_executor::RdGateExecutor;
use adom_debrid::rd_scheduler::RdSchedulerConfig;
use adom_debrid::realdebrid::RealDebrid;
use adom_debrid::realdebrid_autofetch::{
    uncertain_key, RdAutofetchError, RdUncertainIntent, RdUncertainStore, RealDebridAutofetch,
};
use adom_debrid::{DebridError, HttpClient};
use serde_json::Value;

use super::{env_flag, env_num_f};
use crate::rd_warmer::{WarmFuture, WarmPort, WarmReport, WarmSignal};

/// Quarentena do intent em RAM: o worker durável usa KV; aqui a fila é volátil,
/// então a posse expira em 5 min em vez de travar o hash até o restart.
const INTENT_TTL_MS: i64 = 300_000;

/// Produção: cliente HTTP do processo + gate com as réguas `DEBRID_RD_GATE*`.
pub(crate) fn port(poll_ms: u64) -> Option<Arc<dyn WarmPort>> {
    let rd = Arc::new(RealDebrid::new(HttpClient::new().ok()?));
    Some(Arc::new(GateWarm::with_gate(
        rd,
        gate_config(),
        Duration::from_millis(poll_ms),
    )))
}

fn gate_config() -> RdSchedulerConfig {
    RdSchedulerConfig {
        min_gap_ms: env_num_f("DEBRID_RD_GATE_MIN_GAP_MS", 1_000.0),
        max_gap_ms: env_num_f("DEBRID_RD_GATE_MAX_GAP_MS", 30_000.0),
        cooldown_ms: env_num_f("DEBRID_RD_GATE_COOLDOWN_MS", 90_000.0),
        play_max_wait_ms: env_num_f("DEBRID_RD_GATE_PLAY_MAX_WAIT_MS", 1_500.0),
        success_threshold: 5,
        enabled: env_flag("DEBRID_RD_GATE"),
    }
}

// ---------------------------------------------------------------------------
// Intent em RAM (`RdUncertainStore`): a escrita entra antes do HTTP e só sai
// com prova (remoção confirmada, recusa definitiva ou TTL).
// ---------------------------------------------------------------------------

#[derive(Default)]
struct StoreState {
    intents: HashMap<String, i64>,
    owned: HashMap<String, String>,
}

#[derive(Default)]
pub(super) struct WarmStore {
    inner: Mutex<StoreState>,
}

impl WarmStore {
    fn lock(&self) -> MutexGuard<'_, StoreState> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Prova de posse que o `remove` exige (`owns_transfer`).
    pub(super) fn own(&self, account: &str, hash: &str, id: &str) {
        self.lock()
            .owned
            .insert(uncertain_key(account, hash), id.to_string());
    }

    /// O `enqueue` devolveu o id: o intent daquela escrita está resolvido, mas a
    /// posse fica (o `remove` seguinte exige as duas coisas ao contrário).
    pub(super) fn settle(&self, account: &str, hash: &str) {
        self.lock().intents.remove(&uncertain_key(account, hash));
    }

    /// Libera intent e posse de um hash já resolvido.
    pub(super) fn release(&self, account: &str, hash: &str) {
        let key = uncertain_key(account, hash);
        let mut state = self.lock();
        state.intents.remove(&key);
        state.owned.remove(&key);
    }
}

impl RdUncertainStore for WarmStore {
    fn has_intent(&self, key: &str) -> Result<bool, String> {
        let now = adom_sources::now_ms();
        let mut state = self.lock();
        match state.intents.get(key) {
            Some(created) if now - created < INTENT_TTL_MS => Ok(true),
            Some(_) => {
                state.intents.remove(key);
                Ok(false)
            }
            None => Ok(false),
        }
    }

    fn put_intent_if_absent(&self, key: &str, intent: &RdUncertainIntent) -> Result<bool, String> {
        Ok(self
            .lock()
            .intents
            .insert(key.to_string(), intent.created_at_ms)
            .is_none())
    }

    fn clear_intent(&self, key: &str) -> Result<(), String> {
        self.lock().intents.remove(key);
        Ok(())
    }

    fn owns_transfer(&self, account: &str, hash: &str, id: &str) -> Result<bool, String> {
        Ok(self
            .lock()
            .owned
            .get(&uncertain_key(account, hash))
            .is_some_and(|known| known == id))
    }
}

// ---------------------------------------------------------------------------
// Execução: addMagnet + poll + classificação + limpeza.
// ---------------------------------------------------------------------------

pub(crate) struct GateWarm {
    rd: Arc<RealDebrid>,
    autofetch: RealDebridAutofetch,
    store: Arc<WarmStore>,
    poll: Duration,
}

impl GateWarm {
    pub(crate) fn with_gate(rd: Arc<RealDebrid>, gate: RdSchedulerConfig, poll: Duration) -> Self {
        let store = Arc::new(WarmStore::default());
        let autofetch = RealDebridAutofetch::new(
            RdGateExecutor::new(gate),
            Arc::clone(&store) as Arc<dyn RdUncertainStore>,
        );
        Self {
            rd,
            autofetch,
            store,
            poll,
        }
    }

    /// Classifica o que o `enqueue` deixou pronto e devolve a conta ao estado
    /// anterior. Falha de listagem/limpeza não inventa sinal.
    async fn classify(
        &self,
        api_key: &str,
        account: &str,
        pending: Vec<(String, String)>,
        report: &mut WarmReport,
    ) {
        let statuses = match self.rd.torrent_status(api_key).await {
            Ok(statuses) => statuses,
            Err(_) => {
                for (hash, _) in &pending {
                    self.store.release(account, hash);
                }
                return;
            }
        };
        for (hash, id) in pending {
            match statuses.by_hash.get(&hash).map(|status| status.state) {
                Some("ready") => report.signals.push((hash.clone(), WarmSignal::Hit)),
                Some("dead") => report.signals.push((hash.clone(), WarmSignal::Miss)),
                // `downloading`/`unknown`/ausente: evidência insuficiente.
                _ => {}
            }
            if let Err(RdAutofetchError::Cooldown) = self
                .autofetch
                .remove(self.rd.clone(), api_key, &hash, &id)
                .await
            {
                report.stopped = true;
            }
            self.store.release(account, &hash);
        }
    }
}

impl WarmPort for GateWarm {
    fn warm<'a>(&'a self, api_key: &'a str, hashes: &'a [String]) -> WarmFuture<'a> {
        Box::pin(async move {
            let mut report = WarmReport::default();
            let account = account_scope(&Value::from(api_key));
            let hint = PlayHint {
                season: None,
                episode: None,
                work: None,
                dubbed: false,
            };
            let mut pending: Vec<(String, String)> = Vec::new();
            for hash in hashes {
                report.attempted += 1;
                let result = self
                    .autofetch
                    .enqueue(self.rd.clone(), api_key, hash, None, &hint, self.poll)
                    .await;
                match result {
                    Ok(Some(id)) => {
                        self.store.own(&account, hash, &id);
                        self.store.settle(&account, hash);
                        pending.push((hash.clone(), id));
                    }
                    // Sem id ou fora de `downloaded`: não há prova de cache.
                    Ok(None) => {
                        self.store.release(&account, hash);
                        report.signals.push((hash.clone(), WarmSignal::Miss));
                    }
                    Err(RdAutofetchError::Cooldown) | Err(RdAutofetchError::Quarantined) => {
                        report.stopped = true;
                        break;
                    }
                    Err(RdAutofetchError::Debrid(DebridError::RateLimit { .. }))
                    | Err(RdAutofetchError::Debrid(DebridError::Quota(_))) => {
                        report.stopped = true;
                        break;
                    }
                    // Recusa definitiva do serviço: o hash sai da fila por TTL.
                    Err(RdAutofetchError::Debrid(DebridError::Blocked(_))) => {
                        report.signals.push((hash.clone(), WarmSignal::Blocked));
                    }
                    // Hash ruim ou falha local: um hash não derruba o lote.
                    Err(_) => self.store.release(&account, hash),
                }
            }
            if !pending.is_empty() {
                self.classify(api_key, &account, pending, &mut report).await;
            }
            report
        })
    }
}
