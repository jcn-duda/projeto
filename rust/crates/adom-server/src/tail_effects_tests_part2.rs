//! Lote do Chupim no tail (`autofetch_batch`/`br_probe`/`season_key`) e a
//! costura genérica de donos (`NativeEffectSink`).
//!
//! Regra sob teste: com o worker LIGADO o trabalho não volta ao Node; sem dono
//! ligado, sem escopo de conta ou com o canal recusando, o efeito segue ao Node
//! como hoje — e o caminho bem-sucedido nunca duplica trabalho.

use std::sync::Arc;

use adom_search::orchestrator::{EffectsBatch, TailEffects};
use serde_json::json;

use super::super::{NativeTailEffects, AUTOFETCH_BATCH, BR_PROBE, SEASON_KEY};
use super::{
    autofetch_payload, br_probe_payload, dub_audit_payload, encoded_key, entry, season_key_payload,
    worker_tail, FakeQueue, RecordingSink, RecordingTail,
};
use crate::autofetch::Vault;
use crate::dub_audit_fakes::{audit, hash_of, FakeWrites};

/// (a) Worker em `prepared`: os três kinds são do Node, como hoje.
#[tokio::test]
async fn worker_desligado_manda_os_tres_kinds_ao_node() {
    let target = Arc::new(RecordingTail::new(true));
    let queue = Arc::new(FakeQueue::new(false));
    let native = worker_tail(target.clone(), queue.clone(), 2);
    let batch = EffectsBatch {
        encoded: encoded_key("chave-do-worker-7"),
        effects: vec![
            entry(AUTOFETCH_BATCH, autofetch_payload(&hash_of(1))),
            entry(BR_PROBE, br_probe_payload()),
            entry(SEASON_KEY, season_key_payload()),
        ],
    };
    let response = native.effects(batch).await.unwrap();
    assert!(response.ok);
    assert_eq!(response.accepted, 3);
    assert_eq!(response.rejected, 0);
    assert!(
        queue.jobs().is_empty(),
        "worker em prepared não recebe lote"
    );
    let batches = target.batches();
    assert_eq!(batches.len(), 1);
    let kinds: Vec<&str> = batches[0]
        .effects
        .iter()
        .map(|effect| effect.kind.as_str())
        .collect();
    assert_eq!(kinds, [AUTOFETCH_BATCH, BR_PROBE, SEASON_KEY]);
}

/// (b) Worker ligado: o lote NÃO atravessa para o Node e o job chega ao canal
/// com o escopo da conta e o payload intacto.
#[tokio::test]
async fn worker_ligado_enfileira_com_escopo_e_payload_intacto() {
    let target = Arc::new(RecordingTail::new(true));
    let queue = Arc::new(FakeQueue::new(true));
    let native = worker_tail(target.clone(), queue.clone(), 2);
    let autofetch = autofetch_payload(&hash_of(1));
    let batch = EffectsBatch {
        encoded: encoded_key("chave-do-worker-7"),
        effects: vec![
            entry(AUTOFETCH_BATCH, autofetch.clone()),
            entry(BR_PROBE, br_probe_payload()),
            entry(SEASON_KEY, season_key_payload()),
        ],
    };
    let response = native.effects(batch).await.unwrap();
    assert!(response.ok);
    assert_eq!(response.accepted, 3);
    assert_eq!(response.rejected, 0);
    assert!(target.batches().is_empty(), "nada do Chupim volta ao Node");
    let jobs = queue.jobs();
    assert_eq!(jobs.len(), 3);
    // `autofetch_batch` e `br_probe` não trazem conta: o escopo vem do `encoded`.
    let scope = Vault::scope_of("alldebrid", "chave-do-worker-7").expect("escopo do cofre");
    assert_eq!(jobs[0].0, scope);
    assert_eq!(jobs[1].0, scope);
    // `season_key` carrega `adapter_id` + `account`: o escopo sai do payload.
    assert_eq!(jobs[2].0, "alldebrid:digest-da-conta");
    // Payload intacto (o worker monta o `Job` com ele como veio).
    assert_eq!(jobs[0].1, *autofetch.as_object().unwrap());
    assert_eq!(jobs[2].1, *season_key_payload().as_object().unwrap());
}

/// (c) Sem `encoded` (nem conta no payload) o escopo não se deriva: o efeito
/// VOLTA ao Node e conta em `rejected`.
#[tokio::test]
async fn encoded_ausente_devolve_o_kind_ao_node() {
    let target = Arc::new(RecordingTail::new(true));
    let queue = Arc::new(FakeQueue::new(true));
    let native = worker_tail(target.clone(), queue.clone(), 2);
    let batch = EffectsBatch {
        encoded: String::new(),
        effects: vec![entry(AUTOFETCH_BATCH, autofetch_payload(&hash_of(1)))],
    };
    let response = native.effects(batch).await.unwrap();
    assert!(response.ok);
    assert_eq!(response.rejected, 1, "sem escopo conta em rejected");
    // O aceite do Node entra na MESMA resposta: o efeito não se perdeu.
    assert_eq!(response.accepted, 1);
    assert!(queue.jobs().is_empty());
    assert_eq!(target.batches()[0].effects[0].kind, AUTOFETCH_BATCH);
}

/// Canal cheio/ausente também devolve ao Node: trabalho nunca se perde calado.
#[tokio::test]
async fn canal_recusando_devolve_o_kind_ao_node() {
    let target = Arc::new(RecordingTail::new(true));
    let queue = Arc::new(FakeQueue::refusing());
    let native = worker_tail(target.clone(), queue.clone(), 2);
    let batch = EffectsBatch {
        encoded: encoded_key("chave-do-worker-7"),
        effects: vec![entry(BR_PROBE, br_probe_payload())],
    };
    let response = native.effects(batch).await.unwrap();
    assert_eq!(response.accepted, 1);
    assert_eq!(response.rejected, 1);
    assert!(queue.jobs().is_empty());
    assert_eq!(target.batches()[0].effects[0].kind, BR_PROBE);
}

/// (d) `dub_audit` continua no gateway junto do lote do Chupim, e o que não tem
/// dono nativo segue ao Node.
#[tokio::test]
async fn dub_audit_convive_com_o_lote_do_chupim() {
    let target = Arc::new(RecordingTail::new(true));
    let queue = Arc::new(FakeQueue::new(true));
    let (_resolver, audit) = audit(vec![], Arc::new(FakeWrites::default()), 2, false);
    let vault = Arc::new(Vault::new(60_000, 4, ""));
    let native = Arc::new(
        NativeTailEffects::with_vault(target.clone(), audit.clone(), Some(vault))
            .with_queue(queue.clone()),
    );
    let batch = EffectsBatch {
        encoded: encoded_key("chave-do-worker-7"),
        effects: vec![
            entry(AUTOFETCH_BATCH, autofetch_payload(&hash_of(1))),
            entry("dub_audit", dub_audit_payload(&[hash_of(2)])),
            entry("harvester_enqueue", json!({ "imdbId": "tt123" })),
        ],
    };
    let response = native.effects(batch).await.unwrap();
    assert_eq!(response.accepted, 3);
    assert_eq!(response.rejected, 0);
    assert_eq!(queue.jobs().len(), 1);
    assert_eq!(audit.pending(), 1);
    let effects = target.batches()[0].effects.clone();
    assert_eq!(effects.len(), 1);
    assert_eq!(effects[0].kind, "harvester_enqueue");
}

/// (e) Dono registrado por outro módulo recebe o `kind` dele sem mudar a ordem
/// dos demais.
#[tokio::test]
async fn sink_registrado_recebe_rd_warmer_sem_mudar_a_ordem() {
    let target = Arc::new(RecordingTail::new(true));
    let queue = Arc::new(FakeQueue::new(true));
    let sink = Arc::new(RecordingSink {
        accept: true,
        ..RecordingSink::default()
    });
    let (_resolver, audit) = audit(vec![], Arc::new(FakeWrites::default()), 2, false);
    let vault = Arc::new(Vault::new(60_000, 4, ""));
    let native = Arc::new(
        NativeTailEffects::with_vault(target.clone(), audit, Some(vault))
            .with_queue(queue.clone())
            .with_sink("rd_warmer", sink.clone()),
    );
    let warmer = json!({ "releases": [{ "title": "Titulo", "infoHash": hash_of(3) }] });
    let batch = EffectsBatch {
        encoded: encoded_key("chave-do-worker-7"),
        effects: vec![
            entry(AUTOFETCH_BATCH, autofetch_payload(&hash_of(1))),
            entry("rd_warmer", warmer.clone()),
            entry("harvester_enqueue", json!({ "imdbId": "tt123" })),
            entry(BR_PROBE, br_probe_payload()),
        ],
    };
    let response = native.effects(batch).await.unwrap();
    assert_eq!(response.accepted, 4);
    assert_eq!(response.rejected, 0);
    assert_eq!(queue.jobs().len(), 2);
    // O sink recebeu o payload do warmer e nada dele foi ao Node.
    let offers = sink.offers();
    assert_eq!(offers.len(), 1);
    assert_eq!(offers[0].0, "rd_warmer");
    assert_eq!(offers[0].1, warmer);
    // A ordem relativa do que sobra para o Node é a de chegada.
    let rest: Vec<String> = target.batches()[0]
        .effects
        .iter()
        .map(|effect| effect.kind.clone())
        .collect();
    assert_eq!(rest, ["harvester_enqueue"]);
}

#[tokio::test]
async fn sink_que_recusa_devolve_o_efeito_ao_node() {
    let target = Arc::new(RecordingTail::new(true));
    let (_resolver, audit) = audit(vec![], Arc::new(FakeWrites::default()), 2, false);
    let sink = Arc::new(RecordingSink {
        accept: false,
        ..RecordingSink::default()
    });
    let native = NativeTailEffects::with_vault(
        target.clone(),
        audit,
        Some(Arc::new(Vault::new(60_000, 4, ""))),
    )
    .with_sink("rd_warmer", sink);
    let effect = entry("rd_warmer", json!({ "releases": [] }));
    let response = native
        .effects(EffectsBatch {
            encoded: encoded_key("chave-nao-rd"),
            effects: vec![effect],
        })
        .await
        .unwrap();

    assert_eq!(response.accepted, 1);
    assert_eq!(response.rejected, 1);
    assert_eq!(target.batches()[0].effects[0].kind, "rd_warmer");
}
