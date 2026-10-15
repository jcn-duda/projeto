//! Fundação do debrid em Rust.
//!
//! Premiumize já tem adaptador. A API interna ainda responde 501 até o fio
//! do `adom-server`. Com `DEBRID_RUST_SERVICES` vazio o Node não chama esta API.

pub mod api;
pub mod error;
pub mod http;
pub mod import;
pub mod metrics;
pub mod premiumize;
pub mod store;

pub use error::DebridError;
pub use http::{Call, HttpClient};
pub use import::{export_owned, import_once, OWNED_PREFIXES};
pub use metrics::Metrics;
pub use store::Store;
