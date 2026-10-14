//! Tipos da camada `crawl.db`: erro, linha da fila, resultado e contadores.
//! Separados de `ops` para a fonte ficar abaixo da catraca de 400 linhas.

use std::fmt;

/// Erros da camada de persistência.
#[derive(Debug)]
pub enum StoreError {
    Sqlite(String),
    Migration(String),
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Sqlite(msg) => write!(f, "sqlite: {msg}"),
            Self::Migration(msg) => write!(f, "migration: {msg}"),
        }
    }
}
impl std::error::Error for StoreError {}
impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Sqlite(e.to_string())
    }
}

/// Linha da tabela `crawl_url`. Representa uma URL na fila de trabalho.
#[derive(Debug, Clone)]
pub struct UrlRow {
    pub site: String,
    pub url: String,
    pub url_key: String,
    pub kind: String,
    pub status: String,
    pub lastmod: String,
    pub imdb: Option<String>,
    pub tries: u32,
    pub next_at: i64,
    pub checked_at: i64,
    pub releases: u32,
    pub error: String,
    pub progress: String,
    pub added_at: i64,
}

/// Resultado de processar uma URL (gravado via `mark_result`).
#[derive(Debug, Clone)]
pub struct MarkResult {
    pub status: String, // "done", "no-torrent", "error", etc.
    pub imdb: Option<String>,
    pub title: Option<String>,
    pub year: Option<i64>,
    pub releases: u32,
    pub error: String,
    pub progress: String,
    pub next_at: i64, // 0 se terminal, ou epoch ms de retry
    pub request_cost: u32,
}

/// Contadores por status (para o painel).
#[derive(Debug, Clone, Default)]
pub struct StatusCounters {
    pub pending: u32,
    pub done: u32,
    pub no_torrent: u32,
    pub no_work: u32,
    pub error: u32,
    pub inflight: u32,
    pub simulated: u32,
}
