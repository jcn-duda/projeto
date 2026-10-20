//! Wiring do estado vivo: `CollectBatch.live` → `collect_scoped` → fusão.
//!
//! Cobre o que os testes de unidade de cada peça não provam juntos: o estado
//! que o coletor devolve chega ao `SharedLiveState` da janela (inclusive de
//! lote tardio), e o `merge_fast_with_live` consome o estado FINAL. Também
//! fixa a falha desconhecida (erro de tarefa, sem contrato por indexer) como
//! agregado conservador — nunca "respondeu".

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;

use super::test_support::*;
use crate::cache::{StreamsEntry, SwrStore};
use crate::latest_writer::LatestWriter;
use crate::orchestrator::fast_path::{full_window, merge_fast_with_live};
use crate::orchestrator::finish::{FinishValue, SearchInput};
use crate::orchestrator::live_state::{
    live_state_snapshot, merge_into_shared, shared_live_state, LiveAllState, LiveBatchState,
};
use crate::orchestrator::respond::as_ms;

const BR: &str = "brtest";
const GLOBAL: &str = "globaltest";
const HASH_BR: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_GLOBAL: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HASH_FALLBACK_BR: &str = "cccccccccccccccccccccccccccccccccccccccc";
const HASH_FALLBACK_GLOBAL: &str = "dddddddddddddddddddddddddddddddddddddddd";

fn live(failed: &[&str], pending: &[&str], empty: &[&str], all: LiveAllState) -> LiveBatchState {
    LiveBatchState {
        failed: failed.iter().map(|s| s.to_string()).collect(),
        pending: pending.iter().map(|s| s.to_string()).collect(),
        empty: empty.iter().map(|s| s.to_string()).collect(),
        all,
    }
}

fn raw(title: &str, hash: &str, indexer: &str) -> RawItem {
    RawItem {
        title: Some(title.into()),
        info_hash: Some(hash.into()),
        indexer: Some(indexer.into()),
        ..RawItem::default()
    }
}

fn fallback(title: &str, hash: &str, indexer: &str) -> RawItem {
    let mut item = raw(title, hash, indexer);
    item.from_fallback = true;
    item
}

#[derive(Clone)]
enum Outcome {
    Batch(CollectBatch),
    Fail,
}

/// Coletor de dois grupos (BR × global) com resultado roteirizado.
struct ScopeCollector {
    priority: Outcome,
    global: Outcome,
    global_delay: Duration,
}

impl ScopeCollector {
    fn new(priority: Outcome, global: Outcome) -> Self {
        ScopeCollector {
            priority,
            global,
            global_delay: Duration::ZERO,
        }
    }

    fn slow_global(priority: Outcome, global: Outcome, delay_ms: u64) -> Self {
        ScopeCollector {
            priority,
            global,
            global_delay: Duration::from_millis(delay_ms),
        }
    }
}

impl Collector for ScopeCollector {
    fn collect<'a>(
        &'a self,
        job: CollectJob,
    ) -> Pin<Box<dyn Future<Output = Result<CollectBatch, String>> + Send + 'a>> {
        let outcome = if job.priority {
            self.priority.clone()
        } else {
            self.global.clone()
        };
        let delay = if job.priority {
            Duration::ZERO
        } else {
            self.global_delay
        };
        Box::pin(async move {
            if !delay.is_zero() {
                tokio::time::sleep(delay).await;
            }
            match outcome {
                Outcome::Batch(batch) => Ok(batch),
                Outcome::Fail => Err("coletor do grupo fora do ar".into()),
            }
        })
    }
}

fn batch(items: Vec<RawItem>, partial: bool, live: LiveBatchState) -> CollectBatch {
    CollectBatch {
        items,
        partial,
        live: Some(live),
    }
}

fn input(deadline_ms: i64) -> SearchInput {
    let now = crate::orchestrator::respond::now_ms();
    SearchInput {
        kind: "movie".into(),
        id: "tt0133093".into(),
        encoded: None,
        prefix: String::new(),
        options: json!({}),
        key: "k".into(),
        now_ms: now,
        deadline_at: Some(now + deadline_ms),
    }
}

fn orchestrator(collector: Arc<ScopeCollector>) -> Orchestrator {
    let mut cfg = config();
    cfg.selected_indexers = vec![GLOBAL.into(), BR.into()];
    cfg.pt_br_indexers = vec![BR.into()];
    cfg.sweep_enabled = false;
    Orchestrator::new(cfg, Arc::new(MemorySwrStore::new()))
        .with_collector(collector)
        .with_meta(Arc::new(StubMeta(meta())))
}

fn titles(items: &[RawItem]) -> Vec<&str> {
    items
        .iter()
        .map(|i| i.title.as_deref().unwrap_or(""))
        .collect()
}

/// `CollectBatch.live` do split inteiro chega ao estado e a fusão respeita a
/// falha isolada: a reserva do indexer que caiu fica; a do que respondeu sai.
#[tokio::test]
async fn collect_batch_live_atravessa_collect_scoped_e_merge() {
    let collector = Arc::new(ScopeCollector::new(
        Outcome::Batch(batch(
            vec![raw("br vivo", HASH_BR, BR)],
            false,
            live(&[BR], &[], &[], LiveAllState::Ok),
        )),
        Outcome::Batch(batch(
            vec![raw("global vivo", HASH_GLOBAL, GLOBAL)],
            false,
            live(&[], &[], &[], LiveAllState::Ok),
        )),
    ));
    let orch = orchestrator(collector);

    let (items, partial, completion, failed, shared) =
        orch.collect_scoped(&input(2_000), &meta(), None).await;
    assert!(!partial && !failed, "os dois grupos responderam");
    let live_items = full_window(items, completion).await;
    let state = live_state_snapshot(&shared).expect("estado dos dois lotes");
    assert!(state.failed.contains(BR));
    assert!(!state.failed.contains(GLOBAL), "global respondeu");

    let merged = merge_fast_with_live(
        vec![
            fallback("reserva br", HASH_FALLBACK_BR, BR),
            fallback("reserva global", HASH_FALLBACK_GLOBAL, GLOBAL),
        ],
        live_items,
        failed,
        Some(&state),
    );
    assert_eq!(
        titles(&merged),
        ["reserva br", "br vivo", "global vivo"],
        "falha isolada preserva 📦 do BR; o global que respondeu perde a reserva"
    );
    assert!(merged[0].from_fallback);
}

/// Erro de tarefa no split BR (global OK) e o inverso: sem contrato por
/// indexer, o estado sintetizado é `all=error` e NENHUMA marca some.
#[tokio::test]
async fn split_com_erro_de_tarefa_nao_vira_respondeu() {
    for priority_fails in [true, false] {
        let ok = || {
            Outcome::Batch(batch(
                vec![raw("vivo", HASH_GLOBAL, GLOBAL)],
                false,
                live(&[], &[], &[], LiveAllState::Ok),
            ))
        };
        let collector = Arc::new(if priority_fails {
            ScopeCollector::new(Outcome::Fail, ok())
        } else {
            ScopeCollector::new(
                Outcome::Batch(batch(
                    vec![raw("br vivo", HASH_BR, BR)],
                    false,
                    live(&[], &[], &[], LiveAllState::Ok),
                )),
                Outcome::Fail,
            )
        });
        let orch = orchestrator(collector);

        let (items, _partial, completion, failed, shared) =
            orch.collect_scoped(&input(2_000), &meta(), None).await;
        assert!(!failed, "só um dos dois grupos falhou");
        let live_items = full_window(items, completion).await;
        let state = live_state_snapshot(&shared).expect("falha desconhecida sintetizada");
        assert!(
            state.all.failed(),
            "erro de tarefa sem contrato vira agregado conservador (BR falho: {priority_fails})"
        );
        assert!(
            state.failed.is_empty() && state.pending.is_empty(),
            "sem nomes inventados"
        );

        let merged = merge_fast_with_live(
            vec![
                fallback("reserva br", HASH_FALLBACK_BR, BR),
                fallback("reserva global", HASH_FALLBACK_GLOBAL, GLOBAL),
            ],
            live_items,
            failed,
            Some(&state),
        );
        assert_eq!(merged.len(), 3);
        assert!(merged[0].from_fallback && merged[1].from_fallback);
    }
}

/// Pending e agregado `error`/`pending` também preservam 📦/selos — é o mesmo
/// estado que o Node usa para não limpar reserva.
#[tokio::test]
async fn pending_e_agregado_falho_preservam_marcas_no_wiring() {
    for agregado in [LiveAllState::Error, LiveAllState::Pending] {
        let collector = Arc::new(ScopeCollector::new(
            Outcome::Batch(batch(
                vec![],
                false,
                live(&[], &[BR], &[], LiveAllState::Ok),
            )),
            Outcome::Batch(batch(vec![], false, live(&[], &[], &[], agregado))),
        ));
        let orch = orchestrator(collector);

        let (items, _partial, completion, failed, shared) =
            orch.collect_scoped(&input(2_000), &meta(), None).await;
        let live_items = full_window(items, completion).await;
        let state = live_state_snapshot(&shared).expect("estado");
        let merged = merge_fast_with_live(
            vec![
                fallback("reserva br", HASH_FALLBACK_BR, BR),
                fallback("reserva global", HASH_FALLBACK_GLOBAL, GLOBAL),
            ],
            live_items,
            failed,
            Some(&state),
        );
        assert_eq!(
            titles(&merged),
            ["reserva br", "reserva global"],
            "pending do BR e agregado {agregado:?} mantêm as marcas"
        );
        assert!(merged[0].from_fallback && merged[1].from_fallback);
    }
}

/// Lote TARDIO: o global estoura o orçamento, mas o completion devolve o item
/// e o estado vivo dele para o snapshot FINAL lido após a janela.
#[tokio::test]
async fn item_tardio_entra_no_estado_final() {
    let collector = Arc::new(ScopeCollector::slow_global(
        Outcome::Batch(batch(
            vec![raw("br vivo", HASH_BR, BR)],
            false,
            live(&[BR], &[], &[], LiveAllState::Ok),
        )),
        Outcome::Batch(batch(
            vec![raw("global tardio", HASH_GLOBAL, GLOBAL)],
            false,
            live(&[GLOBAL], &[], &[], LiveAllState::Ok),
        )),
        800,
    ));
    let orch = orchestrator(collector);

    // Orçamento cai no piso de 500ms; o global responde em ~800ms.
    let (items, partial, completion, _failed, shared) =
        orch.collect_scoped(&input(300), &meta(), None).await;
    assert!(partial, "o global ficou fora da janela");
    let live_items = full_window(items, completion).await;
    assert!(
        titles(&live_items).contains(&"global tardio"),
        "o completion entrega o item tardio"
    );

    let state = live_state_snapshot(&shared).expect("estado final");
    assert!(
        state.failed.contains(GLOBAL),
        "o estado do lote tardio entra no snapshot final"
    );
    assert!(
        state.failed.contains(BR),
        "a falha precoce do BR sobrevive ao lote tardio"
    );
}

/// A promoção tardia lê o estado FINAL pós-completion: lista parcial VAZIA com
/// indexer falho não pode virar "completa" (TTL cheio congelaria o vazio).
#[tokio::test]
async fn promote_late_nao_promove_vazio_parcial_com_falha_final() {
    let store = Arc::new(MemorySwrStore::new());
    let orch = Orchestrator::new(config(), store.clone());
    let input = input(2_000);
    let entry = StreamsEntry {
        streams: vec![],
        partial: true,
        debrid_known: Some(true),
        ..StreamsEntry::default()
    };
    store.set(&input.key, &entry, 900, as_ms(input.now_ms));

    let shared = shared_live_state();
    merge_into_shared(&shared, &live(&[GLOBAL], &[], &[], LiveAllState::Ok));
    let first = FinishValue {
        entry: entry.clone(),
        entered: vec![],
        filtered: vec![],
        partial: true,
        debrid_known: true,
        needs_debrid_refresh: false,
        commit_write: true,
        commit_ttl: 900,
        effects: Vec::new(),
    };
    let plan = TailPlan {
        encoded: String::new(),
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
        None,
        Some(shared),
        Arc::new(LatestWriter::new()),
    )
    .await;

    let hit = store
        .get_with_stale(&input.key, 0, as_ms(input.now_ms))
        .expect("entrada preservada");
    assert!(
        hit.value.partial,
        "vazio parcial com falha viva não pode ser promovido a completo"
    );
}
