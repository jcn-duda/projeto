//! Testes da FASE 1 no AGENDADOR: freio `DEBRID_AL_SWEEP_APPLY`, fila `sup:`,
//! `adrm` do undubbed, poda do `adprot` e cura da represa.
//!
//! Filho de `al_sweeps_tests` (reusa as linhas e os duplos de lá). Os efeitos
//! caem em `FakeEffects`; a produção (`NativeEffects`) é testada à parte em
//! `al_sweeps_effects_tests`.

use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use adom_debrid::alldebrid_sweeps::{MagnetRow, Reason, SweepKind, SweepMode, SweepOutcome};

use super::super::effects::{apply_effects, SweepEffects};
use super::super::Sweeper;
use super::{
    dead_row, hash_of, outcome, ready_row, source, sweeper, tweak, FakeFacts, INTERVAL, NOW,
};

/// Duplo que registra cada efeito chamado. A poda só conta a chamada.
#[derive(Default)]
pub(crate) struct FakeEffects {
    pub(crate) marked: Mutex<Vec<(String, String)>>,
    pub(crate) prune_calls: AtomicUsize,
    pub(crate) healed: Mutex<Vec<String>>,
    pub(crate) unowned: Mutex<Vec<String>>,
}

impl SweepEffects for FakeEffects {
    fn mark_removed(&self, hash: &str, name: &str, _now_ms: i64) {
        self.marked
            .lock()
            .unwrap()
            .push((hash.to_string(), name.to_string()));
    }

    fn prune_retention(
        &self,
        _facts: &dyn super::FactSource,
        _present: &HashSet<String>,
        _grace_ms: i64,
        _now_ms: i64,
    ) -> usize {
        self.prune_calls.fetch_add(1, Ordering::SeqCst);
        0
    }

    fn heal_suppressed(&self, hash: &str) {
        self.healed.lock().unwrap().push(hash.to_string());
    }

    fn forget_ownership(&self, hash: &str) {
        self.unowned.lock().unwrap().push(hash.to_string());
    }
}

fn sweeper_with_effects(
    mode: SweepMode,
    rows: Option<Vec<MagnetRow>>,
    facts: FakeFacts,
) -> (Arc<Sweeper>, Arc<FakeEffects>) {
    let fx = Arc::new(FakeEffects::default());
    let sweeper = Sweeper::new(
        mode,
        INTERVAL,
        source(rows),
        Arc::new(facts),
        fx.clone(),
        None,
    );
    (sweeper, fx)
}

// ---------------------------------------------------------------------------
// Fila `sup:` nos fatos (o revalidate enxerga a represa real)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn revalidate_diagnostica_a_fila_real() {
    // 'x' está na conta (pronto → NotDead); 'y' sumiu → Gone no plano.
    let facts = FakeFacts::loaded(&[]).suppresses(&['x', 'y']);
    let report = sweeper(
        SweepMode::ReadOnly,
        source(Some(vec![ready_row('x')])),
        facts,
    )
    .tick(NOW)
    .await;
    let plan = outcome(&report, SweepKind::Revalidate);
    assert_eq!(plan.reason_of(&hash_of('x')), Some(Reason::NotDead));
    assert_eq!(plan.reason_of(&hash_of('y')), Some(Reason::Gone));
}

#[tokio::test]
async fn sem_fila_o_revalidate_nao_condena_ninguem() {
    let report = sweeper(
        SweepMode::ReadOnly,
        source(Some(vec![dead_row('a')])),
        FakeFacts::loaded(&[]),
    )
    .tick(NOW)
    .await;
    let plan = outcome(&report, SweepKind::Revalidate);
    assert_eq!(plan.reason_of(&hash_of('a')), Some(Reason::NotSuppressed));
    assert_eq!(plan.planned, 0);
}

// ---------------------------------------------------------------------------
// Freio: ReadOnly monta o plano e NÃO grava estado
// ---------------------------------------------------------------------------

#[tokio::test]
async fn readonly_nao_grava_nenhum_estado() {
    // 'x' é morto, nosso e antigo: o revalidate planeja a saída e o Dead a
    // poda. Em ReadOnly NADA é materializado.
    let facts = FakeFacts::loaded(&[]).owns('x').suppresses(&['x']);
    let (sweeper, fx) = sweeper_with_effects(SweepMode::ReadOnly, Some(vec![dead_row('x')]), facts);
    let report = sweeper.tick(NOW).await;
    assert!(outcome(&report, SweepKind::Revalidate).planned > 0);
    assert!(fx.marked.lock().unwrap().is_empty());
    assert!(fx.healed.lock().unwrap().is_empty());
    assert!(fx.unowned.lock().unwrap().is_empty());
    assert_eq!(fx.prune_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn apply_poda_quando_o_dead_esta_no_intervalo() {
    let (sweeper, fx) = sweeper_with_effects(
        SweepMode::Apply,
        Some(vec![dead_row('a')]),
        FakeFacts::loaded(&[]),
    );
    sweeper.tick(NOW).await;
    assert_eq!(fx.prune_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn fatos_duraveis_ilegeveis_rodada_sem_plano_nem_poda() {
    // `cache.db` ilegível no PLANEJAMENTO: "sem adprot/adhold" não é provável,
    // então a rodada inteira fecha sem plano (os quatro tipos relatados como
    // missing) e a poda do `adprot` nem é chamada.
    let (sweeper, fx) = sweeper_with_effects(
        SweepMode::Apply,
        Some(vec![dead_row('a'), ready_row('b')]),
        FakeFacts::loaded(&[]).durable_broken(),
    );
    let report = sweeper.tick(NOW).await;
    assert_eq!(report.missing.len(), 4, "os quatro tipos ficam relatados");
    assert_eq!(report.outcomes.len(), 4, "o diagnóstico não some");
    assert_eq!(
        report.planned(),
        0,
        "nada entra em plano sem fatos legíveis"
    );
    assert_eq!(fx.prune_calls.load(Ordering::SeqCst), 0, "poda não roda");
}

// ---------------------------------------------------------------------------
// `adrm` só do que o undubbed removeu DE VERDADE
// ---------------------------------------------------------------------------

#[tokio::test]
async fn apply_marca_adrm_somente_do_id_removido() {
    // 'a' sai (gringo provado, antigo); 'b' falha o delete e NÃO marca.
    let fx = Arc::new(FakeEffects::default());
    let rows = tweak(source(Some(vec![ready_row('a'), ready_row('b')])), |s| {
        s.fail('b');
    });
    let sweeper = Sweeper::new(
        SweepMode::Apply,
        INTERVAL,
        rows,
        Arc::new(FakeFacts::loaded(&[])),
        fx.clone(),
        None,
    );
    sweeper.tick(NOW).await;
    assert_eq!(
        *fx.marked.lock().unwrap(),
        vec![(hash_of('a'), "Release a".to_string())],
        "falha de delete não marca: o magnet continua na conta"
    );
}

// ---------------------------------------------------------------------------
// Cura da fila `sup:` no Apply
// ---------------------------------------------------------------------------

#[tokio::test]
async fn revalidate_cura_a_fila_no_apply() {
    // 'x' é morto, nosso e antigo → sai; 'y' sumiu da conta → Gone; 'z' está
    // pronto → NotDead (o registro fica, a heurística pode ter errado).
    let facts = FakeFacts::loaded(&[])
        .owns('x')
        .suppresses(&['x', 'y', 'z']);
    let (sweeper, fx) = sweeper_with_effects(
        SweepMode::Apply,
        Some(vec![dead_row('x'), ready_row('z')]),
        facts,
    );
    let report = sweeper.tick(NOW).await;
    let plan = outcome(&report, SweepKind::Revalidate);
    assert_eq!(plan.removed, vec!["id-x".to_string()]);
    let mut healed = fx.healed.lock().unwrap().clone();
    healed.sort();
    assert_eq!(healed, vec![hash_of('x'), hash_of('y')]);
    assert_eq!(*fx.unowned.lock().unwrap(), vec![hash_of('x')]);
    assert!(
        !fx.healed.lock().unwrap().contains(&hash_of('z')),
        "NotDead não cura: downloading/unknown mantêm o registro"
    );
}

// ---------------------------------------------------------------------------
// apply_effects puro: efeito não vaza entre tipos
// ---------------------------------------------------------------------------

#[test]
fn efeitos_nao_vazam_entre_tipos() {
    let fx = Arc::new(FakeEffects::default());
    let dead = SweepOutcome {
        kind: SweepKind::Dead,
        applied: true,
        planned: 1,
        removed: vec!["id-a".to_string()],
        failed: Vec::new(),
        blocked: Vec::new(),
        stopped: None,
        calls: 1,
        skip: Default::default(),
    };
    apply_effects(fx.as_ref(), &dead, &[ready_row('a')], NOW);
    assert!(
        fx.marked.lock().unwrap().is_empty(),
        "sweepDead NUNCA marca: higiene da checagem não é decisão de conteúdo"
    );
    assert!(fx.healed.lock().unwrap().is_empty());
    assert!(fx.unowned.lock().unwrap().is_empty());
}
