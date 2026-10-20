//! Fundação do debrid em Rust.
//!
//! Premiumize, Debrid-Link, Real-Debrid, TorBox e AllDebrid têm adaptador.
//! HTTP `/debrid/check` cobre PM/TB/RD/DL via `verdict.rs`; AllDebrid fica
//! 501 com `DEBRID_AL_RUST=off` (default) e a checagem nativa responde em
//! `on`. A limpeza segura (`alldebrid_cleanup` + `alldebrid_delete`) é opt-in
//! por `DEBRID_AL_CLEANUP` e só age com `holds_complete` + inventário; sem
//! isso a nativa é read-only e NÃO substitui a rota Node (F4.6).
//! A costura AD em `verdict::check_service` segue para o adom-search
//! in-process. `account`/`files` limitados; link da AllDebrid existe.
//! `/debrid/resolve` não grava magnetdb, cache nem ledger.
//! Com `DEBRID_RUST_SERVICES` vazio o Node não chama esta API.
//! `internal_check.rs` é o cliente de RESERVA da rota `/internal/debrid/check`
//! do Node.

pub mod alldebrid;
pub mod alldebrid_clean_shadow;
// Limpeza segura (hold/`adprot`/`knownBefore`, plano) e fila de delete com
// backoff. Flag `DEBRID_AL_CLEANUP` (default OFF) e kill-switch próprio.
pub mod alldebrid_cleanup;
pub mod alldebrid_delete;
// Flag da checagem nativa da AllDebrid (`DEBRID_AL_RUST`), lida pela API
// interna e pelo `adom-search`.
pub mod alldebrid_mode;
// Inventário PRONTO da conta como fonte (F3): leitura pura, sem memo/efeitos.
pub mod account;
pub mod api;
pub mod debridlink;
pub mod error;
pub mod http;
pub mod import;
pub mod internal_check;
pub mod metrics;
pub mod premiumize;
pub mod realdebrid;
pub mod resolve_effects;
pub mod store;
pub mod torbox;
pub mod verdict;

pub use error::DebridError;
pub use http::{Call, HttpClient};
pub use import::{export_owned, import_once, OWNED_PREFIXES};
pub use metrics::Metrics;
pub use store::Store;

/// Trava ÚNICA dos testes que tocam env (bases de API em loopback). Cada
/// módulo de teste tinha a sua — e testes paralelos de módulos diferentes
/// sujavam a env uns dos outros.
#[cfg(test)]
pub(crate) mod test_env {
    use std::sync::{Mutex, MutexGuard, OnceLock};
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    pub fn lock() -> MutexGuard<'static, ()> {
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|err| err.into_inner())
    }
}
