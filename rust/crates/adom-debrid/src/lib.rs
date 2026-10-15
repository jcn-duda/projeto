//! Fundação do debrid em Rust.
//!
//! Premiumize, Debrid-Link, Real-Debrid e TorBox já têm adaptador. A API
//! interna ainda responde 501 até o fio do `adom-server`. Com
//! `DEBRID_RUST_SERVICES` vazio o Node não chama esta API.

pub mod api;
pub mod debridlink;
pub mod error;
pub mod http;
pub mod import;
pub mod metrics;
pub mod premiumize;
pub mod realdebrid;
pub mod store;
pub mod torbox;

pub use error::DebridError;
pub use http::{Call, HttpClient};
pub use import::{export_owned, import_once, OWNED_PREFIXES};
pub use metrics::Metrics;
pub use store::Store;
