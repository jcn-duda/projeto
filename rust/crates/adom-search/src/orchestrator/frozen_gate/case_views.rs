//! Vistas derivadas da captura: `instant` do sorteio e lote da via rapida.

use std::collections::BTreeSet;

use serde_json::Value;

use crate::raw_item::{raw_item_from_value, RawItem};

use super::case::FrozenCase;

impl FrozenCase {
    /// Hashes do inventário da conta (itens `fromAccount` da captura). É a
    /// evidência `instant` que o Node usa no sorteio (inventário pronto/alive).
    pub(super) fn instant_hashes(&self) -> Vec<String> {
        let mut set = BTreeSet::new();
        for entry in &self.collect {
            for item in &entry.response.items {
                if !item
                    .get("fromAccount")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    continue;
                }
                let hash = item
                    .get("infoHash")
                    .and_then(Value::as_str)
                    .or_else(|| item.get("magnet").and_then(Value::as_str))
                    .map(|raw| {
                        adom_core::extract_info_hash(raw)
                            .unwrap_or_default()
                            .trim()
                            .to_ascii_lowercase()
                    })
                    .unwrap_or_default();
                if !hash.is_empty() {
                    set.insert(hash);
                }
            }
        }
        set.into_iter().collect()
    }

    /// Lote da via rápida do replay: o batch capturado VERBATIM. Substituiu a
    /// rota Node `search/index` (removida no R4) — as fontes nativas são
    /// wire-shaped (`IndexedReleaseWire`/`InstantWork`/`InventoryItem`) e não
    /// carregam a prova POR ITEM que o build do Node já aplicou
    /// (`provenQuality`/`provenAudio`/`provenName`/`mediaSource`). Fora da via
    /// instantânea o `fast_path` neutraliza `fromSnapshot`, como em produção;
    /// `None` = nem instantânea nem índice coberto (a coleta ao vivo segue).
    pub(super) fn fast_path_lote(&self) -> Option<(bool, Vec<RawItem>)> {
        let batch = self.index.as_ref()?;
        if !batch.instant && !batch.index_covered {
            return None;
        }
        let mut items: Vec<RawItem> = batch.items.iter().map(raw_item_from_value).collect();
        if !batch.instant {
            for item in &mut items {
                item.from_snapshot = false;
            }
        }
        Some((batch.instant, items))
    }
}
