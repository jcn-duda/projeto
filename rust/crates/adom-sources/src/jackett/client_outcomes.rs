//! Busca com desfecho POR INDEXER (F2.1).
//!
//! A API legada [`JackettClient::search`] devolve só itens — o que fazia o
//! breaker/skips e os `timeout` sumirem antes do collect. Aqui o mesmo `search`
//! roda a mesma topologia, mas preserva um [`QueryOutcome`] por indexer:
//!
//! - `Ok`/`Empty`: resposta válida (vazio saudável NÃO é falha);
//! - `Failed`: HTTP/rede/envelope/breaker/**timeout** — sem engolir o motivo
//!   (o Node também trata prazo vencido como `responded:false`);
//! - `record_status:false` (varredura inline/tardia) viaja no outcome para o
//!   collect não alimentar `live`/`partial` com uma consulta secundária.
//!
//! Lista vazia de indexers cai no agregado `/all` (um outcome com
//! [`ALL_QUERY_INDEXER`]). O comportamento fail-open é o mesmo: erro vira
//! outcome, jamais `Err` que derrube a busca.

use super::JackettClient;
use crate::jackett::types::{
    IndexerStatus, JackettMediaType, QueryOutcome, SearchOptions, ALL_QUERY_INDEXER,
};

impl JackettClient {
    /// Consulta a lista de indexers em paralelo devolvendo UM outcome por
    /// indexer (mais o agregado `/all` quando a lista é vazia).
    pub async fn search_outcomes(
        &self,
        query: &str,
        media_type: JackettMediaType,
        indexers: &[String],
        options: &SearchOptions,
    ) -> Vec<QueryOutcome> {
        if !self.config.has_api_key() {
            eprintln!("[jackett] JACKETT_API_KEY não configurada");
            return unavailable_outcomes(
                indexers,
                "JACKETT_API_KEY não configurada",
                options.record_status(),
            );
        }
        if query.is_empty() {
            return unavailable_outcomes(indexers, "query vazia", options.record_status());
        }

        if indexers.is_empty() {
            return vec![self.search_all_outcome(query, media_type, options).await];
        }

        let active: Vec<String> = if options.ignore_breaker {
            indexers.to_vec()
        } else {
            let now = crate::http::now_ms();
            indexers
                .iter()
                .filter(|indexer| {
                    if !self.breaker.tripped(indexer, &self.config, now) {
                        self.breaker.clear_announced(indexer);
                        true
                    } else {
                        if self.breaker.should_announce_trip(indexer) {
                            let snap = self.breaker.snapshot(indexer, &self.config, now);
                            eprintln!(
                                "[jackett] {indexer}: circuit breaker aberto após {} falha(s) \
                                 seguidas; buscas pulam este indexer até {}min após a última falha",
                                snap.fail_streak.max(self.config.breaker_failures),
                                self.config.breaker_cooldown_ms / 60_000
                            );
                        }
                        false
                    }
                })
                .cloned()
                .collect()
        };

        let mut pending: Vec<(String, tokio::task::JoinHandle<QueryOutcome>)> =
            Vec::with_capacity(active.len());
        for indexer in &active {
            let this = self.clone();
            let indexer = indexer.clone();
            let query = query.to_string();
            let options = options.clone();
            pending.push((
                indexer.clone(),
                tokio::spawn(async move {
                    this.query_indexer(&indexer, &query, media_type, &options)
                        .await
                }),
            ));
        }

        let mut out = Vec::with_capacity(indexers.len());
        let mut slow = Vec::new();
        for indexer in indexers {
            let Some(pos) = pending.iter().position(|(id, _)| id == indexer) else {
                // Breaker aberto: consulta não aconteceu, mas o status NÃO é
                // engolido — o Node também reporta `responded:false` (breaker).
                slow.push(format!("{indexer} ✗ breaker"));
                out.push(failed_outcome(indexer, "breaker", options.record_status()));
                continue;
            };
            let (_, handle) = pending.remove(pos);
            match handle.await {
                Ok(outcome) => {
                    if options.record_status() && !outcome.from_cache {
                        self.breaker.record(
                            &outcome.indexer,
                            outcome.source_ok,
                            crate::http::now_ms(),
                        );
                        if !outcome.source_ok {
                            if let Some(err) = &outcome.source_error {
                                eprintln!(
                                    "[jackett] {}: fonte fora (HTTP 200): {err}",
                                    outcome.indexer
                                );
                            }
                        }
                    }
                    if !outcome.source_ok {
                        slow.push(format!("{indexer} ✗ fonte"));
                    } else if !outcome.from_cache && outcome.ms > 2_000 {
                        slow.push(format!("{indexer} {:.1}s", outcome.ms as f64 / 1000.0));
                    }
                    out.push(outcome);
                }
                Err(err) => {
                    // JoinError / panic no task — engole e segue (nunca propaga).
                    eprintln!("[jackett] {indexer}: tarefa abortada: {err}");
                    if options.record_status() {
                        self.breaker.record(indexer, false, crate::http::now_ms());
                    }
                    slow.push(format!("{indexer} ✗"));
                    out.push(failed_outcome(
                        indexer,
                        "tarefa abortada",
                        options.record_status(),
                    ));
                }
            }
        }
        if !slow.is_empty() {
            eprintln!("[jackett] lentos/falharam: {}", slow.join(", "));
        }
        out
    }
}

/// Outcome sintético de falha declarada (sem consulta/erro de tarefa).
fn failed_outcome(indexer: &str, reason: &str, record_status: bool) -> QueryOutcome {
    QueryOutcome {
        indexer: indexer.to_string(),
        items: Vec::new(),
        ms: 0,
        from_cache: false,
        source_ok: false,
        source_error: Some(reason.to_string()),
        status: IndexerStatus::Failed,
        record_status,
        primary: true,
    }
}

/// Sem chave/query: cada indexer pedido vira `Failed`; o agregado vira `*all*`.
fn unavailable_outcomes(
    indexers: &[String],
    reason: &str,
    record_status: bool,
) -> Vec<QueryOutcome> {
    if indexers.is_empty() {
        return vec![failed_outcome(ALL_QUERY_INDEXER, reason, record_status)];
    }
    indexers
        .iter()
        .map(|indexer| failed_outcome(indexer, reason, record_status))
        .collect()
}
