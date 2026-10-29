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
//!
//! # Intent incerto
//!
//! `Quarantined` é o intent durável de uma escrita anterior: o hash NÃO é
//! reenviado e o lote NÃO para — ele só sai da fila e espera o TTL do KV. Erro
//! transitório (`TaskFailed`, rede) também deixa o intent de pé: reenviar às
//! cegas é o que o intent existe para impedir. Só `Ok(None)` (transferência
//! existe, mas não baixou) e recusa definitiva liberam a posse.

use std::sync::Arc;
use std::time::Duration;

use adom_core::{account_scope, PlayHint};
use adom_debrid::rd_gate_executor::RdGateExecutor;
#[cfg(test)]
use adom_debrid::rd_scheduler::RdSchedulerConfig;
use adom_debrid::realdebrid::RealDebrid;
use adom_debrid::realdebrid_autofetch::{RdAutofetchError, RealDebridAutofetch};
use adom_debrid::{DebridError, HttpClient};
use serde_json::Value;

use super::super::store::WarmIntentStore;
use super::super::{WarmFuture, WarmPort, WarmReport, WarmSignal};

/// Produção: cliente HTTP do processo + gate COMPARTILHADO do autofetch.
pub(crate) fn port(
    poll_ms: u64,
    gate: RdGateExecutor,
    store: Arc<WarmIntentStore>,
) -> Option<Arc<dyn WarmPort>> {
    let rd = Arc::new(RealDebrid::new(HttpClient::new().ok()?));
    Some(Arc::new(GateWarm::with_store(
        rd,
        gate,
        Duration::from_millis(poll_ms),
        store,
    )))
}

// ---------------------------------------------------------------------------
// Execução: addMagnet + poll + classificação + limpeza.
// ---------------------------------------------------------------------------

pub(crate) struct GateWarm {
    rd: Arc<RealDebrid>,
    autofetch: RealDebridAutofetch,
    store: Arc<WarmIntentStore>,
    poll: Duration,
}

impl GateWarm {
    pub(crate) fn with_store(
        rd: Arc<RealDebrid>,
        gate: RdGateExecutor,
        poll: Duration,
        store: Arc<WarmIntentStore>,
    ) -> Self {
        let autofetch = RealDebridAutofetch::new(gate, store.clone());
        Self {
            rd,
            autofetch,
            store,
            poll,
        }
    }

    #[cfg(test)]
    pub(crate) fn with_gate(
        rd: Arc<RealDebrid>,
        config: RdSchedulerConfig,
        poll: Duration,
    ) -> Self {
        Self::with_store(
            rd,
            RdGateExecutor::new(config),
            poll,
            Arc::new(WarmIntentStore::memory()),
        )
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
                    // Intent durável de uma escrita anterior: NÃO reenvia e NÃO
                    // para o lote; o hash sai da fila e espera o TTL do KV.
                    Err(RdAutofetchError::Quarantined) => {}
                    Err(RdAutofetchError::Cooldown) => {
                        report.stopped = true;
                        break;
                    }
                    // Store quebrado fecha o caminho: nenhuma escrita sem intent.
                    Err(RdAutofetchError::StoreUnavailable) => {
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
                    // Falha local/transitória: o intent fica de pé (quarentena).
                    Err(_) => {}
                }
            }
            if !pending.is_empty() {
                self.classify(api_key, &account, pending, &mut report).await;
            }
            report
        })
    }
}
