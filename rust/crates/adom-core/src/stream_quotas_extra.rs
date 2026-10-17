//! Porte das funções restantes de `stream-quotas.ts` e `stream-quotas-candidate.ts`.
//! `quality_from_title`, `stream_quality`, `is_season_pack_release`,
//! `limit_by_quality`, `limit_by_quality_and_indexer`, `select_quality_candidates`,
//! `limit_reserving_br`.

use regex::Regex;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use crate::audio_presentation::strip_quality_tag_blob;
use crate::episode_parse::parse_title_season_episode;
use crate::js_text::js_trim;
use crate::stream_quotas::clamp_limit;

// Seleção de candidatos e reserva BR vivem num submódulo para caber na catraca
// de 400 linhas por arquivo; o rustfmt expandiria o arquivo único para ~611.
mod limit_br_trace;
mod selection;
pub use limit_br_trace::{limit_reserving_br_trace, LimitReservingBrTrace};
pub use selection::{
    limit_reserving_br, select_quality_candidates, LimitBrOpts, SelectCandidatesOpts,
};

pub const UNKNOWN_QUALITY: &str = "sem resolução";
pub const QUALITY_KEYS: [&str; 6] = ["2160p", "1080p", "720p", "480p", "SD", UNKNOWN_QUALITY];

#[derive(Debug, Clone)]
pub struct StreamRef {
    pub title: String,
    pub quality: Option<String>,
    pub indexer: Option<String>,
    pub is_br: bool,
    pub is_dubbed: bool,
    pub is_dub_claim: bool,
    pub is_lied: bool,
    pub is_season_pack: bool,
}

pub type QualityLimits = HashMap<String, f64>;

// ─── Classificação de qualidade ──────────────────────────────────────────────

fn sd_quality_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?-u:\b)(576P|540P|360P|240P|SDTV|DVD5|DVD9|DVD[- ]?R|DVD[- ]?(?:RIP|SCR)|VHS[- ]?RIP|TS|TC|CAM[- ]?RIP|CAM)(?-u:\b)",
        )
        .expect("regex SD")
    })
}

/// Classifica a qualidade a partir do título.
pub fn quality_from_title(title: &str) -> &str {
    let t = strip_quality_tag_blob(title)
        .to_uppercase()
        .replace('_', " ");
    // Insere espaço entre prefixo de fonte e resolução colada.
    let t = ["RIP", "DL", "WEB", "HDTV"].iter().fold(t, |acc, pfx| {
        ["2160P", "1080P", "720P", "480P"]
            .iter()
            .fold(acc, |a, res| {
                a.replace(&format!("{pfx}{res}"), &format!("{pfx} {res}"))
            })
    });
    if wb_contains(&t, "2160P") || wb_contains(&t, "4K") || wb_contains(&t, "UHD") {
        return "2160p";
    }
    if wb_contains(&t, "1080P") {
        return "1080p";
    }
    if wb_contains(&t, "720P") {
        return "720p";
    }
    if wb_contains(&t, "480P") {
        return "480p";
    }
    if sd_quality_re().is_match(&t) {
        return "SD";
    }
    UNKNOWN_QUALITY
}

/// Busca por palavra com fronteiras \b ASCII.
fn wb_contains(text: &str, word: &str) -> bool {
    let tu = text.to_uppercase();
    let wu = word.to_uppercase();
    let mut start = 0;
    while let Some(pos) = tu[start..].find(&wu) {
        let abs = start + pos;
        let before_ok = abs == 0 || !tu.as_bytes()[abs - 1].is_ascii_alphanumeric();
        let after = abs + wu.len();
        let after_ok = after >= tu.len() || !tu.as_bytes()[after].is_ascii_alphanumeric();
        if before_ok && after_ok {
            return true;
        }
        start = abs + 1;
    }
    false
}

pub fn stream_quality(stream: &StreamRef) -> String {
    stream
        .quality
        .clone()
        .filter(|q| !q.is_empty())
        .unwrap_or_else(|| quality_from_title(&stream.title).to_string())
}

// ─── Detecção de pack ────────────────────────────────────────────────────────

pub fn is_season_pack_release(stream: &StreamRef, season: Option<i64>) -> bool {
    let Some(season) = season else { return false };
    let p = parse_title_season_episode(&stream.title);
    if p.complete && p.seasons.is_empty() {
        return true;
    }
    if !p.episodes.is_empty() {
        return false;
    }
    if !p.seasons.is_empty() {
        return p.seasons.contains(&season);
    }
    p.season_pack
}

// ─── Cotas ───────────────────────────────────────────────────────────────────

pub fn limit_by_quality(qualities: &[&str], quality_limits: &QualityLimits) -> Vec<usize> {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    let mut kept = Vec::with_capacity(qualities.len());
    for (i, q) in qualities.iter().enumerate() {
        let raw = quality_limits.get(*q).copied();
        let limit = match raw {
            None | Some(f64::INFINITY) => usize::MAX,
            Some(v) if v >= 100.0 => usize::MAX,
            Some(v) => clamp_limit(v) as usize,
        };
        let count = counts.get(q).copied().unwrap_or(0);
        if count >= limit {
            continue;
        }
        counts.insert(q, count + 1);
        kept.push(i);
    }
    kept
}

/// Um corte do corte final: a posição na lista visitada e o motivo fechado
/// (o mesmo literal que o `dropTrace` do TS registra).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct QuotaDrop {
    pub index: usize,
    pub reason: &'static str,
}

/// Resultado observacional de [`limit_by_quality_and_indexer`]: os índices
/// mantidos e os descartados com motivo, na ORDEM em que a lista reordenada foi
/// visitada (o ledger do TS depende dessa ordem).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct QualityIndexerTrace {
    pub kept: Vec<usize>,
    pub dropped: Vec<QuotaDrop>,
}

/// Aplica as cotas e devolve também os cortes com motivo.
pub fn limit_by_quality_and_indexer_trace(
    streams: &[&StreamRef],
    quality_limits: &QualityLimits,
    max_per_indexer: f64,
    exempt: &HashSet<usize>,
    indexer_limits: &QualityLimits,
    reserved_br: &HashSet<usize>,
) -> QualityIndexerTrace {
    let mut qc: HashMap<String, usize> = HashMap::new();
    let mut ic: HashMap<String, usize> = HashMap::new();
    let gl = clamp_limit(max_per_indexer);
    let mut kept = Vec::with_capacity(streams.len());
    let mut dropped = Vec::new();
    for (i, s) in streams.iter().enumerate() {
        let quality = stream_quality(s);
        let ql = match quality_limits.get(&quality).copied() {
            None | Some(f64::INFINITY) => usize::MAX,
            Some(v) if v >= 100.0 => usize::MAX,
            Some(v) => clamp_limit(v) as usize,
        };
        let qn = qc.get(&quality).copied().unwrap_or(0);
        let reserved = reserved_br.contains(&i);
        if !reserved && qn >= ql {
            dropped.push(QuotaDrop {
                index: i,
                reason: "quality-quota",
            });
            continue;
        }
        let source = s
            .indexer
            .as_ref()
            .map(|x| js_trim(x).to_lowercase())
            .unwrap_or_default();
        let sn = if source.is_empty() {
            0
        } else {
            ic.get(&source).copied().unwrap_or(0)
        };
        let sl = if source.is_empty() {
            0.0
        } else if let Some(v) = indexer_limits.get(&source) {
            clamp_limit(*v)
        } else {
            gl
        };
        if !source.is_empty() && !exempt.contains(&i) && sl != 0.0 && sn >= sl as usize {
            dropped.push(QuotaDrop {
                index: i,
                reason: "indexer-limit",
            });
            continue;
        }
        if !reserved {
            qc.insert(quality, qn + 1);
        }
        if !source.is_empty() {
            ic.insert(source, sn + 1);
        }
        kept.push(i);
    }
    QualityIndexerTrace { kept, dropped }
}

pub fn limit_by_quality_and_indexer(
    streams: &[&StreamRef],
    quality_limits: &QualityLimits,
    max_per_indexer: f64,
    exempt: &HashSet<usize>,
    indexer_limits: &QualityLimits,
    reserved_br: &HashSet<usize>,
) -> Vec<usize> {
    limit_by_quality_and_indexer_trace(
        streams,
        quality_limits,
        max_per_indexer,
        exempt,
        indexer_limits,
        reserved_br,
    )
    .kept
}
