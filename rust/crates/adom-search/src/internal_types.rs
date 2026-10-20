//! Tipos de fio das rotas internas `/internal/search/*` (Node ↔ orquestrador).
//!
//! Espelham o JSON real de `src/routes/internal-search*.ts`. Campos opacos
//! (meta Cinemeta, RawItem cru, payloads de efeito) ficam em `Value` — o glue
//! não reparseia o domínio; o orquestrador decide depois.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet};

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

#[path = "collect_request.rs"]
mod collect_request;
pub use collect_request::CollectRequest;

fn default_true() -> bool {
    true
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
    /// `false` = a fonte da sombra não está nos `providers` efetivos; o lote
    /// veio vazio de propósito e NÃO pode ser comparado. Ausente em Node
    /// antigo vale `true` (compatibilidade).
    #[serde(default = "default_true")]
    pub eligible: bool,
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

// ── fallback (reserva 📦 do banco para uma build) ───────────────────────────

/// Fatos da build que a leitura do banco precisa. A seleção em si fica no
/// núcleo (`adom_core::fallback_bank`); aqui só viajam as chaves.
#[derive(Debug, Clone, Serialize)]
pub struct FallbackRequest {
    pub encoded: String,
    #[serde(rename = "type")]
    pub media_type: String,
    pub imdb: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub season: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub episode: Option<i64>,
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub failed: BTreeSet<String>,
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub suspect: BTreeSet<String>,
    #[serde(default)]
    pub all_failed: bool,
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub live_hashes: BTreeSet<String>,
    /// Prazo ABSOLUTO desta chamada (epoch ms). O Node ignora o campo; o
    /// cliente HTTP usa o restante como timeout, como no `/collect`. Sem ele
    /// (passe tardio) vale o teto curto de `with_fallback`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deadline_at: Option<i64>,
}

/// Linhas do banco para a obra, já recortadas pela janela de leitura.
#[derive(Debug, Clone, Deserialize)]
pub struct FallbackWorkWire {
    pub hash: String,
    #[serde(default)]
    pub passed_filter: i64,
    #[serde(default)]
    pub last_seen: i64,
    #[serde(default)]
    pub magnet: Option<FallbackMagnetWire>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FallbackMagnetWire {
    pub hash: String,
    #[serde(default)]
    pub uri: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub size: i64,
    #[serde(default)]
    pub is_br: bool,
    #[serde(default)]
    pub dubbed: bool,
    #[serde(default)]
    pub quality: String,
    #[serde(default)]
    pub seeders_max: i64,
    #[serde(default)]
    pub seeders_last: i64,
    #[serde(default)]
    pub last_seen: i64,
    #[serde(default)]
    pub lied: bool,
    /// Histórico ruim da CONTA (bad/lie/dead/miss): a reserva não reapresenta.
    #[serde(default)]
    pub broken: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FallbackSourceWire {
    pub indexer: String,
    #[serde(default)]
    pub tracker: String,
    #[serde(default)]
    pub last_seen: i64,
    #[serde(default)]
    pub allowed: bool,
}

/// Config efetiva do operador + linhas. `enabled`/`fallback_enabled` deixam o
/// núcleo decidir sem uma segunda leitura de config.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct FallbackResponse {
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub fallback_enabled: bool,
    #[serde(default)]
    pub per_indexer_max: i64,
    #[serde(default)]
    pub global_max: i64,
    #[serde(default)]
    pub br_indexers: Vec<String>,
    #[serde(default)]
    pub index_only_indexers: Vec<String>,
    #[serde(default)]
    pub works: Vec<FallbackWorkWire>,
    #[serde(default)]
    pub sources: BTreeMap<String, Vec<FallbackSourceWire>>,
}
