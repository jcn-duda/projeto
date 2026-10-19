//! Wiring da reserva 📦: a rota interna de banco é chamada em TODA build
//! relevante e só quando o estado vivo pede (falha/pending/suspeito). Cobre a
//! primeira resposta e a reconstrução tardia com o estado FINAL — o ponto que
//! o `collectFallbackForBuild` do Node garante e que não pode ser “uma vez só
//! antes de assentar”.

use std::sync::Arc;
use std::time::{Duration, Instant};

use super::fallback_support::*;
use super::test_support::*;
use crate::cache::StreamsEntry;
use crate::latest_writer::LatestWriter;
use crate::orchestrator::finish::{release_entry, FinishValue, SearchInput};
use crate::orchestrator::live_state::{merge_into_shared, shared_live_state};
use crate::orchestrator::tail::TailPlan;

#[tokio::test]
async fn tail_reconstroi_com_estado_final_e_reinjeta_a_reserva() {
    let store = Arc::new(MemorySwrStore::new());
    let routes = FallbackRoutes::new(fallback_response());
    let orch = Orchestrator::new(config(), store.clone())
        .with_collector(StubCollector::empty())
        .with_meta(Arc::new(StubMeta(meta())))
        .with_debrid(Arc::new(StubDebrid {
            cached: vec![HASH.into(), FALLBACK_HASH.into()],
        }))
        .with_internal_routes(routes.clone());

    let input = SearchInput {
        kind: "movie".into(),
        id: "tt0133093".into(),
        encoded: Some(SEGMENT.into()),
        prefix: String::new(),
        options: options(),
        key: "fallback-wiring".into(),
        now_ms: 1_000_000,
        deadline_at: None,
    };
    let shared = shared_live_state();
    merge_into_shared(&shared, &live(&["bludv"], &["pendente"], &[]));
    let first = FinishValue {
        entry: StreamsEntry::default(),
        entered: vec![],
        filtered: vec![],
        partial: true,
        debrid_known: true,
        needs_debrid_refresh: false,
        commit_write: false,
        commit_ttl: 0,
    };
    let completion = Some(tokio::spawn(async { vec![item(HASH)] }));
    let plan = TailPlan {
        encoded: SEGMENT.into(),
        meta: meta(),
        jobs: vec![],
    };

    orch.run_tail(
        input.clone(),
        meta(),
        first,
        vec![],
        true,
        plan,
        completion,
        Some(shared),
        Arc::new(LatestWriter::new()),
    )
    .await;

    let calls = routes.calls();
    assert_eq!(calls.len(), 1, "o tail também consulta a reserva");
    assert!(calls[0].failed.contains("bludv"));
    assert!(calls[0].failed.contains("pendente"));
    assert!(
        calls[0].live_hashes.contains(HASH),
        "o lote tardio entra no liveHashes"
    );

    let hit = store
        .get_with_stale(
            &input.key,
            0,
            crate::orchestrator::respond::as_ms(input.now_ms),
        )
        .expect("a build tardia precisa gravar");
    assert!(
        hit.value.streams.iter().any(|stream| stream
            .title
            .as_deref()
            .unwrap_or("")
            .contains("(Banco)")),
        "a lista regravada pelo tail precisa carregar a reserva"
    );
}

#[tokio::test]
async fn reserva_lenta_e_cortada_no_prazo_e_devolve_o_lote_vivo() {
    let routes = SlowFallbackRoutes::new(Duration::from_secs(5));
    let orch = Orchestrator::new(config(), Arc::new(MemorySwrStore::new()))
        .with_collector(StubCollector::empty())
        .with_meta(Arc::new(StubMeta(meta())))
        .with_debrid(Arc::new(StubDebrid { cached: vec![] }))
        .with_internal_routes(routes.clone());
    let now = wall_now_ms();
    let input = SearchInput {
        kind: "movie".into(),
        id: "tt0133093".into(),
        encoded: Some(SEGMENT.into()),
        prefix: String::new(),
        options: options(),
        key: "fallback-slow".into(),
        now_ms: now,
        // 700ms restantes → teto interno ~450ms (margem de 250ms).
        deadline_at: Some(now + 700),
    };
    let started = Instant::now();
    let out = orch
        .with_fallback(
            &input,
            &meta(),
            vec![item(HASH)],
            Some(&live(&["bludv"], &[], &[])),
        )
        .await;
    let elapsed = started.elapsed();
    assert_eq!(routes.calls(), 1, "a rota foi chamada e cortada");
    assert_eq!(out.len(), 1, "o lote vivo não pode ser perdido");
    assert_eq!(out[0].hash(), HASH);
    assert!(
        elapsed < Duration::from_secs(2),
        "a reserva não pode consumir o prazo: {elapsed:?}"
    );
}

#[tokio::test]
async fn reserva_lenta_nao_rouba_a_primeira_resposta() {
    let mut cfg = config();
    // Janela curta: a rota da reserva atrasada não pode transformar uma
    // resposta útil no aviso "Procurando fontes".
    cfg.stremio_reply_ms = 600;
    cfg.app_reply_ms = 600;
    let routes = SlowFallbackRoutes::new(Duration::from_secs(5));
    let orch = Orchestrator::new(cfg, Arc::new(MemorySwrStore::new()))
        .with_collector(Arc::new(LiveCollector {
            items: vec![item(HASH)],
            live: live(&["bludv"], &[], &[]),
        }))
        .with_meta(Arc::new(StubMeta(meta())))
        .with_debrid(Arc::new(StubDebrid {
            cached: vec![HASH.into()],
        }))
        .with_internal_routes(routes.clone());
    let response = orch.handle(request(wall_now_ms())).await;
    assert!(
        response.streams.iter().any(|stream| stream
            .title
            .as_deref()
            .unwrap_or("")
            .contains("Filme Teste")),
        "a resposta viva tem que sair, mesmo com a reserva lenta: {:?}",
        response.streams
    );
    assert!(
        !response
            .streams
            .iter()
            .any(|stream| stream.external_url.is_some()),
        "a reserva lenta não pode virar aviso: {:?}",
        response.streams
    );
    assert_eq!(routes.calls(), 1, "a reserva foi tentada");
}

#[test]
fn release_entry_nao_persiste_a_reserva_do_banco() {
    let vivo = item(HASH);
    let mut reserva = item(FALLBACK_HASH);
    reserva.from_fallback = true;
    let entry = release_entry(
        &meta(),
        &[vivo.clone(), reserva.clone()],
        &[vivo.clone(), reserva],
    );
    assert_eq!(entry.items.len(), 1, "só o lote vivo alimenta o índice");
    assert_eq!(
        entry.items[0].get("infoHash").and_then(|v| v.as_str()),
        Some(HASH)
    );
    let entered = entry.entered.as_ref().expect("entered");
    let survivors = entry.survivors.as_ref().expect("survivors");
    assert_eq!(entered.len(), 1);
    assert_eq!(survivors.len(), 1);
    for value in entry.items.iter().chain(entered).chain(survivors) {
        assert!(
            value.get("fromFallback").is_none(),
            "a reserva não pode se auto-perpetuar no índice: {value}"
        );
    }
}
