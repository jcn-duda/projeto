//! Fixtures do EXECUTOR: modo (`Off`/`ReadOnly`/`Apply`), lotes com falha
//! parcial, `may_delete` fail-closed no instante do delete, parada por
//! quota/auth e contagem por motivo.
//!
//! O HTTP é um dublê em memória: nenhuma chamada sai para a AllDebrid.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use super::{
    apply_plan, plan_sweep_dead, MagnetRow, Reason, SweepConfig, SweepFacts, SweepHttp,
    SweepHttpError, SweepMode, SweepStop,
};

const NOW: i64 = 1_700_000_000_000;
const DAY: i64 = 24 * 60 * 60 * 1000;

fn hash_of(ch: char) -> String {
    ch.to_string().repeat(40)
}

fn dead_row(ch: char) -> MagnetRow {
    MagnetRow {
        id: format!("id-{ch}"),
        hash: hash_of(ch),
        name: format!("Release {ch}"),
        status: "Error: no peer".into(),
        ready: false,
        uploaded_at_ms: NOW - 30 * DAY,
        files: Vec::new(),
    }
}

/// Dublê do `/magnet/delete`: registra os ids e obedece ao roteiro.
#[derive(Default)]
struct FakeHttp {
    /// Ids que respondem falha transitória.
    fail: HashSet<String>,
    /// Estado da conta que para a rodada.
    terminal: Option<SweepStop>,
    calls: Mutex<Vec<String>>,
}

impl FakeHttp {
    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
}

impl SweepHttp for FakeHttp {
    async fn delete(&self, id: &str) -> Result<(), SweepHttpError> {
        self.calls.lock().unwrap().push(id.to_string());
        if let Some(stop) = self.terminal {
            return Err(SweepHttpError::Terminal(stop));
        }
        if self.fail.contains(id) {
            return Err(SweepHttpError::Failed("503 em rajada".into()));
        }
        Ok(())
    }
}

/// Fatos com inventário carregado e nada protegido.
struct Facts {
    known_before: Option<HashSet<String>>,
    held: HashSet<String>,
    retained: HashSet<String>,
    owned_at: HashMap<String, i64>,
    marked: HashSet<String>,
    consulted: HashSet<String>,
    suppressed: HashSet<String>,
}

impl Facts {
    fn loaded() -> Self {
        Self {
            known_before: Some(HashSet::new()),
            held: HashSet::new(),
            retained: HashSet::new(),
            owned_at: HashMap::new(),
            marked: HashSet::new(),
            consulted: HashSet::new(),
            suppressed: HashSet::new(),
        }
    }

    fn view(&self) -> SweepFacts<'_> {
        SweepFacts {
            known_before: self.known_before.as_ref(),
            held: &self.held,
            retained: &self.retained,
            owned_at: &self.owned_at,
            marked: &self.marked,
            consulted: &self.consulted,
            suppressed: &self.suppressed,
            now_ms: NOW,
        }
    }
}

fn config() -> SweepConfig {
    SweepConfig {
        batch_size: 2,
        ..SweepConfig::dead()
    }
}

#[tokio::test]
async fn read_only_nao_chama_delete() {
    let rows = [dead_row('a'), dead_row('b')];
    let facts = Facts::loaded();
    let plan = plan_sweep_dead(&rows, &facts.view(), &config());
    assert_eq!(plan.delete.len(), 2, "o plano enxerga os dois");
    let http = FakeHttp::default();
    let outcome = apply_plan(
        &plan,
        &rows,
        &facts.view(),
        &config(),
        SweepMode::ReadOnly,
        &http,
    )
    .await;
    assert!(http.calls().is_empty(), "ReadOnly não faz DELETE");
    assert!(!outcome.applied);
    assert_eq!(outcome.planned, 2);
    assert!(outcome.removed.is_empty() && outcome.failed.is_empty());
}

#[tokio::test]
async fn off_nao_faz_io() {
    let rows = [dead_row('a')];
    let facts = Facts::loaded();
    let plan = plan_sweep_dead(&rows, &facts.view(), &config());
    let http = FakeHttp::default();
    let outcome = apply_plan(
        &plan,
        &rows,
        &facts.view(),
        &config(),
        SweepMode::Off,
        &http,
    )
    .await;
    assert!(http.calls().is_empty(), "Off não faz I/O nenhum");
    assert_eq!(outcome.calls, 0);
    assert!(!outcome.applied);
}

#[tokio::test]
async fn apply_remove_e_conta_por_id() {
    let rows = [dead_row('a'), dead_row('b')];
    let facts = Facts::loaded();
    let plan = plan_sweep_dead(&rows, &facts.view(), &config());
    let http = FakeHttp::default();
    let outcome = apply_plan(
        &plan,
        &rows,
        &facts.view(),
        &config(),
        SweepMode::Apply,
        &http,
    )
    .await;
    assert!(outcome.applied);
    assert_eq!(
        outcome.removed,
        vec!["id-a".to_string(), "id-b".to_string()]
    );
    assert_eq!(outcome.calls, 2);
    assert_eq!(http.calls(), vec!["id-a".to_string(), "id-b".to_string()]);
}

#[tokio::test]
async fn lote_com_uma_falha_continua() {
    let rows = [dead_row('a'), dead_row('b'), dead_row('c')];
    let facts = Facts::loaded();
    let plan = plan_sweep_dead(&rows, &facts.view(), &config());
    let http = FakeHttp {
        fail: HashSet::from(["id-b".to_string()]),
        ..FakeHttp::default()
    };
    let outcome = apply_plan(
        &plan,
        &rows,
        &facts.view(),
        &config(),
        SweepMode::Apply,
        &http,
    )
    .await;
    assert_eq!(
        outcome.removed,
        vec!["id-a".to_string(), "id-c".to_string()]
    );
    assert_eq!(outcome.failed, vec!["id-b".to_string()]);
    assert_eq!(outcome.calls, 3, "a falha de um id não para o lote");
    assert_eq!(outcome.count(Reason::DeleteFailed), 1);
}

#[tokio::test]
async fn may_delete_fecha_no_instante_do_delete() {
    let rows = [dead_row('a'), dead_row('b')];
    let facts = Facts::loaded();
    let plan = plan_sweep_dead(&rows, &facts.view(), &config());
    // O hold chega DEPOIS do plano: a guarda fecha na hora do delete.
    let mut during = Facts::loaded();
    during.held.insert(hash_of('a'));
    let http = FakeHttp::default();
    let outcome = apply_plan(
        &plan,
        &rows,
        &during.view(),
        &config(),
        SweepMode::Apply,
        &http,
    )
    .await;
    assert_eq!(outcome.blocked, vec!["id-a".to_string()]);
    assert_eq!(outcome.removed, vec!["id-b".to_string()]);
    assert_eq!(outcome.calls, 1, "o vetado nem chega na API");
    assert_eq!(outcome.count(Reason::GuardClosed), 1);
}

/// Dublê com guarda viva por roteiro: `hash → Some(false)` veta (protegido
/// agora), `hash → None` é ilegível (fail-closed) e ausente deixa passar.
struct GuardedHttp {
    inner: FakeHttp,
    vetoes: HashMap<String, Option<bool>>,
}

impl SweepHttp for GuardedHttp {
    async fn delete(&self, id: &str) -> Result<(), SweepHttpError> {
        self.inner.delete(id).await
    }

    async fn guard_live(&self, hash: &str) -> Option<bool> {
        self.vetoes.get(hash).copied().unwrap_or(Some(true))
    }
}

#[tokio::test]
async fn guarda_viva_que_veta_fecha_sem_chamar_delete() {
    let rows = [dead_row('a'), dead_row('b')];
    let facts = Facts::loaded();
    let plan = plan_sweep_dead(&rows, &facts.view(), &config());
    assert_eq!(plan.delete.len(), 2);
    // O hold de 'b' chegou DEPOIS de o plano fechar: só a guarda viva o vê.
    let http = GuardedHttp {
        inner: FakeHttp::default(),
        vetoes: HashMap::from([(hash_of('b'), Some(false))]),
    };
    let outcome = apply_plan(
        &plan,
        &rows,
        &facts.view(),
        &config(),
        SweepMode::Apply,
        &http,
    )
    .await;
    assert!(outcome.applied);
    assert_eq!(outcome.removed, vec!["id-a".to_string()]);
    assert_eq!(outcome.blocked, vec!["id-b".to_string()]);
    assert_eq!(outcome.reason_of(&hash_of('b')), Some(Reason::GuardClosed));
    assert_eq!(outcome.calls, 1, "o vetado nem chega na API");
    assert_eq!(outcome.failed.len(), 0, "veto não é falha de delete");
}

#[tokio::test]
async fn guarda_viva_ilegivel_e_fail_closed() {
    let rows = [dead_row('a'), dead_row('b')];
    let facts = Facts::loaded();
    let plan = plan_sweep_dead(&rows, &facts.view(), &config());
    // Não deu para reler a guarda de 'b': veto, nunca "pode apagar".
    let http = GuardedHttp {
        inner: FakeHttp::default(),
        vetoes: HashMap::from([(hash_of('b'), None)]),
    };
    let outcome = apply_plan(
        &plan,
        &rows,
        &facts.view(),
        &config(),
        SweepMode::Apply,
        &http,
    )
    .await;
    assert_eq!(outcome.removed, vec!["id-a".to_string()]);
    assert_eq!(outcome.blocked, vec!["id-b".to_string()]);
    assert_eq!(outcome.reason_of(&hash_of('b')), Some(Reason::GuardClosed));
    assert_eq!(outcome.calls, 1);
}

#[tokio::test]
async fn parada_por_quota_interrompe_a_rodada() {
    let rows = [dead_row('a'), dead_row('b'), dead_row('c')];
    let facts = Facts::loaded();
    let plan = plan_sweep_dead(&rows, &facts.view(), &config());
    let http = FakeHttp {
        terminal: Some(SweepStop::Quota),
        ..FakeHttp::default()
    };
    let outcome = apply_plan(
        &plan,
        &rows,
        &facts.view(),
        &config(),
        SweepMode::Apply,
        &http,
    )
    .await;
    assert_eq!(outcome.stopped, Some(SweepStop::Quota));
    assert_eq!(outcome.failed, vec!["id-a".to_string()]);
    assert_eq!(outcome.calls, 1, "insistir no teto só gasta a conta");
    assert_eq!(outcome.removed.len(), 0);
    assert_eq!(outcome.count(Reason::Stopped), 3);
}

#[tokio::test]
async fn hash_sem_linha_nao_apaga() {
    let rows = [dead_row('a'), dead_row('b')];
    let facts = Facts::loaded();
    let plan = plan_sweep_dead(&rows, &facts.view(), &config());
    // O fato da segunda linha não chegou: sem `id` não há delete.
    let known = [dead_row('a')];
    let http = FakeHttp::default();
    let outcome = apply_plan(
        &plan,
        &known,
        &facts.view(),
        &config(),
        SweepMode::Apply,
        &http,
    )
    .await;
    assert_eq!(outcome.removed, vec!["id-a".to_string()]);
    assert_eq!(outcome.failed.len(), 0);
    assert_eq!(outcome.count(Reason::MissingId), 1);
}

#[tokio::test]
async fn contagem_por_motivo_soma_plano_e_apply() {
    let rows = [dead_row('a'), dead_row('b')];
    let facts = Facts::loaded();
    let plan = plan_sweep_dead(&rows, &facts.view(), &config());
    let mut during = Facts::loaded();
    during.retained.insert(hash_of('a'));
    let http = FakeHttp::default();
    let outcome = apply_plan(
        &plan,
        &rows,
        &during.view(),
        &config(),
        SweepMode::Apply,
        &http,
    )
    .await;
    let counts = outcome.reason_counts();
    assert_eq!(counts[Reason::GuardClosed.as_str()], 1);
    assert_eq!(outcome.reason_of(&hash_of('a')), Some(Reason::GuardClosed));
    assert_eq!(
        outcome.reason_of(&hash_of('b')),
        None,
        "saiu, não tem motivo"
    );
}
