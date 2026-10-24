//! Parte 2 dos testes do índice nativo (`native_index_tests.rs`).
//!
//! Corte mecânico: cobertura/parcialidade de origem, contrato do banco,
//! caminho da conta e reserva do banco. Nenhum teste mudou.

use std::sync::Arc;

use adom_core::{InstantMagnet, InstantWork};
use adom_debrid::account::{AccountInventory, InventoryItem};
use serde_json::json;

use super::*;
use crate::cache::MemorySwrStore;
use crate::orchestrator::account::{AccountInventorySource, AccountRequest};
use crate::orchestrator::index_source::BankFilterCtx;
use crate::orchestrator::live_state::LiveBatchState;
use crate::orchestrator::Orchestrator;

#[tokio::test]
async fn instantanea_sem_cobertura_nao_responde() {
    let mut work = instant_work(
        "dddddddddddddddddddddddddddddddddddddddd",
        "Filme 2024 1080p Legendado",
        1,
    );
    if let Some(magnet) = work.magnet.as_mut() {
        magnet.is_br = false;
        magnet.dubbed = false;
        magnet.quality = "480p".to_string();
        magnet.seeders_last = 0;
    }
    let bank = FakeBank::new(
        vec![work],
        sources("dddddddddddddddddddddddddddddddddddddddd"),
    );
    let orch = orch(
        config(),
        Some(FakeIndex::new(Vec::new(), false)),
        Some(bank),
    );
    let scan = orch
        .native_index_scan(
            &input("movie", json!({"providers": ["jackett"]})),
            &meta(None, None),
        )
        .await;
    assert!(!scan.instant_eligible, "sem dublado e sem swarm saudável");
}

#[tokio::test]
async fn filtro_de_origem_corta_release_de_outro_provider() {
    let indexed = vec![release(
        "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        true,
        true,
        "1080p",
        "torrentio",
    )];
    let orch = orch(config(), Some(FakeIndex::new(indexed, false)), None);
    let scan = orch
        .native_index_scan(
            &input(
                "movie",
                json!({"providers": ["jackett"], "jackettIndexers": ["bludv"]}),
            ),
            &meta(None, None),
        )
        .await;
    assert!(scan.indexed.is_empty(), "torrentio fora do p:jackett");
    assert!(scan.follow_up.miss);
}

#[tokio::test]
async fn parcial_bloqueia_o_fast_path_do_indice() {
    let indexed = vec![release(
        "ffffffffffffffffffffffffffffffffffffffff",
        true,
        true,
        "1080p",
        "bludv",
    )];
    let orch = orch(config(), Some(FakeIndex::new(indexed, true)), None);
    let scan = orch
        .native_index_scan(
            &input("movie", json!({"providers": ["jackett"]})),
            &meta(None, None),
        )
        .await;
    assert!(scan.is_partial);
    assert!(!scan.index_covered);
    assert!(scan.follow_up.partial);
}

#[tokio::test]
async fn serie_busca_episodio_temporada_e_raiz() {
    let mut work = instant_work(
        "0101010101010101010101010101010101010101",
        "Serie 2024 S02E05 1080p Dublado",
        1,
    );
    // Release global dublada (isBr=false): o filtro global aceita sem ano; o
    // que está sob teste aqui é o alvo de SÉRIE (episódio/pack/raiz) e a
    // cobertura por episódio NOMEADO.
    if let Some(magnet) = work.magnet.as_mut() {
        magnet.is_br = false;
    }
    let bank = FakeBank::new(
        vec![work],
        sources("0101010101010101010101010101010101010101"),
    );
    let orch = orch(
        config(),
        Some(FakeIndex::new(Vec::new(), false)),
        Some(bank),
    );
    let mut series_meta = meta(Some(2), Some(5));
    series_meta.name = "Serie".to_string();
    series_meta.names = vec!["Serie".to_string()];
    let scan = orch
        .native_index_scan(
            &input("series", json!({"providers": ["jackett"]})),
            &series_meta,
        )
        .await;
    assert!(scan.instant_eligible, "episódio nomeado cobre");
}

#[test]
fn banco_marks_sao_gravados_na_escrita_do_indice() {
    // A escrita nativa é exercida no `late`; aqui garantimos que o contrato da
    // trait de banco é chamável com o lote do índice.
    let bank = FakeBank::new(Vec::new(), BTreeMap::new());
    let entered = vec![json!({"infoHash": "aa"})];
    let survivors = vec![json!({"infoHash": "aa"})];
    assert!(bank.mark_filter_outcome(
        &entered,
        &survivors,
        &BankFilterCtx {
            imdb_id: "tt1".to_string(),
            season: None,
            episode: None,
        },
        now_ms()
    ));
    assert_eq!(bank.marks.lock().unwrap().len(), 1);
}

#[test]
fn hashes_do_indice_e_do_banco_nao_se_misturam() {
    // O hash vindo do item cru é o mesmo formato que o `bank_hash` usa no
    // `liveHashes`.
    let a = crate::raw_item::raw_item_from_value(
        &json!({"infoHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}),
    );
    assert_eq!(a.bank_hash(), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
}

/// Inventário fake para o caminho `account_items` do índice nativo.
struct FakeAccount;

impl AccountInventorySource for FakeAccount {
    fn inventory<'a>(
        &'a self,
        _req: AccountRequest,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<AccountInventory, String>> + Send + 'a>,
    > {
        Box::pin(async {
            Ok(AccountInventory {
                known: true,
                unusable: None,
                items: vec![InventoryItem {
                    title: "Filme 2024 1080p Dublado".to_string(),
                    info_hash: "a".repeat(40),
                    size: 1_000.0,
                    id: None,
                }],
            })
        })
    }
}

#[tokio::test]
async fn conta_entra_no_caminho_do_indice_quando_ha_fonte_nativa() {
    let mut cfg = config();
    cfg.account_fast_path = true;
    cfg.account_inventory_source = true;
    let orch = Orchestrator::new(cfg, Arc::new(MemorySwrStore::new()))
        .with_index_source(Arc::new(FakeIndex::new(Vec::new(), false)))
        .with_account_source(Arc::new(FakeAccount));
    let scan = orch
        .native_index_scan(
            &input(
                "movie",
                json!({"providers": ["jackett"], "debridService": "torbox", "debridApiKey": "k"}),
            ),
            &meta(None, None),
        )
        .await;
    assert_eq!(scan.account_items.len(), 1);
    assert!(scan.account_items[0].from_account);
}

#[tokio::test]
async fn reserva_do_banco_nativo_reinjeta_item_de_indexer_falho() {
    let hash = "b".repeat(40);
    let bank = FakeBank::new(
        vec![InstantWork {
            hash: hash.clone(),
            passed_filter: 1,
            last_seen: now_ms(),
            first_seen: now_ms() - 10,
            magnet: Some(InstantMagnet {
                hash: hash.clone(),
                uri: format!("magnet:?xt=urn:btih:{hash}&dn=Filme.2024.1080p.Dublado"),
                title: "Filme 2024 1080p Dublado".to_string(),
                size: 1_000,
                is_br: true,
                dubbed: true,
                quality: "1080p".to_string(),
                seeders_max: 1,
                seeders_last: 1,
                last_seen: now_ms(),
                lied: false,
            }),
        }],
        sources(&hash),
    );
    let orch = orch(config(), None, Some(bank));
    let mut live = LiveBatchState::default();
    live.failed.insert("bludv".to_string());
    let items = orch
        .with_fallback(
            &input("movie", json!({"providers": ["jackett"]})),
            &meta(None, None),
            Vec::new(),
            Some(&live),
        )
        .await;
    assert_eq!(items.len(), 1);
    assert!(items[0].from_fallback);
    assert_eq!(
        items[0]
            .extra
            .get("fallbackFetchable")
            .and_then(|v| v.as_bool()),
        Some(true)
    );
}
