//! Catálogo durável da conta do operador — porte de `src/utils/catalog*.ts`.
//!
//! SQLite PRÓPRIO (`data/catalog.db`, tabela `magnet`, mesmo esquema do TS) e
//! não o cache: lá há cota, TTL e bump de namespace, que destroem conhecimento;
//! aqui é HISTÓRICO, com tombstone em vez de DELETE. Sem rede e sem relógio: o
//! `now_ms` e as provas vivas (hold, evidência, índice) entram por parâmetro.

pub mod audit;
pub mod cleanup;
pub mod dedup;
pub mod rows;
pub mod scan;

pub use rows::{is_active, CatalogStore, MarkInput, Row};
