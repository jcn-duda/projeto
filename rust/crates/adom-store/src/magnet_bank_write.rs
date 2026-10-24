//! Escrita do acervo (markBankFilterOutcome): passed_filter 1/0 e last_seen nas
//! linhas que JÁ existem, por hash e por alvo.
//!
//! Separado da leitura (worksForObraMany/sourcesForMany) porque é a parte com
//! CAS: last_seen só avança e passed_filter só cede para um lote de carimbo
//! igual ou mais novo — o lost update da Fase 4.0.4.

use std::collections::{HashMap, HashSet};

use adom_core::{extract_info_hash, magnet_display_name, release_work_targets, WorkTarget};
use rusqlite::params;
use serde_json::Value;

use super::{tuple, MagnetBankStore};

/// Contexto da escrita do filtro (`markBankFilterOutcome`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WorkCtx {
    pub imdb_id: String,
    pub season: Option<i64>,
    pub episode: Option<i64>,
}

/// `hashOf`: primeiro campo que rende um infoHash válido.
pub fn hash_of(item: &Value) -> String {
    let candidates = [
        item.get("infoHash"),
        item.get("magnet"),
        item.get("MagnetUri"),
        item.get("Guid"),
    ];
    for candidate in candidates.into_iter().flatten() {
        let text = match candidate {
            Value::String(text) => text.clone(),
            Value::Number(number) => number.to_string(),
            _ => continue,
        };
        if let Some(hash) = extract_info_hash(&text) {
            let lower = hash.trim().to_lowercase();
            if !lower.is_empty() {
                return lower;
            }
        }
    }
    String::new()
}

/// `hashesOf`: hashes únicos, na ordem, sem item de conta nem reserva.
fn hashes_of(items: &[Value]) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for item in items {
        if truthy(item.get("fromAccount")) || truthy(item.get("fromFallback")) {
            continue;
        }
        let hash = hash_of(item);
        if !hash.is_empty() && seen.insert(hash.clone()) {
            out.push(hash);
        }
    }
    out
}

/// `targetsFor`: obras extras por hash (packs que o título declara). Só entra
/// no mapa quando há MAIS DE UM alvo (o do pedido é o default do banco).
fn targets_for(items: &[Value], ctx: &WorkCtx) -> HashMap<String, Vec<(i64, i64)>> {
    let mut out: HashMap<String, Vec<(i64, i64)>> = HashMap::new();
    let request = WorkTarget {
        season: ctx.season,
        episode: ctx.episode,
    };
    for item in items {
        if truthy(item.get("fromAccount")) || truthy(item.get("fromFallback")) {
            continue;
        }
        let hash = hash_of(item);
        if hash.is_empty() {
            continue;
        }
        let title = string_of(item.get("title"))
            .or_else(|| string_of(item.get("Title")))
            .unwrap_or_default();
        let dn = magnet_display_name(
            string_of(item.get("magnet")).as_deref(),
            string_of(item.get("MagnetUri")).as_deref(),
            string_of(item.get("Guid")).as_deref(),
        );
        let merged = out.entry(hash).or_default();
        for target in release_work_targets(&title, request, Some(dn.as_str()), "") {
            let pair = tuple(target.season, target.episode);
            if !merged.contains(&pair) {
                merged.push(pair);
            }
        }
    }
    out
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

impl MagnetBankStore {
    /// `markBankFilterOutcome`: grava `passed_filter` 1/0 e `last_seen` nas
    /// linhas que JÁ existem (fonte sem captura não cria órfão), por hash e por
    /// alvo, e devolve o boolean de `markFilterResult`. MONOTÔNICA (CAS contra o
    /// lote atrasado do Node): `last_seen` só avança, `passed_filter` só cede.
    pub fn mark_filter_outcome(
        &self,
        entered: &[Value],
        survivors: &[Value],
        ctx: &WorkCtx,
        now_ms: i64,
    ) -> bool {
        let all = hashes_of(entered);
        if all.is_empty() {
            return true;
        }
        let surviving: HashSet<String> = hashes_of(survivors).into_iter().collect();
        let targets = targets_for(entered, ctx);
        let request = tuple(ctx.season, ctx.episode);
        let mut conn = self.lock();
        let Ok(tx) = conn.transaction() else {
            return false;
        };
        for hash in &all {
            let list = targets
                .get(hash)
                .cloned()
                .filter(|list| list.len() > 1)
                .unwrap_or_else(|| vec![request]);
            for (season, episode) in list {
                let passed = if surviving.contains(hash) { 1 } else { 0 };
                let result = tx.execute(
                    "UPDATE magnet_work SET passed_filter = CASE WHEN last_seen <= ?2 THEN ?1 ELSE passed_filter END, \
                     last_seen = MAX(last_seen, ?2) WHERE hash = ?3 AND imdb = ?4 AND season = ?5 AND episode = ?6",
                    params![passed, now_ms, hash, ctx.imdb_id, season, episode],
                );
                if result.is_err() {
                    return false;
                }
            }
        }
        tx.commit().is_ok()
    }
}
