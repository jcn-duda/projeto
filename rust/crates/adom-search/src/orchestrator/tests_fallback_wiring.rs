//! Wiring da reserva 📦: a rota interna de banco é chamada em TODA build
//! relevante e só quando o estado vivo pede (falha/pending/suspeito). Cobre a
//! primeira resposta e a reconstrução tardia com o estado FINAL — o ponto que
//! o `collectFallbackForBuild` do Node garante e que não pode ser “uma vez só
//! antes de assentar”.

use std::sync::Arc;

use super::fallback_support::*;
use super::test_support::*;
use crate::orchestrator::finish::SearchInput;

#[tokio::test]
async fn primeira_resposta_reinjeta_reserva_do_indexer_falho() {
    let store = Arc::new(MemorySwrStore::new());
    let routes = FallbackRoutes::new(fallback_response());
    let orch = Orchestrator::new(config(), store)
        .with_collector(Arc::new(LiveCollector {
            items: vec![item(HASH)],
            live: live(&["bludv"], &[], &[]),
        }))
        .with_meta(Arc::new(StubMeta(meta())))
        .with_debrid(Arc::new(StubDebrid {
            cached: vec![HASH.into(), FALLBACK_HASH.into()],
        }))
        .with_internal_routes(routes.clone());

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

    let calls = routes.calls();
    assert_eq!(calls.len(), 1, "uma consulta por build");
    assert!(calls[0].failed.contains("bludv"));
    assert!(
        calls[0].live_hashes.contains(HASH),
        "o hash vivo precisa ir como exclusão"
    );
}

#[tokio::test]
async fn raw_item_da_reserva_preserva_flags_no_extra() {
    let routes = FallbackRoutes::new(fallback_response());
    let orch = Orchestrator::new(config(), Arc::new(MemorySwrStore::new()))
        .with_collector(StubCollector::empty())
        .with_meta(Arc::new(StubMeta(meta())))
        .with_debrid(Arc::new(StubDebrid { cached: vec![] }))
        .with_internal_routes(routes);

    let input = SearchInput {
        kind: "movie".into(),
        id: "tt0133093".into(),
        encoded: Some(SEGMENT.into()),
        prefix: String::new(),
        options: options(),
        key: "fallback-wire".into(),
        now_ms: 1_000_000,
        deadline_at: None,
    };
    let items = orch
        .with_fallback(&input, &meta(), vec![], Some(&live(&["bludv"], &[], &[])))
        .await;

    assert_eq!(items.len(), 1, "a rota devolve uma reserva elegível");
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
async fn sem_falha_nao_consulta_a_rota_de_banco() {
    let routes = FallbackRoutes::new(fallback_response());
    let orch = Orchestrator::new(config(), Arc::new(MemorySwrStore::new()))
        .with_collector(StubCollector::with(vec![item(HASH)]))
        .with_meta(Arc::new(StubMeta(meta())))
        .with_debrid(Arc::new(StubDebrid {
            cached: vec![HASH.into()],
        }))
        .with_internal_routes(routes.clone());

    orch.handle(request(1_000_000)).await;
    assert!(
        routes.calls().is_empty(),
        "sem estado vivo que peça reserva, a rota nem é chamada"
    );
}

#[tokio::test]
async fn rota_com_erro_mantem_o_lote_vivo() {
    let routes = FallbackRoutes::failing("banco fora");
    let orch = Orchestrator::new(config(), Arc::new(MemorySwrStore::new()))
        .with_collector(StubCollector::empty())
        .with_meta(Arc::new(StubMeta(meta())))
        .with_debrid(Arc::new(StubDebrid { cached: vec![] }))
        .with_internal_routes(routes.clone());
    let input = SearchInput {
        kind: "movie".into(),
        id: "tt0133093".into(),
        encoded: Some(SEGMENT.into()),
        prefix: String::new(),
        options: options(),
        key: "fallback-error".into(),
        now_ms: wall_now_ms(),
        deadline_at: None,
    };
    let out = orch
        .with_fallback(
            &input,
            &meta(),
            vec![item(HASH)],
            Some(&live(&["bludv"], &[], &[])),
        )
        .await;
    assert_eq!(out.len(), 1, "erro da rota é fail-open");
    assert_eq!(out[0].hash(), HASH);
}

#[tokio::test]
async fn rota_ok_false_mantem_o_lote_vivo() {
    let routes = FallbackRoutes::not_ok();
    let orch = Orchestrator::new(config(), Arc::new(MemorySwrStore::new()))
        .with_collector(StubCollector::empty())
        .with_meta(Arc::new(StubMeta(meta())))
        .with_debrid(Arc::new(StubDebrid { cached: vec![] }))
        .with_internal_routes(routes);
    let input = SearchInput {
        kind: "movie".into(),
        id: "tt0133093".into(),
        encoded: Some(SEGMENT.into()),
        prefix: String::new(),
        options: options(),
        key: "fallback-not-ok".into(),
        now_ms: wall_now_ms(),
        deadline_at: None,
    };
    let out = orch
        .with_fallback(
            &input,
            &meta(),
            vec![item(HASH)],
            Some(&live(&["bludv"], &[], &[])),
        )
        .await;
    assert_eq!(out.len(), 1, "ok:false também é fail-open");
    assert_eq!(out[0].hash(), HASH);
}
