//! Testes da interceptação no tail: `dub_audit` (T3-L7a) e os donos nativos que
//! chegaram depois (o lote do Chupim e a costura genérica ficam no irmão
//! `tail_effects_tests_part2.rs`, pela catraca de linhas).

use std::sync::{Arc, Mutex};

use adom_search::orchestrator::{EffectsBatch, RouteFuture, TailEffects};
use adom_search::{EffectEntry, EffectsResponse};
use serde_json::{json, Map, Value};

use super::*;
use crate::autofetch::Vault;
use crate::dub_audit_fakes::*;

/// Alvo de repasse: guarda os lotes que chegaram e devolve o `ok` combinado.
struct RecordingTail {
    batches: Mutex<Vec<EffectsBatch>>,
    ok: bool,
}

impl RecordingTail {
    fn new(ok: bool) -> Self {
        Self {
            batches: Mutex::new(Vec::new()),
            ok,
        }
    }

    fn batches(&self) -> Vec<EffectsBatch> {
        self.batches.lock().unwrap().clone()
    }
}

impl TailEffects for RecordingTail {
    fn effects<'a>(&'a self, batch: EffectsBatch) -> RouteFuture<'a, EffectsResponse> {
        Box::pin(async move {
            let accepted = i64::try_from(batch.effects.len()).unwrap_or(i64::MAX);
            self.batches.lock().unwrap().push(batch);
            Ok(EffectsResponse {
                ok: self.ok,
                accepted,
                rejected: 0,
            })
        })
    }
}

/// Canal do worker: grava os jobs publicados e responde pelo próprio estado.
struct FakeQueue {
    enabled: bool,
    accept: bool,
    jobs: Mutex<Vec<(String, Map<String, Value>)>>,
}

impl FakeQueue {
    fn new(enabled: bool) -> Self {
        Self {
            enabled,
            accept: true,
            jobs: Mutex::new(Vec::new()),
        }
    }

    /// Canal cheio: `submit` recusa.
    fn refusing() -> Self {
        Self {
            enabled: true,
            accept: false,
            jobs: Mutex::new(Vec::new()),
        }
    }

    fn jobs(&self) -> Vec<(String, Map<String, Value>)> {
        self.jobs.lock().unwrap().clone()
    }
}

impl NativeWorkQueue for FakeQueue {
    fn enabled(&self) -> bool {
        self.enabled
    }

    fn submit(&self, scope: &str, payload: &Map<String, Value>) -> bool {
        if !self.accept {
            return false;
        }
        self.jobs
            .lock()
            .unwrap()
            .push((scope.to_string(), payload.clone()));
        true
    }
}

/// Dono registrado por outro módulo (`rd_warmer`).
#[derive(Default)]
struct RecordingSink {
    offers: Mutex<Vec<(String, Value)>>,
}

impl RecordingSink {
    fn offers(&self) -> Vec<(String, Value)> {
        self.offers.lock().unwrap().clone()
    }
}

impl NativeEffectSink for RecordingSink {
    fn offer(&self, kind: &str, payload: &Value, _scope: Option<&str>) {
        self.offers
            .lock()
            .unwrap()
            .push((kind.to_string(), payload.clone()));
    }
}

fn entry(kind: &str, payload: serde_json::Value) -> EffectEntry {
    EffectEntry {
        kind: kind.to_string(),
        payload: serde_json::from_value(payload).unwrap(),
    }
}

fn dub_audit_payload(hashes: &[String]) -> serde_json::Value {
    json!({
        "adapter_id": "alldebrid",
        "api_key": "chave-a",
        "candidates": hashes.iter().map(|hash| json!({
            "hash": hash,
            "season": 1,
            "episode": 4,
            "imdbId": "tt123",
            "dubbed": true
        })).collect::<Vec<_>>()
    })
}

/// Lote do Chupim com um item — a forma do `effects::autofetch_batch`.
fn autofetch_payload(hash: &str) -> Value {
    json!({
        "items": [{ "infoHash": hash, "title": "Titulo", "name": "Titulo 1080p",
                    "_br": true, "_dubbed": true, "_quality": "1080p" }],
        "cached": [],
        "known": true,
        "season": null,
        "episode": null,
        "imdbId": "tt123",
        "searchKey": "tt123:movie"
    })
}

fn br_probe_payload() -> Value {
    json!({ "imdbId": "tt123", "type": "movie", "season": null,
            "episode": null, "mode": "evidence" })
}

fn season_key_payload() -> Value {
    json!({ "adapter_id": "alldebrid", "account": "digest-da-conta",
            "imdb": "tt123", "season": 2, "cache_key": "streams:v21:chave" })
}

fn build(
    tail: Arc<RecordingTail>,
    tail_max: usize,
) -> (Arc<FakeResolver>, Arc<DubAudit>, Arc<NativeTailEffects>) {
    let (resolver, audit) = audit(vec![], Arc::new(FakeWrites::default()), tail_max, false);
    let native = Arc::new(NativeTailEffects::new(tail, audit.clone()));
    (resolver, audit, native)
}

/// Tail com cofre e canal injetados (o worker fora da env do processo).
fn worker_tail(
    tail: Arc<RecordingTail>,
    queue: Arc<FakeQueue>,
    tail_max: usize,
) -> Arc<NativeTailEffects> {
    let (_resolver, audit) = audit(vec![], Arc::new(FakeWrites::default()), tail_max, false);
    let vault = Arc::new(Vault::new(60_000, 4, ""));
    Arc::new(NativeTailEffects::with_vault(tail, audit, Some(vault)).with_queue(queue))
}

#[tokio::test]
async fn dub_audit_fica_no_gateway_e_o_resto_vai_ao_node() {
    let target = Arc::new(RecordingTail::new(true));
    let (_resolver, audit, native) = build(target.clone(), 2);
    let batch = EffectsBatch {
        encoded: "cfg".into(),
        effects: vec![
            entry("dub_audit", dub_audit_payload(&[hash_of(1), hash_of(2)])),
            entry("autofetch", json!({ "items": [] })),
        ],
    };
    let response = native.effects(batch).await.unwrap();
    assert!(response.ok);
    assert_eq!(response.accepted, 2);
    assert_eq!(response.rejected, 0);
    // O Node recebeu SÓ o autofetch — o `dub_audit` não atravessa mais.
    let batches = target.batches();
    assert_eq!(batches.len(), 1);
    assert_eq!(batches[0].encoded, "cfg");
    assert_eq!(batches[0].effects.len(), 1);
    assert_eq!(batches[0].effects[0].kind, "autofetch");
    // Os dois candidatos entraram na fila do interrogatório nativo.
    assert_eq!(audit.pending(), 2);
}

#[tokio::test]
async fn payload_invalido_e_rejeitado_sem_chamar_o_alvo() {
    let target = Arc::new(RecordingTail::new(true));
    let (_resolver, audit, native) = build(target.clone(), 2);
    let batch = EffectsBatch {
        encoded: "cfg".into(),
        effects: vec![entry(
            "dub_audit",
            json!({ "adapter_id": "alldebrid", "api_key": "chave-a",
                    "candidates": [{ "hash": "curto" }] }),
        )],
    };
    let response = native.effects(batch).await.unwrap();
    assert!(response.ok);
    assert_eq!(response.accepted, 0);
    assert_eq!(response.rejected, 1);
    assert!(target.batches().is_empty());
    assert_eq!(audit.pending(), 0);
}

#[tokio::test]
async fn veredito_do_alvo_propaga() {
    let target = Arc::new(RecordingTail::new(false));
    let (_resolver, _audit, native) = build(target.clone(), 2);
    let batch = EffectsBatch {
        encoded: "cfg".into(),
        effects: vec![entry("autofetch", json!({ "items": [] }))],
    };
    let response = native.effects(batch).await.unwrap();
    assert!(!response.ok);
    assert_eq!(response.accepted, 1);
}

#[tokio::test]
async fn aceite_dispara_a_drenagem_em_segundo_plano() {
    let target = Arc::new(RecordingTail::new(true));
    let (resolver, audit, native) = build(target, 2);
    let batch = EffectsBatch {
        encoded: "cfg".into(),
        effects: vec![entry("dub_audit", dub_audit_payload(&[hash_of(1)]))],
    };
    native.effects(batch).await.unwrap();
    // A drenagem é fire-and-forget: cede a vez até a fila esvaziar.
    for _ in 0..50 {
        if audit.pending() == 0 {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert_eq!(audit.pending(), 0);
    assert_eq!(resolver.calls().len(), 1);
    assert_eq!(resolver.calls()[0].hash, hash_of(1));
}

fn encoded_key(api_key: &str) -> String {
    adom_core::encode_config(&json!({ "ds": "alldebrid", "dk": api_key }))
}

/// O `encoded` do lote alimenta o cofre ANTES da delegação — inclusive quando o
/// lote só tem `dub_audit` (o Node nem recebe nada).
#[tokio::test]
async fn encoded_alimenta_o_cofre_do_worker() {
    let target = Arc::new(RecordingTail::new(true));
    let (resolver, audit) = audit(vec![], Arc::new(FakeWrites::default()), 2, false);
    let vault = Arc::new(Vault::new(60_000, 4, ""));
    let native = NativeTailEffects::with_vault(target.clone(), audit, Some(vault.clone()));
    let batch = EffectsBatch {
        encoded: encoded_key("chave-do-cofre-99"),
        effects: vec![entry("dub_audit", dub_audit_payload(&[hash_of(1)]))],
    };
    let response = native.effects(batch).await.unwrap();
    assert_eq!(response.accepted, 1);
    assert_eq!(vault.len(), 1, "lote só com dub_audit ensina a conta");
    assert!(target.batches().is_empty());
    let debug = format!("{vault:?}");
    assert!(!debug.contains("chave-do-cofre-99"), "{debug}");
    assert_eq!(resolver.calls().len(), 0);
}

/// Cofre ausente (trava desligada) é o default: nada é guardado nem consumido.
#[tokio::test]
async fn sem_cofre_o_lote_segue_intacto() {
    let target = Arc::new(RecordingTail::new(true));
    let (_resolver, audit) = audit(vec![], Arc::new(FakeWrites::default()), 2, false);
    let native = NativeTailEffects::with_vault(target.clone(), audit, None);
    let batch = EffectsBatch {
        encoded: encoded_key("chave-do-cofre-99"),
        effects: vec![entry("autofetch", json!({ "items": [] }))],
    };
    let response = native.effects(batch).await.unwrap();
    assert!(response.ok);
    assert_eq!(target.batches().len(), 1);
}

/// Lote do Chupim e a costura genérica de donos.
#[path = "tail_effects_tests_part2.rs"]
mod lote;
