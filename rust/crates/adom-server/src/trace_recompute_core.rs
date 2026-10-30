//! Produção do `RecomputeOutcome` — o porte 1:1 de `src/utils/trace-recompute.ts`
//! (a régua é o teste do Node). Tudo leitura QUIET: `peek`/`state` por chave,
//! sem rede, sem LRU-promote, sem contador. O resultado é um JSON com os
//! MESMOS campos que o TS produzia (`attempted/basis/built/builtAt/note/items`).

use std::collections::HashSet;

use serde_json::{json, Value};

use adom_autofetch::QueueV3;
use adom_core::{sanitize_trace_label, TraceValue, WorkTarget};

use super::{raw_key::raw_key_for, Install, TraceRecompute};

/// Mesmo teto do trace serializado (`RECOMPUTE_MAX_ITEMS` do TS).
const RECOMPUTE_MAX_ITEMS: usize = 300;

/// Recompute para UM hit do handler: só explica entrada SEM trace e COM
/// `searchMeta` — o mesmo ramo que o Node tinha (knob desligado = boot None,
/// e sem instalação legível na chave o recompute não inventa matéria).
pub(crate) fn recompute_for_hit(
    hit: &adom_store::TraceHit,
    kind: &str,
    id: &str,
    now_ms: u64,
) -> Value {
    let Some(boot) = super::boot() else {
        return Value::Null;
    };
    let entry = &hit.value;
    if entry.trace.is_some() || entry.search_meta.is_none() {
        return Value::Null;
    }
    let Some(install) = super::install_from_key(&hit.key, kind, id, &boot) else {
        return Value::Null;
    };
    let meta = entry.search_meta.as_ref().unwrap_or(&Value::Null);
    let names: Vec<String> = meta
        .get("names")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    // `year ? ... : ...` do TS: ano 0/null é falsy e não entra na query.
    let year = meta
        .get("year")
        .and_then(Value::as_f64)
        .filter(|year| *year != 0.0);
    let (imdb_id, location) = split_id(id);
    recompute_offline(
        &boot,
        &install,
        &imdb_id,
        location,
        &names,
        year,
        now_ms as i64,
    )
}

/// `id.split(':')` com a coerção `Number(sRaw) || null` do TS ("0" e lixo
/// viram ausente — o id validado pela rota só tem dígitos).
fn split_id(id: &str) -> (String, WorkTarget) {
    let mut parts = id.split(':');
    let num = |raw: Option<&str>| -> Option<i64> {
        let raw = raw?;
        if raw.is_empty() {
            return None;
        }
        raw.parse::<i64>().ok().filter(|n| *n != 0)
    };
    (
        parts.next().unwrap_or("").to_string(),
        WorkTarget {
            season: num(parts.next()),
            episode: num(parts.next()),
        },
    )
}

/// Porte do `recomputeOffline`: sem nomes ⇒ `no-names`; sem material ⇒
/// `no-material`; com material ⇒ itens com `now` (estado atual, quiet).
pub(super) fn recompute_offline(
    boot: &TraceRecompute,
    install: &Install,
    imdb_id: &str,
    location: WorkTarget,
    names: &[String],
    year: Option<f64>,
    now_ms: i64,
) -> Value {
    if names.iter().all(|name| name.is_empty()) {
        return json!({
            "attempted": true, "basis": [], "built": false,
            "builtAt": null, "note": "no-names", "items": [],
        });
    }
    let material = collect_local_material(boot, install, imdb_id, location, names, year, now_ms);
    if material.items.is_empty() {
        return json!({
            "attempted": true, "basis": material.basis, "built": false,
            "builtAt": null, "note": "no-material", "items": [],
        });
    }
    let items: Vec<Value> = material
        .items
        .iter()
        .take(RECOMPUTE_MAX_ITEMS)
        .enumerate()
        .map(|(i, item)| recompute_item(boot, install, imdb_id, location, item, i, now_ms))
        .collect();
    json!({
        "attempted": true, "basis": material.basis, "built": true,
        "builtAt": now_ms, "note": null, "items": items,
    })
}

/// `label` pela porta única (`sanitizeTraceLabel`) + `br/dubbed/quality` da
/// forma crua + `now` (estado atual).
fn recompute_item(
    boot: &TraceRecompute,
    install: &Install,
    imdb_id: &str,
    location: WorkTarget,
    item: &Value,
    index: usize,
    now_ms: i64,
) -> Value {
    let title = item.get("title").and_then(Value::as_str).unwrap_or("");
    // `String(item.title || '').split('\n')[0]` — só a primeira linha.
    let first_line: String = title.chars().take_while(|c| *c != '\n').collect();
    let label =
        String::from_utf16_lossy(sanitize_trace_label(&TraceValue::text(&first_line)).as_units());
    // `Boolean(item._br || item.isBr)`.
    let br = truthy(item.get("_br")) || truthy(item.get("isBr"));
    let mut entry = json!({
        "id": format!("r{}", index + 1),
        "label": label,
        "br": br,
    });
    // `_dubbed` presente (JSON não tem undefined) ⇒ campo `dubbed` sai.
    if let Some(dubbed) = item.get("_dubbed") {
        entry["dubbed"] = json!(truthy(Some(dubbed)));
    }
    if let Some(quality) = item.get("_quality").filter(|q| truthy(Some(q))) {
        entry["quality"] = json!(quality.as_str().unwrap_or(""));
    }
    entry["now"] =
        json!({ "state": current_state(boot, install, imdb_id, item, location, now_ms) });
    entry
}

/// Verdade do JS para os campos do item cru.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Null) | None => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_none_or(|f| f != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

#[derive(Default)]
struct Material {
    items: Vec<Value>,
    basis: Vec<&'static str>,
}

/// Porte do `collectLocalMaterial`: idx quente + raw quente, dedupe por hash.
/// O inventário (`basis: inventory`) fica FORA do porte (flush deferido do L1
/// do Node — ver header do módulo pai).
fn collect_local_material(
    boot: &TraceRecompute,
    install: &Install,
    imdb_id: &str,
    location: WorkTarget,
    names: &[String],
    year: Option<f64>,
    now_ms: i64,
) -> Material {
    let mut out = Material::default();
    let mut seen: HashSet<String> = HashSet::new();
    // 1) Índice de releases: o que a busca já provou existir. O item montado é
    //    o MESMO do TS (title/hash/seeders/indexer/size) — isBr/dubbed/quality
    //    do rel NÃO entram (o TS não os lia, e o `br` do output não muda).
    for rel in boot.idx.lookup(imdb_id, location, now_ms) {
        let mut item = json!({
            "title": rel.title,
            "infoHash": rel.hash,
            "seeders": rel.seeders,
            "indexer": rel.indexer,
        });
        if let Some(size) = rel.size {
            item["size"] = json!(size);
        }
        push_material(&mut out, &mut seen, &item, "idx");
    }
    // 2) Cache bruto do Jackett pelas queries da obra — SÓ o que a busca
    //    consultaria (mesma moldura do `rawKeyFor`), com a LISTA EFETIVA da
    //    instalação que fez a busca.
    let kind = if location.season.is_some() && location.episode.is_some() {
        "series"
    } else {
        "movie"
    };
    let queries: Vec<String> = names
        .iter()
        .filter(|name| !name.is_empty())
        .map(|name| match year {
            Some(year) => format!("{name} {year}"),
            None => name.clone(),
        })
        .collect();
    if !queries.is_empty() && !install.jackett_indexers.is_empty() {
        for query in &queries {
            for indexer in &install.jackett_indexers {
                let key = raw_key_for(
                    &boot.pt_br_indexers,
                    &boot.bare_title_indexers,
                    indexer,
                    query,
                    kind,
                );
                let hit = boot.raw.peek(&key, now_ms).ok().flatten();
                let items = match hit {
                    Some(Value::Array(list)) => list,
                    // O escritor grava o ENVELOPE `{ items: [...] }`; o array
                    // cru é a forma legada de antes do P5.
                    Some(value) => value
                        .get("items")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default(),
                    None => Vec::new(),
                };
                for item in items {
                    push_material(&mut out, &mut seen, &item, "raw");
                }
            }
        }
    }
    out
}

/// `push` do TS: item sem hash sai; hash repetido sai (primeira ocorrência
/// vence); a origem entra no `basis` UMA vez.
fn push_material(
    material: &mut Material,
    seen: &mut HashSet<String>,
    item: &Value,
    origin: &'static str,
) {
    let hash = item.get("infoHash").and_then(Value::as_str).unwrap_or("");
    if hash.is_empty() {
        return;
    }
    if !seen.insert(hash.to_lowercase()) {
        return;
    }
    if !material.basis.contains(&origin) {
        material.basis.push(origin);
    }
    material.items.push(item.clone());
}

/// Porte do `currentState`: `bad+lie+dead+idx-miss` (leituras INDEPENDENTES —
/// `bad` e `lie` coexistem), só com conta; sem evidência viva = `tocável`.
fn current_state(
    boot: &TraceRecompute,
    install: &Install,
    imdb_id: &str,
    item: &Value,
    location: WorkTarget,
    now_ms: i64,
) -> String {
    let mut reasons: Vec<&'static str> = Vec::new();
    if !install.adapter.is_empty() && install.has_account {
        let hash = item
            .get("infoHash")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_lowercase();
        if boot
            .mag
            .peek_mark_scoped("bad", &install.adapter, &install.scope, &hash, now_ms)
            .unwrap_or(false)
        {
            reasons.push("bad");
        }
        if boot
            .mag
            .peek_mark_scoped("lie", &install.adapter, &install.scope, &hash, now_ms)
            .unwrap_or(false)
        {
            reasons.push("lie");
        }
        if QueueV3::new(&boot.kv)
            .is_dead(&install.adapter, &install.scope, &hash, now_ms)
            .unwrap_or(false)
        {
            reasons.push("dead");
        }
        if location.season.is_some()
            && location.episode.is_some()
            && boot.idx.is_missing(imdb_id, location, &hash, now_ms)
        {
            reasons.push("idx-miss");
        }
    }
    if reasons.is_empty() {
        "tocável".to_string()
    } else {
        reasons.join("+")
    }
}
