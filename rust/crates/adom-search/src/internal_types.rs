//! Tipos de fio das rotas internas `/internal/search/*` (Node ↔ orquestrador).
//!
//! Espelham o JSON real de `src/routes/internal-search*.ts`. Campos opacos
//! (meta Cinemeta, RawItem cru, payloads de efeito) ficam em `Value` — o glue
//! não reparseia o domínio; o orquestrador decide depois. Índice/banco/coleta
//! não viajam mais pelo fio: `ReleaseEntry` só alimenta a escrita NATIVA e
//! `LiveSnapshot` só sobrevive como contrato de replay do gate congelado.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Escopo de coleta (`priority`/`nonpriority`/`all`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskScope {
    #[default]
    All,
    Priority,
    Nonpriority,
}

impl TaskScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::Priority => "priority",
            Self::Nonpriority => "nonpriority",
        }
    }
}

/// Corpo de erro curto das rotas internas (`{ ok:false, error }`).
#[derive(Debug, Clone, Deserialize)]
pub struct ErrorBody {
    pub ok: bool,
    #[serde(default)]
    pub error: String,
}

// ── meta ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct MetaRequest {
    pub encoded: String,
    #[serde(rename = "type")]
    pub media_type: String,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_multiwork: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_home_release: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MetaResponse {
    pub ok: bool,
    #[serde(rename = "type")]
    pub media_type: String,
    pub id: String,
    pub imdb_id: String,
    #[serde(default)]
    pub season: Option<i64>,
    #[serde(default)]
    pub episode: Option<i64>,
    /// Miss honesto = `null` (não é erro HTTP).
    #[serde(default)]
    pub meta: Option<Value>,
    #[serde(default)]
    pub titles: Option<Value>,
    /// Só presente quando `include_multiwork` foi true.
    #[serde(default, rename = "multiWork")]
    pub multi_work: Option<Value>,
    /// Só presente quando `include_home_release` foi true (epoch ms).
    #[serde(default, rename = "homeReleaseAt")]
    pub home_release_at: Option<i64>,
}

// ── collect ─────────────────────────────────────────────────────────────────

/// Estado vivo POR indexer do lote (`live.snapshot()`), preservado só para o
/// replay do gate congelado. `None` = fonte sem contrato vivo: ausência NUNCA
/// prova sucesso.
#[derive(Debug, Clone, Deserialize)]
pub struct LiveSnapshot {
    #[serde(default)]
    pub failed: Vec<String>,
    #[serde(default)]
    pub pending: Vec<String>,
    #[serde(default)]
    pub empty: Vec<String>,
    #[serde(default)]
    pub all: String,
}

// ── índice nativo ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct ReleaseEntry {
    pub imdb: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub season: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub episode: Option<i64>,
    pub items: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entered: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub survivors: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

// ── effects ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct EffectEntry {
    pub kind: String,
    pub payload: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EffectsRequest {
    pub encoded: String,
    pub effects: Vec<EffectEntry>,
}

/// Resposta **202** — só contagens; side-effect é fire-and-forget.
#[derive(Debug, Clone, Deserialize)]
pub struct EffectsResponse {
    pub ok: bool,
    pub accepted: i64,
    pub rejected: i64,
}
