//! Tipos da fila `harvest:v1:q` — espelho de `HarvestEntry` / `EnqueueOutcome`
//! em `src/providers/harvest-queue.ts`.

use serde::{Deserialize, Serialize};

/// Tipo de obra na fila (filme ou série).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HarvestMediaType {
    Movie,
    Series,
}

impl HarvestMediaType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Movie => "movie",
            Self::Series => "series",
        }
    }

    /// Aceita só `"movie"` / `"series"` (mesmo contrato do enqueue TS).
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "movie" => Some(Self::Movie),
            "series" => Some(Self::Series),
            _ => None,
        }
    }
}

/// Uma obra a colher. Espelho de `HarvestEntry` no TS.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarvestEntry {
    pub imdb_id: String,
    #[serde(rename = "type")]
    pub media_type: HarvestMediaType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub season: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub episode: Option<i32>,
    pub reason: String,
    /// Epoch ms do pedido original — promoção NÃO reseta (anti-fome).
    pub enqueued_at: i64,
    /// Janela própria do `br-gap` (Fase 5). Ausente em entrada antiga.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority_at: Option<i64>,
    /// Preempção de painel — head com `enqueued_at` original.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub resumed: bool,
    /// Sonda dirigida: execução probe OR-aderente.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub br_probe: bool,
    /// Nasceu FULL e ganhou flag probe por promoção.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub full_base: bool,
}

/// Pedido de enqueue sem `enqueued_at` (o relógio preenche no aceite).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HarvestRequest {
    pub imdb_id: String,
    pub media_type: HarvestMediaType,
    pub season: Option<i32>,
    pub episode: Option<i32>,
    pub reason: String,
    pub br_probe: bool,
}

impl HarvestRequest {
    pub fn movie(imdb_id: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            imdb_id: imdb_id.into(),
            media_type: HarvestMediaType::Movie,
            season: None,
            episode: None,
            reason: reason.into(),
            br_probe: false,
        }
    }

    pub fn series(
        imdb_id: impl Into<String>,
        season: i32,
        episode: Option<i32>,
        reason: impl Into<String>,
    ) -> Self {
        Self {
            imdb_id: imdb_id.into(),
            media_type: HarvestMediaType::Series,
            season: Some(season),
            episode,
            reason: reason.into(),
            br_probe: false,
        }
    }
}

/// Motivo do resultado do enqueue (espelho de `EnqueueOutcome.reason`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnqueueReason {
    Disabled,
    Invalid,
    Queued,
    Promoted,
    Duplicate,
    /// Dedupe 12h — stub: só quando o caller ligar o mapa (Fase E real).
    Dedupe,
    /// Obra em voo no worker — stub: precisa de `harvest-inflight`.
    Coalesced,
}

impl EnqueueReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::Invalid => "invalid",
            Self::Queued => "queued",
            Self::Promoted => "promoted",
            Self::Duplicate => "duplicate",
            Self::Dedupe => "dedupe",
            Self::Coalesced => "coalesced",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EnqueueOutcome {
    pub accepted: bool,
    pub reason: EnqueueReason,
}

impl EnqueueOutcome {
    pub fn rejected(reason: EnqueueReason) -> Self {
        Self {
            accepted: false,
            reason,
        }
    }

    pub fn accepted(reason: EnqueueReason) -> Self {
        Self {
            accepted: true,
            reason,
        }
    }
}
