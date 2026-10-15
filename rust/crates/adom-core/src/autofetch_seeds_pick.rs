//! Porte puro do núcleo de seleção de `src/providers/autofetch-seeds-pool.ts` —
//! `pickSeedsPool`: pool "seeds" do Chupim (melhor swarm).
//!
//! HYB: a viabilidade (`viable`) entra como `HashSet<String>` de hashes
//! viáveis (minúsculos), pré-computada pelo chamador. Sem métricas, sem IO,
//! sem `held.release`, sem `writeQueue`.
//!
//! Dois regimes de relaxamento para minSeeders=1:
//! - strict VAZIO: relaxado preenche a capacidade TOTAL (seedsLimit);
//! - strict PARCIAL: completa só as vagas imediatas que faltam.
//!
//! Título RARO (poucos candidatos viáveis ≤ threshold, melhor < maxSeeders):
//! o limite imediato sobe de topSeedsMax para rare.max.

use std::collections::HashSet;

use crate::br_pool_selection::{top_seeded_pool, PoolOptions, PoolStream};

/// Config viva necessária para a seleção (subconjunto do `live` do TS).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeedsPickLive {
    pub min_seeders: i64,
    pub top_seeds_max: i64,
    pub pt_first: bool,
}

/// Config do regime raro.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RareConfig {
    pub max: i64,
    pub threshold: i64,
    pub max_seeders: i64,
}

/// Opções da seleção (season, queueDepth, rare).
#[derive(Debug, Clone)]
pub struct SeedsPickOpts {
    pub season: Option<i64>,
    pub queue_depth: i64,
    pub rare: RareConfig,
}

/// Resultado da seleção de candidatos seeds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeedsPickResult {
    /// Índices dos candidatos selecionados no array de entrada.
    pub candidates: Vec<usize>,
    /// Limite imediato efetivo (pode ser rare.max se raro ativou).
    pub immediate_limit: i64,
    /// Se o regime raro foi ativado.
    pub rare_used: bool,
}

/// Seleção do pool seeds: estrito + complemento relaxado + regime raro.
///
/// `viable_hashes`: conjunto de hashes (minúsculos) que o chamador considera
/// viáveis. Stream fora deste conjunto é pulado (inviável).
pub fn pick_seeds_pool(
    streams: &[PoolStream],
    live: &SeedsPickLive,
    opts: &SeedsPickOpts,
    viable_hashes: &HashSet<String>,
) -> SeedsPickResult {
    let pool_opts = PoolOptions {
        season: opts.season,
        min_seeders: 0,
        pt_first: live.pt_first,
    };

    // Seletor limitado do pool: coleta até `limit` candidatos VIÁVEIS na ordem
    // do pool (topSeededPool com minSeeders variável), com dedupe por hash.
    let pick_viable = |limit: i64, min_seeders: i64| -> Vec<usize> {
        let max = limit.max(0) as usize;
        if max == 0 {
            return Vec::new();
        }
        let ordered = top_seeded_pool(
            streams,
            &PoolOptions {
                min_seeders,
                ..pool_opts.clone()
            },
        );
        let mut seen: HashSet<String> = HashSet::new();
        let mut out: Vec<usize> = Vec::new();
        for &i in &ordered {
            if out.len() >= max {
                break;
            }
            let s = &streams[i];
            let key = match &s.info_hash {
                Some(h) if !h.is_empty() => h.to_lowercase(),
                _ => continue,
            };
            if !seen.insert(key.clone()) {
                continue;
            }
            if !viable_hashes.contains(&key) {
                continue;
            }
            out.push(i);
        }
        out
    };

    // Detecção de título RARO: universo com minSeeders=1, conta VIÁVEIS.
    let mut immediate_limit = live.top_seeds_max;
    let mut rare_used = false;
    if opts.rare.threshold > 0 && opts.rare.max > immediate_limit {
        let universo = pick_viable(opts.rare.threshold + 1, 1);
        let melhor = universo
            .iter()
            .map(|&i| streams[i].seeders_number())
            .max()
            .unwrap_or(0);
        if !universo.is_empty()
            && (universo.len() as i64) <= opts.rare.threshold
            && melhor < opts.rare.max_seeders
        {
            immediate_limit = opts.rare.max;
            rare_used = true;
        }
    }

    let seeds_limit = immediate_limit + opts.queue_depth;
    let mut candidates = pick_viable(seeds_limit, live.min_seeders);

    // Complemento relaxado: estrito vazio → capacidade TOTAL; parcial → vagas
    // imediatas que faltam.
    if live.min_seeders > 1 {
        let strict_empty = candidates.is_empty();
        let capacity = if strict_empty {
            seeds_limit
        } else {
            immediate_limit - candidates.len() as i64
        };
        if capacity > 0 {
            let chosen: HashSet<String> = candidates
                .iter()
                .filter_map(|&i| streams[i].info_hash.as_deref())
                .map(|h| h.to_lowercase())
                .collect();
            let relaxed: Vec<usize> = pick_viable(seeds_limit, 1)
                .into_iter()
                .filter(|&i| {
                    let key = streams[i].info_hash.as_deref().unwrap_or("").to_lowercase();
                    !chosen.contains(&key)
                })
                .take(capacity.max(0) as usize)
                .collect();
            candidates.extend(relaxed);
        }
    }

    SeedsPickResult {
        candidates,
        immediate_limit,
        rare_used,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stream(hash: &str, seeders: i64) -> PoolStream {
        PoolStream {
            info_hash: Some(hash.to_string()),
            name: Some(format!("Movie 1988 1080p 👤 {seeders}")),
            title: Some("Movie 1988 1080p".to_string()),
            seeders: Some(seeders),
            ..Default::default()
        }
    }

    fn all_viable(streams: &[PoolStream]) -> HashSet<String> {
        streams
            .iter()
            .filter_map(|s| s.info_hash.clone())
            .map(|h| h.to_lowercase())
            .collect()
    }

    #[test]
    fn seleciona_por_swarm_decrescente() {
        let streams = vec![stream("aaa", 10), stream("bbb", 50), stream("ccc", 30)];
        let live = SeedsPickLive {
            min_seeders: 1,
            top_seeds_max: 2,
            pt_first: false,
        };
        let opts = SeedsPickOpts {
            season: None,
            queue_depth: 0,
            rare: RareConfig::default(),
        };
        let r = pick_seeds_pool(&streams, &live, &opts, &all_viable(&streams));
        assert_eq!(r.candidates.len(), 2);
        assert_eq!(r.immediate_limit, 2);
        assert!(!r.rare_used);
    }

    #[test]
    fn raro_ativa_com_poucos_viaveis_fracos() {
        let streams = vec![stream("aaa", 3), stream("bbb", 2)];
        let live = SeedsPickLive {
            min_seeders: 1,
            top_seeds_max: 2,
            pt_first: false,
        };
        let opts = SeedsPickOpts {
            season: None,
            queue_depth: 0,
            rare: RareConfig {
                max: 4,
                threshold: 3,
                max_seeders: 10,
            },
        };
        let r = pick_seeds_pool(&streams, &live, &opts, &all_viable(&streams));
        assert!(r.rare_used);
        assert_eq!(r.immediate_limit, 4);
    }

    #[test]
    fn complemento_relaxado_preenche_vagas() {
        let streams = vec![stream("aaa", 10), stream("bbb", 1)];
        let live = SeedsPickLive {
            min_seeders: 5,
            top_seeds_max: 2,
            pt_first: false,
        };
        let opts = SeedsPickOpts {
            season: None,
            queue_depth: 0,
            rare: RareConfig::default(),
        };
        let r = pick_seeds_pool(&streams, &live, &opts, &all_viable(&streams));
        // strict (>=5): só "aaa". capacity = 2 - 1 = 1. relaxado: "bbb".
        assert_eq!(r.candidates.len(), 2);
    }
}
