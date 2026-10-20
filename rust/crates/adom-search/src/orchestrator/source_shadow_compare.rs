//! Comparação pura da sombra de fonte: conjuntos de `info_hash` normalizado
//! por indexer, estado vivo e `partial` (este apenas informativo — janela do
//! Node não é divergência de fonte). Sem métricas/log (o chamador decide).

use std::collections::{BTreeMap, BTreeSet};

use crate::orchestrator::collect::CollectBatch;
use crate::orchestrator::live_state::{LiveAllState, LiveBatchState};

/// Resultado da comparação de dois lotes.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ShadowComparison {
    pub missing: BTreeMap<String, BTreeSet<String>>,
    pub extra: BTreeMap<String, BTreeSet<String>>,
    pub missing_count: u64,
    pub extra_count: u64,
    pub live_divergence: bool,
    pub partial_divergence: bool,
}

impl ShadowComparison {
    /// Divergência de FONTE. `partial_divergence` fica de fora de propósito:
    /// `partial` é a janela de coleta do Node, não um desacordo de indexer.
    pub fn diverged(&self) -> bool {
        self.missing_count > 0 || self.extra_count > 0 || self.live_divergence
    }
}

/// Compara o lote nativo (esquerda) com o Node (referência), incluindo `live`.
pub fn compare_batches(native: &CollectBatch, node: &CollectBatch) -> ShadowComparison {
    compare_batches_opts(native, node, true)
}

/// Compara com o `live` opcional. `compare_live:false` é para fonte cujo Node
/// NÃO promete contrato vivo (Prowlarr): o snapshot da referência é vazio por
/// construção e usá-lo acusaria divergência falsa. Hashes/`partial` seguem
/// comparados normalmente.
pub fn compare_batches_opts(
    native: &CollectBatch,
    node: &CollectBatch,
    compare_live: bool,
) -> ShadowComparison {
    let native_sets = by_indexer(native);
    let node_sets = by_indexer(node);
    let empty = BTreeSet::new();

    let mut missing = BTreeMap::new();
    for (indexer, node_hashes) in &node_sets {
        let native_hashes = native_sets.get(indexer).unwrap_or(&empty);
        let diff: BTreeSet<String> = node_hashes.difference(native_hashes).cloned().collect();
        if !diff.is_empty() {
            missing.insert(indexer.clone(), diff);
        }
    }

    let mut extra = BTreeMap::new();
    for (indexer, native_hashes) in &native_sets {
        let node_hashes = node_sets.get(indexer).unwrap_or(&empty);
        let diff: BTreeSet<String> = native_hashes.difference(node_hashes).cloned().collect();
        if !diff.is_empty() {
            extra.insert(indexer.clone(), diff);
        }
    }

    let missing_count = missing.values().map(BTreeSet::len).sum::<usize>() as u64;
    let extra_count = extra.values().map(BTreeSet::len).sum::<usize>() as u64;
    ShadowComparison {
        missing,
        extra,
        missing_count,
        extra_count,
        live_divergence: compare_live && live_differs(native.live.as_ref(), node.live.as_ref()),
        partial_divergence: native.partial != node.partial,
    }
}

/// Conjunto de hashes normalizados por indexer. Itens de conta ficam de fora
/// (o Node sempre roda o inventário; o nativo não), assim como item sem hash.
fn by_indexer(batch: &CollectBatch) -> BTreeMap<String, BTreeSet<String>> {
    let mut out: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for item in &batch.items {
        if item.from_account {
            continue;
        }
        let hash = item.hash().trim().to_ascii_lowercase();
        if hash.is_empty() {
            continue;
        }
        let indexer = item
            .indexer
            .as_deref()
            .map(|id| id.trim().to_ascii_lowercase())
            .filter(|id| !id.is_empty())
            .unwrap_or_else(|| "sem-indexer".to_string());
        out.entry(indexer).or_default().insert(hash);
    }
    out
}

/// `live` só compara quando os DOIS lados têm o contrato. `all` só entra se
/// ambos têm veredito (`Unknown` = sem ramo `/all`, não divergência).
fn live_differs(native: Option<&LiveBatchState>, node: Option<&LiveBatchState>) -> bool {
    let (Some(native), Some(node)) = (native, node) else {
        return false;
    };
    let sets_differ = native.failed != node.failed
        || native.pending != node.pending
        || native.empty != node.empty;
    let both_known = native.all != LiveAllState::Unknown && node.all != LiveAllState::Unknown;
    sets_differ || (both_known && native.all != node.all)
}
