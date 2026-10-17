//! Golden das decisões do fim da busca (`adom_core::search_finish`).
//!
//! Cada linha de `rust/golden/search-commit.jsonl` é `{id, input, expected}`: o
//! `input` é o JSON de fatos que o dump também entregou ao TypeScript REAL
//! (`node scripts/golden/dump-search-commit.mjs`), e o `expected` é a saída
//! daquele TS. Aqui o mesmo `input` entra no porte Rust e o `Value` produzido é
//! comparado ao `expected` — comparação por `Value` (ordem de chave
//! insensível), porque o contrato é o conjunto de campos e valores, não a ordem
//! de serialização.
//!
//! O corpus cobre os ramos que mais doem em produção: reserva com cache
//! desligado, `debridKnown` desconhecido (com e sem refresh), lista vazia com
//! indexer falho e promoção sem debrid conferido.

use adom_core::{
    commit_decision, late_promotion_decision, stale_refresh_eligible, CommitFacts, LateFacts,
    LiveState,
};
use serde::Deserialize;
use serde_json::{json, Value};

const JSONL: &str = include_str!("../../../golden/search-commit.jsonl");

#[derive(Debug, Deserialize)]
struct Case {
    id: String,
    input: String,
    expected: String,
}

fn cases() -> Vec<Case> {
    JSONL
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            serde_json::from_str::<Case>(line)
                .unwrap_or_else(|err| panic!("linha inválida ({err}): {line}"))
        })
        .collect()
}

fn flag(req: &Value, key: &str) -> bool {
    req.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn ttl(req: &Value, key: &str) -> i64 {
    req.get(key)
        .and_then(Value::as_i64)
        .unwrap_or_else(|| panic!("campo {key} ausente ou não-inteiro"))
}

fn live_of(req: &Value) -> Option<LiveState> {
    match req.get("live") {
        None | Some(Value::Null) => None,
        Some(spec) => Some(LiveState {
            needs_fallback: flag(spec, "needsFallback"),
            has_any_failure: flag(spec, "hasAnyFailure"),
        }),
    }
}

/// `null` explícito do corpus é o `undefined` do TS (nunca respondeu).
fn debrid_known_of(req: &Value) -> Option<bool> {
    match req.get("debridKnown") {
        None | Some(Value::Null) => None,
        Some(value) => value.as_bool(),
    }
}

fn measure(req: &Value) -> Value {
    match req.get("op").and_then(Value::as_str) {
        Some("commit") => {
            let decision = commit_decision(&CommitFacts {
                playable: flag(req, "playable"),
                partial: flag(req, "partial"),
                debrid_known: debrid_known_of(req),
                needs_debrid_refresh: flag(req, "needsDebridRefresh"),
                has_fallback: flag(req, "hasFallback"),
                cache_ttl: ttl(req, "cacheTtl"),
                fallback_streams_ttl: ttl(req, "fallbackStreamsTtl"),
            });
            json!({
                "write": decision.write,
                "ttl": decision.ttl,
                "partial": decision.partial,
                "debridKnown": decision.debrid_known,
            })
        }
        Some("late") => {
            let decision = late_promotion_decision(&LateFacts {
                hit_partial: flag(req, "hitPartial"),
                hit_fallback: flag(req, "hitFallback"),
                hit_has_streams: flag(req, "hitHasStreams"),
                hit_debrid_known: flag(req, "hitDebridKnown"),
                live: live_of(req),
                cache_ttl: ttl(req, "cacheTtl"),
            });
            json!({
                "action": decision.action.as_str(),
                "reason": decision.reason.as_str(),
                "ttl": decision.ttl,
                "debridKnown": decision.debrid_known,
            })
        }
        Some("swr") => {
            let entry = req.get("entry").filter(|value| !value.is_null());
            json!(stale_refresh_eligible(entry, flag(req, "playable")))
        }
        Some("refresh") => {
            let entry = req.get("entry").filter(|value| !value.is_null());
            json!(adom_core::debrid_refresh_satisfied(entry))
        }
        other => panic!("op desconhecida no golden: {other:?}"),
    }
}

#[test]
fn golden_do_fim_da_busca_bate_com_o_ts() {
    let cases = cases();
    assert!(cases.len() >= 30, "golden curto demais: {}", cases.len());
    let mut vistos = std::collections::HashSet::new();
    for case in &cases {
        assert!(
            vistos.insert(case.id.clone()),
            "id duplicado no golden: {}",
            case.id
        );
        let req: Value = serde_json::from_str(&case.input)
            .unwrap_or_else(|err| panic!("input inválido em {}: {err}", case.id));
        let esperado: Value = serde_json::from_str(&case.expected)
            .unwrap_or_else(|err| panic!("expected inválido em {}: {err}", case.id));
        let obtido = measure(&req);
        assert_eq!(obtido, esperado, "caso {} divergiu", case.id);
    }
}
