//! Testes do INVENTÁRIO frio: a rodada tenta provar a referência
//! `knownBefore` com o carregador injetado e, sem prova, fecha INTEIRA em
//! `inventory_missing` — nada apagado, nada podado, nada curado, e a falha
//! fica relatada no tick.
//!
//! Filho de `al_sweeps_tests`.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use adom_debrid::alldebrid_sweeps::{Reason, SweepKind, SweepMode};

use super::super::{EnsureFuture, FactSource, InventoryEnsure, Sweeper};
use super::fx::FakeEffects;
use super::{outcome, ready_row, source, INTERVAL, NOW};

/// Fatos que acordam FRIOS (`known_before = None`) e esquentam quando o
/// carregador passa.
struct ColdFacts {
    thawed: Arc<AtomicBool>,
}

impl FactSource for ColdFacts {
    fn known_before(&self) -> Option<HashSet<String>> {
        self.thawed.load(Ordering::SeqCst).then(HashSet::new)
    }

    fn held(&self, _hash: &str) -> bool {
        false
    }

    fn retained(&self, _hash: &str) -> bool {
        false
    }

    fn owned_at(&self, _hash: &str) -> Option<i64> {
        None
    }

    fn marked(&self) -> HashSet<String> {
        HashSet::new()
    }

    fn suppressed(&self) -> HashSet<String> {
        HashSet::new()
    }
}

/// Carregador que PROVA (o `/magnet/status` que responde).
struct Thaw(Arc<AtomicBool>);

impl InventoryEnsure for Thaw {
    fn ensure(&self) -> EnsureFuture<'_> {
        Box::pin(async {
            self.0.store(true, Ordering::SeqCst);
        })
    }
}

/// Carregador que FALHA (rede/auth): conta a tentativa e não prova nada.
struct DeadEnsure(Arc<AtomicUsize>);

impl InventoryEnsure for DeadEnsure {
    fn ensure(&self) -> EnsureFuture<'_> {
        Box::pin(async {
            self.0.fetch_add(1, Ordering::SeqCst);
        })
    }
}

#[tokio::test]
async fn inventario_frio_e_provido_antes_da_rodada() {
    let thawed = Arc::new(AtomicBool::new(false));
    // Alvo de UMA varredura só (Undubbed): `ready_row` com prova EN.
    let src = source(Some(vec![ready_row('a')]));
    let sweeper = Sweeper::new(
        SweepMode::Apply,
        INTERVAL,
        src.clone(),
        Arc::new(ColdFacts {
            thawed: thawed.clone(),
        }),
        Arc::new(FakeEffects::default()),
        Some(Arc::new(Thaw(thawed.clone()))),
    );
    let report = sweeper.tick(NOW).await;
    assert!(
        thawed.load(Ordering::SeqCst),
        "a rodada fria tentou carregar a referência"
    );
    let undubbed = outcome(&report, SweepKind::Undubbed);
    assert_eq!(undubbed.planned, 1, "referência provada abre o plano");
    assert_eq!(src.deletes(), vec!["id-a".to_string()]);
}

#[tokio::test]
async fn inventario_frio_que_falha_fecha_a_rodada_inteira() {
    let calls = Arc::new(AtomicUsize::new(0));
    let src = source(Some(vec![ready_row('a')]));
    let sweeper = Sweeper::new(
        SweepMode::Apply,
        INTERVAL,
        src.clone(),
        Arc::new(ColdFacts {
            thawed: Arc::new(AtomicBool::new(false)),
        }),
        Arc::new(FakeEffects::default()),
        Some(Arc::new(DeadEnsure(calls.clone()))),
    );
    let report = sweeper.tick(NOW).await;
    assert_eq!(calls.load(Ordering::SeqCst), 1, "a tentativa aconteceu");
    assert_eq!(report.planned(), 0, "sem prova não há plano");
    assert!(src.deletes().is_empty());
    // O fechamento é por LINHA (`inventory_missing` em toda decisão), não
    // por tipo ausente — a listagem em si respondeu.
    assert!(report.missing.is_empty());
    assert!(report
        .outcomes
        .iter()
        .all(|item| item.count(Reason::InventoryMissing) == 1));
}
