//! Releases/instantanea -> `RawItem`/`PoolCoverageItem` (as reguas do TS).

use std::collections::HashMap;

use adom_core::{magnet_display_name, InstantItem, PoolCoverageItem};
use serde_json::{json, Map};

use crate::raw_item::RawItem;

use super::index_source::{IndexedReleaseWire, MagnetBankSource};

/// Releases do índice → pseudo-item de cobertura (`PoolCoverageItem`).
pub(super) fn release_to_coverage(release: &IndexedReleaseWire) -> PoolCoverageItem {
    PoolCoverageItem {
        title: Some(release.title.clone()),
        quality: Some(release.quality.clone()),
        seeders: Some(json!(release.seeders)),
        hash: Some(release.hash.clone()),
        is_br: release.is_br,
        dubbed: Some(Some(release.dubbed)),
        source: release.source.clone(),
        ..PoolCoverageItem::default()
    }
}

/// Item instantâneo → pseudo-item de cobertura.
pub(super) fn instant_to_coverage(item: &InstantItem) -> PoolCoverageItem {
    PoolCoverageItem {
        title: Some(item.title.clone()),
        quality: Some(item.quality.clone()),
        seeders: Some(json!(item.seeders)),
        hash: Some(item.info_hash.clone()),
        magnet: item.magnet.clone(),
        is_br: item.is_br,
        dubbed: Some(Some(item.dubbed)),
        ..PoolCoverageItem::default()
    }
}

/// `idxReleasesToRaw` do TS: sem marca (o chamador põe `fromSnapshot`).
pub(super) fn release_to_raw(release: &IndexedReleaseWire, from_snapshot: bool) -> RawItem {
    let mut extra = Map::new();
    extra.insert("dubbed".to_string(), release.dubbed.into());
    if !release.quality.is_empty() {
        extra.insert("quality".to_string(), release.quality.clone().into());
    }
    if let Some(source) = &release.source {
        extra.insert("indexSource".to_string(), source.clone().into());
    }
    RawItem {
        title: Some(release.title.clone()),
        info_hash: Some(release.hash.clone()),
        seeders: Some(release.seeders as f64),
        size_bytes: release.size.map(|size| size as f64),
        indexer: Some(release.indexer.clone()),
        tracker: release
            .tracker
            .clone()
            .or_else(|| Some(release.indexer.clone())),
        is_br: release.is_br,
        from_snapshot,
        lied: release.lied,
        media_source: release.media_source.clone(),
        extra,
        ..RawItem::default()
    }
}

/// Anexa o `dn=` do acervo aos itens do índice (uma leitura em lote). Só a
/// origem BR o lê: sem ele o veto de `dn` russo ficava cego no index-only.
pub(super) fn attach_bank_dn(items: &mut [RawItem], bank: &dyn MagnetBankSource) {
    let hashes: Vec<String> = items
        .iter()
        .map(RawItem::hash)
        .filter(|hash| !hash.is_empty())
        .collect();
    if hashes.is_empty() {
        return;
    }
    let by_hash: HashMap<String, String> = bank
        .bank_rows_many(&hashes)
        .into_iter()
        .map(|row| {
            let dn = magnet_display_name(Some(row.uri.as_str()), None, None);
            (row.hash.to_lowercase(), dn)
        })
        .filter(|(_, dn)| !dn.is_empty())
        .collect();
    for item in items.iter_mut() {
        if let Some(dn) = by_hash.get(&item.hash()) {
            item.bank_dn = Some(dn.clone());
        }
    }
}

/// `toRawItem` da via instantânea: selo 📦 + flags que o build lê
/// (`dubbed`/`quality`/`fallbackFetchable`).
pub(super) fn instant_to_raw(item: &InstantItem) -> RawItem {
    let mut extra = Map::new();
    extra.insert("dubbed".to_string(), item.dubbed.into());
    if !item.quality.is_empty() {
        extra.insert("quality".to_string(), item.quality.clone().into());
    }
    if item.fallback_fetchable {
        extra.insert("fallbackFetchable".to_string(), true.into());
    }
    RawItem {
        title: Some(item.title.clone()),
        info_hash: Some(item.info_hash.clone()),
        magnet: item.magnet.clone(),
        seeders: Some(item.seeders as f64),
        size_bytes: item.size.map(|size| size as f64),
        indexer: Some(item.indexer.clone()),
        tracker: (!item.tracker.is_empty()).then(|| item.tracker.clone()),
        is_br: item.is_br,
        from_fallback: true,
        extra,
        ..RawItem::default()
    }
}
