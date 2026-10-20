//! Testes da IDENTIDADE do coletor nativo do Torrentio — o objeto que
//! `mapStream` publica no Node. Matriz do `live` em
//! `torrentio_collector_live_tests.rs`; breaker e não-consultas em
//! `torrentio_collector_breaker_tests.rs`.

use std::collections::BTreeSet;

use serde_json::json;

use super::test_support::*;
use super::*;
use crate::orchestrator::live_state::LiveAllState;
use crate::orchestrator::sources_rust::sources_rust_csv_includes;

#[test]
fn token_torrentio_no_csv() {
    assert!(sources_rust_csv_includes("torrentio", "torrentio"));
    assert!(sources_rust_csv_includes("jackett,torrentio", "torrentio"));
    assert!(!sources_rust_csv_includes("jackett", "torrentio"));
}

/// `indexer:"torrentio"` (agregador), `tracker` do ⚙️, hash minúsculo,
/// título/seeders/tamanho do payload e `fileIdx` preservado — o mesmo objeto
/// que `mapStream` devolve no Node.
#[test]
fn mapa_preserva_identidade_do_node() {
    let raw = raw_from_torrentio(TorrentioRawItem {
        title: "The Matrix 1999 1080p".into(),
        info_hash: "ABCDEF0123456789ABCDEF0123456789ABCDEF01".into(),
        seeders: 1234.0,
        size: Some((2.4 * 1024.0_f64.powi(3)).round()),
        tracker: Some(" Torrentio ".into()),
        indexer: "torrentio".into(),
        file_idx: Some(2),
    });
    assert_eq!(raw.indexer.as_deref(), Some("torrentio"));
    assert_eq!(raw.tracker.as_deref(), Some("Torrentio"));
    assert_eq!(raw.sources, vec!["tracker:Torrentio".to_string()]);
    assert_eq!(
        raw.hash(),
        "abcdef0123456789abcdef0123456789abcdef01",
        "hash do infoHash em minúsculas"
    );
    assert_eq!(raw.title_text(), "The Matrix 1999 1080p");
    assert_eq!(raw.seeders, Some(1234.0));
    assert_eq!(raw.size_bytes, Some((2.4 * 1024.0_f64.powi(3)).round()));
    assert_eq!(raw.extra.get("fileIdx"), Some(&json!(2)));
    // Áudio NÃO vem do provider: `torrentio.ts` não marca `isBr`; o chip sai do
    // título no build (`looksPtBr`), como nos demais indexers globais.
    assert!(!raw.is_br, "Torrentio não marca isBr");
}

/// Sem a linha `👤 … ⚙️` o Node deixa `tracker` vazio e o `⚙️` cai no
/// `indexer` ("torrentio"). O nativo guarda `None` e o `display_tracker` faz
/// a mesma queda.
#[test]
fn mapa_sem_fonte_nao_inventa_tracker() {
    let raw = raw_from_torrentio(TorrentioRawItem {
        title: "Sem metadados".into(),
        info_hash: HASH_B.into(),
        seeders: 0.0,
        size: None,
        tracker: Some("   ".into()),
        indexer: "torrentio".into(),
        file_idx: None,
    });
    assert_eq!(raw.tracker, None);
    assert!(raw.sources.is_empty());
    assert_eq!(raw.seeders, Some(0.0), "seeders ?? 0 do TS");
    assert_eq!(raw.size_bytes, None);
    assert!(!raw.extra.contains_key("fileIdx"));
    assert_eq!(raw.indexer.as_deref(), Some("torrentio"));
}

/// Tamanho segue a régua `known_size` do item cru do Node: 1 KB sentinela e
/// tamanho implausível viram "desconhecido".
#[test]
fn mapa_limpa_tamanho_sentinela_como_o_node() {
    let small = raw_from_torrentio(TorrentioRawItem {
        title: "x".into(),
        info_hash: HASH_A.into(),
        seeders: 1.0,
        size: Some(1024.0),
        tracker: None,
        indexer: "torrentio".into(),
        file_idx: None,
    });
    assert_eq!(small.size_bytes, None, "1 KB não é tamanho de vídeo");
    let big = raw_from_torrentio(TorrentioRawItem {
        title: "x".into(),
        info_hash: HASH_A.into(),
        seeders: 1.0,
        size: Some(600.0 * 1024.0_f64.powi(3)),
        tracker: None,
        indexer: "torrentio".into(),
        file_idx: None,
    });
    assert_eq!(big.size_bytes, None, "tamanho implausível é desconhecido");
}

#[test]
fn serie_sem_se_nao_monta_args() {
    let job = CollectJob {
        kind: "series".into(),
        season: None,
        episode: Some(1),
        ..base_job()
    };
    assert!(search_args_from_job(&job).is_none());
}

#[test]
fn serie_monta_args_com_se() {
    let job = CollectJob {
        kind: "series".into(),
        imdb_id: "tt0944947".into(),
        season: Some(3),
        episode: Some(1),
        ..base_job()
    };
    let args = search_args_from_job(&job).expect("args");
    assert_eq!(args.media_type, TorrentioMediaType::Series);
    assert_eq!(args.season, Some(3));
    assert_eq!(args.episode, Some(1));
}

#[test]
fn live_falha_e_vazio_sao_por_fonte_e_nunca_pending() {
    let failed = live_failed();
    assert_eq!(
        failed.failed,
        BTreeSet::from([TORRENTIO_LIVE_KEY.to_string()])
    );
    assert!(failed.pending.is_empty(), "nunca inventa pending");
    assert_eq!(failed.all, LiveAllState::Unknown);

    let empty = live_empty();
    assert!(empty.failed.is_empty());
    assert_eq!(
        empty.empty,
        BTreeSet::from([TORRENTIO_LIVE_KEY.to_string()])
    );
    assert_eq!(empty.all, LiveAllState::Unknown);
    assert!(empty.needs_fallback(), "vazio suspeito pede o banco");
    assert!(
        !empty.has_any_failure(),
        "vazio suspeito não é falha provada"
    );

    let ok = live_ok();
    assert!(ok.failed.is_empty() && ok.empty.is_empty() && ok.pending.is_empty());
    assert_eq!(ok.all, LiveAllState::Unknown);
}
