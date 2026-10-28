//! Golden de CONTRATO do passo de dreno da represa (`suppressed_step::drain`):
//! o que fica represado e o que entra no dreno.
//!
//! Fixture: `rust/golden/autofetch-suppressed-step.jsonl` (+ `.manifest.json`),
//! gerada por `scripts/golden/contract-autofetch-steps.mjs`.
//!
//! Cada caso descreve as entradas do KV (`autofetch:v3:sup:`) e os registros
//! de defesa (`adhold:v1:`, `adprot:v1:`, `adrm:v1:`) do jeito que o Node os
//! grava; a decisão é a contagem da passagem (`kept`/`dropped`/`operations`) e a
//! profundidade que sobra. Rede zero: o adaptador é o dublê de `fakes`.

// O MESMO loader (`golden_support.rs`) é carregado pelos quatro goldens de passo.
// Clonar o arquivo quatro vezes seria pior: o helper divergiria em silêncio.
#![allow(clippy::duplicate_mod)]

#[path = "golden_support.rs"]
mod support;

use std::sync::Arc;

use adom_autofetch::v3::suppressed_key;
use adom_index::NativeKv;
use serde_json::{json, Value};

use crate::autofetch::fakes::{factory_for, FakeDebrid, SCOPE};
use crate::autofetch::ports::DebridIo;
use crate::autofetch::suppressed_step::{clear, count, drain, test_lock, DrainGate};

const JSONL: &str = include_str!("../../../../golden/autofetch-suppressed-step.jsonl");
const MANIFEST_TEXT: &str =
    include_str!("../../../../golden/autofetch-suppressed-step.manifest.json");
const PATH: &str = "rust/golden/autofetch-suppressed-step.jsonl";
const REGISTRY: &str = "autofetch-suppressed-step/drain";
/// Relógio de todos os casos (o mesmo do gerador).
const NOW: i64 = 1_700_000_000_000;
const TTL: i64 = 600;

/// Semeia UMA entrada: registro da represa + os registros de defesa. O formato
/// do registro é o do Node (`{id, at, fails, nextAt}`); o legado `{at}` só
/// reproduz a órfã sem id.
fn seed(kv: &NativeKv, entry: &Value) {
    let adapter = entry["adapter"].as_str().expect("adapter");
    let account = entry["account"].as_str().expect("account");
    let hash = entry["hash"].as_str().expect("hash");
    let raw_at_only = entry
        .get("raw_at_only")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let record = if raw_at_only {
        json!({ "at": NOW })
    } else {
        json!({
            "at": NOW,
            "id": entry["id"].as_str().expect("id"),
            "fails": entry.get("fails").and_then(Value::as_i64).unwrap_or(0),
            "nextAt": entry.get("next_at").and_then(Value::as_i64).unwrap_or(0),
        })
    };
    kv.put_json(&suppressed_key(adapter, account, hash), &record, TTL, NOW)
        .expect("semeia a represa");
    if entry.get("hold").and_then(Value::as_bool).unwrap_or(false) {
        kv.put_json(
            &format!("adhold:v1:{account}:{hash}"),
            &json!({ "until": NOW + 60_000 }),
            TTL,
            NOW,
        )
        .expect("semeia o hold");
    }
    if entry
        .get("adprot")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        kv.put_json(
            &format!(
                "adprot:v1:{}:{account}:{hash}",
                adapter.to_ascii_lowercase()
            ),
            &json!({ "acceptedAt": NOW, "readyAt": NOW }),
            TTL,
            NOW,
        )
        .expect("semeia a proteção");
    }
    if entry.get("adrm").and_then(Value::as_bool).unwrap_or(false) {
        kv.put_json(&format!("adrm:v1:{account}:{hash}"), &json!(NOW), TTL, NOW)
            .expect("semeia o adrm");
    }
}

fn render(report: &crate::autofetch::suppressed_step::DrainReport) -> String {
    json!({
        "counters": {
            "dropped": report.counters.dropped,
            "failed": report.counters.failed,
            "kept": report.counters.kept,
            "retried": report.counters.retried,
        },
        "depth": report.depth,
        "operations": report.operations,
    })
    .to_string()
}

fn cases() -> Vec<support::Case> {
    support::load(JSONL, MANIFEST_TEXT, PATH, REGISTRY)
}

#[test]
fn fixture_integra_e_declara_contrato() {
    assert_eq!(cases().len(), 8, "contagem de casos do golden mudou");
    // O dublê precisa responder pelo MESMO escopo que os casos gravam.
    assert_eq!(SCOPE, "alldebrid:conta-de-teste");
}

#[tokio::test]
async fn dreno_bate_com_o_contrato() {
    // `drain` publica o último passo num registro do PROCESSO.
    let _guard = test_lock().await;
    for case in cases() {
        clear();
        let kv = NativeKv::open_memory().expect("kv em memória");
        for entry in case.input["entries"].as_array().expect("entries") {
            seed(&kv, entry);
        }
        let fake = Arc::new(FakeDebrid::accepting());
        let io: DebridIo = fake.clone();
        let max = case.input["max"].as_u64().expect("max") as usize;
        // Gate ABERTO de propósito: o caso mede o CORPO do dreno (o que fica
        // represado e o que entra no dreno), não o gate do knob — esse tem
        // testes próprios em `suppressed_step_tests.rs`.
        let gate = DrainGate {
            remove_by_id: true,
            force: false,
        };
        let report = drain(&kv, factory_for(SCOPE, io), max, NOW, gate)
            .await
            .expect("dreno sem erro de KV");
        assert_eq!(
            render(&report),
            case.expected,
            "caso {} divergiu do contrato: {}",
            case.id,
            case.input
        );
        // O que foi apagado é o id ATUAL, nunca um id qualquer.
        for id in fake.removed() {
            assert!(
                !id.is_empty(),
                "caso {}: dreno chamou remove com id vazio",
                case.id
            );
        }
        // Represa lida por outro ângulo: a profundidade do report é a do KV
        // (o mesmo `count` que o painel publica).
        assert_eq!(
            report.depth,
            count(&kv, NOW).expect("profundidade da represa"),
            "caso {}: depth não é a profundidade real da represa",
            case.id
        );
    }
    clear();
}
