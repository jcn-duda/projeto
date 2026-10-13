//! Camada de acesso ao `crawl.db` (SQLite via rusqlite).
//!
//! Responsabilidades:
//! - **schema**: DDL das tabelas `crawl_url`, `crawl_run`, `crawl_state` e
//!   migração idempotente.
//! - **ops**: `CrawlStore` com todas as operações (upsert, take_next,
//!   mark_result, counters, state, runs, etc.).
//!
//! Port Rust do TypeScript `utils/crawl-store-migrate.ts` + `utils/crawl-store.ts`.

pub mod ops;
pub mod schema;

#[cfg(test)]
mod tests;

// Re-exports para conveniência do consumidor.
pub use ops::{CrawlStore, MarkResult, StatusCounters, StoreError, UrlRow};
