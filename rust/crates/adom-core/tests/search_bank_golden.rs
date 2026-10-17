//! Golden da via do banco de magnets (`adom_core::search_bank`).
//!
//! Dois arquivos, um por fonte TS:
//! - `rust/golden/magnet-bank-source.jsonl` — `pickSource`; o `expected` é o
//!   ÍNDICE da fonte escolhida ("null" quando nenhuma), que prova o empate do
//!   `reduce` do TS ficando com a primeira;
//! - `rust/golden/magnet-bank-instant.jsonl` — `isRecentRelease` ("1"/"0") e
//!   `instantWindow` (JSON do `{windowMs,lastCollection,newest,stability,fresh}`).
//!
//! Ambos foram medidos contra o TypeScript REAL do `dist`
//! (`node scripts/golden/dump-magnet-bank-{source,instant}.mjs`). Comparação por
//! `Value` para objetos; o intervalo de datas do corpus é só o subconjunto
//! UTC determinístico aceito pelo porte (decisão no cabeçalho do módulo).

use adom_core::{instant_window, is_recent_release, pick_source, InstantMeta, SourceRow, WorkRow};
use serde::Deserialize;
use serde_json::{json, Value};

const SOURCE_JSONL: &str = include_str!("../../../golden/magnet-bank-source.jsonl");
const INSTANT_JSONL: &str = include_str!("../../../golden/magnet-bank-instant.jsonl");

#[derive(Debug, Deserialize)]
struct Case {
    id: String,
    input: String,
    expected: String,
}

fn cases(jsonl: &str) -> Vec<Case> {
    jsonl
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            serde_json::from_str(line)
                .unwrap_or_else(|err| panic!("linha inválida ({err}): {line}"))
        })
        .collect()
}

fn flag(req: &Value, key: &str) -> bool {
    req.get(key).and_then(Value::as_bool).unwrap_or(false)
}

/// `String(value || '')` do TS: `null`/ausente viram "", número vira decimal.
fn js_string(req: &Value, key: &str) -> String {
    match req.get(key) {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(other) => other.to_string(),
    }
}

/// `String(meta.year ?? '')`: `null` e ausente viram "" (o `??` pega o `null`).
/// As três strings precisam viver enquanto o `InstantMeta` é usado.
fn meta_strings(req: &Value) -> (String, String, String) {
    let Some(meta) = req.get("meta").filter(|value| !value.is_null()) else {
        return (String::new(), String::new(), String::new());
    };
    let year = match meta.get("year") {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => number.to_string(),
        Some(other) => other.to_string(),
    };
    (
        year,
        js_string(meta, "released"),
        js_string(meta, "firstAired"),
    )
}

fn measure_source(req: &Value) -> String {
    let sources: Vec<SourceRow<'_>> = req
        .get("sources")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| SourceRow {
                    indexer: item.get("indexer").and_then(Value::as_str).unwrap_or(""),
                    last_seen: item.get("lastSeen").and_then(Value::as_i64).unwrap_or(0),
                })
                .collect()
        })
        .unwrap_or_default();
    let failed: std::collections::HashSet<String> = req
        .get("failed")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    match pick_source(&sources, &failed, flag(req, "allFailed")) {
        None => "null".to_string(),
        Some(index) => index.to_string(),
    }
}

fn measure_instant(req: &Value) -> Value {
    let now = req.get("now").and_then(Value::as_i64).unwrap_or(0);
    let (year, released, first_aired) = meta_strings(req);
    let meta = InstantMeta {
        year: &year,
        released: &released,
        first_aired: &first_aired,
    };
    if req.get("op").and_then(Value::as_str) == Some("isRecentRelease") {
        return json!(is_recent_release(&meta, now));
    }
    let works: Vec<Option<WorkRow>> = req
        .get("works")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| match item {
                    Value::Null => None,
                    row => Some(WorkRow {
                        passed_filter: row.get("passedFilter").and_then(Value::as_i64).unwrap_or(0),
                        last_seen: row.get("lastSeen").and_then(Value::as_i64).unwrap_or(0),
                        first_seen: row.get("firstSeen").and_then(Value::as_i64).unwrap_or(0),
                    }),
                })
                .collect()
        })
        .unwrap_or_default();
    // Defaults de src/config/cache.ts:76-78 — o oráculo roda com dotenv vazio,
    // então o golden prende o comportamento SOB ELES (min = max = 7 dias: com o
    // config padrão o clamp adaptativo não se manifesta; fresh cai para 2 h).
    const DEFAULT_MIN_MS: i64 = 7 * 86_400_000;
    const DEFAULT_MAX_MS: i64 = 7 * 86_400_000;
    const DEFAULT_FRESH_MAX_MS: i64 = 2 * 3_600_000;
    let window = instant_window(
        &works,
        &meta,
        now,
        DEFAULT_MIN_MS,
        DEFAULT_MAX_MS,
        DEFAULT_FRESH_MAX_MS,
    );
    json!({
        "windowMs": window.window_ms,
        "lastCollection": window.last_collection,
        "newest": window.newest,
        "stability": window.stability,
        "fresh": window.fresh,
    })
}

#[test]
fn golden_da_reserva_do_banco_bate_com_o_ts() {
    let cases = cases(SOURCE_JSONL);
    assert!(cases.len() >= 10, "golden curto demais: {}", cases.len());
    for case in &cases {
        let req: Value = serde_json::from_str(&case.input).expect("input do golden");
        assert_eq!(
            measure_source(&req).as_str(),
            case.expected,
            "caso {} divergiu",
            case.id
        );
    }
}

#[test]
fn golden_da_janela_instantanea_bate_com_o_ts() {
    let cases = cases(INSTANT_JSONL);
    assert!(cases.len() >= 20, "golden curto demais: {}", cases.len());
    let mut ops = std::collections::HashSet::new();
    for case in &cases {
        let req: Value = serde_json::from_str(&case.input).expect("input do golden");
        if let Some(op) = req.get("op").and_then(Value::as_str) {
            ops.insert(op.to_string());
        }
        if req.get("op").and_then(Value::as_str) == Some("isRecentRelease") {
            // O oráculo devolve "1"/"0" (contrato de string do kit).
            assert_eq!(
                measure_instant(&req),
                json!(case.expected == "1"),
                "caso {} divergiu",
                case.id
            );
            continue;
        }
        let esperado: Value = serde_json::from_str(&case.expected)
            .unwrap_or_else(|err| panic!("expected inválido em {}: {err}", case.id));
        assert_eq!(measure_instant(&req), esperado, "caso {} divergiu", case.id);
    }
    assert!(
        ops.contains("isRecentRelease") && ops.contains("instantWindow"),
        "corpus perdeu uma op"
    );
}
