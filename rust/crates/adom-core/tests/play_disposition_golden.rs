//! Golden de `playDisposition` (`adom_core::play_disposition`).
//!
//! Cada linha de `rust/golden/play-disposition.jsonl` é `{id, input, expected}`:
//! o `input` é o JSON de fatos que o dump também entregou ao TypeScript REAL
//! (`node scripts/golden/dump-play-disposition.mjs`), e o `expected` é a saída
//! daquele TS (`resolve`/`p2p`/`drop`).
//!
//! O corpus cobre a ORDEM dos ramos — multiobra admitida antes do degradado,
//! `drop` da coleção fria sem knob — e as marcas por verdade do JS (string vazia
//! e `0` são falsas).

use adom_core::{play_disposition, PlayDisposition, PlayFacts};
use serde::Deserialize;
use serde_json::Value;

const JSONL: &str = include_str!("../../../golden/play-disposition.jsonl");

#[derive(Debug, Deserialize)]
struct Case {
    id: String,
    input: String,
    expected: String,
}

/// Verdade do JS para `if (stream.infoHash)`: `null`/`""`/ausente são falsos.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Number(number)) => number.as_f64().map(|n| n != 0.0).unwrap_or(true),
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::Object(map)) => !map.is_empty(),
    }
}

fn measure(req: &Value) -> &'static str {
    let disposition = play_disposition(&PlayFacts {
        has_info_hash: truthy(req.get("infoHash")),
        multi_work_admitted: truthy(req.get("multiWorkAdmitted")),
        cached: truthy(req.get("cached")),
        resolve_uncached: truthy(req.get("resolveUncached")),
        degraded: truthy(req.get("degraded")),
    });
    PlayDisposition::as_str(disposition)
}

#[test]
fn golden_da_saida_do_stream_bate_com_o_ts() {
    let cases: Vec<Case> = JSONL
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            serde_json::from_str(line)
                .unwrap_or_else(|err| panic!("linha inválida ({err}): {line}"))
        })
        .collect();
    assert!(cases.len() >= 15, "golden curto demais: {}", cases.len());
    for case in &cases {
        let req: Value = serde_json::from_str(&case.input)
            .unwrap_or_else(|err| panic!("input inválido em {}: {err}", case.id));
        assert_eq!(measure(&req), case.expected, "caso {} divergiu", case.id);
    }
}

#[test]
fn todo_caso_declara_uma_saida_conhecida() {
    let mut vistos = std::collections::HashSet::new();
    for line in JSONL.lines().filter(|line| !line.trim().is_empty()) {
        let case: Case = serde_json::from_str(line).expect("linha do golden");
        assert!(vistos.insert(case.id.clone()), "id duplicado: {}", case.id);
        assert!(
            matches!(case.expected.as_str(), "resolve" | "p2p" | "drop"),
            "caso {}: saída fora do contrato ({})",
            case.id,
            case.expected
        );
    }
}
