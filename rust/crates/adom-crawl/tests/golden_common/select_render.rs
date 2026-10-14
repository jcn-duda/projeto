//! Render canônico dos ops de seleção/despacho do golden `crawl-policy`
//! (`crawl-site-select` + `crawl-dispatch`). Vive num submódulo de
//! `golden_common` para o arquivo de teste ficar sob o teto de 400 linhas do CI
//! Rust; reusa os helpers de `super` (golden_common).
use std::collections::HashMap;

use adom_crawl::*;
use serde_json::{json, Value};

use super::{canon, deps_from, runtime_from, site_config_from};

pub fn runtimes_map(v: &Value) -> HashMap<String, Value> {
    v.as_object()
        .map(|m| m.iter().map(|(k, x)| (k.clone(), x.clone())).collect())
        .unwrap_or_default()
}

pub fn configs_map(v: &Value) -> HashMap<String, Value> {
    v.as_object()
        .map(|m| m.iter().map(|(k, x)| (k.clone(), x.clone())).collect())
        .unwrap_or_default()
}

pub fn string_list(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(ToString::to_string))
                .collect()
        })
        .unwrap_or_default()
}

pub fn due_json(d: Option<DueClass>) -> Value {
    match d {
        Some(DueClass::Item) => json!("item"),
        Some(DueClass::Discovery) => json!("discovery"),
        None => Value::Null,
    }
}

/// `assessSites` / `selectNext` / `pickBatch` / `byFairness`.
pub fn render_select(op: &str, r: &Value) -> String {
    let ids: Vec<String> = string_list(&r["ids"]);
    let runtimes = runtimes_map(r.get("runtimes").unwrap_or(&Value::Null));
    let configs = configs_map(r.get("configs").unwrap_or(&Value::Null));
    let deps = deps_from(r.get("deps").unwrap_or(&Value::Null));
    let now = r["now"].as_i64().unwrap_or(0);
    let runtime_of = move |id: &str| runtimes.get(id).map(runtime_from).unwrap_or_default();
    let config_of = move |id: &str| configs.get(id).map(site_config_from).unwrap_or_default();

    match op {
        "assessSites" => {
            let cands = assess_sites(&ids, runtime_of, config_of, &deps, now);
            canon(&json!(cands
                .iter()
                .map(|c| json!({"id": c.id, "due": due_json(c.due), "skipReason": c.skip_reason}))
                .collect::<Vec<_>>()))
        }
        "selectNext" => {
            let res = select_next(&ids, runtime_of, config_of, &deps, now);
            canon(&json!({ "chosen": res.chosen.map(|c| c.id) }))
        }
        "byFairness" => {
            let cands: Vec<SiteCandidate> = r["candidates"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| SiteCandidate {
                    id: c["id"].as_str().unwrap().to_string(),
                    config: CrawlerSiteConfig::default(),
                    runtime: runtime_from(c),
                    due: None,
                    skip_reason: None,
                })
                .collect();
            canon(&json!(by_fairness(&cands)
                .iter()
                .map(|c| c.id.clone())
                .collect::<Vec<_>>()))
        }
        _ => {
            let input = DispatchInput::new(
                ids,
                string_list(&r["inflight"]),
                r["maxParallel"].as_u64().unwrap_or(0) as usize,
                string_list(&r["flareSites"]),
                runtime_of,
                config_of,
                &deps,
                now,
            );
            let res = pick_batch(input);
            let mut paced: Vec<String> = res.paced.into_iter().collect();
            paced.sort();
            canon(
                &json!({ "chosen": res.chosen.iter().map(|c| c.id.clone()).collect::<Vec<_>>(), "paced": paced }),
            )
        }
    }
}
