//! Fatos da cascata medidos no `enqueue` — a parte de LEITURA do lote.
//!
//! Separado de `enqueue.rs` pela catraca de linhas: aqui não há decisão nem
//! escrita, só as perguntas ao KV (orçamento, canal `adrm`, cache por hash) e a
//! montagem do [`CascadeFacts`] que a cascata consome.
//!
//! O que ainda NÃO é medido aqui entra no default do crate — `probe_pending`,
//! `seeds_block`, `seeds_stop`, `rare_over_cached` e o `obra` (o teto por obra é
//! aplicado no portão do candidato, em [`super::obra`], como o `tryObraCap` do
//! TS: `autofetch-gates.ts:57`). Teto do crate é 0 = "não medido, não barra".

use std::collections::HashSet;

use adom_autofetch::v3::CascadeFacts;
use adom_index::NativeKv;

use super::gates::{self, LivePolicy};
use crate::autofetch::enqueue_items::Item;

/// Fatos prontos mais o conjunto de hashes marcados pelo anti-reenchimento.
pub(super) struct Measured {
    pub(super) facts: CascadeFacts,
    pub(super) adrm: HashSet<String>,
}

/// Entradas da medição (contexto do lote, já validado pelo chamador).
#[derive(Clone, Copy)]
pub(super) struct Measure<'a> {
    pub(super) kv: &'a NativeKv,
    pub(super) adapter: &'a str,
    pub(super) account: &'a str,
    pub(super) live: &'a LivePolicy,
    pub(super) paused: bool,
    /// Uso da conta medido pela sonda (`debrid.account()`), quando ligada.
    pub(super) account_used: Option<u64>,
    pub(super) items: &'a [Item],
    /// Hashes do lote com hold desta chamada (só eles contam como fatos).
    pub(super) eligible: &'a HashSet<&'a str>,
    pub(super) cached: &'a HashSet<String>,
    pub(super) hashes: &'a [String],
    pub(super) now_ms: i64,
}

pub(super) fn measure(input: Measure<'_>) -> Result<Measured, String> {
    // Orçamento cheio NÃO é recusa: vira `budget_blocked` e a cascata adia.
    let budget_full = gates::budget_count(input.kv, input.adapter, input.account, input.now_ms)?
        >= input.live.hourly_limit;
    let mut facts = CascadeFacts {
        paused: input.paused,
        cache_known: true,
        slots: input.live.max_attempts,
        account_blocked: gates::account_is_blocked(input.account_used, input.live.pause_at),
        budget_blocked: budget_full,
        ..CascadeFacts::default()
    };
    let in_batch = |item: &&Item| input.eligible.contains(item.info_hash.as_str());
    let is_cached = |item: &&Item| input.cached.contains(&item.info_hash);
    facts.has_cached_br_dubbed = input
        .items
        .iter()
        .filter(in_batch)
        .any(|item| item.is_br_dubbed_proven() && is_cached(&item));
    facts.has_cached_any_dubbed = input
        .items
        .iter()
        .filter(in_batch)
        .any(|item| item.dubbed && !item.lied && is_cached(&item));
    facts.covered_qualities = input
        .items
        .iter()
        .filter(in_batch)
        .filter(|item| item.is_br_dubbed_proven() && is_cached(item))
        .filter_map(|item| item.quality.clone())
        .collect();

    // Invariante 6: hash que a evicção apagou DE PROPÓSITO (`adrm:v1`) sai dos
    // candidatos ANTES dos pools — só LEITURA aqui: quem marca é a evicção. A
    // checagem consulta o mesmo `adrm` (`blocked_for_check`, fail-closed): a
    // marca fecha as DUAS portas que reenviam hash ao serviço.
    let adrm = gates::adrm_blocked(input.kv, input.account, input.hashes, input.now_ms)?;
    Ok(Measured { facts, adrm })
}
