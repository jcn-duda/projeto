//! Types compartilhados do motor do raspador (C4).
//!
//! Espelham os types do TypeScript (crawl-types.ts) para manter compatibilidade
//! entre o sidecar Rust e o Node.js.

use serde::{Deserialize, Serialize};

/// Status de uma URL trabalhada (espelha CrawlResultStatus do TS).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum CrawlResultStatus {
    Done,
    NoTorrent,
    NoWork,
    Error,
    Simulated,
    Partial,
}

/// Resultado de UMA página trabalhada (espelha CrawlWorkResult do TS crawl-types.ts:243-295).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrawlWorkResult {
    pub url: String,
    pub url_key: String,
    pub site: String,
    pub status: CrawlResultStatus,
    pub imdb: Option<String>,
    pub title: Option<String>,
    pub year: Option<i64>,
    pub kind: String, // "movie" | "series"
    pub releases: Vec<CrawlRawItem>,
    pub groups: Vec<CrawlReleaseGroup>,
    pub unlocated: Vec<CrawlRawItem>,
    pub progress: Option<String>, // JSON SeriesWorkProgress
    pub request_cost: u32,
    pub error: String,
}

/// Item cru de release (espelha RawItem do TS).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrawlRawItem {
    pub title: String,
    pub magnet: Option<String>,
    pub link: Option<String>,
    pub size: Option<String>,
    pub seeders: Option<u32>,
    pub tracker: Option<String>,
    pub is_br: bool,
}

/// Grupo de releases (séries: S/E, S, raiz).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrawlReleaseGroup {
    pub season: Option<u32>,
    pub episode: Option<u32>,
    pub releases: Vec<CrawlRawItem>,
}

/// Config do motor (lida do .env / config).
#[derive(Debug, Clone)]
pub struct MotorConfig {
    pub max_parallel: usize,         // default 3
    pub delay_ms: u64,               // default 1000
    pub max_per_hour: u32,           // default 1500
    pub max_tries: u32,              // default 3
    pub error_pause_streak: u32,     // default 5
    pub idle_window_ms: u64,         // default 600_000 (10 min)
    pub step_deadline_ms: u64,       // default 700_000
    pub flare_step_deadline_ms: u64, // default 2_660_000
    pub node_url: String,            // "http://127.0.0.1:<porta>"
    pub admin_token: String,         // token no header
}

impl Default for MotorConfig {
    fn default() -> Self {
        Self {
            max_parallel: 3,
            delay_ms: 1000,
            max_per_hour: 1500,
            max_tries: 3,
            error_pause_streak: 5,
            idle_window_ms: 600_000,
            step_deadline_ms: 700_000,
            flare_step_deadline_ms: 2_660_000,
            node_url: "http://127.0.0.1:3000".to_string(),
            admin_token: String::new(),
        }
    }
}

/// Snapshot do status do motor (para o painel).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MotorStatus {
    pub active: bool,
    pub sites: Vec<SiteStatus>,
    pub pages_this_hour: u32,
    pub global_paused: bool,
}

/// Status de um site individual.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SiteStatus {
    pub site_id: String,
    pub pending: u32,
    pub done: u32,
    pub no_torrent: u32,
    pub error: u32,
    pub inflight: u32,
    pub releases: u32,
}
