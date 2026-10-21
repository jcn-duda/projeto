//! Wiring da reserva 📦 no passe tardio: o banco NATIVO é lido em TODA build
//! relevante e só quando o estado vivo pede (falha/pending/suspeito). Cobre a
//! reconstrução tardia com o estado FINAL — o ponto que o
//! `collectFallbackForBuild` do Node garante e que não pode ser “uma vez só
//! antes de assentar”.

use std::sync::Arc;

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
    let bank = fallback_bank();
    let orch = Orchestrator::new(config(), store.clone())
        .with_collector(StubCollector::empty())
        .with_meta(Arc::new(StubMeta(meta())))
        .with_debrid(Arc::new(StubDebrid {
            cached: vec![HASH.into(), FALLBACK_HASH.into()],
        }))
        .with_bank_source(bank.clone());

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
        effects: Vec::new(),
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

    assert_eq!(bank.reads(), 1, "o tail também lê a reserva");

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
