//! Provas do agregado `mag_meta:v1:counts` do lado Rust: o valor gravado tem
//! exatamente a forma que o Node lia, e tudo o que não é legível volta como
//! ausente (o chamador reconta o acervo em vez de aceitar número inventado).
//!
//! Os casos de payload ilegível plantam a linha com INSERT cru de propósito: a
//! API tipada não consegue produzir `version: 2` nem `adapters: [...]`, e é
//! justamente esse lixo herdado que o boot pode encontrar no `cache.db`.

use std::collections::BTreeMap;

use adom_core::mag_meta_counts_key;
use rusqlite::params;
use serde_json::{json, Value};

use crate::magnet_state::{read_row, MagnetStateStore};

use super::{MagMetaCounts, MagMetaSums, MagMetaTotals, MAG_META_VERSION};

/// 7 dias: o piso de TTL que o Node usa para o agregado.
const TTL: i64 = 7 * 24 * 3_600;
const NOW: i64 = 1_760_000_000_000;

fn totals(alive: u32, bad: u32, lie: u32, ttl: (i64, i64, i64)) -> MagMetaTotals {
    MagMetaTotals {
        alive,
        bad,
        lie,
        ttl_remaining_sums: MagMetaSums {
            alive: ttl.0,
            bad: ttl.1,
            lie: ttl.2,
        },
    }
}

fn adapters(rows: &[(&str, MagMetaTotals)]) -> BTreeMap<String, MagMetaTotals> {
    rows.iter().map(|(id, t)| ((*id).to_string(), *t)).collect()
}

/// Linha crua como ela está no `cache.db`: valor decodificado e `expires_at`.
fn raw_row(store: &MagnetStateStore) -> Option<(Value, Option<i64>)> {
    let conn = store.lock();
    let row = read_row(&conn, &mag_meta_counts_key()).unwrap();
    row.map(|(raw, expires_at)| (serde_json::from_str(&raw).unwrap(), expires_at))
}

/// Planta um payload arbitrário (o que o Node herdado pode ter deixado).
fn plant(store: &MagnetStateStore, raw: &str) {
    store
        .lock()
        .execute(
            "INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?1, ?2, 0)",
            params![mag_meta_counts_key(), raw],
        )
        .unwrap();
}

#[test]
fn put_counts_grava_o_mesmo_valor_que_o_node_gravava() {
    let store = MagnetStateStore::open_memory().unwrap();
    let rows = adapters(&[
        ("premiumize", totals(2, 0, 0, (120, 0, 0))),
        ("torbox", totals(0, 1, 1, (0, 3_600, 7_200))),
    ]);

    store.put_counts(&rows, TTL, NOW).unwrap();

    let (value, expires_at) = raw_row(&store).expect("linha gravada");
    assert_eq!(
        value,
        json!({
            "version": 1,
            "updatedAt": NOW,
            "adapters": {
                "premiumize": {
                    "alive": 2, "bad": 0, "lie": 0,
                    "ttlRemainingSums": { "alive": 120, "bad": 0, "lie": 0 },
                },
                "torbox": {
                    "alive": 0, "bad": 1, "lie": 1,
                    "ttlRemainingSums": { "alive": 0, "bad": 3_600, "lie": 7_200 },
                },
            },
        }),
        "valor idêntico ao `{{version, updatedAt, adapters}}` do Node"
    );
    assert_eq!(
        expires_at,
        Some(NOW + TTL * 1_000),
        "`expires_at` = now + ttl, como o `cache.set` fazia"
    );
    assert_eq!(MAG_META_VERSION, 1);
}

#[test]
fn counts_devolve_o_que_put_counts_gravou() {
    let store = MagnetStateStore::open_memory().unwrap();
    let rows = adapters(&[("premiumize", totals(3, 1, 2, (600, 60, 1_200)))]);
    store.put_counts(&rows, TTL, NOW).unwrap();

    let read = store.counts(NOW + 1).unwrap().expect("agregado presente");
    assert_eq!(
        read,
        MagMetaCounts {
            updated_at: NOW,
            adapters: rows,
        },
        "round-trip sem perda: carimbo, contagem e soma de TTL"
    );
}

#[test]
fn agregado_ausente_devolve_none() {
    let store = MagnetStateStore::open_memory().unwrap();
    assert!(store.counts(NOW).unwrap().is_none());
}

#[test]
fn agregado_vencido_devolve_none_sem_apagar_a_linha() {
    let store = MagnetStateStore::open_memory().unwrap();
    store
        .put_counts(
            &adapters(&[("premiumize", totals(1, 0, 0, (60, 0, 0)))]),
            60,
            NOW,
        )
        .unwrap();

    assert!(store.counts(NOW + 60_001).unwrap().is_none(), "vencido");
    assert!(
        raw_row(&store).is_some(),
        "a leitura não apaga: o rebuild regrava por cima, sem perder a linha no meio do boot"
    );
}

#[test]
fn ttl_zero_grava_permanente() {
    let store = MagnetStateStore::open_memory().unwrap();
    store
        .put_counts(
            &adapters(&[("premiumize", totals(1, 0, 0, (0, 0, 0)))]),
            0,
            NOW,
        )
        .unwrap();

    assert_eq!(raw_row(&store).unwrap().1, Some(0), "sem expiração");
    let dez_anos = NOW + 10 * 365 * 86_400_000_i64;
    assert!(store.counts(dez_anos).unwrap().is_some());
}

#[test]
fn versao_estranha_ou_adapters_nao_objeto_contam_como_ausente() {
    let store = MagnetStateStore::open_memory().unwrap();

    plant(
        &store,
        r#"{"version":2,"updatedAt":1,"adapters":{"premiumize":{"alive":9,"bad":0,"lie":0,"ttlRemainingSums":{"alive":9,"bad":0,"lie":0}}}}"#,
    );
    assert!(
        store.counts(NOW).unwrap().is_none(),
        "versão que este escritor não lê cai no rebuild"
    );

    plant(&store, r#"{"version":1,"updatedAt":1,"adapters":["lixo"]}"#);
    assert!(
        store.counts(NOW).unwrap().is_none(),
        "adapters em array é lixo"
    );

    plant(&store, "nao-e-json");
    assert!(store.counts(NOW).unwrap().is_none(), "JSON quebrado");
}

#[test]
fn entrada_torta_vira_zero_sem_derrubar_o_agregado() {
    let store = MagnetStateStore::open_memory().unwrap();
    plant(
        &store,
        r#"{"version":1,"updatedAt":7,"adapters":{
            "premiumize":{"alive":"9","bad":-3,"lie":2.9,"ttlRemainingSums":{"alive":"x","lie":-5}},
            "quebrado":null
        }}"#,
    );

    let read = store.counts(NOW).unwrap().expect("o objeto sobrevive");
    assert_eq!(read.updated_at, 7);
    assert_eq!(
        read.adapters.get("premiumize"),
        Some(&totals(0, 0, 2, (0, 0, 0))),
        "texto→0, negativo→0, 2.9→2 e TTL torto→0"
    );
    assert!(
        !read.adapters.contains_key("quebrado"),
        "adapter que não é objeto fica fora"
    );
}

#[test]
fn forget_counts_apaga_so_o_agregado_e_e_idempotente() {
    let store = MagnetStateStore::open_memory().unwrap();
    store
        .put_counts(
            &adapters(&[("premiumize", totals(1, 0, 0, (60, 0, 0)))]),
            TTL,
            NOW,
        )
        .unwrap();

    assert!(store.forget_counts().unwrap(), "havia o que apagar");
    assert!(!store.forget_counts().unwrap(), "idempotente");
    assert!(store.counts(NOW).unwrap().is_none());
    assert_eq!(raw_row(&store), None);
}

#[test]
fn put_counts_sobrescreve_em_vez_de_duplicar() {
    let store = MagnetStateStore::open_memory().unwrap();
    store
        .put_counts(
            &adapters(&[("premiumize", totals(1, 0, 0, (60, 0, 0)))]),
            TTL,
            NOW,
        )
        .unwrap();
    store
        .put_counts(
            &adapters(&[("torbox", totals(0, 4, 0, (0, 240, 0)))]),
            TTL,
            NOW + 1_000,
        )
        .unwrap();

    let rows: i64 = store
        .lock()
        .query_row(
            "SELECT COUNT(*) FROM cache WHERE key = ?1",
            params![mag_meta_counts_key()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        rows, 1,
        "uma linha por chave, como o INSERT OR REPLACE do Node"
    );

    let read = store.counts(NOW + 2_000).unwrap().unwrap();
    assert_eq!(read.adapters.len(), 1);
    assert_eq!(
        read.updated_at,
        NOW + 1_000,
        "o carimbo acompanha a gravação"
    );
}
