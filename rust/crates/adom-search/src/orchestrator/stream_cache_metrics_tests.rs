//! Contadores `stream.cache.*`: forma local e fiação no caminho do usuário.
//!
//! O global é POR PROCESSO e todos os testes do binário o compartilham em
//! paralelo (cada `handle`/`finish` dos vizinhos incrementa também) — valor
//! absoluto não é afirmável. A régua é o DELTA: o cenário garante o
//! incremento na chave certa, e o ruído dos paralelos só soma.

use std::sync::Arc;

use crate::cache::{MemorySwrStore, StreamsEntry};
use crate::contract::StreamItem;
use crate::latest_writer::LatestWriter;

use super::super::finish::SearchInput;
use super::*;

use crate::orchestrator::tests::test_support::*;

const OBRA: &str = "tt0133093";
const NOW: i64 = 1_000_000;

fn count(key: &str) -> u64 {
    global_metrics().get(key)
}

/// Mesmo molde de `fence_tests::orchestration`.
fn orchestration(store: Arc<MemorySwrStore>) -> Orchestrator {
    Orchestrator::new(config(), store)
        .with_collector(StubCollector::with(vec![item(HASH)]))
        .with_meta(Arc::new(StubMeta(meta())))
        .with_debrid(Arc::new(StubDebrid {
            cached: vec![HASH.to_string()],
        }))
}

fn cache_key() -> String {
    adom_core::streams_cache_key("movie", OBRA, &options())
}

fn input(store: &MemorySwrStore) -> SearchInput {
    SearchInput {
        kind: "movie".into(),
        id: OBRA.into(),
        encoded: Some(SEGMENT.into()),
        prefix: format!("/{SEGMENT}"),
        options: options(),
        key: cache_key(),
        now_ms: NOW,
        deadline_at: None,
        fence: store.fence_for_key(&cache_key()),
    }
}

// ── Forma local (mesmo molde de index_metrics_tests) ────────────────────────

#[test]
fn snapshot_expoe_as_quatro_chaves_zeradas() {
    let metrics = StreamCacheMetrics::new();
    let snapshot = metrics.snapshot();
    for key in [HIT, STALE_SERVED, MISS, WRITE] {
        assert_eq!(snapshot.get(key), Some(&0), "{key} zerada no snapshot");
    }
    assert_eq!(snapshot.len(), KEYS.len());
}

#[test]
fn incrementa_e_satura() {
    let metrics = StreamCacheMetrics::new();
    metrics.inc(MISS, 2);
    metrics.inc(MISS, 0);
    assert_eq!(metrics.get(MISS), 2);
    metrics.inc(MISS, u64::MAX);
    assert_eq!(metrics.get(MISS), u64::MAX);
}

#[test]
fn hit_rate_null_sem_consulta_e_fracao_servida_com_consulta() {
    let metrics = StreamCacheMetrics::new();
    assert_eq!(hit_rate(&metrics.snapshot()), None, "sem consulta: null");
    // 4 servidos (3 hits + 1 stale) de 5 consultas = 0.8.
    metrics.inc(HIT, 3);
    metrics.inc(STALE_SERVED, 1);
    metrics.inc(MISS, 1);
    let rate = hit_rate(&metrics.snapshot()).expect("com consulta tem taxa");
    assert!((rate - 0.8).abs() < 1e-9, "taxa: {rate}");
}

// ── Fiação da rota (`route.rs::handle`) ─────────────────────────────────────

#[tokio::test]
async fn miss_na_rota_incrementa_contador() {
    let store = Arc::new(MemorySwrStore::new());
    let orch = orchestration(store);
    let before = count(MISS);
    let _ = orch.handle(request(NOW)).await;
    assert!(count(MISS) > before, "miss tem que crescer");
}

#[tokio::test]
async fn hit_fresco_incrementa_hit() {
    let store = Arc::new(MemorySwrStore::new());
    let orch = orchestration(store);
    // 1ª abertura popula o cache (miss); a 2ª é o hit fresco.
    let _ = orch.handle(request(NOW)).await;
    let before = count(HIT);
    let _ = orch.handle(request(NOW)).await;
    assert!(count(HIT) > before, "hit fresco tem que crescer");
}

#[tokio::test]
async fn hit_stale_na_graca_incrementa_stale_served() {
    let store = Arc::new(MemorySwrStore::new());
    let orch = orchestration(store);
    let _ = orch.handle(request(NOW)).await;
    let before = count(STALE_SERVED);
    // TTL 900s da lista completa: 901,5s depois está expirada DENTRO da graça
    // de 300s — serve na hora e sinaliza revalidação (mesmo cenário do
    // `hit_stale_serve_e_revalida_em_fundo`).
    let _ = orch.handle(request(NOW + 901_500)).await;
    assert!(
        count(STALE_SERVED) > before,
        "stale servido tem que crescer"
    );
}

// ── Escritas (`finish.rs` e promoção tardia) ────────────────────────────────

#[test]
fn commit_gravado_incrementa_write() {
    let store = Arc::new(MemorySwrStore::new());
    let orch = orchestration(store.clone());
    let before = count(WRITE);

    let writer = LatestWriter::new();
    let phase = writer.phase();
    let _ = orch.finish(
        &input(&store),
        &meta(),
        &writer,
        phase,
        &[item(HASH)],
        false,
        None,
    );

    assert!(count(WRITE) > before, "commit gravado é 1 write");
}

#[test]
fn promocao_tardia_gravada_incrementa_write() {
    let store = Arc::new(MemorySwrStore::new());
    // Entrada parcial com stream e debrid conferido: a decisão do núcleo
    // PROMOVE (mesma entrada de `fence_tests::parcial`).
    store.set(
        &cache_key(),
        &StreamsEntry {
            streams: vec![StreamItem {
                url: Some(format!("/{SEGMENT}/resolve/{HASH}")),
                ..StreamItem::default()
            }],
            partial: true,
            debrid_known: Some(true),
            ..StreamsEntry::default()
        },
        900,
        NOW as u64,
    );
    let orch = orchestration(store.clone());
    let before = count(WRITE);

    orch.promote_late(&input(&store), None);

    assert!(count(WRITE) > before, "promoção gravada é 1 write");
}
