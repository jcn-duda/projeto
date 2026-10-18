//! Tipos de fio das rotas internas `/internal/search/*` (Node ↔ orquestrador).
//!
//! Espelham o JSON real de `src/routes/internal-search*.ts`. Campos opacos
//! (meta Cinemeta, RawItem cru, payloads de efeito) ficam em `Value` — o glue
//! não reparseia o domínio; o orquestrador decide depois.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

/// Escopo de coleta (`collectRaw` taskScope).
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

// ── state ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct StateRequest {
    pub encoded: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub obra_keys: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hashes: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct StateResponse {
    pub ok: bool,
    /// Chave EXATA da `obra_key` pedida; sem linha → `[]`.
    #[serde(default)]
    pub obras: BTreeMap<String, Vec<Value>>,
    /// Hash ausente omitido.
    #[serde(default)]
    pub sources: BTreeMap<String, Vec<Value>>,
    /// Epoch ms; hash ausente omitido.
    #[serde(default, rename = "firstSeen")]
    pub first_seen: BTreeMap<String, i64>,
}

// ── collect ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct CollectRequest {
    pub encoded: String,
    pub query: String,
    #[serde(rename = "type")]
    pub media_type: String,
    pub imdb: String,
    /// Epoch ms absoluto — o orquestrador manda o orçamento.
    pub deadline_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_scope: Option<TaskScope>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pt_query: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub season: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub episode: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub year: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub names: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sweep_query: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_query: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub multi_work_query: Option<String>,
}

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

#[derive(Debug, Clone, Deserialize)]
pub struct BreakerSnapshot {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub tripped: bool,
    #[serde(default)]
    pub state: String,
    #[serde(default, rename = "failStreak")]
    pub fail_streak: i64,
    #[serde(default, rename = "failuresRequired")]
    pub failures_required: i64,
    #[serde(default, rename = "cooldownMs")]
    pub cooldown_ms: i64,
    #[serde(default, rename = "cooldownRemainingMs")]
    pub cooldown_remaining_ms: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CollectResponse {
    pub ok: bool,
    pub task_scope: String,
    pub query: String,
    pub imdb_id: String,
    #[serde(default)]
    pub season: Option<i64>,
    #[serde(default)]
    pub episode: Option<i64>,
    pub partial: bool,
    /// Lote cru completo (`RawItem` no fio — Value opaco).
    #[serde(default)]
    pub items: Vec<Value>,
    #[serde(default)]
    pub by_indexer: BTreeMap<String, Vec<Value>>,
    #[serde(default)]
    pub live: Option<LiveSnapshot>,
    #[serde(default)]
    pub breaker: BTreeMap<String, BreakerSnapshot>,
}

// ── index-write ─────────────────────────────────────────────────────────────

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

#[derive(Debug, Clone, Serialize)]
pub struct IndexWriteRequest {
    pub encoded: String,
    pub releases: Vec<ReleaseEntry>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct IndexWriteResponse {
    pub ok: bool,
    pub recorded: i64,
    pub entries: i64,
    pub bank_marked: i64,
    pub failed: i64,
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

// ── index (leitura do releaseIndex e via instantânea do banco) ─────────────

#[derive(Debug, Clone, Default, Serialize)]
pub struct SearchIndexRequest {
    pub encoded: String,
    #[serde(rename = "type")]
    pub media_type: String,
    pub imdb: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub season: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub episode: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub names: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub year: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub released: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_aired: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct SearchIndexResponse {
    pub ok: bool,
    #[serde(default)]
    pub is_partial: bool,
    #[serde(default)]
    pub index_covered: bool,
    #[serde(default)]
    pub instant_eligible: bool,
    #[serde(default)]
    pub index_items: Vec<Value>,
    #[serde(default)]
    pub instant_items: Vec<Value>,
    #[serde(default)]
    pub account_items: Vec<Value>,
}
