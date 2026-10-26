//! Recuo da entrega recusada pela ingestão. Separado do `gate.rs` pela catraca de
//! 400 linhas; continua sendo `impl GateExecutor`.

use super::{with_store, GateExecutor, RowOutcome};
use crate::motor::types::{error_backoff_ms, now_ms};
use crate::store::ops::GateRow;

impl GateExecutor {
    /// Entrega recusada: a linha segue `gate-pending` com `next_at` no recuo
    /// exponencial do motor (`tries` conta as entregas recusadas).
    pub(super) async fn defer_delivery(&self, g: &GateRow, etapa: &str, erro: &str) -> RowOutcome {
        let tentativas = g.row.tries.saturating_add(1);
        let espera = error_backoff_ms(
            self.tuning.retry_base_ms,
            self.tuning.error_backoff_cap_ms,
            tentativas,
        );
        eprintln!(
            "[gate] {} {}: {etapa} falhou ({tentativas}ª), nova tentativa em {}s: {erro}",
            g.row.site,
            g.row.url_key,
            espera / 1000
        );
        let (site, url_key, erro) = (g.row.site.clone(), g.row.url_key.clone(), erro.to_string());
        let next_at = now_ms() + espera as i64;
        if let Err(e) = with_store(self.store.clone(), move |db| {
            db.defer_gate_delivery(&site, &url_key, next_at, &erro)
        })
        .await
        {
            eprintln!(
                "[gate] {} {}: recuo não gravado: {e}",
                g.row.site, g.row.url_key
            );
        }
        RowOutcome::Pending
    }
}
