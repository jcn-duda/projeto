//! Fonte do rotulo (`mediaSource`) reconstruida do `apply-debrid.json`.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

use super::annotate::{applied_hash, batch_item_hash};
use super::capture::{ApplyDebridFile, FileEntry};

/// `files.json` é `{ "<hash>": [{path,size}] }`; hash minúsculo é o contrato do
/// record — normalizar impede que um corpus escrito à mão perca o casamento em
/// silêncio. Lista vazia/ inválida não é medida e fica de fora.
pub(super) fn normalize_files(
    raw: BTreeMap<String, Vec<FileEntry>>,
) -> BTreeMap<String, Vec<FileEntry>> {
    raw.into_iter()
        .filter_map(|(hash, list)| {
            let hash = hash.trim().to_ascii_lowercase();
            let list: Vec<FileEntry> = list
                .into_iter()
                .filter(|file| !file.path.is_empty() && file.size > 0.0)
                .collect();
            (!hash.is_empty() && !list.is_empty()).then_some((hash, list))
        })
        .collect()
}

/// `proven-quality.json` é `{ "<hash>": "<quality>" }`; hash minúsculo é o
/// contrato do record, mas normalizar aqui impede que um corpus antigo/escrito
/// à mão com maiúsculas perca o casamento em silêncio. Qualidade vazia não é
/// prova: fica de fora para não virar balde nomeado.
pub(super) fn normalize_qualities(raw: BTreeMap<String, String>) -> BTreeMap<String, String> {
    raw.into_iter()
        .filter_map(|(hash, quality)| {
            let hash = hash.trim().to_ascii_lowercase();
            let quality = quality.trim().to_string();
            (!hash.is_empty() && !quality.is_empty()).then_some((hash, quality))
        })
        .collect()
}

/// Fonte do rótulo por hash, lida do `behaviorHints.bingeGroup` do
/// `apply-debrid.json` — o VENCEDOR do dedupe, com a fonte que o Node exibiu no
/// `name` (`powerm-<qualidade>-<fonte>`). `any` = o Node não tinha fonte.
pub(super) fn applied_media_sources(files: &[ApplyDebridFile]) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for file in files {
        for item in &file.output {
            let Some(hash) = applied_hash(item) else {
                continue;
            };
            // A PRIMEIRA ocorrência do hash é a do vencedor da passada (a
            // mesma regra de `applied_qualities`). Ela pode dizer `any` (sem
            // fonte) ou nem trazer `behaviorHints`; nesse caso a passada
            // seguinte NÃO pode emprestar a fonte dela — era o que pintava um
            // item `📦 · 720p` de `BluRay` porque o re-passe do debrid tinha a
            // mesma hash com outro rótulo.
            if !seen.insert(hash.clone()) {
                continue;
            }
            let Some(source) = item
                .get("behaviorHints")
                .and_then(|hints| hints.get("bingeGroup"))
                .and_then(Value::as_str)
                .and_then(source_from_binge_group)
            else {
                continue;
            };
            out.insert(hash, source);
        }
    }
    out
}

/// `powerm-<2160p|1080p|720p|480p|SD|na>-<fonte>` → fonte (`WEB-DL`, `BluRay`…).
/// A fonte pode conter hífen (`WEB-DL`), por isso só o PRIMEIRO token é a
/// qualidade; `any` é a ausência de fonte no Node.
pub(super) fn source_from_binge_group(binge: &str) -> Option<String> {
    let rest = binge.strip_prefix("powerm-")?;
    let (quality, source) = rest.split_once('-')?;
    if !matches!(quality, "2160p" | "1080p" | "720p" | "480p" | "SD" | "na") {
        return None;
    }
    let source = source.trim();
    (!source.is_empty() && source != "any").then(|| source.to_string())
}

/// Repõe `mediaSource` nos itens. O `toStremioStream` lê `titleSource ||
/// magnetSource || mediaSource`; a fonte vinda do índice/banco não está no item
/// cru da captura, então sem esta reposição o `name` do replay perde o "WEB-DL".
/// Item que já traz a fonte vence: é a do próprio lote.
pub(super) fn annotate_media_source_items(items: &mut [Value], sources: &BTreeMap<String, String>) {
    for item in items {
        if item
            .get("mediaSource")
            .is_some_and(|value| !value.is_null())
        {
            continue;
        }
        let Some(hash) = batch_item_hash(item) else {
            continue;
        };
        let Some(source) = sources.get(&hash) else {
            continue;
        };
        if let Some(map) = item.as_object_mut() {
            map.insert("mediaSource".into(), Value::String(source.clone()));
        }
    }
}
