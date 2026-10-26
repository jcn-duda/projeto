//! T1-C2: a busca captura a geração da obra na LEITURA e só grava com ela.
//!
//! O que estes testes fixam (a 5H no caminho quente):
//!
//! - a invalidação que chega **durante** a busca não é perdida: a lista
//!   coletada não vai para o cache (`set_fenced` devolve `false`), mas a
//!   resposta da requisição em curso continua saindo;
//! - a promoção tardia de uma entrada lida ANTES de uma invalidação também é
//!   descartada — é a mesma corrida, só que no fim da busca.
//!
//! Nada de `sleep`/timing: quem cria a corrida é um `SwrStore` de teste que
//! invalida a obra entre a leitura e a escrita.

use std::sync::Arc;

use crate::cache::{Fence, MemorySwrStore, StoreHit, StreamsEntry, SwrStore};
use crate::contract::StreamItem;
use crate::latest_writer::LatestWriter;

use super::finish::SearchInput;
use super::tests::test_support::*;

const OBRA: &str = "tt0133093";
const NOW: i64 = 1_000_000;

fn cache_key() -> String {
    adom_core::streams_cache_key("movie", OBRA, &options())
}

fn input(fence: Fence) -> SearchInput {
    SearchInput {
        kind: "movie".into(),
        id: OBRA.into(),
        encoded: Some(SEGMENT.into()),
        prefix: format!("/{SEGMENT}"),
        options: options(),
        key: cache_key(),
        now_ms: NOW,
        deadline_at: None,
        fence,
    }
}

fn orchestration(store: Arc<dyn SwrStore>) -> Orchestrator {
    Orchestrator::new(config(), store)
        .with_collector(StubCollector::with(vec![item(HASH)]))
        .with_meta(Arc::new(StubMeta(meta())))
        .with_debrid(Arc::new(StubDebrid {
            cached: vec![HASH.to_string()],
        }))
}

fn parcial() -> StreamsEntry {
    StreamsEntry {
        streams: vec![StreamItem {
            url: Some(format!("/{SEGMENT}/resolve/{HASH}")),
            ..StreamItem::default()
        }],
        partial: true,
        debrid_known: Some(true),
        ..StreamsEntry::default()
    }
}

// ── Commit da passada ───────────────────────────────────────────────────────

#[test]
fn commit_descartado_quando_a_obra_e_invalidada_durante_a_busca() {
    let store = Arc::new(MemorySwrStore::new());
    let orch = orchestration(store.clone());
    // Captura no instante da leitura (o que `route.rs` faz antes de coletar).
    let input = input(store.fence_for_key(&cache_key()));
    // O operador invalida a obra enquanto a coleta corre.
    store.invalidate_for_obra(OBRA);

    let writer = LatestWriter::new();
    let phase = writer.phase();
    let value = orch.finish(&input, &meta(), &writer, phase, &[item(HASH)], false, None);

    assert!(
        !value.entry.streams.is_empty(),
        "a resposta da requisição em curso continua saindo"
    );
    assert!(
        store.get_with_stale(&input.key, 0, NOW as u64).is_none(),
        "lista de geração anterior não pode ficar em cache"
    );
}

#[test]
fn commit_grava_quando_ninguem_invalidou_a_obra() {
    let store = Arc::new(MemorySwrStore::new());
    let orch = orchestration(store.clone());
    let input = input(store.fence_for_key(&cache_key()));

    let writer = LatestWriter::new();
    let phase = writer.phase();
    let _ = orch.finish(&input, &meta(), &writer, phase, &[item(HASH)], false, None);

    let hit = store
        .get_with_stale(&input.key, 0, NOW as u64)
        .expect("lista completa gravada");
    assert_eq!(hit.value.streams.len(), 1);
}

// ── Promoção tardia ─────────────────────────────────────────────────────────

/// `SwrStore` que injeta a invalidação EXATAMENTE entre a leitura e a escrita:
/// é a corrida que a fence existe para pegar (um `clear-cache` caindo no meio
/// do tail). Devolve a fence LIDA — velha — de propósito.
struct RaceStore {
    inner: MemorySwrStore,
    obra: &'static str,
}

impl SwrStore for RaceStore {
    fn get_with_stale(&self, key: &str, grace_seconds: u64, now_ms: u64) -> Option<StoreHit> {
        self.inner.get_with_stale(key, grace_seconds, now_ms)
    }

    fn set(&self, key: &str, value: &StreamsEntry, ttl_seconds: u64, now_ms: u64) {
        self.inner.set(key, value, ttl_seconds, now_ms);
    }

    fn forget(&self, key: &str) {
        self.inner.forget(key);
    }

    fn len(&self) -> usize {
        self.inner.len()
    }

    fn fence_for_key(&self, key: &str) -> Fence {
        self.inner.fence_for_key(key)
    }

    fn get_fenced(&self, key: &str, grace_seconds: u64, now_ms: u64) -> (Option<StoreHit>, Fence) {
        let lido = self.inner.get_fenced(key, grace_seconds, now_ms);
        self.inner.invalidate_for_obra(self.obra);
        lido
    }

    fn set_fenced(
        &self,
        key: &str,
        value: &StreamsEntry,
        ttl_seconds: u64,
        now_ms: u64,
        fence: Fence,
    ) -> bool {
        self.inner
            .set_fenced(key, value, ttl_seconds, now_ms, fence)
    }
}

#[test]
fn promocao_tardia_nao_grava_lista_de_geracao_anterior() {
    let store = Arc::new(RaceStore {
        inner: MemorySwrStore::new(),
        obra: OBRA,
    });
    store.inner.set(&cache_key(), &parcial(), 900, NOW as u64);
    let orch = orchestration(store.clone());

    orch.promote_late(&input(Fence::default()), None);

    assert_eq!(
        store.inner.len(),
        0,
        "promover uma entrada lida antes da invalidação ressuscitaria a lista velha"
    );
}
