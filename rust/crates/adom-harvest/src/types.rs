//! Tipos da fila `harvest:v1:q` e da sonda BR — espelho de `HarvestEntry` /
//! `EnqueueOutcome` (`harvest-queue.ts`) e do contrato de `br-probe.ts`.

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

/// Obra da sonda. `type` é enum: o `type !== 'movie' && type !== 'series'` do TS
/// não é representável aqui (a normalização só valida o IMDb).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrProbeWork {
    pub media_type: HarvestMediaType,
    pub imdb_id: String,
    pub season: Option<i32>,
    pub episode: Option<i32>,
}

impl BrProbeWork {
    pub fn movie(imdb_id: impl Into<String>) -> Self {
        Self {
            media_type: HarvestMediaType::Movie,
            imdb_id: imdb_id.into(),
            season: None,
            episode: None,
        }
    }

    pub fn series(imdb_id: impl Into<String>, season: i32, episode: i32) -> Self {
        Self {
            media_type: HarvestMediaType::Series,
            imdb_id: imdb_id.into(),
            season: Some(season),
            episode: Some(episode),
        }
    }
}

/// Estados persistidos. `pending` é o único transitório.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BrProbeState {
    Pending,
    Found,
    Empty,
    Failed,
    Capped,
}

impl BrProbeState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Found => "found",
            Self::Empty => "empty",
            Self::Failed => "failed",
            Self::Capped => "capped",
        }
    }
}

/// Estado FINAL aceito por `BrProbe::finalize` — `pending` não é representável.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeFinal {
    Found,
    Empty,
    Failed,
    Capped,
}

impl ProbeFinal {
    pub(crate) fn as_state(self) -> BrProbeState {
        match self {
            Self::Found => BrProbeState::Found,
            Self::Empty => BrProbeState::Empty,
            Self::Failed => BrProbeState::Failed,
            Self::Capped => BrProbeState::Capped,
        }
    }
}

/// Registro persistido. `lease_until` só existe em `pending`; o JSON é o mesmo
/// do TS (`{state, at, leaseUntil}`), então os dois lados leem o mesmo cache.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrProbeRecord {
    pub state: BrProbeState,
    /// Epoch ms da gravação (idade do agendamento e janela do retry curto).
    pub at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lease_until: Option<i64>,
}

/// Resultado da solicitação — espelho de `RequestBrProbeResult` do TS.
/// `probe` e `pending` são sempre iguais neste contrato (o TS mantém os dois
/// nomes: um para o worker, outro para o aviso na lista).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RequestProbeResult {
    pub probe: bool,
    pub pending: bool,
    pub skipped: Option<&'static str>,
    /// A sonda não é elegível: o call site mantém a rede de segurança do
    /// `br-gap` normal (desligar a sonda não pode perder o enqueue).
    pub fallback_br_gap: bool,
}

impl RequestProbeResult {
    pub(crate) fn skipped(reason: &'static str, fallback_br_gap: bool) -> Self {
        Self {
            probe: false,
            pending: false,
            skipped: Some(reason),
            fallback_br_gap,
        }
    }

    pub(crate) fn scheduled(skipped: Option<&'static str>) -> Self {
        Self {
            probe: true,
            pending: true,
            skipped,
            fallback_br_gap: false,
        }
    }
}

/// Config injetável — fatia de `config.releaseIndex` / `config.jackett` /
/// `autoFetchBrProbe` / `config.debrid.brProbeTtl`.
#[derive(Debug, Clone)]
pub struct ProbeConfig {
    /// `RELEASE_INDEX` ativo (sem índice a sonda não tem onde escrever).
    pub release_index_enabled: bool,
    /// `AUTOFETCH_BR_PROBE` (toggle do operador).
    pub auto_fetch_br_probe: bool,
    /// `JACKETT_INDEX_ONLY_INDEXERS`.
    pub index_only_indexers: Vec<String>,
    /// `JACKETT_PT_BR_INDEXERS`.
    pub pt_br_indexers: Vec<String>,
    /// `JACKETT_LIVE_EXEMPT_INDEXERS` — entram na busca viva, não são index-only.
    pub live_exempt_indexers: Vec<String>,
    /// `BR_PROBE_TTL_S` (o TS já clampeia em ≥ 60).
    pub ttl_seconds: u64,
}

impl Default for ProbeConfig {
    fn default() -> Self {
        Self {
            release_index_enabled: true,
            auto_fetch_br_probe: true,
            index_only_indexers: Vec::new(),
            pt_br_indexers: Vec::new(),
            live_exempt_indexers: Vec::new(),
            ttl_seconds: crate::probe::DEFAULT_PROBE_TTL_SECONDS,
        }
    }
}
