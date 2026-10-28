//! Fundação do debrid em Rust.
//!
//! Premiumize, Debrid-Link, Real-Debrid, TorBox e AllDebrid têm adaptador.
//! HTTP `/debrid/check` cobre os cinco via `verdict.rs`; a checagem da
//! AllDebrid é nativa e INCONDICIONAL desde a R3 (não há mais rota Node).
//! A limpeza segura (`alldebrid_cleanup` + `alldebrid_delete`) é opt-in
//! por `DEBRID_AL_CLEANUP` e só age com `holds_complete` + inventário; sem
//! isso a nativa é read-only. O hold volátil do autofetch mora no Node: o
//! sidecar recebe os fatos no corpo e o seam in-process pelo feed de holds
//! (`holds_feed`, `DEBRID_AL_HOLDS`, default OFF).
//! A costura AD em `verdict::check_service` segue para o adom-search
//! in-process. `account` cobre os quatro adaptadores que publicam
//! `accountStatus`; `files` só o Premiumize e o link da AllDebrid existe.
//! `/debrid/resolve` não grava magnetdb, cache nem ledger.
//! Com `DEBRID_RUST_SERVICES` vazio o Node não chama esta API.
//! `holds_feed.rs` e `marks_feed.rs` são os ÚNICOS que falam com rotas
//! internas do Node: `/internal/debrid/holds` (fatos do hold) e
//! `/internal/debrid/marked` (devolução de `adsub`/`adrm`, dono único do
//! `cache.db`).
//! `play.rs` é o dispatch do play nativo (`/resolve` do gateway, incondicional):
//! os cinco adaptadores, com o mesmo `pickFile` e a mesma
//! prova de áudio (`play_audit`) do TS; efeitos L1 continuam no Node.

pub mod alldebrid;
// Limpeza segura (hold/`adprot`/`knownBefore`, plano) e fila de delete com
// backoff. Flag `DEBRID_AL_CLEANUP` (default OFF) e kill-switch próprio.
pub mod alldebrid_cleanup;
pub mod alldebrid_delete;
// Inventário PRONTO da conta como fonte (F3): leitura pura, sem memo/efeitos.
pub mod account;
/// Memo local, não bloqueante e fail-open da ocupação da conta no autofetch.
pub mod account_gate;
pub mod api;
/// Portas do autofetch v3 (`adom_autofetch::v3::AutofetchDebrid`) para os cinco
/// adaptadores: a chave entra no construtor (`adapter:account`), nunca no
/// `QueueCandidate`; `unknown` nunca vira morte e capacidade inexistente é
/// desligada explicitamente. O `impl` do trait mora em
/// `adom-server/src/autofetch` porque `adom-autofetch` e `adom-debrid` estão em
/// ciclo de pacote — os dados do contrato vêm espelhados de
/// `autofetch_ports_contract`.
pub mod autofetch_ports;
pub mod debridlink;
/// Orçamento deslizante de enqueues por hora, por `adapter:account` (porte do
/// `checkAndRecordBudget`/`blockBudget` do TS); puro em memória, `now_ms` do
/// chamador.
pub mod enqueue_budget;
pub mod error;
/// Feed do hold volátil do autofetch para o seam in-process
/// (`DEBRID_AL_HOLDS`, default OFF) — rota `/internal/debrid/holds` do Node.
pub mod holds_feed;
pub mod http;
/// Devolução das marcas da limpeza nativa (`adsub`/`adrm`) ao Node — rota
/// `/internal/debrid/marked`. Fail-open; gate em `DEBRID_AL_CLEANUP=on`.
pub mod marks_feed;
pub mod metrics;
/// Play nativo: dispatch por adaptador (usado pelo `/resolve` do gateway).
pub mod play;
/// Prova de áudio no play (`assertDubbedFiles`) compartilhada pelos adaptadores.
pub mod play_audit;
pub mod premiumize;
pub mod realdebrid;
/// Primitivos RD de autofetch; requer NativeKv compartilhado antes de ligar rede.
pub mod realdebrid_autofetch;
pub mod resolve_effects;
pub mod store;
pub mod torbox;
pub mod verdict;

pub use autofetch_ports::{
    scope_of, AccountEvidence, AlldebridFacts, AutofetchPorts, CacheEvidence, Capabilities,
    DebridFuture, EnqueueEvidence, PortCandidate, PortError, RdLedgerPeek, RdPorts, Service,
    TorrentEvidence, TorrentProgress,
};
pub use enqueue_budget::EnqueueBudget;
pub use error::DebridError;
pub use http::{Call, HttpClient};
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
pub mod rd_gate_executor;
pub mod rd_scheduler;
