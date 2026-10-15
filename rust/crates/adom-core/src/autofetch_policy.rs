//! Porte puro de `src/providers/autofetch-policy.ts` — política do pool `seeds`
//! do Chupim (Fase 1). Módulo PURO: só decide, não seleciona, não segura hash,
//! não escreve fila. Nada aqui finge conhecer cache: o que depende de `cached`
//! entra como parâmetro já medido.

use regex::Regex;
use std::sync::OnceLock;

use crate::stream_quotas_extra::{quality_from_title, UNKNOWN_QUALITY};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SeedsRejectReason {
    SeedsSizeUnknown,
    SeedsTooBig,
    SeedsQuality,
}

impl SeedsRejectReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SeedsSizeUnknown => "seeds-size-unknown",
            Self::SeedsTooBig => "seeds-too-big",
            Self::SeedsQuality => "seeds-quality",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeedsSelectionBlockReason {
    DubbedOnly,
    SeedsPlayable,
    BrProbePending,
}

impl SeedsSelectionBlockReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::DubbedOnly => "dubbed-only",
            Self::SeedsPlayable => "seeds-playable",
            Self::BrProbePending => "br-probe-pending",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeedsStopReason {
    StopHasBr,
    StopHasCached,
}

impl SeedsStopReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::StopHasBr => "stop-has-br",
            Self::StopHasCached => "stop-has-cached",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeedsDrainReason {
    DubbedOnly,
    SeedsSizeUnknown,
    SeedsTooBig,
    SeedsQuality,
}

impl SeedsDrainReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::DubbedOnly => "dubbed-only",
            Self::SeedsSizeUnknown => "seeds-size-unknown",
            Self::SeedsTooBig => "seeds-too-big",
            Self::SeedsQuality => "seeds-quality",
        }
    }
}

#[derive(Debug, Clone)]
pub struct SeedsPolicyConfig {
    pub dubbed_only: bool,
    pub cached_only: bool,
    pub max_size_gb: f64,
    pub seeds_max_gb: f64,
    pub seeds_max_quality: String,
}

#[derive(Debug, Clone, Default)]
pub struct SeedsCandidate {
    pub size_field: Option<f64>,
    pub pack_bytes: Option<f64>,
    pub quality_underscore: Option<String>,
    pub quality_plain: Option<String>,
    pub size_queue: Option<f64>,
    pub title: Option<String>,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct PlayableStream {
    pub notice: bool,
    pub url: Option<String>,
    pub info_hash: Option<String>,
    pub external_url: Option<String>,
}

#[derive(Debug, Clone)]
pub struct DecideSeedsStopInput {
    pub has_cached_dubbed: bool,
    pub cached_count: i64,
    pub rare: bool,
    pub rare_threshold: i64,
    pub adapter_cache_check: bool,
    pub rare_over_cached: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecideSeedsStopOutput {
    pub stop: Option<SeedsStopReason>,
    pub rare_over_cached: bool,
}

#[derive(Debug, Clone, Default)]
pub struct FilterSeedsResult {
    pub eligible_count: usize,
    pub rejected_quality: usize,
    pub rejected_too_big: usize,
    pub rejected_size_unknown: usize,
}

const BYTES_PER_GB: f64 = 1_073_741_824.0;
const DEFAULT_SEEDS_MAX_QUALITY: &str = "1080p";

fn remux_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)\b(?:BD)?REMUX\b").expect("regex REMUX"))
}

fn quality_rank(q: &str) -> Option<i64> {
    match q {
        "2160p" => Some(5),
        "1080p" => Some(4),
        "720p" => Some(3),
        "480p" => Some(2),
        "SD" => Some(1),
        UNKNOWN_QUALITY => Some(0),
        _ => None,
    }
}

fn is_valid_seeds_quality(q: &str) -> bool {
    matches!(q, "2160p" | "1080p" | "720p" | "480p" | "SD")
}

fn size_mark_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new("\u{1F4BE} (\\d+(?:\\.\\d+)? (?:B|KB|MB|GB|TB))").expect("regex SIZE_MARK")
    })
}

fn pack_total_mark_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new("\u{1F4E6} pack (\\d+(?:\\.\\d+)? (?:B|KB|MB|GB|TB))")
            .expect("regex PACK_TOTAL_MARK")
    })
}

fn parse_size_label(label: &str) -> f64 {
    let Some((value_str, unit)) = label.split_once(' ') else {
        return 0.0;
    };
    let Ok(value) = value_str.parse::<f64>() else {
        return 0.0;
    };
    if !value.is_finite() {
        return 0.0;
    }
    let power: u32 = match unit {
        "B" => 0,
        "KB" => 1,
        "MB" => 2,
        "GB" => 3,
        "TB" => 4,
        _ => return 0.0,
    };
    (value * 1024f64.powi(power as i32)).round()
}

/// Tamanho do DOWNLOAD que o título do stream anuncia (💾 ou 📦 pack).
pub fn stream_title_bytes(title: Option<&str>) -> f64 {
    let text = title.unwrap_or("");
    if text.is_empty() {
        return 0.0;
    }
    if let Some(caps) = pack_total_mark_re().captures(text) {
        return parse_size_label(&caps[1]);
    }
    if let Some(caps) = size_mark_re().captures(text) {
        return parse_size_label(&caps[1]);
    }
    0.0
}

pub fn normalize_seeds_max_quality(value: &str) -> &str {
    let q = value.trim();
    if is_valid_seeds_quality(q) {
        q
    } else {
        DEFAULT_SEEDS_MAX_QUALITY
    }
}

/// Teto efetivo de tamanho em bytes (menor entre pool e usuário; 0 = sem teto).
pub fn effective_seeds_max_bytes(seeds_max_gb: f64, max_size_gb: f64) -> f64 {
    let seeds = seeds_max_gb.max(0.0);
    let user = max_size_gb.max(0.0);
    let gb = if user > 0.0 {
        if seeds > 0.0 {
            seeds.min(user)
        } else {
            user
        }
    } else {
        seeds
    };
    if gb > 0.0 {
        gb * BYTES_PER_GB
    } else {
        0.0
    }
}

/// Tamanho do DOWNLOAD: `_size` → `_packBytes` → `size` da fila → marker título.
pub fn seeds_download_bytes(stream: &SeedsCandidate) -> f64 {
    let explicit = stream
        .size_field
        .filter(|v| *v > 0.0)
        .or_else(|| stream.pack_bytes.filter(|v| *v > 0.0))
        .or_else(|| stream.size_queue.filter(|v| *v > 0.0))
        .unwrap_or(0.0);
    if explicit > 0.0 {
        return explicit;
    }
    stream_title_bytes(stream.title.as_deref())
}

/// Recusa por qualidade. REMUX/BDREMUX recusado SEMPRE; desconhecida também.
pub fn seeds_quality_reject(
    stream: &SeedsCandidate,
    max_quality: &str,
) -> Option<SeedsRejectReason> {
    let title = stream
        .title
        .as_deref()
        .or(stream.name.as_deref())
        .unwrap_or("");
    if remux_re().is_match(title) {
        return Some(SeedsRejectReason::SeedsQuality);
    }
    let explicit = stream
        .quality_underscore
        .as_deref()
        .or(stream.quality_plain.as_deref());
    let quality = match explicit {
        Some(q) if !q.is_empty() => q.to_string(),
        _ => quality_from_title(title).to_string(),
    };
    let Some(rank) = quality_rank(&quality) else {
        return Some(SeedsRejectReason::SeedsQuality);
    };
    if rank == 0 {
        return Some(SeedsRejectReason::SeedsQuality);
    }
    let cap = quality_rank(normalize_seeds_max_quality(max_quality)).unwrap_or(4);
    if rank > cap {
        Some(SeedsRejectReason::SeedsQuality)
    } else {
        None
    }
}

/// Recusa por tamanho: desconhecido ou acima do teto.
pub fn seeds_size_reject(stream: &SeedsCandidate, max_bytes: f64) -> Option<SeedsRejectReason> {
    let size = seeds_download_bytes(stream);
    // `!(size > 0)` do TS: NaN também é "desconhecido" (paridade com o falsy do JS).
    if size.is_nan() || size <= 0.0 {
        return Some(SeedsRejectReason::SeedsSizeUnknown);
    }
    if max_bytes > 0.0 && size > max_bytes {
        return Some(SeedsRejectReason::SeedsTooBig);
    }
    None
}

/// Regras intrínsecas do candidato seeds (qualidade antes de tamanho).
pub fn seeds_intrinsic_rejection(
    stream: &SeedsCandidate,
    cfg: &SeedsPolicyConfig,
) -> Option<SeedsRejectReason> {
    if let Some(r) = seeds_quality_reject(stream, &cfg.seeds_max_quality) {
        return Some(r);
    }
    seeds_size_reject(
        stream,
        effective_seeds_max_bytes(cfg.seeds_max_gb, cfg.max_size_gb),
    )
}

/// Filtra o universo ANTES de `pickSeedsPool`: contagem por motivo.
pub fn filter_seeds_universe(
    streams: &[SeedsCandidate],
    cfg: &SeedsPolicyConfig,
) -> FilterSeedsResult {
    let mut r = FilterSeedsResult::default();
    for s in streams {
        match seeds_intrinsic_rejection(s, cfg) {
            None => r.eligible_count += 1,
            Some(SeedsRejectReason::SeedsQuality) => r.rejected_quality += 1,
            Some(SeedsRejectReason::SeedsTooBig) => r.rejected_too_big += 1,
            Some(SeedsRejectReason::SeedsSizeUnknown) => r.rejected_size_unknown += 1,
        }
    }
    r
}

/// Stream tocável de verdade. Aviso (`notice: true`) não conta.
pub fn has_playable_stream(streams: &[PlayableStream]) -> bool {
    streams.iter().any(|s| {
        !s.notice
            && (s.url.as_deref().is_some_and(|u| !u.is_empty())
                || s.info_hash.as_deref().is_some_and(|h| !h.is_empty())
                || s.external_url.as_deref().is_some_and(|e| !e.is_empty()))
    })
}

/// Bloqueio de SELEÇÃO do pool seeds, avaliável antes do checkCached.
pub fn seeds_selection_block(
    dubbed_only: bool,
    cached_only: bool,
    streams: &[PlayableStream],
    br_probe_pending: bool,
) -> Option<SeedsSelectionBlockReason> {
    if dubbed_only {
        return Some(SeedsSelectionBlockReason::DubbedOnly);
    }
    if !cached_only && has_playable_stream(streams) {
        return Some(SeedsSelectionBlockReason::SeedsPlayable);
    }
    if br_probe_pending {
        return Some(SeedsSelectionBlockReason::BrProbePending);
    }
    None
}

/// Decisão de parada do pool seeds com o cache JÁ conhecido.
pub fn decide_seeds_stop(input: &DecideSeedsStopInput) -> DecideSeedsStopOutput {
    if input.has_cached_dubbed {
        return DecideSeedsStopOutput {
            stop: Some(SeedsStopReason::StopHasBr),
            rare_over_cached: false,
        };
    }
    if input.cached_count == 0 {
        return DecideSeedsStopOutput {
            stop: None,
            rare_over_cached: false,
        };
    }
    if !(input.rare
        && input.rare_threshold > 0
        && input.adapter_cache_check
        && input.rare_over_cached)
    {
        return DecideSeedsStopOutput {
            stop: Some(SeedsStopReason::StopHasCached),
            rare_over_cached: false,
        };
    }
    DecideSeedsStopOutput {
        stop: None,
        rare_over_cached: true,
    }
}

/// Regras PERMANENTES revalidadas no dreno.
pub fn seeds_drain_rejection(
    candidate: &SeedsCandidate,
    cfg: &SeedsPolicyConfig,
) -> Option<SeedsDrainReason> {
    if cfg.dubbed_only {
        return Some(SeedsDrainReason::DubbedOnly);
    }
    seeds_intrinsic_rejection(candidate, cfg).map(|r| match r {
        SeedsRejectReason::SeedsSizeUnknown => SeedsDrainReason::SeedsSizeUnknown,
        SeedsRejectReason::SeedsTooBig => SeedsDrainReason::SeedsTooBig,
        SeedsRejectReason::SeedsQuality => SeedsDrainReason::SeedsQuality,
    })
}
