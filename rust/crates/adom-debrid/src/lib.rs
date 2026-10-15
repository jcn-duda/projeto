//! Fundação do debrid em Rust (fase D0).
//!
//! Os cinco adaptadores ainda não moram aqui. Este crate entrega o cliente
//! HTTP, a taxonomia de erro, o `debrid.db` e a API interna que o `adom-server`
//! escuta em loopback. Enquanto `DEBRID_RUST_SERVICES` estiver vazio, o Node
//! não chama esta API.

pub mod api;
pub mod error;
pub mod http;
pub mod import;
pub mod metrics;
pub mod store;

pub use error::DebridError;
pub use http::{Call, HttpClient};
pub use import::{export_owned, import_once, OWNED_PREFIXES};
pub use metrics::Metrics;
pub use store::Store;
