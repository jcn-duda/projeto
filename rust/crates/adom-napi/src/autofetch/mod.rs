//! Avaliação em lote da seleção de candidatos do autofetch (Chupim).
//!
//! UMA chamada napi compõe os módulos puros já portados (`adom-core`) e devolve
//! a decisão inteira: imediatos, fila persistente, skips com rollback, resultado
//! do pool seeds, estado do teto por obra e um trace. O ganho vem do lote — por
//! chamada o napi é mais lento que o TS (travessia de string), então só compensa
//! mandar a busca inteira de uma vez.
//!
//! Toda a decisão mora em [`decide`], função pura e testável sem Node; a função
//! exposta (`evaluate_autofetch_candidates`) só a chama. Convenção de vazio:
//! `None`/`""` chegam como ausentes, espelhando o `falsy` do JS.
//!
//! # Fronteira impura fica no Node
//!
//! Os portões de enqueue (`gates`), a viabilidade por stream (`viable`, o
//! waiver do piso de seeders) e o estado do teto por obra (`obra_entries` +
//! `pending_reservations`) entram como FATOS já medidos pelo runner. Aqui nada
//! adquire lock, segura hash, faz rede ou escreve fila — reproduzimos só a parte
//! determinística da cascata `br → any → seeds`.
//!
//! # Limitações deliberadas (documentadas para o shadow)
//!
//! - O corte `filter_known_cache` (cachedOnly/rd-miss) pertence ao caminho de
//!   LISTAGEM; a seleção do autofetch passa cache VAZIO aos picks (o corte de
//!   já-cacheado acontece no portão `already-cached`, avaliado no Node).
//! - `seeds_selection_block` (dubbedOnly/lista tocável/br-probe-pending) depende
//!   de estado de sonda e da lista P2P tocável, que não viajam como streams
//!   neste lote; entra como FATO pré-computado (`options.seeds_blocked`) e
//!   bloqueia o pool seeds PRIMÁRIO e o fallback seeds, como no TS.

use std::collections::HashSet;

use adom_core::{
    can_auto_fetch_br, classify_enqueue, combined_view, compose_queue_entries, counts_from,
    pick_any_dubbed_candidates, pick_br_dubbed_by_target_qualities, pick_lower_pool_fallbacks,
    pick_seeds_pool, rollback_for, seeds_intrinsic_rejection, FallbackLive, FallbackOpts,
    ObraRecordEntry, PendingReservation, PoolOptions, PoolStream, QueueEntry, RareConfig,
    SeedsCandidate, SeedsPickLive, SeedsPickOpts, SeedsPickResult, SeedsPolicyConfig,
};
use napi_derive::napi;

mod convert;
// Regras puras AVULSAS (chave de mortas, portões, progresso, fila, seeds e o
// resumo do trace) para as cascas que ainda importam `autofetch-*.ts`.
pub mod rules;
// Ponte do FORMATO v3 da fila por busca (`adom-autofetch::v3`): prova de
// round-trip com o TS e base do worker nativo (T3-L5/L6).
mod queue_v3;
mod state_v3;
mod types;

#[cfg(test)]
mod tests;

pub use queue_v3::*;
pub use state_v3::*;

use convert::{
    gates_in, hash_of, js_i64, pending_in, pool_stream_in, record_in, seeds_candidate_in, trunc,
};
pub use types::{
    AutofetchCandidateOut, AutofetchDecision, AutofetchInput, AutofetchStreamIn, EnqueueGatesIn,
    ObraRecordIn, ObraStatusOut, PendingIn, PoolOptionsIn, QueueCandidateOut, SeedsPolicyIn,
    SeedsResultOut, SkipOut, TraceOut,
};

// ---------------------------------------------------------------------------
// Decisão (pura)
// ---------------------------------------------------------------------------

/// Compõe a cascata `br → any → seeds` + portões + fila + teto por obra.
pub(crate) fn decide(input: &AutofetchInput) -> AutofetchDecision {
    let o = &input.options;
    let policy = SeedsPolicyConfig {
        dubbed_only: input.seeds_policy.dubbed_only,
        cached_only: input.seeds_policy.cached_only,
        max_size_gb: input.seeds_policy.max_size_gb,
        seeds_max_gb: input.seeds_policy.seeds_max_gb,
        seeds_max_quality: input.seeds_policy.seeds_max_quality.clone(),
    };

    // Teto por obra: visão combinada + contagem (independe do toggle).
    let entries: Vec<ObraRecordEntry> = input.obra_entries.iter().map(record_in).collect();
    let pending: Vec<PendingReservation> =
        input.pending_reservations.iter().map(pending_in).collect();
    let counts = counts_from(&entries, &pending);
    let obra_status = ObraStatusOut {
        br: i64::from(counts.br),
        any: i64::from(counts.any),
        seeds: i64::from(counts.seeds),
        total: i64::from(counts.total),
        view_len: combined_view(&entries, &pending).len() as i64,
    };

    let empty_seeds = SeedsResultOut {
        candidates: Vec::new(),
        immediate_limit: 0,
        rare_used: false,
    };

    // 1. Toggle do autofetch BR: sem ele, nada é selecionado.
    if !can_auto_fetch_br(
        o.auto_fetch_br,
        o.adapter_cache_check,
        o.adapter_autofetch_source,
    ) {
        return AutofetchDecision {
            immediates: Vec::new(),
            queue: Vec::new(),
            skips: Vec::new(),
            seeds_result: empty_seeds,
            obra_status,
            trace: TraceOut {
                pool: "none".into(),
                seeds_count: 0,
                immediate_count: 0,
                queue_count: 0,
                skip_count: 0,
                disabled: true,
                labels: Vec::new(),
            },
        };
    }

    let streams: Vec<PoolStream> = input.streams.iter().map(pool_stream_in).collect();
    let season = js_i64(o.season);
    let auto_max = trunc(o.auto_fetch_max);
    let queue_depth = trunc(o.queue_depth);
    let total_max = auto_max + queue_depth;
    let min_seeders = trunc(o.min_seeders);
    let top_seeds_max = trunc(o.top_seeds_max);
    let pool_opts = PoolOptions {
        season,
        min_seeders,
        pt_first: o.pt_first,
    };
    let no_cache: HashSet<String> = HashSet::new();

    // Viabilidade por hash (o waiver do piso de seeders, medido no Node).
    let viable_hashes: HashSet<String> = input
        .streams
        .iter()
        .filter(|s| s.viable)
        .filter_map(|s| s.info_hash.clone())
        .map(|h| h.to_lowercase())
        .filter(|h| !h.is_empty())
        .collect();
    let viable_at = |i: usize| input.streams.get(i).is_some_and(|s| s.viable);

    // 3. Pool BR (cache vazio: o corte de já-cacheado é o portão, no Node).
    // O oráculo usa `pickBrDubbedByTargetQualities` (1º uncached de CADA faixa
    // 1080/720/4K antes dos alternates) — o pick simples ordenava só por
    // qualidade/seeders e trocava o 2º imediato por um alternate (divergência
    // medida no shadow: Shawshank, Breaking Bad S01).
    let mut pool = "br";
    let mut candidates: Vec<usize> =
        pick_br_dubbed_by_target_qualities(&streams, &no_cache, total_max, &pool_opts)
            .into_iter()
            .filter(|&i| viable_at(i))
            .collect();

    // Pool `any`: só com o BR vazio e o toggle ligado.
    if candidates.is_empty() && o.any_dubbed {
        let any: Vec<usize> =
            pick_any_dubbed_candidates(&streams, &no_cache, total_max, &pool_opts)
                .into_iter()
                .filter(|&i| viable_at(i))
                .collect();
        if !any.is_empty() {
            candidates = any;
            pool = "any";
        }
    }

    // Universo seeds: índices que passam a política intrínseca (qualidade/tamanho).
    let seeds_cands: Vec<SeedsCandidate> = input.streams.iter().map(seeds_candidate_in).collect();
    let eligible_idx: Vec<usize> = seeds_cands
        .iter()
        .enumerate()
        .filter(|(_, c)| seeds_intrinsic_rejection(c, &policy).is_none())
        .map(|(i, _)| i)
        .collect();

    // 4. Pool seeds: só com br/any vazios e o toggle ligado.
    let mut seeds_result = SeedsPickResult {
        candidates: Vec::new(),
        immediate_limit: 0,
        rare_used: false,
    };
    // 4. Pool seeds: só com br/any vazios, o toggle ligado e SEM bloqueio de
    // seleção (`seedsSelectionBlock` do TS: dubbed-only / lista tocável /
    // br-probe-pending — fato pré-computado que chega em `seeds_blocked`).
    let mut seeds_evaluated = false;
    if candidates.is_empty() && o.top_seeds && !o.seeds_blocked {
        seeds_evaluated = true;
        let eligible_streams: Vec<PoolStream> =
            eligible_idx.iter().map(|&i| streams[i].clone()).collect();
        let live = SeedsPickLive {
            min_seeders,
            top_seeds_max,
            pt_first: o.pt_first,
        };
        let sopts = SeedsPickOpts {
            season,
            queue_depth,
            rare: RareConfig {
                max: trunc(o.rare_max),
                threshold: trunc(o.rare_threshold),
                max_seeders: trunc(o.rare_max_seeders),
            },
        };
        let r = pick_seeds_pool(&eligible_streams, &live, &sopts, &viable_hashes);
        candidates = r
            .candidates
            .iter()
            .map(|&local| eligible_idx[local])
            .collect();
        seeds_result = r;
        pool = "seeds";
    }

    // 5. Imediatos × excedente (o teto imediato depende do pool vencedor).
    let immediate_limit = if pool == "seeds" {
        seeds_result.immediate_limit
    } else {
        auto_max
    };
    let cut = immediate_limit.max(0) as usize;
    let rare = pool == "seeds" && seeds_result.rare_used;
    let slot = if pool == "seeds" {
        Some(seeds_result.immediate_limit)
    } else {
        None
    };

    // 6. Portões: o mesmo snapshot vale para cada imediato.
    let reason = classify_enqueue(&gates_in(&input.gates));
    let mut immediates: Vec<AutofetchCandidateOut> = Vec::new();
    let mut skips: Vec<SkipOut> = Vec::new();
    for &i in candidates.iter().take(cut) {
        let info_hash = hash_of(&streams, i);
        match reason {
            None => immediates.push(AutofetchCandidateOut {
                info_hash,
                pool: pool.into(),
                rare,
                slot_limit: slot,
            }),
            Some(r) => skips.push(SkipOut {
                reason: r.as_str().into(),
                rollback: rollback_for(r)
                    .iter()
                    .map(|a| a.as_str().to_string())
                    .collect(),
                info_hash,
            }),
        }
    }

    // 5b. Fila persistente: excedente primário + fallback dos pools inferiores.
    let mut queue: Vec<QueueCandidateOut> = Vec::new();
    if queue_depth > 0 {
        let exclude: HashSet<String> = candidates
            .iter()
            .map(|&i| hash_of(&streams, i))
            .filter(|h| !h.is_empty())
            .collect();
        let fb_live = FallbackLive {
            any_dubbed: o.any_dubbed,
            top_seeds: o.top_seeds,
            min_seeders,
            top_seeds_max,
            pt_first: o.pt_first,
            rare_max: trunc(o.rare_max),
            rare_threshold: trunc(o.rare_threshold),
            rare_max_seeders: trunc(o.rare_max_seeders),
        };
        let fb_opts = FallbackOpts {
            primary_pool: pool.to_string(),
            exclude_hashes: exclude,
            season,
            seeds_blocked: o.seeds_blocked,
            eligible_seeds: eligible_idx.clone(),
        };
        let fallbacks = pick_lower_pool_fallbacks(&streams, &fb_live, &fb_opts, &viable_hashes);
        let surplus: Vec<QueueEntry> = candidates
            .iter()
            .skip(cut)
            .map(|&i| QueueEntry {
                index: i,
                pool: pool.to_string(),
                rare,
                slot_limit: slot,
            })
            .collect();
        queue = compose_queue_entries(&surplus, &fallbacks, queue_depth)
            .iter()
            .map(|e| QueueCandidateOut {
                info_hash: hash_of(&streams, e.index),
                pool: e.pool.clone(),
                rare: e.rare,
                slot_limit: e.slot_limit,
            })
            .collect();
    }

    let mut labels = vec![format!("pool={pool}")];
    if seeds_evaluated {
        labels.push(format!("seeds={}", eligible_idx.len()));
    }
    // Contadores lidos ANTES de mover os vetores para o struct da decisão.
    let immediate_count = immediates.len() as i64 + skips.len() as i64;
    let queue_count = queue.len() as i64;
    let skip_count = skips.len() as i64;
    AutofetchDecision {
        immediates,
        queue,
        skips,
        seeds_result: SeedsResultOut {
            candidates: seeds_result.candidates.iter().map(|&i| i as i64).collect(),
            immediate_limit: seeds_result.immediate_limit,
            rare_used: seeds_result.rare_used,
        },
        obra_status,
        trace: TraceOut {
            pool: if candidates.is_empty() {
                "none".into()
            } else {
                pool.into()
            },
            seeds_count: eligible_idx.len() as i64,
            immediate_count,
            queue_count,
            skip_count,
            disabled: false,
            labels,
        },
    }
}

/// Avalia o lote do autofetch numa única travessia de fronteira.
#[napi(catch_unwind)]
pub fn evaluate_autofetch_candidates(input: AutofetchInput) -> AutofetchDecision {
    decide(&input)
}
