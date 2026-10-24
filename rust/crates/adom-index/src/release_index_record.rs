//! Escrita do `idx:v14` (`releaseIndex.record`): merge por hash, roteamento
//! da release pela temporada/episódio e corte protegido BR.
//!
//! Submódulo de `release_index`: enxerga a `conn` e os helpers privados.

use std::collections::HashMap;

use adom_core::{
    audio_from_title, cut_protected, explicit_pt_audio, extract_info_hash, magnet_display_name,
    merge_media_source, quality_from_title, route_work_location, BankRow, CutKey, MagnetLike,
    WorkTarget,
};
use serde_json::Value;

use super::{BankLookup, IndexEntry, IndexedRelease, RecordOptions, ReleaseIndexStore};

impl ReleaseIndexStore {
    /// `releaseIndex.record`. Devolve quantos hashes NOVOS ficaram no índice
    /// (o `search.idx.recorded` do Node).
    #[allow(clippy::too_many_arguments)]
    pub fn record(
        &self,
        imdb_id: &str,
        location: WorkTarget,
        items: &[Value],
        opts: RecordOptions<'_>,
        ttl_seconds: u64,
        max_releases: usize,
        now_ms: i64,
        bank: Option<BankLookup<'_>>,
    ) -> Result<usize, String> {
        if ttl_seconds == 0 || !imdb_id.starts_with("tt") || items.is_empty() || max_releases == 0 {
            return Ok(0);
        }
        let mut candidates: Vec<Candidate<'_>> = Vec::new();
        for item in items {
            if truthy(item.get("fromAccount")) {
                continue;
            }
            let hash = record_hash(item);
            if hash.is_empty() {
                continue;
            }
            let title = item_title(item).trim().to_string();
            candidates.push(Candidate {
                item,
                magnet: MagnetLike {
                    magnet: string_of(item.get("magnet")),
                    magnet_uri: string_of(item.get("MagnetUri")),
                    guid: string_of(item.get("Guid")),
                },
                hash,
                title,
            });
        }
        if candidates.is_empty() {
            return Ok(0);
        }

        // Fonte de mídia: as linhas do acervo dos hashes SEM `dn=` no item.
        let lookup = |hashes: &[String]| bank.map(|lookup| lookup(hashes)).unwrap_or_default();
        let lote: Vec<(MagnetLike, String)> = candidates
            .iter()
            .map(|cand| (cand.magnet.clone(), cand.hash.clone()))
            .collect();
        let bank_by_hash = adom_core::bank_rows_for_media_source(&lote, Some(&lookup));

        // Roteamento por título (dn mais específico manda).
        let mut por_chave: HashMap<String, Vec<&Candidate<'_>>> = HashMap::new();
        let mut ordem: Vec<String> = Vec::new();
        for cand in &candidates {
            let dn = dn_for_record(cand, &bank_by_hash);
            let destino = route_work_location(location, &cand.title, Some(dn.as_str()));
            let key = Self::obra_key(imdb_id, destino);
            if !por_chave.contains_key(&key) {
                ordem.push(key.clone());
            }
            por_chave.entry(key).or_default().push(cand);
        }

        let mut added = 0usize;
        for key in ordem {
            let Some(lote) = por_chave.get(&key) else {
                continue;
            };
            let prior_entry = self.read_entry(&key, now_ms);
            let mut releases: Vec<IndexedRelease> = prior_entry
                .as_ref()
                .map(|entry| entry.releases.clone())
                .unwrap_or_default();
            let mut index_of: HashMap<String, usize> = HashMap::new();
            for (index, release) in releases.iter().enumerate() {
                index_of.insert(release.hash.clone(), index);
            }
            let mut novos: Vec<String> = Vec::new();
            for cand in lote {
                let prior = index_of
                    .get(&cand.hash)
                    .map(|index| releases[*index].clone());
                let Some(merged) = merge_release(cand, prior.as_ref(), opts, now_ms, &bank_by_hash)
                else {
                    continue;
                };
                match index_of.get(&cand.hash) {
                    Some(index) => releases[*index] = merged,
                    None => {
                        novos.push(cand.hash.clone());
                        index_of.insert(cand.hash.clone(), releases.len());
                        releases.push(merged);
                    }
                }
            }
            if releases.is_empty() {
                // `existing.size === 0` no TS nunca ocorre com lote não vazio,
                // mas o guarda mantém o arquivo honesto.
                continue;
            }
            let (kept, _protected_dropped) =
                cut_protected(&releases, max_releases, |release| CutKey {
                    is_br: release.is_br,
                    dubbed: release.dubbed,
                    seen_at: release.seen_at,
                    seeders: release.seeders,
                });
            added += kept
                .iter()
                .filter(|release| novos.contains(&release.hash))
                .count();
            let partial = if opts.keep_partial {
                prior_entry.as_ref().is_some_and(|entry| entry.partial) || opts.partial
            } else {
                opts.partial
            };
            let entry = IndexEntry {
                at: now_ms,
                partial,
                releases: kept,
            };
            self.write_entry(&key, &entry, ttl_seconds, now_ms)?;
        }
        Ok(added)
    }
}

/// Candidato do lote (o item cru + o magnet para a fonte de mídia).
struct Candidate<'a> {
    item: &'a Value,
    magnet: MagnetLike,
    hash: String,
    title: String,
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Null) | None => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

fn string_of(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => (!text.is_empty()).then(|| text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

fn number_of(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                Some(0.0)
            } else {
                trimmed.parse::<f64>().ok()
            }
        }
        Value::Bool(flag) => Some(f64::from(u8::from(*flag))),
        _ => None,
    }
}

/// `String(item.title || item.Title || '')`.
fn item_title(item: &Value) -> String {
    string_of(item.get("title"))
        .or_else(|| string_of(item.get("Title")))
        .unwrap_or_default()
}

/// `String(extractInfoHash(item.infoHash || item.magnet || '') || '').toLowerCase()`.
fn record_hash(item: &Value) -> String {
    let source = string_of(item.get("infoHash"))
        .or_else(|| string_of(item.get("magnet")))
        .unwrap_or_default();
    extract_info_hash(&source).unwrap_or_default()
}

fn dn_for_record(cand: &Candidate<'_>, bank_by_hash: &HashMap<String, BankRow>) -> String {
    let from_item = magnet_display_name(
        cand.magnet.magnet.as_deref(),
        cand.magnet.magnet_uri.as_deref(),
        cand.magnet.guid.as_deref(),
    );
    if !from_item.is_empty() {
        return from_item;
    }
    let Some(row) = bank_by_hash.get(&cand.hash) else {
        return String::new();
    };
    let from_row = magnet_display_name(Some(row.uri.as_str()), None, None);
    if from_row.is_empty() {
        row.title.clone()
    } else {
        from_row
    }
}

/// Merge de UMA release (`record`), com as mesmas decisões do TS.
fn merge_release(
    cand: &Candidate<'_>,
    prior: Option<&IndexedRelease>,
    opts: RecordOptions<'_>,
    now_ms: i64,
    bank_by_hash: &HashMap<String, BankRow>,
) -> Option<IndexedRelease> {
    let item = cand.item;
    let item_source = match string_of(item.get("indexSource")).as_deref() {
        Some("autofetch") => Some("autofetch"),
        _ => opts.source,
    };
    let promotes_observed = prior.and_then(|release| release.source.as_deref())
        == Some("autofetch")
        && item_source != Some("autofetch");
    if let Some(prior) = prior {
        if prior.seen_at >= now_ms && !promotes_observed {
            return None;
        }
    }
    let prior_is_br = prior.is_some_and(|release| release.is_br);
    let is_br = truthy(item.get("isBr")) || prior_is_br;
    let title = if cand.title.is_empty() {
        prior
            .map(|release| release.title.clone())
            .unwrap_or_default()
    } else {
        cand.title.clone()
    };
    let classified_dubbed = if is_br {
        matches!(audio_from_title(&title), "Dublado" | "Dual" | "Nacional")
    } else {
        explicit_pt_audio(&title)
    };
    // No autofetch a classificação já atravessou o `toStremioStream` (pode ter
    // prova de arquivo): só o título perderia essa evidência.
    let dubbed = if item_source == Some("autofetch") && item.get("dubbed").is_some() {
        truthy(item.get("dubbed"))
    } else {
        classified_dubbed
    };
    let prior_autofetch = prior.and_then(|release| release.source.as_deref()) == Some("autofetch");
    let source = if item_source == Some("autofetch") && (prior.is_none() || prior_autofetch) {
        Some("autofetch".to_string())
    } else {
        None
    };
    let media_source = merge_media_source(
        &cand.magnet,
        &title,
        &cand.hash,
        prior.and_then(|release| release.media_source.as_deref()),
        Some(bank_by_hash),
    );
    let size = number_of(item.get("size"))
        .or_else(|| number_of(item.get("Size")))
        .map(|number| number.trunc() as i64)
        .filter(|number| *number != 0);
    let indexer = string_of(item.get("indexer"))
        .or_else(|| string_of(item.get("tracker")))
        .or_else(|| prior.map(|release| release.indexer.clone()))
        .unwrap_or_default();
    let tracker = string_of(item.get("tracker"))
        .or_else(|| prior.and_then(|release| release.tracker.clone()))
        .filter(|value| !value.is_empty());
    let quality = if item_source == Some("autofetch") {
        string_of(item.get("quality")).unwrap_or_else(|| quality_from_title(&title).to_string())
    } else {
        quality_from_title(&title).to_string()
    };
    let seeders = number_of(item.get("seeders"))
        .or_else(|| number_of(item.get("Seeders")))
        .map(|number| number.trunc() as i64)
        .filter(|number| *number != 0)
        .unwrap_or(0)
        .max(prior.map(|release| release.seeders).unwrap_or(0));
    Some(IndexedRelease {
        hash: cand.hash.clone(),
        title,
        size,
        indexer,
        tracker,
        is_br,
        dubbed: dubbed || prior.is_some_and(|release| release.dubbed),
        quality,
        seeders,
        seen_at: now_ms,
        lied: truthy(item.get("lied")) || prior.is_some_and(|release| release.lied),
        source,
        media_source,
    })
}
