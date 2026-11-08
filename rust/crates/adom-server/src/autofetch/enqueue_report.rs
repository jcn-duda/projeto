//! Saída de um lote do Chupim: o que foi aceito, o que ficou na fila e os
//! motivos de desistência.
//!
//! Separado de [`super::enqueue`] pela catraca de linhas: é o CONTRATO com o
//! worker (`serve_jobs::enqueue_batch` lê `skips`/`refused`/`enqueued`/
//! `search_key`/`season_hints`), não a decisão.

use std::collections::BTreeMap;

use adom_autofetch::v3::{AutofetchDebrid, QueueCandidate, QueueV3};

use super::gates::LivePolicy;
use super::user_policy::UserPolicy;
use crate::autofetch::season_fill::SeasonHint;
use crate::autofetch::Policy;

/// Resultado de um lote: o que foi aceito, o que ficou na fila e os motivos.
#[derive(Debug, Default)]
pub(crate) struct Report {
    pub(crate) search_key: String,
    /// Hashes aceitos pelo debrid, com o id do transfer (vão para o lote).
    pub(crate) enqueued: Vec<(String, Option<String>)>,
    pub(crate) attempts: usize,
    pub(crate) deferred: usize,
    pub(crate) dropped: usize,
    pub(crate) queue_len: usize,
    /// Motivo de desistência → contagem (`autofetch.skip.<motivo>`).
    pub(crate) skips: BTreeMap<String, usize>,
    /// Fatos do PACK por hash (título do release, obra declarada). Vão para o
    /// lote do recheck; o preenchimento de temporada lê de lá.
    pub(crate) season_hints: BTreeMap<String, SeasonHint>,
    /// Lote inteiro recusado por um motivo só (sem escrita nenhuma).
    pub(crate) refused: Option<&'static str>,
    /// Política do usuário deste lote e a qualidade de cada BR aceito: vão
    /// para o lote do recheck, que é de onde o dreno lê o teto por qualidade.
    pub(crate) user: UserPolicy,
    pub(crate) qualities: BTreeMap<String, String>,
}

impl Report {
    /// `pub(crate)` porque o registro do aceite no índice (`index_record`) conta
    /// os próprios motivos neste mesmo `skips` (canal único do painel).
    pub(crate) fn skip(&mut self, label: &str) {
        *self.skips.entry(label.to_string()).or_default() += 1;
    }

    pub(super) fn refused(search_key: &str, label: &'static str) -> Self {
        Self {
            search_key: search_key.to_string(),
            refused: Some(label),
            ..Self::default()
        }
    }
}

/// Passo 5 do lote: a fila vira `attempts ∪ deferred` (escritor único). O corte
/// por profundidade é do `write_queue` (mesma régua do `writeQueue` do Node);
/// fila desligada ou vazia cai inteira.
pub(super) fn write_queue(
    queue: &QueueV3<'_>,
    live: &LivePolicy,
    policy: Policy,
    search_key: &str,
    out: &[QueueCandidate],
    scope: (&str, &str),
    now_ms: i64,
) -> Result<(), String> {
    if !live.queue_enabled || live.queue_depth == 0 || out.is_empty() {
        return queue.drop_queue(search_key).map(drop);
    }
    queue.write_queue(
        search_key,
        out,
        policy.queue_ttl_seconds,
        live.queue_depth,
        Some(scope),
        now_ms,
    )
    .map(drop)
}

/// Fim do lote, holds já soltos: o que a checagem deste lote pôs na conta e não
/// foi aceito volta à limpeza normal (`release_check`; na AllDebrid checar é
/// upload). Falha só vai ao log — a sobra fica como antes, nunca derruba o lote.
pub(super) async fn release_leftovers(
    debrid: &dyn AutofetchDebrid<Error = String>,
    hashes: &[String],
    accepted: &[(String, Option<String>)],
) {
    let leftovers: Vec<String> = hashes
        .iter()
        .filter(|hash| !accepted.iter().any(|(done, _)| done == *hash))
        .cloned()
        .collect();
    if let Err(err) = debrid.release_check(&leftovers).await {
        eprintln!("[autofetch] sobra da checagem fica na conta: {err}");
    }
}
