//! Golden de CONTRATO da evicção de fallbacks (`evict_step::plan`): cada gate
//! que tira um hash do plano, um caso por régua.
//!
//! Fixture: `rust/golden/autofetch-evict-step.jsonl` (+ `.manifest.json`),
//! gerada por `scripts/golden/contract-autofetch-steps.mjs`.
//!
//! O `expected` é a LINHA do plano (remoção provada ou motivo do pulo) na ordem
//! dos itens. O que importa aqui não é a régua do crate (`eligible_evictions`,
//! que tem golden próprio): são os VETOS fail-closed e a ORDEM dos rótulos que
//! este passo acrescenta (retenção BR antes de proteção, pool antes de hold,
//! teto antes do delete).

// O MESMO loader (`golden_support.rs`) é carregado pelos quatro goldens de passo.
// Clonar o arquivo quatro vezes seria pior: o helper divergiria em silêncio.
#![allow(clippy::duplicate_mod)]

#[path = "golden_support.rs"]
mod support;

use adom_autofetch::v3::evict::EvictAction;
use serde_json::{json, Value};

use crate::autofetch::evict_step::{plan, EvictFacts, EvictGates, EvictItem, Occupancy};

const JSONL: &str = include_str!("../../../../golden/autofetch-evict-step.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../../golden/autofetch-evict-step.manifest.json");
const PATH: &str = "rust/golden/autofetch-evict-step.jsonl";
const REGISTRY: &str = "autofetch-evict-step/plan";
/// Relógio de todos os casos (o mesmo do gerador).
const NOW: i64 = 1_700_000_000_000;

fn bool_of(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn item_of(value: &Value) -> EvictItem {
    EvictItem {
        hash: value["hash"].as_str().expect("hash").to_string(),
        transfer_id: value
            .get("transfer_id")
            .and_then(Value::as_str)
            .map(str::to_string),
        name: value
            .get("name")
            .and_then(Value::as_str)
            .map(str::to_string),
        pool: value["pool"].as_str().expect("pool").to_string(),
        overflow: bool_of(value, "overflow"),
        marker_matches_work: bool_of(value, "marker_matches_work"),
        owned: bool_of(value, "owned"),
        held: bool_of(value, "held"),
        protected: bool_of(value, "protected"),
        br_retained: bool_of(value, "br_retained"),
        accepted_at: value
            .get("accepted_at")
            .and_then(Value::as_i64)
            .unwrap_or(0),
    }
}

fn gates_of(input: &Value) -> EvictGates {
    let gates = &input["gates"];
    EvictGates {
        enabled: gates
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        max_per_run: gates
            .get("max_per_run")
            .and_then(Value::as_u64)
            .unwrap_or(25) as usize,
        min_age_ms: gates
            .get("min_age_ms")
            .and_then(Value::as_i64)
            .unwrap_or(1_800_000),
        occupancy: gates
            .get("occupancy")
            .and_then(Value::as_object)
            .map(|occupancy| Occupancy {
                used: occupancy["used"].as_u64().expect("used"),
                floor: occupancy["floor"].as_u64().expect("floor"),
            }),
    }
}

fn facts_of(input: &Value) -> EvictFacts {
    let facts = &input["facts"];
    EvictFacts {
        current_ready_is_br: bool_of(facts, "current_ready_is_br"),
        work_has_prior_br_ready: bool_of(facts, "work_has_prior_br_ready"),
        now_ms: NOW,
        items: input["items"]
            .as_array()
            .expect("items")
            .iter()
            .map(item_of)
            .collect(),
    }
}

fn render(actions: &[EvictAction]) -> String {
    let rows: Vec<Value> = actions
        .iter()
        .map(|action| match action {
            EvictAction::Remove {
                hash,
                transfer_id,
                name,
            } => json!({
                "action": "remove",
                "hash": hash,
                "name": name,
                "transfer_id": transfer_id,
            }),
            EvictAction::Skip { hash, reason } => json!({
                "action": "skip",
                "hash": hash,
                "reason": reason.as_str(),
            }),
        })
        .collect();
    Value::Array(rows).to_string()
}

fn cases() -> Vec<support::Case> {
    support::load(JSONL, MANIFEST_TEXT, PATH, REGISTRY)
}

#[test]
fn fixture_integra_e_declara_contrato() {
    assert_eq!(cases().len(), 29, "contagem de casos do golden mudou");
}

#[test]
fn plano_bate_com_o_contrato() {
    for case in cases() {
        let actions = plan(&facts_of(&case.input), &gates_of(&case.input));
        assert_eq!(
            render(&actions),
            case.expected,
            "caso {} divergiu do contrato: {}",
            case.id,
            case.input
        );
    }
}
