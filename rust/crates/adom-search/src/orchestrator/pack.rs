//! Pack de temporada da série — o `needsPack` e o `packTail` de
//! `search-orchestrator.ts`, que o orquestrador Rust não tinha.
//!
//! - **Fallback no caminho crítico**: coleta do episódio vazia, ou completa e
//!   sem nada relevante, refaz a coleta com `Nome SNN` (e o pt-BR/original).
//!   As fontes BR só publicam pack de temporada: é aqui que elas aparecem.
//! - **Pack tardio** (`SEARCH_PACK_TAIL`): sem o fallback, o tail busca o
//!   pack da temporada e MESCLA — hash novo entra; hash conhecido com swarm
//!   maior só sobe o seeders (a fusão por hash do `fuseIndexEnrichment`).

use std::collections::HashMap;

use tokio::task::JoinHandle;

use super::fast_path::full_window;
use super::finish::SearchInput;
use super::live_state::{live_state_snapshot, merge_into_shared, SharedLiveState};
use super::meta::SearchMeta;
use super::Orchestrator;
use crate::raw_item::RawItem;

/// Saída de uma coleta: (itens, parcial, completion, todas_falharam, estado vivo).
pub(super) type CollectOut = (
    Vec<RawItem>,
    bool,
    Option<JoinHandle<Vec<RawItem>>>,
    bool,
    SharedLiveState,
);

/// As queries do pack da temporada (`Nome S01`, `<pt> S01`, `<original> S01`).
/// `None` = não é série.
pub(super) fn pack_meta(meta: &SearchMeta) -> Option<SearchMeta> {
    let season = meta.season?;
    let s = format!("S{season:02}");
    let mut pack = meta.clone();
    pack.query = format!("{} {s}", meta.name);
    // Igual ao TS: pt-BR só quando a busca já tinha a query pt (título difere).
    pack.pt_query = meta
        .pt_query
        .as_ref()
        .and(meta.pt_title.as_ref())
        .map(|pt| format!("{pt} {s}"));
    pack.original_query = meta.original_query.as_ref().map(|o| format!("{o} {s}"));
    // O TS não passa o degrau multiobra na coleta do pack.
    pack.multi_work_query = None;
    Some(pack)
}

/// Fusão por hash: novo entra; conhecido só sobe o seeders. Devolve quantos
/// entraram e quantos foram fundidos.
pub(super) fn fuse_pack(base: &mut Vec<RawItem>, pack: Vec<RawItem>) -> (usize, usize) {
    let mut index: HashMap<String, usize> = HashMap::new();
    for (i, item) in base.iter().enumerate() {
        let hash = item.hash();
        if !hash.is_empty() {
            index.entry(hash).or_insert(i);
        }
    }
    let (mut fresh, mut fused) = (0, 0);
    for item in pack {
        let hash = item.hash();
        if hash.is_empty() {
            continue;
        }
        match index.get(&hash) {
            Some(&i) => {
                let novo = item.seeders.unwrap_or(0.0);
                if novo > base[i].seeders.unwrap_or(0.0) {
                    base[i].seeders = Some(novo);
                    fused += 1;
                }
            }
            None => {
                index.insert(hash, base.len());
                base.push(item);
                fresh += 1;
            }
        }
    }
    (fresh, fused)
}

impl Orchestrator {
    /// O `needsPack` do TS: coleta do episódio vazia, ou completa sem nada que
    /// passe no filtro de título. Devolve a coleta do pack, que SUBSTITUI a
    /// do episódio na resposta (o TS faz `raw = await collectRaw(pack…)`).
    pub(super) async fn pack_fallback(
        &self,
        input: &SearchInput,
        meta: &SearchMeta,
        items: &[RawItem],
        partial: bool,
    ) -> Option<CollectOut> {
        if meta.is_demo {
            return None;
        }
        let pack = pack_meta(meta)?;
        let relevant = if items.is_empty() {
            0
        } else {
            let mut ctx = self.build_context(input, meta);
            super::file_sizes::merge_file_sizes(self.file_sizes.as_deref(), items, &mut ctx);
            let opts = super::config::build_options_from(&input.options, &self.config.build);
            crate::list_builder::relevant_count(items, &ctx, &opts)
        };
        let needs = items.is_empty() || (!partial && relevant == 0);
        if !needs {
            return None;
        }
        eprintln!("[search] sem resultados; tentando pack \"{}\"", pack.query);
        Some(self.collect(input, &pack).await)
    }

    /// O pack tardio: envolve o `completion` da resposta. O tail espera o lote
    /// COMPLETO do episódio, coleta o pack (prazo do tail) e devolve a lista
    /// fundida — o `late` reconstrói quando ela mudou.
    pub(super) fn with_pack_tail(
        &self,
        input: &SearchInput,
        meta: &SearchMeta,
        base: Vec<RawItem>,
        completion: Option<JoinHandle<Vec<RawItem>>>,
        tail_live: Option<&SharedLiveState>,
    ) -> Option<JoinHandle<Vec<RawItem>>> {
        let Some(pack) = pack_meta(meta).filter(|_| self.config.pack_tail && !meta.is_demo) else {
            return completion;
        };
        let this = self.clone();
        let tail_input = self.tail_input(input);
        let tail_live = tail_live.cloned();
        Some(tokio::spawn(async move {
            let mut full = full_window(base, completion).await;
            let (items, _, pack_completion, _, pack_live) = this.collect(&tail_input, &pack).await;
            let pack_items = full_window(items, pack_completion).await;
            // Une o estado vivo da coleta do pack ao do tail (mergeLiveIndexerStates).
            if let (Some(shared), Some(state)) =
                (tail_live.as_ref(), live_state_snapshot(&pack_live))
            {
                merge_into_shared(shared, &state);
            }
            let (fresh, fused) = fuse_pack(&mut full, pack_items);
            if fresh > 0 || fused > 0 {
                eprintln!("[search] pack tardio: {fresh} novo(s), {fused} evidência fundida");
            }
            full
        }))
    }
}

#[cfg(test)]
#[path = "pack_tests.rs"]
mod pack_tests;
