//! Fundação do debrid em Rust.
//!
//! Premiumize, Debrid-Link, Real-Debrid, TorBox e AllDebrid já têm adaptador.
//! A API interna liga check, link, resolve, conta e arquivos de Premiumize,
//! Debrid-Link e Real-Debrid. O check do Real-Debrid, TorBox e AllDebrid
//! seguem em 501. O `/debrid/resolve` não grava magnetdb, cache nem ledger.
//! Com `DEBRID_RUST_SERVICES` vazio o Node não chama esta API.

pub mod alldebrid;
pub mod alldebrid_clean_shadow;
pub mod api;
pub mod debridlink;
pub mod error;
pub mod http;
pub mod import;
pub mod metrics;
pub mod premiumize;
pub mod realdebrid;
pub mod resolve_effects;
pub mod store;
pub mod torbox;

pub use error::DebridError;
pub use http::{Call, HttpClient};
pub use import::{export_owned, import_once, OWNED_PREFIXES};
pub use metrics::Metrics;
pub use store::Store;
