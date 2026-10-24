//! Camada de acesso ao `crawl.db` (SQLite via rusqlite).
//!
//! Responsabilidades:
//! - **schema**: DDL das tabelas `crawl_url`, `crawl_run`, `crawl_state` e
//!   migração idempotente.
//! - **ops**: `CrawlStore` com todas as operações (upsert, take_next,
//!   mark_result, counters, state, runs, etc.).
//! - **gate_ops**: operações de portão (`crawl_gate` + status `gate-pending`).
//!
//! Port Rust do TypeScript `utils/crawl-store-migrate.ts` + `utils/crawl-store.ts`.

mod gate_ops;
/// Enfileiramento/consulta da lane do Mico (descoberta própria).
pub mod mico_ops;
pub mod ops;
pub mod schema;
pub mod types;
/// Identidade de página (`url_key` = caminho da URL) — porta de `crawl-url-key.ts`.
pub mod url_key;

#[cfg(test)]
mod tests;
// Segunda metade dos testes da camada store: separada para a fonte .rs ficar
// abaixo da catraca de 400 linhas do CI Rust; reusa os helpers de `tests`.
#[cfg(test)]
mod tests_part2;

// Re-exports para conveniência do consumidor.
pub use mico_ops::EnqueueReport;
pub use ops::{CrawlStore, MarkResult, StatusCounters, StoreError, UrlRow};
