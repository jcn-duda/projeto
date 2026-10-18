use std::collections::HashSet;

use crate::stream_quotas_extra::QualityLimits;
use crate::stream_ranking_types::{RankingStream, TraceDrop};

/// 2º parâmetro do `sortAndLimit` do TS, com os MESMOS defaults.
#[derive(Debug, Clone)]
pub struct SortOptions {
    pub min_seeders: f64,
    pub max_results: f64,
    pub quality_filter: Vec<String>,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub prefer_dubbed: bool,
    /// Lido e descartado no TS (`void dubbedOnly`): presença de global/EN em
    /// cache não é cortada aqui — mantido só para espelhar o contrato.
    pub dubbed_only: bool,
    pub exclude_cam: bool,
    pub max_size_gb: f64,
    pub quality_limits: QualityLimits,
    pub br_reserved_slots: f64,
    pub br_reserved_per_quality: f64,
    pub candidate_factor: f64,
    pub br_first: bool,
    pub indexer_priority: Vec<String>,
}

impl Default for SortOptions {
    fn default() -> Self {
        Self {
            min_seeders: 0.0,
            max_results: 40.0,
            quality_filter: Vec::new(),
            season: None,
            episode: None,
            prefer_dubbed: false,
            dubbed_only: false,
            exclude_cam: false,
            max_size_gb: 0.0,
            quality_limits: QualityLimits::default(),
            br_reserved_slots: 0.0,
            br_reserved_per_quality: 0.0,
            candidate_factor: 1.0,
            br_first: true,
            indexer_priority: Vec::new(),
        }
    }
}

/// Entrada do `sortAndLimit`. `streams` já aceita `null` no TS; aqui quem
/// filtra nulos é o dedupe (chave `infoHash` ausente — ver `Parte 2`).
#[derive(Debug, Clone, Default)]
pub struct SortInput {
    pub streams: Vec<RankingStream>,
    pub options: SortOptions,
    /// Callback `instant: (hash) => bool` do TS, materializado.
    pub instant_hashes: HashSet<String>,
}

#[derive(Debug, Clone, Default)]
pub struct SortOutput {
    pub streams: Vec<RankingStream>,
    /// Streams com waiver do piso (`_seedFloorWaived`): quem chama aplica
    /// `metrics.count('search.brDubbed.seedFloorWaived')`.
    pub waived_hashes: Vec<String>,
    /// Último recurso do qualityFilter acionado
    /// (`metrics.count('search.qualityFilter.relaxed')` no TS).
    pub quality_relaxed: bool,
    /// Cortes na ordem do trace TS (`dedupe`, `lie`, `min-seeders`,
    /// `quality-filter`, `cam-excluded`, `size-limit`, `pool-cut`).
    pub drops: Vec<TraceDrop>,
}
