//! Corpo de `POST /internal/search/collect` (Node ↔ orquestrador).
//!
//! Extraído de `internal_types.rs` pela catraca de 400 linhas. `read_only` e
//! `shadow_source` são o contrato da sombra de fonte (F2.1/F2.2); o caminho de
//! resposta nunca liga os dois.

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
    /// Referência de sombra: o Node coleta SEM efeitos (inventário da conta,
    /// captura no banco, status/breaker e cache bruto). Só a sombra de fonte
    /// liga; o caminho de resposta nunca.
    #[serde(default, skip_serializing_if = "is_false")]
    pub read_only: bool,
    /// Fonte que a sombra quer comparar (`jackett`/`prowlarr`). A rota
    /// read-only confere se ela está habilitada nos `providers` efetivos;
    /// ausente = `eligible:false` e nada é coletado.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shadow_source: Option<String>,
    /// `JACKETT_INDEXERS` do PROCESSO como FALLBACK do `ji` da request na rota
    /// read-only (C0b): `None` = o Node usa a seleção que veio no job.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub indexers: Option<Vec<String>>,
}

fn is_false(value: &bool) -> bool {
    !*value
}
