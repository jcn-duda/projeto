//! Tipos públicos do cliente Jackett — alinhados ao `mapResults` do TS e ao
//! que `collectRaw` / `RawItem` esperam na entrada do build.

use serde::{Deserialize, Serialize};

/// Item cru Torznab já normalizado (saída de [`crate::jackett::map_results`]).
///
/// Campos batem com o objeto que o TS monta em `jackett-results.ts`: magnet,
/// infoHash, seeders, size, publishedAt, tracker, indexer, downloadUrl, isBr.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JackettRawItem {
    pub title: String,
    /// `MagnetUri` ou `Guid` (pode ser magnet ou URL).
    pub magnet: Option<String>,
    pub info_hash: Option<String>,
    pub seeders: Option<f64>,
    /// Bytes quando o Jackett informa `Size`.
    pub size: Option<f64>,
    /// `PublishDate` em epoch ms; ausente se o parse falhar.
    pub published_at: Option<i64>,
    pub tracker: Option<String>,
    /// Id estável do plano (`indexer` passado na consulta) ou TrackerId.
    pub indexer: String,
    /// `Link` Torznab — input de TERCEIRO; só resolve com guarda SSRF.
    pub download_url: Option<String>,
    /// Flag do indexer BR **ou** `looks_pt_br(title)`.
    pub is_br: bool,
}

/// Resultado de UMA consulta a um indexer (espelha o retorno de `queryIndexer`).
#[derive(Debug, Clone, PartialEq)]
pub struct QueryOutcome {
    pub indexer: String,
    pub items: Vec<JackettRawItem>,
    /// Custo total desta chamada (ms).
    pub ms: u64,
    /// `true` quando nenhuma ida Torznab aconteceu (reservado; nesta fatia
    /// ainda não há cache `raw:v1` — sempre `false`).
    pub from_cache: bool,
    /// Separação transporte × fonte: `false` só com falha declarada no
    /// envelope `Indexers[]` e lista vazia.
    pub source_ok: bool,
    pub source_error: Option<String>,
}

/// Opções de uma busca (subconjunto do `JackettSearchOptions` do TS).
#[derive(Debug, Clone, Default)]
pub struct SearchOptions {
    /// Varredura tardia: falha não pinta o card / não alimenta o breaker.
    pub record_status: Option<bool>,
    /// Varredura tardia: consulta mesmo com circuito aberto.
    pub ignore_breaker: bool,
    /// Não resolve `Link` → magnet (warmup / matéria-prima).
    pub skip_resolve: bool,
    /// Orçamento dedicado (colhedor index-only); `None` = `budget_for`.
    pub timeout_ms: Option<u64>,
    /// Cascata: grafia arábica (só BR).
    pub variant_query: Option<String>,
    /// Cascata: fallback bilíngue.
    pub fallback_query: Option<String>,
    /// Cascata: raiz da franquia (só BR).
    pub franchise_query: Option<String>,
    /// Cascata: coleção multiobra (só BR, complementar).
    pub multi_work_query: Option<String>,
    /// Cascata: título original (TMDB).
    pub original_query: Option<String>,
}

impl SearchOptions {
    pub fn record_status(&self) -> bool {
        self.record_status.unwrap_or(true)
    }
}

/// Tipo Torznab da consulta (`movie` → Category 2000, `series` → 5000).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JackettMediaType {
    Movie,
    Series,
    /// Sem filtro de categoria na URL.
    Any,
}

impl JackettMediaType {
    pub fn parse(raw: &str) -> Self {
        match raw.trim() {
            "series" => Self::Series,
            "movie" => Self::Movie,
            _ => Self::Any,
        }
    }

    pub fn category_bucket(self) -> u32 {
        match self {
            Self::Movie => 2000,
            Self::Series => 5000,
            Self::Any => 0,
        }
    }
}
