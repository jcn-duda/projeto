//! Parte 2 dos testes do índice (`record`/`lookup`/higiene do `idx:v14`).
//!
//! Incluída por `#[path]` a partir de `release_index_tests.rs`, que passaria
//! do teto de 400 linhas num arquivo só.

use super::{movie, record, store, NOW, TTL};
use adom_core::BankRow;
use serde_json::json;

use crate::release_index::{RecordOptions, ReleaseIndexStore};

#[test]
fn partial_grava_bloqueia_e_keep_partial_nao_rebaixa() {
    let store = store();
    let item = json!({"title": "Filme 2024 1080p", "infoHash": "0101010101010101010101010101010101010101"});
    record(
        &store,
        "tt6666666",
        movie(),
        std::slice::from_ref(&item),
        true,
        NOW,
    );
    assert!(store.is_partial("tt6666666", movie(), NOW));
    record(
        &store,
        "tt6666666",
        movie(),
        std::slice::from_ref(&item),
        false,
        NOW + 1,
    );
    assert!(
        !store.is_partial("tt6666666", movie(), NOW + 1),
        "gravação completa limpa"
    );
    record(
        &store,
        "tt6666666",
        movie(),
        std::slice::from_ref(&item),
        true,
        NOW + 2,
    );
    // `keepPartial`: nova gravação "completa" não rebaixa a chave parcial.
    store
        .record(
            "tt6666666",
            movie(),
            &[item],
            RecordOptions {
                partial: false,
                keep_partial: true,
                source: None,
                supplemental: false,
            },
            TTL,
            60,
            NOW + 3,
            None,
        )
        .expect("record keepPartial");
    assert!(store.is_partial("tt6666666", movie(), NOW + 3));
}

#[test]
fn corte_protege_br_mas_respeita_o_teto() {
    let store = store();
    let mut items = Vec::new();
    for i in 0..5 {
        items.push(json!({
            "title": format!("Filme {i} 1080p Dublado"),
            "infoHash": format!("{:040x}", i + 1),
            "isBr": true,
            "seeders": 1,
        }));
    }
    store
        .record(
            "tt7777777",
            movie(),
            &items,
            RecordOptions::default(),
            TTL,
            3,
            NOW,
            None,
        )
        .expect("record");
    let out = store.lookup("tt7777777", movie(), NOW);
    assert_eq!(out.len(), 3, "teto de 3 releases por obra");
}

#[test]
fn fonte_de_midia_vem_do_banco_por_hash() {
    let store = store();
    let item = json!({"title": "Filme 2024 1080p", "infoHash": "0202020202020202020202020202020202020202"});
    let hash = "0202020202020202020202020202020202020202";
    let bank = move |hashes: &[String]| -> Vec<BankRow> {
        hashes
            .iter()
            .map(|h| BankRow {
                hash: h.clone(),
                uri: format!("magnet:?xt=urn:btih:{h}&dn=Filme.2024.CAM"),
                title: String::new(),
            })
            .collect()
    };
    store
        .record(
            "tt8888888",
            movie(),
            &[item],
            RecordOptions::default(),
            TTL,
            60,
            NOW,
            Some(&bank),
        )
        .expect("record");
    let out = store.lookup("tt8888888", movie(), NOW);
    assert_eq!(out[0].media_source.as_deref(), Some("CAM"));
    assert_eq!(out[0].hash, hash);
}

#[test]
fn hash_curto_ou_sem_hash_nao_entra() {
    let store = store();
    let items = vec![
        json!({"title": "sem hash"}),
        json!({"title": "hash torto", "infoHash": "xyz"}),
        json!({"title": "conta", "infoHash": "0303030303030303030303030303030303030303", "fromAccount": true}),
    ];
    assert_eq!(record(&store, "tt9999999", movie(), &items, false, NOW), 0);
    assert!(store.lookup("tt9999999", movie(), NOW).is_empty());
}

#[test]
fn open_apaga_versao_morta_e_idx_expirado() {
    let dir = std::env::temp_dir().join(format!("adom-idx-hygiene-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("tmpdir");
    let path = dir.join("cache.db");
    {
        let seed = rusqlite::Connection::open(&path).expect("seed");
        seed.execute_batch(crate::release_index::SCHEMA)
            .expect("schema");
        let far = NOW + 86_400_000;
        seed.execute(
            "INSERT INTO cache (key, value, expires_at) VALUES (?1, '{}', ?2)",
            rusqlite::params!["idx:v13:tt1", far],
        )
        .unwrap();
        seed.execute(
            "INSERT INTO cache (key, value, expires_at) VALUES (?1, '{}', ?2)",
            rusqlite::params!["idx:v14:tt2", far],
        )
        .unwrap();
        seed.execute(
            "INSERT INTO cache (key, value, expires_at) VALUES (?1, '{}', ?2)",
            rusqlite::params!["idx:v14:tt3", 1],
        )
        .unwrap();
        seed.execute(
            "INSERT INTO cache (key, value, expires_at) VALUES (?1, '{}', ?2)",
            rusqlite::params!["raw:v1:keep", far],
        )
        .unwrap();
    }
    let store = ReleaseIndexStore::open(&path).expect("open");
    let far = NOW + 86_400_000;
    assert!(
        !store.has_key("idx:v13:tt1", far),
        "versão morta some no open"
    );
    assert!(store.has_key("idx:v14:tt2", far), "v14 viva fica");
    assert!(!store.has_key("idx:v14:tt3", far), "expirado não é vivo");
    drop(store);
    let verify = rusqlite::Connection::open(&path).expect("verify");
    let stale: i64 = verify
        .query_row(
            "SELECT COUNT(*) FROM cache WHERE key = 'idx:v13:tt1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(stale, 0);
    let expired: i64 = verify
        .query_row(
            "SELECT COUNT(*) FROM cache WHERE key = 'idx:v14:tt3'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(expired, 1, "expirado fica para a leitura / enforce_quota");
    let raw: i64 = verify
        .query_row(
            "SELECT COUNT(*) FROM cache WHERE key = 'raw:v1:keep'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(raw, 1, "outro namespace não é tocado");
    let _ = std::fs::remove_dir_all(&dir);
}
