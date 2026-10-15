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
    /// Post que só publica o botão do portão (BLUDV): aguarda o executor de
    /// fundo pagar o portão. Não é falha nem `no-torrent` — é pendência de
    /// custo, resolvida fora do passo de raspagem.
    pub gate_pending: u32,
}

/// Registro de pendência de portão que o motor grava quando o parser devolve
/// um post só-gate (`mark_gate_pending`). Os metadados vêm do que a leitura da
/// página já colheu — o executor de fundo nunca volta ao site.
#[derive(Debug, Clone)]
pub struct GatePendingRecord {
    pub gate: String,
    pub title: String,
    pub year: i64,
    pub imdb: String,
    pub kind: String,
}

/// O que o executor de fundo precisa de UM post pendente de portão: a linha da
/// fila + os metadados gravados na `crawl_gate` quando o post foi marcado.
#[derive(Debug, Clone)]
pub struct GateRow {
    /// Linha do post na `crawl_url` (status `gate-pending`).
    pub row: UrlRow,
    /// Href do botão do portão (input do resolver local).
    pub gate: String,
    /// Título de obra do `<h1>` (vazio = a leitura não colheu).
    pub title: String,
    /// Ano do post (0 = desconhecido).
    pub year: i64,
    /// IMDb da ficha (vazio = desconhecido; o Node identifica por título/ano).
    pub imdb: String,
    /// "movie" | "tv_show" — o vocabulário da fila.
    pub kind: String,
}
