//! Fronteira napi das regras PURAS do Chupim já portadas para o `adom-core`.
//!
//! O lote (`evaluateAutofetchCandidates`, no `mod.rs`) decide uma busca
//! INTEIRA; estes bindings expõem cada régua AVULSA, para as cascas do Node que
//! ainda importam `src/providers/autofetch-*.ts` (chave de mortas, overflow do
//! teto por obra, posse do expirado, portões, progresso, fila persistida, pool
//! seeds e o resumo do trace). Nada aqui reimplementa: cada função traduz a
//! entrada e delega ao módulo real do núcleo — a régua é uma só.
//!
//! # Estado de PROCESSO (progresso)
//!
//! `derive_stall` recebe a memória por `&mut` no núcleo; no TS ela é um `Map` de
//! processo. Para a assinatura do Node continuar a mesma, a memória mora aqui
//! (`PROGRESS`) e é limpa por `forget_progress`, como no fonte.
//!
//! # Fatos, não IO
//!
//! `expired_removal_allowed` e `classify_enqueue` recebem FATOS já medidos
//! (cache, held, inventário e as aquisições de lock/vaga/obra/orçamento são IO
//! do Node). `pick_seeds_pool` recebe o universo JÁ filtrado por
//! `filter_seeds_universe`, como no fonte.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, MutexGuard, OnceLock};

use adom_core::{
    ExpiredFacts, FallbackPick, FallbackPool, ObraEntry, PoolStream, ProgressLot, ProgressMemory,
    QueueCandidateOpts, QueueEntry, RareConfig, SeedsPickLive, SeedsPickOpts, SkipReason,
    TorrentProgress, TorrentStatus, TraceValue,
};
use napi_derive::napi;

use super::convert::{gates_in, js_i64, pool_stream_in, trunc};
use super::types::{AutofetchStreamIn, EnqueueGatesIn, SeedsResultOut};

/// Structs de fronteira das regras (moram em `types.rs`, como as do lote).
pub use super::types::{
    ExpiredFactsIn, FallbackPickIn, ObraOverflowEntryIn, ProgressDerivationOut, ProgressLotIn,
    QueueCandidateOptsIn, QueueCandidateRuleOut, QueueEntryIn, QueueEntryOut, SeedsLiveIn,
    SeedsOptsIn, SeedsPoolInput, TorrentProgressIn, TorrentStatusIn, TorrentStatusPairIn,
};

// ---------------------------------------------------------------------------
// Regras
// ---------------------------------------------------------------------------

/// `deadKey(adapterId, account, infoHash)` — chave folha do registro de mortas.
#[napi(catch_unwind)]
pub fn dead_key(adapter: String, account: String, info_hash: String) -> String {
    adom_core::dead_key(&adapter, &account, &info_hash)
}

/// `overflowUpgradeAllowed(entries, pool, quality)` — overflow de upgrade (C11).
#[napi(catch_unwind)]
pub fn overflow_upgrade_allowed(
    entries: Vec<ObraOverflowEntryIn>,
    pool: String,
    quality: String,
) -> bool {
    let rows: Vec<ObraEntry> = entries
        .into_iter()
        .map(|e| ObraEntry {
            pool: e.pool,
            quality: e.quality,
            overflow: e.overflow,
        })
        .collect();
    adom_core::overflow_upgrade_allowed(&rows, &pool, &quality)
}

/// `expiredRemovalAllowed(facts)` — guarda de posse do `expired-unready`.
#[napi(catch_unwind)]
pub fn expired_removal_allowed(facts: ExpiredFactsIn) -> bool {
    adom_core::expired_removal_allowed(&ExpiredFacts {
        hash_empty: facts.hash_empty,
        is_cleanup_protected: facts.is_cleanup_protected,
        adapter_is_alldebrid: facts.adapter_is_alldebrid,
        has_marker: facts.has_marker,
        has_adsub: facts.has_adsub,
        has_snapshot: facts.has_snapshot,
        in_snapshot: facts.in_snapshot,
    })
}

/// `classifyEnqueue(gates)` — qual portão fechou, na ordem sagrada; `null` =
/// todos abertos (candidato enfileirável).
#[napi(catch_unwind)]
pub fn classify_enqueue(gates: EnqueueGatesIn) -> Option<String> {
    adom_core::classify_enqueue(&gates_in(&gates)).map(|r| r.as_str().to_string())
}

/// `rollbackFor(reason)` — o que a desistência precisa liberar, na ordem.
/// `null` = motivo desconhecido (o `noteSkip` do TS cai em `unknown`, que não é
/// portão e não tem tabela própria).
#[napi(catch_unwind)]
pub fn rollback_for(reason: String) -> Option<Vec<String>> {
    let parsed = SkipReason::parse(&reason)?;
    Some(
        adom_core::rollback_for(parsed)
            .iter()
            .map(|a| a.as_str().to_string())
            .collect(),
    )
}

/// `toQueueCandidate(stream, pool, opts)` — entrada persistida da fila.
#[napi(catch_unwind)]
pub fn to_queue_candidate(
    stream: AutofetchStreamIn,
    pool: String,
    opts: QueueCandidateOptsIn,
) -> QueueCandidateRuleOut {
    let s: PoolStream = pool_stream_in(&stream);
    let c = adom_core::to_queue_candidate(
        &s,
        &pool,
        &QueueCandidateOpts {
            imdb_id: opts.imdb_id,
            season: js_i64(opts.season),
            episode: js_i64(opts.episode),
            season_fill: opts.season_fill,
            rare: opts.rare,
            slot_limit: js_i64(opts.slot_limit),
            size_bytes: opts.size_bytes,
        },
    );
    QueueCandidateRuleOut {
        info_hash: c.info_hash,
        name: c.name,
        title: c.title,
        quality: c.quality,
        size: c.size,
        seeders: c.seeders,
        br: c.br,
        dubbed: c.dubbed,
        bank_dub: c.bank_dub,
        lied: c.lied,
        pool: c.pool,
        imdb_id: c.imdb_id,
        season: c.season,
        episode: c.episode,
        is_pack: c.is_pack,
        probe_season: c.probe_season,
        probe_episode: c.probe_episode,
        rare: c.rare,
        slot_limit: c.slot_limit,
    }
}

/// `composeQueueEntries(primarySurplus, fallbacks, depth)` — fila final.
#[napi(catch_unwind)]
pub fn compose_queue_entries(
    primary_surplus: Vec<QueueEntryIn>,
    fallbacks: Vec<FallbackPickIn>,
    depth: f64,
) -> napi::Result<Vec<QueueEntryOut>> {
    let primary: Vec<QueueEntry> = primary_surplus
        .into_iter()
        .map(|e| QueueEntry {
            index: e.index.max(0.0) as usize,
            pool: e.pool,
            rare: e.rare,
            slot_limit: js_i64(e.slot_limit),
        })
        .collect();
    let mut picks: Vec<FallbackPick> = Vec::with_capacity(fallbacks.len());
    for f in fallbacks {
        let pool = match f.pool.as_str() {
            "any" => FallbackPool::Any,
            "seeds" => FallbackPool::Seeds,
            other => {
                return Err(napi::Error::from_reason(format!(
                    "pool de fallback desconhecido: {other}"
                )))
            }
        };
        picks.push(FallbackPick {
            index: f.index.max(0.0) as usize,
            pool,
            rare: f.rare,
            slot_limit: js_i64(f.slot_limit),
        });
    }
    Ok(
        adom_core::compose_queue_entries(&primary, &picks, trunc(depth))
            .iter()
            .map(|e| QueueEntryOut {
                index: e.index as i64,
                pool: e.pool.clone(),
                rare: e.rare,
                slot_limit: e.slot_limit,
            })
            .collect(),
    )
}

/// `pickSeedsPool(streams, live, opts, viableHashes)` — pool seeds do Chupim.
#[napi(catch_unwind)]
pub fn pick_seeds_pool(input: SeedsPoolInput) -> SeedsResultOut {
    let streams: Vec<PoolStream> = input.streams.iter().map(pool_stream_in).collect();
    let viable: HashSet<String> = input
        .viable_hashes
        .into_iter()
        .map(|h| h.to_lowercase())
        .filter(|h| !h.is_empty())
        .collect();
    let r = adom_core::pick_seeds_pool(
        &streams,
        &SeedsPickLive {
            min_seeders: trunc(input.live.min_seeders),
            top_seeds_max: trunc(input.live.top_seeds_max),
            pt_first: input.live.pt_first,
        },
        &SeedsPickOpts {
            season: js_i64(input.opts.season),
            queue_depth: trunc(input.opts.queue_depth),
            rare: RareConfig {
                max: trunc(input.opts.rare.max),
                threshold: trunc(input.opts.rare.threshold),
                max_seeders: trunc(input.opts.rare.max_seeders),
            },
        },
        &viable,
    );
    SeedsResultOut {
        candidates: r.candidates.iter().map(|&i| i as i64).collect(),
        immediate_limit: r.immediate_limit,
        rare_used: r.rare_used,
    }
}

/// `setTraceChupim(note, enabled)` — resumo do Chupim já sanitizado, ou `null`
/// com o kill-switch desligado. A régua (magnet/hash fora + teto de 160
/// unidades UTF-16) é a do núcleo; o objeto de trace fica no Node, e o `chupim`
/// é o único campo que esta escrita toca.
#[napi(catch_unwind)]
pub fn set_trace_chupim(note: String, enabled: bool) -> Option<String> {
    let mut t = TraceValue::Object(Vec::new());
    adom_core::set_trace_chupim(Some(&mut t), &TraceValue::text(&note), enabled);
    let v = t.get("chupim")?;
    Some(String::from_utf16_lossy(v.to_text().as_units()))
}

// ---------------------------------------------------------------------------
// Progresso (memória de processo, como o `Map` do TS)
// ---------------------------------------------------------------------------

/// Memória de progresso do processo: o `Map<adapter:account:hash>` do fonte.
static PROGRESS: OnceLock<Mutex<ProgressMemory>> = OnceLock::new();

fn progress_memory() -> MutexGuard<'static, ProgressMemory> {
    PROGRESS
        .get_or_init(|| Mutex::new(ProgressMemory::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn status_in(s: TorrentStatusIn) -> TorrentStatus {
    TorrentStatus {
        state: s.state,
        id: s.id,
        progress: s.progress.map(|p| TorrentProgress {
            bytes: p.bytes,
            total: p.total,
            speed: p.speed,
            seeders: p.seeders,
        }),
    }
}

/// `deriveStall(lot, statuses)` — derivação CONSERVADORA de parada.
#[napi(catch_unwind)]
pub fn derive_stall(
    lot: ProgressLotIn,
    statuses: Vec<TorrentStatusPairIn>,
) -> ProgressDerivationOut {
    let by_hash: HashMap<String, TorrentStatus> = statuses
        .into_iter()
        .map(|p| (p.hash, status_in(p.status)))
        .collect();
    let out = adom_core::derive_stall(
        &mut progress_memory(),
        &ProgressLot {
            adapter_id: &lot.adapter_id,
            account: &lot.account,
            hashes: &lot.hashes,
            threshold: trunc(lot.threshold),
        },
        &by_hash,
    );
    // O `Set` do TS não ordena; ordenar aqui só torna o teste determinístico.
    let mut stalled: Vec<String> = out.stalled.into_iter().collect();
    stalled.sort();
    ProgressDerivationOut {
        stalled,
        signals: out.signals as i64,
    }
}

/// `forgetProgress(adapterId, account, hash)` — limpa UM hash do lote.
/// Devolve o tamanho da memória depois da limpeza (observabilidade).
#[napi(catch_unwind)]
pub fn forget_progress(adapter_id: String, account: String, hash: String) -> i64 {
    let mut memory = progress_memory();
    adom_core::forget_progress(&mut memory, &adapter_id, &account, &hash);
    adom_core::progress_memory_size(&memory) as i64
}

/// `progressMemorySize()` — observabilidade de vazamento.
#[napi(catch_unwind)]
pub fn progress_memory_size() -> i64 {
    adom_core::progress_memory_size(&progress_memory()) as i64
}
