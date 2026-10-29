//! Fase 1 do warmer: estado durável (intent/posse), fila no formato do Node e
//! quota horária. Nenhuma sonda HTTP: só o KV e a reidratação do boot.

use std::sync::Arc;

use adom_debrid::realdebrid_autofetch::{
    uncertain_key, RdUncertainIntent, RdUncertainStore, RdWriteKind,
};
use adom_index::NativeKv;
use serde_json::json;

use crate::rd_warmer::store::{hour_key, queue_key, NativeQueue, WarmIntentStore};
use crate::rd_warmer::{NoMagnet, WarmConfig, WarmDeps, WarmItem, WarmQueue, Warmer};

use super::{FakeKey, FakeLedger, FakePort, HASH_DOWN, HASH_READY};

const ACCOUNT: &str = "conta-a";
const HOUR_MS: i64 = 3_600_000;

fn kv_memory() -> Arc<NativeKv> {
    Arc::new(NativeKv::open_memory().expect("kv em memória"))
}

// ---------------------------------------------------------------------------
// Intent durável + posse
// ---------------------------------------------------------------------------

#[test]
fn intent_sobrevive_ao_restart_e_clear_nao_toca_a_posse() {
    let kv = kv_memory();
    let now = adom_sources::now_ms();
    let key = uncertain_key(ACCOUNT, HASH_READY);
    assert_eq!(key, format!("rdq:v1:uncertain:{ACCOUNT}:{HASH_READY}"));
    let intent = RdUncertainIntent {
        kind: RdWriteKind::Enqueue,
        created_at_ms: now,
    };

    let store = WarmIntentStore::new(Some(kv.clone()));
    assert!(
        store
            .put_intent_if_absent(&key, &intent)
            .expect("intent grava"),
        "a primeira escrita é dona do intent"
    );
    // Outra instância = processo novo lendo o mesmo `cache.db`.
    let restarted = WarmIntentStore::new(Some(kv.clone()));
    assert!(
        restarted.has_intent(&key).expect("reidrata o intent"),
        "o intent durável sobrevive ao restart"
    );
    assert!(kv.get_json(&key, now).expect("leitura").is_some());

    store.own(ACCOUNT, HASH_READY, "101");
    let owned = format!("rdq:v1:owned:{ACCOUNT}:{HASH_READY}");
    assert_eq!(
        kv.get_json(&owned, now)
            .expect("leitura da posse")
            .expect("posse gravada")["id"],
        "101"
    );
    assert!(store
        .owns_transfer(ACCOUNT, HASH_READY, "101")
        .expect("consulta posse"));
    assert!(
        !store
            .owns_transfer(ACCOUNT, HASH_READY, "202")
            .expect("consulta posse"),
        "id de outra transferência não é posse"
    );

    // `clear_intent` resolve só a escrita incerta; a posse continua.
    store.clear_intent(&key).expect("limpa intent");
    assert!(!store.has_intent(&key).expect("consulta intent"));
    assert!(
        store
            .owns_transfer(ACCOUNT, HASH_READY, "101")
            .expect("consulta posse"),
        "clear_intent não apaga a posse"
    );
    assert!(kv.get_json(&owned, now).expect("leitura").is_some());

    // `release` limpa as duas coisas.
    assert!(store
        .put_intent_if_absent(&key, &intent)
        .expect("intent volta"));
    store.release(ACCOUNT, HASH_READY);
    assert!(!store.has_intent(&key).expect("consulta intent"));
    assert!(!store
        .owns_transfer(ACCOUNT, HASH_READY, "101")
        .expect("consulta posse"));
    assert!(kv.get_json(&key, now).expect("leitura").is_none());
    assert!(kv.get_json(&owned, now).expect("leitura").is_none());
}

#[test]
fn intent_em_ram_guarda_a_mesma_semantica() {
    let store = WarmIntentStore::memory();
    let key = uncertain_key(ACCOUNT, HASH_READY);
    let intent = RdUncertainIntent {
        kind: RdWriteKind::Enqueue,
        created_at_ms: adom_sources::now_ms(),
    };
    assert!(store
        .put_intent_if_absent(&key, &intent)
        .expect("intent em RAM"));
    assert!(!store
        .has_intent("rdq:v1:uncertain:outra:hash")
        .expect("nada"));
    store.own(ACCOUNT, HASH_READY, "101");
    assert!(store
        .owns_transfer(ACCOUNT, HASH_READY, "101")
        .expect("posse em RAM"));
    store.release(ACCOUNT, HASH_READY);
    assert!(!store.has_intent(&key).expect("consulta intent"));
    assert!(!store
        .owns_transfer(ACCOUNT, HASH_READY, "101")
        .expect("consulta posse"));
}

// ---------------------------------------------------------------------------
// Fila no formato do Node
// ---------------------------------------------------------------------------

#[test]
fn fila_le_o_array_do_node_e_grava_escopo_explicito() {
    let kv = kv_memory();
    let now: i64 = 1_700_000_000_000;
    // Formato EXATO do Node: sem `scope`, com `enqueuedAt` em ms.
    let node_rows = json!([{ "hash": HASH_READY, "score": 80, "enqueuedAt": 1 }]);
    kv.put_json(&queue_key(), &node_rows, 0, now)
        .expect("fila do Node no KV");

    let queue = NativeQueue::new(Some(kv.clone()));
    let loaded = queue.load(now, 100, "realdebrid:operador");
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0].hash, HASH_READY);
    assert_eq!(loaded[0].score, 80);
    assert_eq!(loaded[0].enqueued_at, 1);
    assert_eq!(
        loaded[0].scope, "realdebrid:operador",
        "entrada sem conta adota o operador"
    );

    let item = WarmItem {
        hash: HASH_DOWN.to_string(),
        scope: "realdebrid:conta-b".to_string(),
        score: 40,
        enqueued_at: now,
    };
    queue.save(&[item], now);
    let raw = kv
        .get_json(&queue_key(), now)
        .expect("fila gravada")
        .expect("chave presente");
    let rows = raw.as_array().expect("array como o Node lê");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["hash"], HASH_DOWN);
    assert_eq!(rows[0]["score"], 40);
    assert_eq!(rows[0]["enqueuedAt"], now);
    assert_eq!(rows[0]["scope"], "realdebrid:conta-b");

    // Fila vazia não deixa array pendurado no KV.
    queue.save(&[], now);
    assert!(kv.get_json(&queue_key(), now).expect("leitura").is_none());
}

// ---------------------------------------------------------------------------
// Quota horária
// ---------------------------------------------------------------------------

#[test]
fn quota_do_balde_horario_nao_vaza_para_a_hora_nova() {
    let kv = kv_memory();
    let now: i64 = 1_700_000_000_000;
    let hour = now.div_euclid(HOUR_MS);
    let queue = NativeQueue::new(Some(kv.clone()));

    queue.save_hour(hour, 7, now);
    assert_eq!(queue.load_hour(now), (hour, 7));
    let stored = kv
        .get_json(&hour_key(), now)
        .expect("quota gravada")
        .expect("chave presente");
    assert_eq!(stored["hour"], hour);
    assert_eq!(stored["count"], 7);

    // Restart/mesma hora mantém o teto; hora nova começa do zero.
    assert_eq!(queue.load_hour(now + 60_000), (hour, 7));
    assert_eq!(queue.load_hour(now + HOUR_MS), (hour + 1, 0));
}

// ---------------------------------------------------------------------------
// Reidratação no boot
// ---------------------------------------------------------------------------

#[tokio::test]
async fn boot_reidrata_a_fila_do_kv_e_drena() {
    let kv = kv_memory();
    let now = adom_sources::now_ms();
    let node_rows = json!([
        { "hash": HASH_READY, "score": 80, "enqueuedAt": 1 },
        { "hash": HASH_DOWN, "score": 40, "enqueuedAt": 2 },
    ]);
    kv.put_json(&queue_key(), &node_rows, 0, now)
        .expect("fila deixada pelo Node");

    let port = Arc::new(FakePort::default());
    let warm = Warmer::with_deps(WarmDeps {
        config: WarmConfig::fixture(10, 100, 300),
        key: FakeKey::some("k"),
        port: port.clone(),
        ledger: Arc::new(FakeLedger::default()),
        magnet: Arc::new(NoMagnet),
        queue: Arc::new(NativeQueue::new(Some(kv.clone()))),
        traffic: None,
    });

    assert_eq!(warm.pending(), 2, "o boot reidrata a fila persistida");
    assert_eq!(warm.drain().await, 2);
    let probed: Vec<String> = port.batches().into_iter().flatten().collect();
    assert_eq!(
        probed,
        vec![HASH_READY.to_string(), HASH_DOWN.to_string()],
        "score maior sonda primeiro"
    );
    assert_eq!(warm.pending(), 0);
    assert!(
        kv.get_json(&queue_key(), now).expect("leitura").is_none(),
        "a fila persistida fica vazia depois do dreno"
    );
}
