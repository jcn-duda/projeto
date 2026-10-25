//! Entrega da página à INGESTÃO NATIVA (T3-L3).
//!
//! Este é o elo que substituiu o `POST /internal/crawl-result`: a página é
//! gravada NO PROCESSO (banco vivo → índice → invalidação), com a mesma cerca
//! do prazo do passo. O POST antigo não acontece mais — fazer os dois gravaria
//! a mesma página duas vezes.
//!
//! `delivered` mantém a semântica que o motor já tinha: `true` = a ingestão
//! aceitou o resultado (gravou ou deu veredito terminal), `false` = a linha
//! volta com backoff (`PageReport.retryable` ou erro de store/catálogo).

use tokio::time::Instant;

use super::r#loop::BatchCtx;
use super::types::{now_ms, CrawlWorkResult};
use crate::ingest::IngestOptions;

/// Entrega UMA página. `deadline_at` é a MESMA cerca que interrompeu a engine:
/// o `should_abort` da ingestão vira verdadeiro quando o passo estourou.
pub(super) async fn deliver_page(
    ctx: &BatchCtx,
    site: &str,
    work: &mut CrawlWorkResult,
    deadline_at: Instant,
) -> bool {
    let Some(ingest) = ctx.ingest.clone() else {
        // O tick não reivindica sem ingestão; aqui é só o cinto de segurança.
        eprintln!(
            "[motor] ingestão indisponível; {} não foi entregue",
            work.url_key
        );
        work.error = "ingest-pendente".to_string();
        return false;
    };
    let should_abort = || Instant::now() >= deadline_at;
    let options = IngestOptions {
        should_abort: Some(&should_abort),
    };
    match ingest.apply_page(site, work, now_ms(), options).await {
        Ok(report) if !report.retryable => true,
        Ok(report) => {
            // `unavailable`/store: a página volta com backoff, como no 500.
            let motivo = report.reason.as_deref().unwrap_or("reentrega");
            eprintln!(
                "[motor] ingestão pediu reentrega de {}: {motivo}",
                work.url_key
            );
            if work.error.is_empty() {
                work.error = format!("ingest: {motivo}");
            }
            false
        }
        Err(err) => {
            eprintln!("[motor] ingestão recusou {}: {err}", work.url_key);
            if work.error.is_empty() {
                work.error = format!("ingest: {err}");
            }
            false
        }
    }
}
