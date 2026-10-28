//! Testes do AGENDADOR das varreduras da AllDebrid (gateway): freio e execução.
//!
//! Sem rede e sem `cache.db`: as portas (`SweepSource`/`FactSource`) são duplos
//! em memória. O relógio e a montagem de env ficam em `al_sweeps_tests_clock`.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use adom_debrid::alldebrid_sweeps::{
    MagnetRow, Reason, SweepHttpError, SweepKind, SweepMode, SweepOutcome, SweepStop,
};
use tokio::sync::Semaphore;

use super::env::{mode_from, settings_from};
use super::native::gated_snapshot;
use super::{FactSource, SweepSource, Sweeper};

#[path = "al_sweeps_tests_clock.rs"]
mod clock;

pub(crate) const NOW: i64 = 1_700_000_000_000;
pub(crate) const DAY: i64 = 24 * 60 * 60 * 1000;
pub(crate) const HOUR: i64 = 60 * 60 * 1000;
pub(crate) const INTERVAL: i64 = 6 * HOUR;

// ---------------------------------------------------------------------------
// Linhas e duplos
// ---------------------------------------------------------------------------

pub(crate) fn hash_of(ch: char) -> String {
    ch.to_string().repeat(40)
}

pub(crate) fn ready_row(ch: char) -> MagnetRow {
    MagnetRow {
        id: format!("id-{ch}"),
        hash: hash_of(ch),
        name: format!("Release {ch}"),
        status: "Ready".into(),
        ready: true,
        uploaded_at_ms: NOW - 30 * DAY,
        files: vec![format!("Release.{ch}.1080p.WEB-DL.x264-RARBG.mkv")],
    }
}

pub(crate) fn dead_row(ch: char) -> MagnetRow {
    MagnetRow {
        status: "Error: no peer".into(),
        ready: false,
        ..ready_row(ch)
    }
}

#[derive(Default)]
pub(crate) struct FakeSource {
    rows: Mutex<Option<Vec<MagnetRow>>>,
    rows_calls: AtomicUsize,
    file_paths: HashMap<String, Vec<String>>,
    file_calls: Mutex<Vec<String>>,
    deletes: Mutex<Vec<String>>,
    failed: HashSet<String>,
    terminal: HashSet<String>,
    gate: Option<Arc<Semaphore>>,
}

pub(crate) fn source(rows: Option<Vec<MagnetRow>>) -> Arc<FakeSource> {
    Arc::new(FakeSource {
        rows: Mutex::new(rows),
        ..FakeSource::default()
    })
}

/// Ajusta a fonte recém-criada (dono único: `Arc::get_mut` não falha).
pub(crate) fn tweak(
    mut source: Arc<FakeSource>,
    apply: impl FnOnce(&mut FakeSource),
) -> Arc<FakeSource> {
    apply(Arc::get_mut(&mut source).expect("fonte única"));
    source
}

impl FakeSource {
    pub(crate) fn fail(&mut self, ch: char) {
        self.failed.insert(format!("id-{ch}"));
    }

    pub(crate) fn stop(&mut self, ch: char) {
        self.terminal.insert(format!("id-{ch}"));
    }

    pub(crate) fn gate(&mut self, gate: Arc<Semaphore>) {
        self.gate = Some(gate);
    }

    pub(crate) fn rows_calls(&self) -> usize {
        self.rows_calls.load(Ordering::SeqCst)
    }

    pub(crate) fn file_calls(&self) -> Vec<String> {
        self.file_calls.lock().unwrap().clone()
    }

    pub(crate) fn deletes(&self) -> Vec<String> {
        self.deletes.lock().unwrap().clone()
    }
}

impl SweepSource for FakeSource {
    fn rows(&self) -> super::RowsFuture<'_> {
        Box::pin(async move {
            self.rows_calls.fetch_add(1, Ordering::SeqCst);
            if let Some(gate) = self.gate.as_ref() {
                let permit = gate.acquire().await;
                drop(permit);
            }
            self.rows.lock().unwrap().clone()
        })
    }

    fn files(&self, id: String) -> super::FilesFuture<'_> {
        Box::pin(async move {
            self.file_calls.lock().unwrap().push(id.clone());
            self.file_paths.get(&id).cloned()
        })
    }

    fn delete(&self, id: String) -> super::DeleteFuture<'_> {
        Box::pin(async move {
            if self.terminal.contains(&id) {
                return Err(SweepHttpError::Terminal(SweepStop::Quota));
            }
            if self.failed.contains(&id) {
                return Err(SweepHttpError::Failed("503".into()));
            }
            self.deletes.lock().unwrap().push(id);
            Ok(())
        })
    }
}

#[derive(Default)]
pub(crate) struct FakeFacts {
    known_before: Option<HashSet<String>>,
    held: HashSet<String>,
    retained: HashSet<String>,
    owned_at: HashMap<String, i64>,
    marked: HashSet<String>,
}

impl FakeFacts {
    /// Inventário carregado (holds on) com os preexistentes de `hashes`.
    pub(crate) fn loaded(hashes: &[char]) -> Self {
        Self {
            known_before: Some(hashes.iter().map(|ch| hash_of(*ch)).collect()),
            ..Self::default()
        }
    }

    pub(crate) fn owns(mut self, ch: char) -> Self {
        self.owned_at.insert(hash_of(ch), NOW - 30 * DAY);
        self
    }
}

impl FactSource for FakeFacts {
    fn known_before(&self) -> Option<HashSet<String>> {
        self.known_before.clone()
    }

    fn held(&self, hash: &str) -> bool {
        self.held.contains(hash)
    }

    fn retained(&self, hash: &str) -> bool {
        self.retained.contains(hash)
    }

    fn owned_at(&self, hash: &str) -> Option<i64> {
        self.owned_at.get(hash).copied()
    }

    fn marked(&self) -> HashSet<String> {
        self.marked.clone()
    }
}

pub(crate) fn sweeper(mode: SweepMode, source: Arc<FakeSource>, facts: FakeFacts) -> Arc<Sweeper> {
    Sweeper::new(mode, INTERVAL, source, Arc::new(facts))
}

fn outcome(report: &super::TickReport, kind: SweepKind) -> &SweepOutcome {
    report
        .outcomes
        .iter()
        .find(|outcome| outcome.kind == kind)
        .expect("o tipo deveria ter rodado")
}

// ---------------------------------------------------------------------------
// Freio: sem fato, sem delete
// ---------------------------------------------------------------------------

#[tokio::test]
async fn sem_inventario_zero_delete() {
    let source = source(Some(vec![dead_row('a'), ready_row('b')]));
    let report = sweeper(SweepMode::Apply, source.clone(), FakeFacts::default())
        .tick(NOW)
        .await;
    assert_eq!(report.outcomes.len(), 4, "os quatro tipos decidem");
    assert_eq!(report.planned(), 0, "sem inventário nada entra no plano");
    assert_eq!(report.calls(), 0, "nenhum DELETE");
    assert!(source.deletes().is_empty());
    assert!(report
        .outcomes
        .iter()
        .all(|item| item.count(Reason::InventoryMissing) == 2));
}

#[tokio::test]
async fn holds_off_fecha_a_rodada() {
    // `DEBRID_AL_HOLDS` off ⇒ `gated_snapshot` devolve `None` mesmo com snapshot.
    let mut snapshot = HashSet::new();
    snapshot.insert(hash_of('a'));
    assert_eq!(gated_snapshot(false, Some(snapshot.clone())), None);
    assert_eq!(gated_snapshot(true, Some(snapshot.clone())), Some(snapshot));

    let source = source(Some(vec![dead_row('a')]));
    let report = sweeper(SweepMode::Apply, source.clone(), FakeFacts::default())
        .tick(NOW)
        .await;
    assert_eq!(report.planned(), 0);
    assert!(source.deletes().is_empty());
}

#[tokio::test]
async fn holds_on_mantem_preexistente() {
    let source = source(Some(vec![dead_row('a'), ready_row('b')]));
    let report = sweeper(SweepMode::Apply, source.clone(), FakeFacts::loaded(&['a']))
        .tick(NOW)
        .await;
    let dead = outcome(&report, SweepKind::Dead);
    assert_eq!(dead.reason_of(&hash_of('a')), Some(Reason::Preexisting));
    assert!(!source.deletes().contains(&"id-a".to_string()));
}

#[test]
fn cleanup_ausente_vira_readonly() {
    assert_eq!(mode_from(None, false), SweepMode::ReadOnly);
    assert_eq!(mode_from(Some("off"), false), SweepMode::Off);
    assert_eq!(mode_from(Some("on"), false), SweepMode::Apply);
    assert_eq!(
        mode_from(Some("on"), true),
        SweepMode::ReadOnly,
        "kill-switch"
    );
}

#[test]
fn cleanup_on_fica_readonly_sem_provas_nativas_completas() {
    let settings = settings_from(Some("60000"), Some("on"), false)
        .expect("intervalo ligado agenda o modo de diagnóstico");
    assert_eq!(settings.mode, SweepMode::ReadOnly);
}

#[tokio::test]
async fn readonly_monta_plano_sem_delete() {
    let source = source(Some(vec![dead_row('a'), ready_row('b')]));
    let report = sweeper(
        SweepMode::ReadOnly,
        source.clone(),
        FakeFacts::loaded(&[]).owns('b'),
    )
    .tick(NOW)
    .await;
    assert!(report.planned() > 0, "o plano existe para diagnóstico");
    assert_eq!(report.calls(), 0, "modo ReadOnly não chama DELETE");
    assert!(source.deletes().is_empty());
    assert!(report.outcomes.iter().all(|item| !item.applied));
}

#[tokio::test]
async fn listagem_indisponivel_sem_delete() {
    let source = source(None);
    let report = sweeper(SweepMode::Apply, source.clone(), FakeFacts::loaded(&[]))
        .tick(NOW)
        .await;
    assert_eq!(report.missing.len(), 4);
    assert_eq!(report.outcomes.len(), 4, "o diagnóstico não some");
    assert_eq!(report.planned(), 0);
    assert_eq!(report.calls(), 0);
    assert!(source.deletes().is_empty());
}

// ---------------------------------------------------------------------------
// Execução: falha de um tipo não cancela os outros
// ---------------------------------------------------------------------------

#[tokio::test]
async fn falha_transitoria_nao_cancela_os_outros() {
    let source = tweak(source(Some(vec![dead_row('a'), ready_row('b')])), |s| {
        s.fail('a');
    });
    let report = sweeper(
        SweepMode::Apply,
        source.clone(),
        FakeFacts::loaded(&[]).owns('b'),
    )
    .tick(NOW)
    .await;
    assert_eq!(
        report.outcomes.len(),
        4,
        "um id que falhou não derruba a rodada"
    );
    let dead = outcome(&report, SweepKind::Dead);
    assert_eq!(dead.failed, vec!["id-a".to_string()]);
    assert_eq!(dead.reason_of(&hash_of('a')), Some(Reason::DeleteFailed));
    assert!(
        source.deletes().contains(&"id-b".to_string()),
        "os outros seguem"
    );
}

#[tokio::test]
async fn parada_por_quota_nao_cancela_os_outros() {
    let source = tweak(source(Some(vec![dead_row('a'), ready_row('b')])), |s| {
        s.stop('a');
    });
    let report = sweeper(
        SweepMode::Apply,
        source.clone(),
        FakeFacts::loaded(&[]).owns('b'),
    )
    .tick(NOW)
    .await;
    assert_eq!(report.outcomes.len(), 4);
    assert_eq!(
        outcome(&report, SweepKind::Dead).stopped,
        Some(SweepStop::Quota)
    );
    assert!(
        source.deletes().contains(&"id-b".to_string()),
        "quota não para o resto"
    );
}

#[tokio::test]
async fn apply_com_fatos_completos_remove() {
    let source = source(Some(vec![dead_row('a'), ready_row('b')]));
    let report = sweeper(
        SweepMode::Apply,
        source.clone(),
        FakeFacts::loaded(&[]).owns('b'),
    )
    .tick(NOW)
    .await;
    let dead = outcome(&report, SweepKind::Dead);
    assert!(dead.applied);
    assert_eq!(dead.removed, vec!["id-a".to_string()]);
    assert!(report.removed() >= 1);
}
