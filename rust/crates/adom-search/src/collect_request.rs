//! Corpo de `POST /internal/search/collect` (Node ↔ orquestrador).
//!
//! Extraído de `internal_types.rs` pela catraca de 400 linhas.

use serde::Serialize;
use serde_json::Value;

use super::TaskScope;

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
    /// Fontes que o Node pula (já coletadas nativamente). Vazio = nada a pular.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skip_sources: Vec<String>,
}
