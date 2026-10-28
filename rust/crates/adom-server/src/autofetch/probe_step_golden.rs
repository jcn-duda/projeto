//! Golden de CONTRATO do passo da sonda dirigida (`probe_step`): plano puro e
//! `settle`.
//!
//! Fixture: `rust/golden/autofetch-probe-step.jsonl` (+ `.manifest.json`),
//! gerada por `scripts/golden/contract-autofetch-steps.mjs`.
//!
//! O `expected` documenta a decisão do contrato (ordem dos motivos, rótulos que
//! o painel já conta, e a regra "só agenda com `pending` provado"). NÃO é
//! paridade com o `br-probe.ts`: aquele módulo do worktree `../adom-esm` é
//! procedural (rede + fila) e não expõe esta régua.
//!
//! O que este golden protege que os testes unitários de `probe_step_tests.rs`
//! não protegem: a TABELA inteira de motivo → rótulo num só lugar, com hash.
//! Um teste unitário pode ser "consertado" junto com o bug; a fixture acusa.

// O MESMO loader (`golden_support.rs`) é carregado pelos quatro goldens de passo.
// Clonar o arquivo quatro vezes seria pior: o helper divergiria em silêncio.
#![allow(clippy::duplicate_mod)]

#[path = "golden_support.rs"]
mod support;

use adom_autofetch::v3::{ProbeRecord, ProbeState};
use adom_harvest::{BrProbeWork, EnqueueOutcome, EnqueueReason, HarvestMediaType, ProbeConfig};
use adom_index::NativeKv;
use serde_json::{json, Map, Value};

use crate::autofetch::probe_step::{
    plan, settle, ProbeRun, ProbeSchedule, ProbeStep, ProbeStepConfig,
};

const JSONL: &str = include_str!("../../../../golden/autofetch-probe-step.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../../golden/autofetch-probe-step.manifest.json");
const PATH: &str = "rust/golden/autofetch-probe-step.jsonl";
const REGISTRY: &str = "autofetch-probe-step/plan+settle";
/// Relógio de todos os casos (o mesmo do gerador).
const NOW: i64 = 1_700_000_000_000;

fn flag(config: &Value, key: &str, default: bool) -> bool {
    config.get(key).and_then(Value::as_bool).unwrap_or(default)
}

fn list(config: &Value, key: &str) -> Vec<String> {
    config
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn config_of(input: &Value) -> ProbeStepConfig {
    let config = &input["config"];
    ProbeStepConfig {
        probe: ProbeConfig {
            release_index_enabled: flag(config, "release_index", true),
            auto_fetch_br_probe: flag(config, "br_probe", true),
            index_only_indexers: list(config, "index_only"),
            pt_br_indexers: list(config, "pt_br"),
            live_exempt_indexers: list(config, "live_exempt"),
            ttl_seconds: config
                .get("ttl_seconds")
                .and_then(Value::as_u64)
                .unwrap_or(43_200),
        },
        paused: flag(config, "paused", false),
        queue_len: config.get("queue_len").and_then(Value::as_u64).unwrap_or(0) as usize,
        queue_max: config
            .get("queue_max")
            .and_then(Value::as_u64)
            .unwrap_or(200) as usize,
    }
}

/// `{state, at, leaseUntil}` do caso — o MESMO JSON que o Node lê do KV.
fn record_of(input: &Value) -> Option<ProbeRecord> {
    let raw = input.get("state").filter(|value| !value.is_null())?;
    Some(ProbeRecord {
        state: ProbeState::parse(raw["state"].as_str().expect("state string"))?,
        at: raw["at"].as_i64().expect("at em ms"),
        lease_until: raw.get("leaseUntil").and_then(Value::as_i64),
    })
}

fn payload_of(input: &Value) -> Map<String, Value> {
    input["payload"].as_object().cloned().unwrap_or_default()
}

fn render_plan(step: &ProbeStep) -> String {
    match step {
        ProbeStep::Schedule(planned) => json!({
            "decision": "schedule",
            "episode": planned.work.episode,
            "imdb": planned.work.imdb_id,
            "indexers": planned.indexers,
            "orphan": planned.orphan,
            "season": planned.work.season,
            "type": planned.work.media_type.as_str(),
        })
        .to_string(),
        ProbeStep::Skip(reason) => {
            json!({ "decision": "skip", "reason": reason.as_str() }).to_string()
        }
    }
}

fn schedule_of(input: &Value) -> ProbeSchedule {
    let work = &input["work"];
    ProbeSchedule {
        work: BrProbeWork {
            media_type: HarvestMediaType::parse(work["type"].as_str().expect("type"))
                .expect("type movie|series"),
            imdb_id: work["imdb"].as_str().expect("imdb").to_string(),
            season: work.get("season").and_then(Value::as_i64).map(|n| n as i32),
            episode: work
                .get("episode")
                .and_then(Value::as_i64)
                .map(|n| n as i32),
        },
        indexers: Vec::new(),
        orphan: false,
    }
}

fn outcome_of(input: &Value) -> EnqueueOutcome {
    let raw = input["outcome"].as_str().expect("outcome");
    let (accepted, label) = raw.split_once(':').expect("accepted|rejected:<motivo>");
    let reason = match label {
        "disabled" => EnqueueReason::Disabled,
        "invalid" => EnqueueReason::Invalid,
        "queued" => EnqueueReason::Queued,
        "promoted" => EnqueueReason::Promoted,
        "duplicate" => EnqueueReason::Duplicate,
        "dedupe" => EnqueueReason::Dedupe,
        "coalesced" => EnqueueReason::Coalesced,
        "capacity" => EnqueueReason::Capacity,
        other => panic!("motivo de enqueue fora do contrato: {other}"),
    };
    if accepted == "accepted" {
        EnqueueOutcome::accepted(reason)
    } else {
        EnqueueOutcome::rejected(reason)
    }
}

fn render_run(run: &ProbeRun) -> String {
    json!({
        "error": run.error,
        "pending": run.pending,
        "scheduled": run.scheduled,
        "skip": run.skip,
    })
    .to_string()
}

fn cases() -> Vec<support::Case> {
    support::load(JSONL, MANIFEST_TEXT, PATH, REGISTRY)
}

#[test]
fn fixture_integra_e_declara_contrato() {
    assert_eq!(cases().len(), 32, "contagem de casos do golden mudou");
}

#[test]
fn plano_e_settle_batem_com_o_contrato() {
    for case in cases() {
        let obtained = match case.input["op"].as_str().expect("op do caso") {
            "plan" => {
                let step = plan(
                    &payload_of(&case.input),
                    record_of(&case.input),
                    &config_of(&case.input),
                    NOW,
                );
                render_plan(&step)
            }
            // KV novo por caso: `settle` grava, e um caso não pode herdar o
            // `pending` do anterior.
            "settle" => {
                let kv = NativeKv::open_memory().expect("kv em memória");
                let run = settle(
                    &kv,
                    &schedule_of(&case.input),
                    outcome_of(&case.input),
                    case.input["directed"].as_bool().expect("directed"),
                    case.input["ttl_seconds"].as_u64().expect("ttl"),
                    NOW,
                );
                render_run(&run)
            }
            other => panic!("op desconhecida no golden: {other}"),
        };
        assert_eq!(
            obtained, case.expected,
            "caso {} divergiu do contrato: {}",
            case.id, case.input
        );
    }
}
