//! Revalidação SWR em fundo — separada de `search.rs` pela catraca de linhas.

use serde_json::Value;

use crate::request::encoded_for_internal;

use super::finish::SearchInput;
use super::respond::{as_ms, now_ms, StreamRequest};
use super::Orchestrator;

impl Orchestrator {
    /// Revalidação em fundo de um hit stale. Mapa PRÓPRIO (`refreshing`): não
    /// coalesce com a busca síncrona nem a impede de começar.
    pub(super) fn spawn_stale_refresh(&self, key: String, req: StreamRequest, options: Value) {
        {
            let mut refreshing = self.refreshing.lock().expect("refreshing");
            if !refreshing.insert(key.clone()) {
                return;
            }
        }
        let this = self.clone();
        tokio::spawn(async move {
            let now = now_ms();
            // Revalida ANTES de pagar a busca: passe tardio, recheck do
            // autofetch ou outra requisição podem ter reescrito a entrada.
            // A geração sai da MESMA leitura (`get_fenced`): é ela que o
            // commit da revalidação leva consigo.
            let (hit, fence) =
                this.store
                    .get_fenced(&key, this.config.stale_grace_seconds, as_ms(now));
            let ainda_stale = hit.map(|hit| hit.stale).unwrap_or(true);
            if ainda_stale {
                let input = SearchInput {
                    kind: req.kind.clone(),
                    id: req.id.clone(),
                    encoded: Some(encoded_for_internal(req.encoded.as_deref())),
                    prefix: req.prefix(),
                    options,
                    key: key.clone(),
                    now_ms: now,
                    // Passe de fundo tem o orçamento COMPLETO (sem deadlineAt
                    // encurtado), como no `scheduleStaleRefresh`.
                    deadline_at: None,
                    fence,
                };
                let in_flight = this.in_flight.clone();
                in_flight
                    .coalesce(&key, || {
                        let this = this.clone();
                        async move { this.run_search(input).await }
                    })
                    .await;
            }
            this.refreshing.lock().expect("refreshing").remove(&key);
        });
    }
}
