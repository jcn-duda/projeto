//! Seleção de candidatos e reserva de origem BR — submódulo de
//! [`super`](crate::stream_quotas_extra), separado pela catraca de 400 linhas.

use std::collections::{HashMap, HashSet};

use crate::stream_quotas::clamp_limit;

use super::{stream_quality, QualityLimits, StreamRef, QUALITY_KEYS};

// ─── Seleção de candidatos ───────────────────────────────────────────────────

pub struct SelectCandidatesOpts {
    pub max_results: f64,
    pub quality_limits: QualityLimits,
    pub br_reserved_slots: f64,
    pub br_reserved_per_quality: f64,
    pub candidate_factor: f64,
    pub br_first: bool,
}
impl Default for SelectCandidatesOpts {
    fn default() -> Self {
        Self {
            max_results: 40.0,
            quality_limits: HashMap::new(),
            br_reserved_slots: 0.0,
            br_reserved_per_quality: 0.0,
            candidate_factor: 1.0,
            br_first: true,
        }
    }
}

/// Seleciona candidatos no pool pré-debrid, separando espaço por qualidade.
pub fn select_quality_candidates(
    streams: &[&StreamRef],
    opts: &SelectCandidatesOpts,
) -> Vec<usize> {
    let pool_size = clamp_limit(opts.max_results) as usize;
    // NaN < 100 = false no TS; qualities sem limite explícito NÃO estão em custom.
    let custom: Vec<&str> = QUALITY_KEYS
        .iter()
        .filter(|q| {
            opts.quality_limits
                .get(**q)
                .map(|&v| v < 100.0)
                .unwrap_or(false)
        })
        .copied()
        .collect();
    let custom_set: HashSet<&str> = custom.iter().copied().collect();
    let mut buckets: HashMap<&str, Vec<usize>> = HashMap::new();
    for q in &custom {
        buckets.insert(q, Vec::new());
    }
    for (i, s) in streams.iter().enumerate() {
        let q = stream_quality(s);
        if let Some(b) = buckets.get_mut(q.as_str()) {
            b.push(i);
        }
    }
    let mut selected = HashSet::new();
    let mut positions: HashMap<&str, usize> = custom.iter().map(|q| (*q, 0)).collect();
    let mut counts: HashMap<String, usize> = custom.iter().map(|q| (q.to_string(), 0)).collect();
    let factor = clamp_limit(opts.candidate_factor).max(1.0) as usize;
    let targets: HashMap<&str, usize> = custom
        .iter()
        .map(|q| {
            let lim = opts.quality_limits.get(*q).copied().unwrap_or(0.0);
            (*q, clamp_limit(lim) as usize * factor)
        })
        .collect();
    let br_target = if opts.br_first {
        pool_size
    } else {
        clamp_limit(opts.br_reserved_slots) as usize
    };
    let per_faixa = clamp_limit(opts.br_reserved_per_quality) as usize;
    if per_faixa > 0 {
        let mut fc: HashMap<String, usize> = HashMap::new();
        for (i, s) in streams.iter().enumerate() {
            if selected.len() >= pool_size || selected.len() >= br_target {
                break;
            }
            if !s.is_br || s.is_lied || selected.contains(&i) {
                continue;
            }
            let quality = stream_quality(s);
            let usados = fc.get(&quality).copied().unwrap_or(0);
            if usados >= per_faixa {
                continue;
            }
            if custom_set.contains(quality.as_str())
                && counts.get(quality.as_str()).copied().unwrap_or(0)
                    >= targets.get(quality.as_str()).copied().unwrap_or(0)
            {
                continue;
            }
            fc.insert(quality.clone(), usados + 1);
            selected.insert(i);
            if custom_set.contains(quality.as_str()) {
                *counts.entry(quality.clone()).or_insert(0) += 1;
            }
        }
    }
    for (i, s) in streams.iter().enumerate() {
        if selected.len() >= pool_size || selected.len() >= br_target {
            break;
        }
        if !s.is_br || s.is_lied || selected.contains(&i) {
            continue;
        }
        let quality = stream_quality(s);
        if custom_set.contains(quality.as_str())
            && counts.get(quality.as_str()).copied().unwrap_or(0)
                >= targets.get(quality.as_str()).copied().unwrap_or(0)
        {
            continue;
        }
        selected.insert(i);
        if custom_set.contains(quality.as_str()) {
            *counts.entry(quality).or_insert(0) += 1;
        }
    }
    let mut progressed = true;
    while selected.len() < pool_size && progressed {
        progressed = false;
        for q in &custom {
            let bucket = buckets.get(q).map(|b| b.as_slice()).unwrap_or(&[]);
            let mut pos = positions.get(q).copied().unwrap_or(0);
            while pos < bucket.len() && selected.contains(&bucket[pos]) {
                pos += 1;
            }
            positions.insert(q, pos);
            if counts.get(*q).copied().unwrap_or(0) >= targets.get(*q).copied().unwrap_or(0) {
                continue;
            }
            if pos >= bucket.len() {
                continue;
            }
            selected.insert(bucket[pos]);
            positions.insert(q, pos + 1);
            *counts.entry(q.to_string()).or_insert(0) += 1;
            progressed = true;
            if selected.len() >= pool_size {
                break;
            }
        }
    }
    for (i, s) in streams.iter().enumerate() {
        if selected.len() >= pool_size {
            break;
        }
        if selected.contains(&i) || custom_set.contains(stream_quality(s).as_str()) {
            continue;
        }
        selected.insert(i);
    }
    let mut result: Vec<usize> = selected.into_iter().collect();
    result.sort();
    result
}

// ─── Reserva BR ──────────────────────────────────────────────────────────────

pub struct LimitBrOpts {
    pub br_reserved_slots: f64,
    pub br_reserved_per_quality: f64,
    pub max_results: f64,
    pub br_only: bool,
    pub quality_limits: QualityLimits,
    pub br_first: bool,
    pub max_per_indexer: f64,
    pub indexer_limits: QualityLimits,
    pub season: Option<i64>,
}
impl Default for LimitBrOpts {
    fn default() -> Self {
        Self {
            br_reserved_slots: 0.0,
            br_reserved_per_quality: 0.0,
            max_results: 40.0,
            br_only: false,
            quality_limits: HashMap::new(),
            br_first: true,
            max_per_indexer: 0.0,
            indexer_limits: HashMap::new(),
            season: None,
        }
    }
}

/// Reserva origem BR, aplica cotas finais, devolve índices selecionados.
///
/// A lógica (e o ledger dos cortes) vive em
/// [`super::limit_reserving_br_trace`], noutro submódulo pela catraca de linhas;
/// esta fachada mantém o contrato antigo devolvendo só a seleção.
pub fn limit_reserving_br(streams: &[StreamRef], opts: &LimitBrOpts) -> Vec<usize> {
    super::limit_reserving_br_trace(streams, opts).selected
}
