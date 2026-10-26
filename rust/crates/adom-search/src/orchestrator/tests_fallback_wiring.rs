//! Wiring da reserva 📦: o banco NATIVO é consultado em TODA build relevante
//! e só quando o estado vivo pede (falha/pending/suspeito). Cobre a primeira
//! resposta e a reconstrução tardia com o estado FINAL — o ponto que o
//! `collectFallbackForBuild` do Node garante e que não pode ser “uma vez só
//! antes de assentar”.

use std::sync::Arc;

use super::fallback_support::*;
use super::test_support::*;
use crate::orchestrator::finish::SearchInput;

#[tokio::test]
async fn primeira_resposta_reinjeta_reserva_do_indexer_falho() {
    let store = Arc::new(MemorySwrStore::new());
    let bank = fallback_bank();
    // A instantânea da via rápida também lê o banco; aqui o alvo é a leitura
    // da RESERVA no fallback, então ela fica desligada.
    let mut cfg = config();
    cfg.magnet_bank_instant_enabled = false;
    let orch = Orchestrator::new(cfg, store)
        .with_collector(Arc::new(LiveCollector {
            items: vec![item(HASH)],
            live: live(&["bludv"], &[], &[]),
        }))
        .with_meta(Arc::new(StubMeta(meta())))
        .with_debrid(Arc::new(StubDebrid {
            cached: vec![HASH.into(), FALLBACK_HASH.into()],
        }))
        .with_bank_source(bank.clone());

    let response = orch.handle(request(wall_now_ms())).await;
    let titles: Vec<&str> = response
        .streams
        .iter()
        .filter_map(|stream| stream.title.as_deref())
        .collect();
    assert!(
        titles.iter().any(|title| title.contains("(Banco)")),
        "a reserva 📦 precisa entrar na primeira resposta: {titles:?}"
    );
    assert_eq!(bank.reads(), 1, "uma leitura por build");
}

#[tokio::test]
async fn raw_item_da_reserva_preserva_flags_no_extra() {
    let orch = Orchestrator::new(config(), Arc::new(MemorySwrStore::new()))
        .with_collector(StubCollector::empty())
        .with_meta(Arc::new(StubMeta(meta())))
        .with_debrid(Arc::new(StubDebrid { cached: vec![] }))
        .with_bank_source(fallback_bank());

    let input = SearchInput {
        kind: "movie".into(),
        id: "tt0133093".into(),
        encoded: Some(SEGMENT.into()),
        prefix: String::new(),
        options: options(),
        key: "fallback-wire".into(),
        now_ms: 1_000_000,
        deadline_at: None,
        fence: Default::default(),
    };
    let items = orch
        .with_fallback(&input, &meta(), vec![], Some(&live(&["bludv"], &[], &[])))
        .await;

    assert_eq!(items.len(), 1, "o banco devolve uma reserva elegível");
    let item = &items[0];
    assert!(item.from_fallback);
    assert_eq!(
        item.extra
            .get("fallbackFetchable")
            .and_then(|v| v.as_bool()),
        Some(true),
        "o construtor dedicado não pode zerar o extra das flags"
    );
    assert_eq!(
        item.extra.get("dubbed").and_then(|v| v.as_bool()),
        Some(true)
    );
    assert_eq!(
        item.extra.get("quality").and_then(|v| v.as_str()),
        Some("1080p")
    );
}

#[tokio::test]
async fn sem_falha_nao_consulta_o_banco() {
    let bank = fallback_bank();
    let mut cfg = config();
    cfg.magnet_bank_instant_enabled = false;
    let orch = Orchestrator::new(cfg, Arc::new(MemorySwrStore::new()))
        .with_collector(StubCollector::with(vec![item(HASH)]))
        .with_meta(Arc::new(StubMeta(meta())))
        .with_debrid(Arc::new(StubDebrid {
            cached: vec![HASH.into()],
        }))
        .with_bank_source(bank.clone());

    orch.handle(request(1_000_000)).await;
    assert_eq!(
        bank.reads(),
        0,
        "sem estado vivo que peça reserva, o banco nem é lido"
    );
}

#[tokio::test]
async fn banco_ausente_mantem_o_lote_vivo() {
    let orch = Orchestrator::new(config(), Arc::new(MemorySwrStore::new()))
        .with_collector(StubCollector::empty())
        .with_meta(Arc::new(StubMeta(meta())))
        .with_debrid(Arc::new(StubDebrid { cached: vec![] }));
    let input = SearchInput {
        kind: "movie".into(),
        id: "tt0133093".into(),
        encoded: Some(SEGMENT.into()),
        prefix: String::new(),
        options: options(),
        key: "fallback-missing".into(),
        now_ms: wall_now_ms(),
        deadline_at: None,
        fence: Default::default(),
    };
    let out = orch
        .with_fallback(
            &input,
            &meta(),
            vec![item(HASH)],
            Some(&live(&["bludv"], &[], &[])),
        )
        .await;
    assert_eq!(out.len(), 1, "sem banco aberto é degradação, não perda");
    assert_eq!(out[0].hash(), HASH);
}

#[tokio::test]
async fn banco_sem_linhas_mantem_o_lote_vivo() {
    let bank = Arc::new(StubBank::default());
    let orch = Orchestrator::new(config(), Arc::new(MemorySwrStore::new()))
        .with_collector(StubCollector::empty())
        .with_meta(Arc::new(StubMeta(meta())))
        .with_debrid(Arc::new(StubDebrid { cached: vec![] }))
        .with_bank_source(bank.clone());
    let input = SearchInput {
        kind: "movie".into(),
        id: "tt0133093".into(),
        encoded: Some(SEGMENT.into()),
        prefix: String::new(),
        options: options(),
        key: "fallback-empty".into(),
        now_ms: wall_now_ms(),
        deadline_at: None,
        fence: Default::default(),
    };
    let out = orch
        .with_fallback(
            &input,
            &meta(),
            vec![item(HASH)],
            Some(&live(&["bludv"], &[], &[])),
        )
        .await;
    assert_eq!(out.len(), 1, "banco vazio é fail-open");
    assert_eq!(out[0].hash(), HASH);
    assert_eq!(
        bank.reads(),
        1,
        "a leitura aconteceu, só não rendeu reserva"
    );
}
