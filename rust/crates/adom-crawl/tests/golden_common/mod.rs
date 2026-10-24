//! Suporte comum dos goldens de `adom-crawl` (política C2 e parsers C0/C1).
//!
//! Lê o manifest `adom-golden-manifest/1` e o JSONL (formato `{id,input,expected}`),
//! confere que o corpus JSON tem os mesmos ids/inputs, e materializa os tipos do
//! crate a partir dos `input` JSON do corpus.
//!
//! O SHA-256 do manifest NÃO é reexecutado aqui (o crate não declara `sha2` e não
//! vamos tocar no `Cargo.toml`): a integridade por hash é garantida pelo
//! `--check` do gerador (`dump-crawl-policy.mjs` / `dump-crawl-parsers.mjs`), que
//! roda no CI. Aqui travamos identidade, formato, contagem e comportamento.
#![allow(dead_code)]

use adom_crawl::{MockSelectDeps, SiteCounters, SiteRuntime};
use serde::Deserialize;
use serde_json::Value;

pub mod select_render;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub format: String,
    pub registry: Vec<String>,
    pub corpus: CorpusRef,
    pub output: OutputRef,
}

#[derive(Debug, Deserialize)]
pub struct CorpusRef {
    pub path: String,
    pub sha256: String,
    pub cases: usize,
}

#[derive(Debug, Deserialize)]
pub struct OutputRef {
    pub path: String,
    pub sha256: String,
    pub lines: usize,
}

#[derive(Debug, Deserialize)]
pub struct GoldenCase {
    pub id: String,
    pub input: String,
    pub expected: String,
}

pub fn manifest(text: &str) -> Manifest {
    serde_json::from_str(text).expect("manifest golden precisa ser JSON válido")
}

pub fn jsonl_lines(bytes: &'static [u8]) -> Vec<&'static str> {
    let text = std::str::from_utf8(bytes).expect("golden precisa ser UTF-8");
    text.trim_end_matches('\n').split('\n').collect()
}

pub fn parse_cases(bytes: &'static [u8]) -> Vec<GoldenCase> {
    jsonl_lines(bytes)
        .iter()
        .map(|line| {
            serde_json::from_str(line).expect("linha do golden commitado precisa ser válida")
        })
        .collect()
}

/// Confere que o corpus JSON tem o mesmo nº de casos, ids e inputs do golden.
pub fn assert_corpus_matches(corpus_text: &str, cases: &[GoldenCase]) {
    let corpus: Value = serde_json::from_str(corpus_text).expect("corpus JSON válido");
    let raw = corpus["cases"].as_array().expect("cases: array");
    assert_eq!(
        raw.len(),
        cases.len(),
        "contagem do corpus diverge do golden"
    );
    for (case, row) in cases.iter().zip(raw) {
        assert_eq!(row["id"].as_str(), Some(case.id.as_str()));
        assert_eq!(row["input"].as_str(), Some(case.input.as_str()));
    }
}

// ---------------------------------------------------------------------------
// Rendering canônico (mesma forma que o oráculo JS `stable`/`numStr`).
// ---------------------------------------------------------------------------

/// `String(int)` do JS.
pub fn num_str(n: i64) -> String {
    n.to_string()
}

/// `String(number)` do JS para finitos (Display do Rust casa p.ex. `1.33`, `1`).
pub fn f64_str(v: f64) -> String {
    format!("{v}")
}

pub fn bit(b: bool) -> String {
    if b {
        "1".to_string()
    } else {
        "0".to_string()
    }
}

/// JSON canônico: chaves ordenadas RECURSIVAMENTE (o `serde_json` do crate
/// preserva ordem de inserção por `preserve_order`; o oráculo JS usa `sortDeep`).
pub fn canon(v: &Value) -> String {
    serde_json::to_string(&sorted(v)).expect("serialização canônica")
}

fn sorted(v: &Value) -> Value {
    match v {
        Value::Object(map) => {
            let mut items: Vec<(&String, &Value)> = map.iter().collect();
            items.sort_by(|a, b| a.0.cmp(b.0));
            let mut out = serde_json::Map::new();
            for (k, val) in items {
                out.insert(k.clone(), sorted(val));
            }
            Value::Object(out)
        }
        Value::Array(arr) => Value::Array(arr.iter().map(sorted).collect()),
        other => other.clone(),
    }
}

// ---------------------------------------------------------------------------
// Materialização dos tipos de política a partir do corpus.
// ---------------------------------------------------------------------------

pub fn counters_from(v: &Value) -> SiteCounters {
    let by = &v["byStatus"];
    let g = |k: &str| by[k].as_i64().unwrap_or(0);
    SiteCounters::new(
        v["total"].as_i64().unwrap_or(0),
        g("pending"),
        g("error"),
        g("inflight"),
        g("partial"),
    )
}

/// Materializa o `SiteRuntime` do crate a partir do runtime do corpus. O
/// `..Default::default()` deixa o helper tolerante a campos novos do port.
#[allow(clippy::needless_update)]
pub fn runtime_from(v: &Value) -> SiteRuntime {
    SiteRuntime {
        id: v["id"].as_str().unwrap_or("").to_string(),
        paused: v["paused"].as_bool().unwrap_or(false),
        auto_pause: v["autoPause"].is_object() || v["autoPause"].as_bool().unwrap_or(false),
        hour_pages: v["hourPages"].as_i64().unwrap_or(0),
        last_active_at: v["lastActiveAt"].as_i64().unwrap_or(0),
        next_discover_at: v["nextDiscoverAt"].as_i64().unwrap_or(0),
        open_run_id: v["openRunId"].as_i64(),
        adapter_failed_at: v["adapterFailedAt"].as_i64().unwrap_or(0),
        skip_reason: v["skipReason"].as_str().map(|s| s.to_string()),
        need_simulated_recovery: v["needSimulatedRecovery"].as_bool().unwrap_or(false),
        need_inflight_recovery: v["needInflightRecovery"].as_bool().unwrap_or(false),
        ..Default::default()
    }
}

/// Constrói `MockSelectDeps` a partir do bloco `deps` do corpus.
pub fn deps_from(d: &Value) -> MockSelectDeps {
    let global = d["globalCapHit"].as_bool().unwrap_or(false);
    let mut counters: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
    if let Some(map) = d["counters"].as_object() {
        for (k, v) in map {
            counters.insert(k.clone(), v.clone());
        }
    }
    let mut probe: std::collections::HashMap<String, bool> = std::collections::HashMap::new();
    if let Some(map) = d["probeOpen"].as_object() {
        for (k, v) in map {
            probe.insert(k.clone(), v.as_bool().unwrap_or(true));
        }
    }
    let has_due: Option<std::collections::HashMap<String, bool>> =
        d["hasDue"].as_object().map(|map| {
            map.iter()
                .map(|(k, v)| (k.clone(), v.as_bool().unwrap_or(false)))
                .collect()
        });

    let mut deps = MockSelectDeps::new()
        .with_global_cap_hit(move || global)
        .with_counters(move |id| counters.get(id).map(counters_from).unwrap_or_default())
        .with_probe_open(move |id| probe.get(id).copied().unwrap_or(true));
    if let Some(hd) = has_due {
        deps = deps.with_has_due(move |id, _now| hd.get(id).copied().unwrap_or(false));
    }
    deps
}

/// Config efetiva a partir do JSON do corpus (schema camelCase do crate).
pub fn site_config_from(v: &Value) -> adom_crawl::CrawlerSiteConfig {
    serde_json::from_value(v.clone()).expect("CrawlerSiteConfig do corpus")
}
