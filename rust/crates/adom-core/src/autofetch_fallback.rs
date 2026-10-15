//! Porte puro das partes determinísticas de `src/providers/autofetch-fallback.ts`
//! — reposição de pools inferiores do Chupim.
//!
//! HYB: viabilidade e filtragem de universo seeds entram pré-computadas. Sem
//! métricas, sem IO, sem held.release. As três funções exportadas:
//! - `pick_lower_pool_fallbacks`: cascata br → any → seeds
//! - `compose_queue_entries`: fila final (primário + fallbacks, até depth)
//! - `to_queue_candidate`: conversão de stream para entrada persistida

use std::collections::HashSet;

use crate::autofetch_seeds_pick::{pick_seeds_pool, RareConfig, SeedsPickLive, SeedsPickOpts};
use crate::br_pool_selection::picks::pick_any_dubbed_candidates;
use crate::br_pool_selection::{PoolOptions, PoolStream};
use crate::episode_matching::is_season_pack_fill_eligible;

/// Config viva do fallback (subconjunto do `autofetchLive.effective()`).
#[derive(Debug, Clone, PartialEq)]
pub struct FallbackLive {
    pub any_dubbed: bool,
    pub top_seeds: bool,
    pub min_seeders: i64,
    pub top_seeds_max: i64,
    pub pt_first: bool,
    pub rare_max: i64,
    pub rare_threshold: i64,
    pub rare_max_seeders: i64,
}

/// Pool do candidato de fallback.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FallbackPool {
    Any,
    Seeds,
}

impl FallbackPool {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Any => "any",
            Self::Seeds => "seeds",
        }
    }
}

/// Um candidato escolhido pelo fallback.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FallbackPick {
    pub index: usize,
    pub pool: FallbackPool,
    pub rare: bool,
    pub slot_limit: Option<i64>,
}

/// Entrada na fila persistente (candidato com metadados do dreno).
#[derive(Debug, Clone, PartialEq)]
pub struct QueueEntry {
    pub index: usize,
    pub pool: String,
    pub rare: bool,
    pub slot_limit: Option<i64>,
}

/// Resultado de `to_queue_candidate`.
#[derive(Debug, Clone, PartialEq)]
pub struct QueueCandidate {
    pub info_hash: String,
    pub name: Option<String>,
    pub title: Option<String>,
    pub quality: Option<String>,
    pub size: Option<f64>,
    pub seeders: Option<i64>,
    pub br: bool,
    pub dubbed: bool,
    pub bank_dub: bool,
    pub lied: bool,
    pub pool: String,
    pub imdb_id: Option<String>,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub is_pack: bool,
    pub probe_season: Option<i64>,
    pub probe_episode: Option<i64>,
    pub rare: bool,
    pub slot_limit: Option<i64>,
}

/// Opções do `pick_lower_pool_fallbacks`.
#[derive(Debug, Clone)]
pub struct FallbackOpts {
    pub primary_pool: String,
    pub exclude_hashes: HashSet<String>,
    pub season: Option<i64>,
    /// Bloqueio de seleção seeds pré-computado (`seedsSelectionBlock != None`).
    pub seeds_blocked: bool,
    /// Sonda dirigida pendente (brProbePending) — já embutido em seeds_blocked.
    /// Índices de streams que passaram `filterSeedsUniverse` (eligible).
    pub eligible_seeds: Vec<usize>,
}

/// Cascata de fallback dos pools inferiores (br → any → seeds).
///
/// `viable_hashes`: hashes (minúsculos) considerados viáveis pelo chamador.
pub fn pick_lower_pool_fallbacks(
    streams: &[PoolStream],
    live: &FallbackLive,
    opts: &FallbackOpts,
    viable_hashes: &HashSet<String>,
) -> Vec<FallbackPick> {
    if opts.primary_pool == "seeds" {
        return Vec::new();
    }
    let mut exclude: HashSet<String> = opts
        .exclude_hashes
        .iter()
        .map(|h| h.to_lowercase())
        .filter(|h| !h.is_empty())
        .collect();
    let mut out: Vec<FallbackPick> = Vec::new();

    // Pool `any`: só abaixo de `br` e se o toggle permitir.
    if opts.primary_pool == "br" && live.any_dubbed {
        let pool_opts = PoolOptions {
            season: opts.season,
            ..Default::default()
        };
        let picks = pick_any_dubbed_candidates(streams, &exclude, 1, &pool_opts);
        if let Some(&idx) = picks.first() {
            let h = streams[idx]
                .info_hash
                .as_deref()
                .unwrap_or("")
                .to_lowercase();
            if viable_hashes.contains(&h) {
                exclude.insert(h);
                out.push(FallbackPick {
                    index: idx,
                    pool: FallbackPool::Any,
                    rare: false,
                    slot_limit: None,
                });
            }
        }
    }

    // Pool `seeds`: último recurso, exige toggle e sem bloqueio de seleção.
    if live.top_seeds && !opts.seeds_blocked {
        let seeds_streams: Vec<PoolStream> = opts
            .eligible_seeds
            .iter()
            .filter(|&&i| {
                let s = &streams[i];
                let h = s.info_hash.as_deref().unwrap_or("").to_lowercase();
                !h.is_empty() && !s.is_br && !exclude.contains(&h)
            })
            .map(|&i| streams[i].clone())
            .collect();
        // Mapeia índice local → índice global.
        let index_map: Vec<usize> = opts
            .eligible_seeds
            .iter()
            .filter(|&&i| {
                let s = &streams[i];
                let h = s.info_hash.as_deref().unwrap_or("").to_lowercase();
                !h.is_empty() && !s.is_br && !exclude.contains(&h)
            })
            .copied()
            .collect();
        let seeds_live = SeedsPickLive {
            min_seeders: live.min_seeders,
            top_seeds_max: live.top_seeds_max,
            pt_first: live.pt_first,
        };
        let seeds_opts = SeedsPickOpts {
            season: opts.season,
            queue_depth: 0,
            rare: RareConfig {
                max: live.rare_max,
                threshold: live.rare_threshold,
                max_seeders: live.rare_max_seeders,
            },
        };
        let result = pick_seeds_pool(&seeds_streams, &seeds_live, &seeds_opts, viable_hashes);
        for &local_idx in &result.candidates {
            let global_idx = index_map[local_idx];
            let h = streams[global_idx]
                .info_hash
                .as_deref()
                .unwrap_or("")
                .to_lowercase();
            exclude.insert(h);
            out.push(FallbackPick {
                index: global_idx,
                pool: FallbackPool::Seeds,
                rare: result.rare_used,
                slot_limit: Some(result.immediate_limit),
            });
        }
    }

    out
}

/// Fila final: excedente primário primeiro, fallbacks na folga.
pub fn compose_queue_entries(
    primary_surplus: &[QueueEntry],
    fallbacks: &[FallbackPick],
    depth: i64,
) -> Vec<QueueEntry> {
    let max = depth.max(0) as usize;
    if max == 0 {
        return Vec::new();
    }
    let mut out: Vec<QueueEntry> = primary_surplus.to_vec();
    for fb in fallbacks {
        if out.len() >= max {
            break;
        }
        out.push(QueueEntry {
            index: fb.index,
            pool: fb.pool.as_str().to_string(),
            rare: fb.rare,
            slot_limit: fb.slot_limit,
        });
    }
    out.truncate(max);
    out
}

/// Opções de `to_queue_candidate`.
#[derive(Debug, Clone)]
pub struct QueueCandidateOpts {
    pub imdb_id: Option<String>,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub season_fill: bool,
    pub rare: bool,
    pub slot_limit: Option<i64>,
    pub size_bytes: Option<f64>,
}

/// Converte um stream para entrada persistida da fila.
pub fn to_queue_candidate(
    stream: &PoolStream,
    pool: &str,
    opts: &QueueCandidateOpts,
) -> QueueCandidate {
    let is_pack = opts.season_fill
        && is_season_pack_fill_eligible(
            stream
                .title
                .as_deref()
                .or(stream.name.as_deref())
                .unwrap_or(""),
            opts.season,
        );
    QueueCandidate {
        info_hash: stream.info_hash.as_deref().unwrap_or("").to_lowercase(),
        name: stream.name.clone(),
        title: stream.title.clone(),
        quality: stream.quality.clone(),
        size: opts.size_bytes.filter(|&v| v > 0.0),
        seeders: stream.seeders,
        br: stream.is_br,
        dubbed: stream.is_dubbed,
        bank_dub: stream.is_bank_dub,
        lied: stream.is_lied,
        pool: pool.to_string(),
        imdb_id: opts.imdb_id.clone(),
        season: opts.season,
        episode: if is_pack { None } else { opts.episode },
        is_pack,
        probe_season: opts.season,
        probe_episode: opts.episode,
        rare: opts.rare,
        slot_limit: opts.slot_limit,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stream(hash: &str, seeders: i64, br: bool) -> PoolStream {
        PoolStream {
            info_hash: Some(hash.to_string()),
            name: Some(format!("Movie 1988 1080p 👤 {seeders}")),
            title: Some("Movie 1988 1080p".to_string()),
            seeders: Some(seeders),
            is_br: br,
            is_dubbed: !br,
            ..Default::default()
        }
    }

    #[test]
    fn seeds_primario_nao_gera_fallback() {
        let streams = vec![stream("aaa", 10, false)];
        let live = FallbackLive {
            any_dubbed: true,
            top_seeds: true,
            min_seeders: 1,
            top_seeds_max: 2,
            pt_first: false,
            rare_max: 0,
            rare_threshold: 0,
            rare_max_seeders: 0,
        };
        let opts = FallbackOpts {
            primary_pool: "seeds".to_string(),
            exclude_hashes: HashSet::new(),
            season: None,
            seeds_blocked: false,
            eligible_seeds: vec![0],
        };
        let viable: HashSet<String> = vec!["aaa".to_string()].into_iter().collect();
        assert!(pick_lower_pool_fallbacks(&streams, &live, &opts, &viable).is_empty());
    }

    #[test]
    fn compose_respeita_depth() {
        let entries = vec![
            QueueEntry {
                index: 0,
                pool: "br".into(),
                rare: false,
                slot_limit: None,
            },
            QueueEntry {
                index: 1,
                pool: "br".into(),
                rare: false,
                slot_limit: None,
            },
        ];
        let fbs = vec![FallbackPick {
            index: 2,
            pool: FallbackPool::Seeds,
            rare: false,
            slot_limit: None,
        }];
        assert_eq!(compose_queue_entries(&entries, &fbs, 2).len(), 2);
        assert_eq!(compose_queue_entries(&entries, &fbs, 3).len(), 3);
        assert!(compose_queue_entries(&entries, &fbs, 0).is_empty());
    }
}
