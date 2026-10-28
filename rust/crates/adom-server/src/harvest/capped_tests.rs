//! Sonda TRUNCADA ponta a ponta no loop: `DrainOutcome::truncated` →
//! `Settlement::capped` → registro `capped` no L2.
//!
//! Sem esta fiação o `settle` decide sozinho e a sonda cortada volta a gravar
//! `empty` — o painel passaria 12 h dizendo que a obra não tem dublado BR.

use std::sync::Arc;

use adom_harvest::{
    probe_key, BrProbe, BrProbeRecord, BrProbeState, BrProbeWork, HarvestStore, ProbeConfig,
    RETRY_MS,
};

use super::super::{run_iteration, IterationOutcome};
use super::{probe_req, test_inner, worker, ImmediateDrain, Inner};
use crate::harvest::settle::Settler;

const NOW: i64 = 1_700_000_000_000;
const SHAW: &str = "tt0111161";

fn probe() -> BrProbe {
    BrProbe::new(ProbeConfig {
        index_only_indexers: vec!["br".into()],
        pt_br_indexers: vec!["br".into()],
        ..ProbeConfig::default()
    })
}

fn probe_state(store: &HarvestStore, imdb: &str, now: i64) -> Option<BrProbeState> {
    let raw = store
        .get_value(&probe_key(&BrProbeWork::movie(imdb)), now)
        .ok()
        .flatten()?;
    serde_json::from_str::<BrProbeRecord>(&raw)
        .ok()
        .map(|record| record.state)
}

/// `enqueue` cru (sem dedupe) para o `request` do retry não colidir com o
/// pedido que armou o teste.
async fn arm(inner: &Arc<Inner>) {
    let mut queue = inner.queue.lock().await;
    assert!(queue.enqueue(probe_req(SHAW)).accepted);
}

#[tokio::test]
async fn sonda_truncada_no_loop_grava_capped_e_libera_o_retry() {
    let store = Arc::new(HarvestStore::open_memory().unwrap());
    let inner = test_inner(store.clone(), 86_400);
    arm(&inner).await;

    let mut worker = worker();
    let mut settler = Settler::new(adom_harvest::DEFAULT_PROBE_TTL_SECONDS);
    // Alvos sobraram: o teto cortou a sonda.
    let mut drain = ImmediateDrain {
        ok: true,
        queries: 1,
        truncated: true,
    };
    assert_eq!(
        run_iteration(&inner, &mut worker, &mut drain, &mut settler, NOW).await,
        IterationOutcome::Drained { ok: true }
    );
    assert_eq!(
        probe_state(&store, SHAW, NOW),
        Some(BrProbeState::Capped),
        "sonda cortada nao prova ausencia"
    );

    // O registro final é o que destrava a nova tentativa 5 min depois.
    let mut queue = inner.queue.lock().await;
    let again = probe()
        .request(
            &store,
            &mut queue,
            &BrProbeWork::movie(SHAW),
            NOW + RETRY_MS,
        )
        .unwrap();
    assert!(again.probe, "retry da sonda truncada: {again:?}");
}

#[tokio::test]
async fn sonda_sem_truncamento_no_loop_continua_empty() {
    let store = Arc::new(HarvestStore::open_memory().unwrap());
    let inner = test_inner(store.clone(), 86_400);
    arm(&inner).await;

    let mut worker = worker();
    let mut settler = Settler::new(adom_harvest::DEFAULT_PROBE_TTL_SECONDS);
    // Todos os alvos consultados: a resposta é conclusiva.
    let mut drain = ImmediateDrain {
        ok: true,
        queries: 1,
        truncated: false,
    };
    assert_eq!(
        run_iteration(&inner, &mut worker, &mut drain, &mut settler, NOW).await,
        IterationOutcome::Drained { ok: true }
    );
    assert_eq!(probe_state(&store, SHAW, NOW), Some(BrProbeState::Empty));

    let mut queue = inner.queue.lock().await;
    let later = probe()
        .request(
            &store,
            &mut queue,
            &BrProbeWork::movie(SHAW),
            NOW + RETRY_MS,
        )
        .unwrap();
    assert_eq!(
        later.skipped,
        Some("empty"),
        "resposta conclusiva não retenta"
    );
}
