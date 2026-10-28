//! Golden de CONTRATO do passo de Season Pack Fill (`season_step`): registro da
//! busca de temporada e decisão de preenchimento do pack.
//!
//! Fixture: `rust/golden/autofetch-season-step.jsonl` (+ `.manifest.json`),
//! gerada por `scripts/golden/contract-autofetch-steps.mjs`.
//!
//! Os dois lados vêm no mesmo fixture porque são a mesma feature: o `plan`
//! registra `<adapter>:<conta>:<imdb>:<temporada>` e o `plan_fill` decide se o
//! pack que ficou pronto invalida aquela entrada. O caso que mais importa é o
//! `no-declared-season`: "Temporada Completa" sem número NUNCA vira S1.

// O MESMO loader (`golden_support.rs`) é carregado pelos quatro goldens de passo.
// Clonar o arquivo quatro vezes seria pior: o helper divergiria em silêncio.
#![allow(clippy::duplicate_mod)]

#[path = "golden_support.rs"]
mod support;

use adom_autofetch::v3::SeasonGap;
use serde_json::{Map, Value};

use crate::autofetch::season_step::{
    index_key, plan, plan_fill, FillStep, SeasonFillFacts, SeasonStep, SeasonStepConfig,
};

const JSONL: &str = include_str!("../../../../golden/autofetch-season-step.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../../golden/autofetch-season-step.manifest.json");
const PATH: &str = "rust/golden/autofetch-season-step.jsonl";
const REGISTRY: &str = "autofetch-season-step/plan+fill";

fn config_of(input: &Value) -> SeasonStepConfig {
    let config = &input["config"];
    SeasonStepConfig {
        enabled: config
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        paused: config
            .get("paused")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        max_seasons: config
            .get("max_seasons")
            .and_then(Value::as_u64)
            .unwrap_or(200) as usize,
        max_keys: config.get("max_keys").and_then(Value::as_u64).unwrap_or(64) as usize,
        ttl_seconds: config
            .get("ttl_seconds")
            .and_then(Value::as_i64)
            .unwrap_or(600),
    }
}

fn payload_of(input: &Value) -> Map<String, Value> {
    input["payload"].as_object().cloned().unwrap_or_default()
}

fn render_plan(step: &SeasonStep) -> String {
    match step {
        SeasonStep::Register(register) => serde_json::json!({
            "cache_key": register.cache_key,
            "decision": "register",
            // Chave da ENTRADA no KV (`SEASON_PREFIX` + chave lógica do TS).
            "key": index_key(
                &register.adapter_id,
                &register.account,
                &register.imdb_id,
                register.season,
            ),
            "season": register.season,
        })
        .to_string(),
        SeasonStep::Skip(reason) => {
            serde_json::json!({ "decision": "skip", "reason": reason.as_str() }).to_string()
        }
    }
}

/// Um caso de preenchimento completo: o título empresta do `Value` do caso, sem
/// cópia e sem `'static` inventado.
fn fill_of(input: &Value) -> String {
    let facts = &input["facts"];
    let step = plan_fill(
        &config_of(input),
        SeasonFillFacts {
            title: facts["title"].as_str().expect("title string"),
            gap: SeasonGap {
                season: facts.get("gap").and_then(Value::as_i64),
            },
            is_pack: facts
                .get("is_pack")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        },
    );
    render_fill(&step)
}

fn render_fill(step: &FillStep) -> String {
    match step {
        FillStep::Fill { season } => {
            serde_json::json!({ "decision": "fill", "season": season }).to_string()
        }
        FillStep::Skip(reason) => {
            serde_json::json!({ "decision": "skip", "reason": reason.as_str() }).to_string()
        }
    }
}

fn cases() -> Vec<support::Case> {
    support::load(JSONL, MANIFEST_TEXT, PATH, REGISTRY)
}

#[test]
fn fixture_integra_e_declara_contrato() {
    assert_eq!(cases().len(), 22, "contagem de casos do golden mudou");
}

#[test]
fn registro_e_preenchimento_batem_com_o_contrato() {
    for case in cases() {
        let obtained = match case.input["op"].as_str().expect("op do caso") {
            "plan" => {
                let step = plan(&payload_of(&case.input), &config_of(&case.input));
                render_plan(&step)
            }
            "fill" => fill_of(&case.input),
            other => panic!("op desconhecida no golden: {other}"),
        };
        assert_eq!(
            obtained, case.expected,
            "caso {} divergiu do contrato: {}",
            case.id, case.input
        );
    }
}
