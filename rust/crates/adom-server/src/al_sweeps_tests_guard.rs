//! Testes da GUARDA VIVA no agendador: o mundo muda ENTRE o plano e o
//! delete, e o delete de CADA id relê preexistente/hold/retenção na hora —
//! `Some(false)` veta (protegido agora), `None` veta (fail-closed).
//!
//! Filho de `al_sweeps_tests` (reusa as linhas, os duplos e o portão de
//! delete de lá).

use std::sync::Arc;

use adom_debrid::alldebrid_sweeps::{Reason, SweepKind, SweepMode};
use tokio::sync::Semaphore;

use super::ff::SharedFacts;
use super::fx::FakeEffects;
use super::Sweeper;
use super::{hash_of, outcome, ready_row, source, tweak, FakeFacts, FakeSource, INTERVAL, NOW};

/// Alvo de UMA varredura só (`ready_row` com prova EN): só o `sweepUndubbed`
/// planeja delete (o Dead vê `Ready`, o Reconcile sem posse e o Revalidate
/// fora da fila). Assim o portão só tem os deletes DESTE tipo — o `dead_row`
/// seria planejado também pelo Undubbed (e o mesmo id sairia duas vezes).
fn alvo(ch: char) -> adom_debrid::alldebrid_sweeps::MagnetRow {
    ready_row(ch)
}

/// Rodada com o delete de CADA id parado no portão até o teste soltar.
fn sweeper_gated(src: Arc<FakeSource>, facts: Arc<SharedFacts>) -> Arc<Sweeper> {
    Sweeper::new(
        SweepMode::Apply,
        INTERVAL,
        src,
        facts,
        Arc::new(FakeEffects::default()),
        None,
    )
}

/// Espera o primeiro id PARAR dentro do delete (antes de a fonte registrá-lo).
async fn aguarda_primeiro_delete(src: &Arc<FakeSource>) {
    while src.delete_started().is_empty() {
        tokio::task::yield_now().await;
    }
}

#[tokio::test]
async fn hold_chegado_depois_do_plano_veta_o_delete() {
    let gate = Arc::new(Semaphore::new(0));
    let src = tweak(source(Some(vec![alvo('a'), alvo('b')])), |s| {
        s.delete_gate(gate.clone());
    });
    let facts = Arc::new(SharedFacts::new(FakeFacts::loaded(&[])));
    let sweeper = sweeper_gated(src.clone(), facts.clone());
    let task = tokio::spawn({
        let sweeper = sweeper.clone();
        async move { sweeper.tick(NOW).await }
    });
    aguarda_primeiro_delete(&src).await;
    // O mundo mudou com o delete de 'a' em voo: 'b' ganhou hold do autofetch.
    facts.hold('b');
    gate.add_permits(10);
    let report = task.await.unwrap();
    let undubbed = outcome(&report, SweepKind::Undubbed);
    assert_eq!(undubbed.planned, 2, "os dois entraram no plano");
    assert_eq!(undubbed.removed, vec!["id-a".to_string()]);
    assert_eq!(undubbed.blocked, vec!["id-b".to_string()]);
    assert_eq!(undubbed.reason_of(&hash_of('b')), Some(Reason::GuardClosed));
    assert_eq!(undubbed.calls, 1, "só UM delete saiu");
    assert_eq!(
        src.deletes(),
        vec!["id-a".to_string()],
        "a guarda viva, relida NO INSTANTE, vetou o delete de 'b'"
    );
}

#[tokio::test]
async fn inventario_que_sumiu_antes_do_delete_veta_fail_closed() {
    let gate = Arc::new(Semaphore::new(0));
    let src = tweak(source(Some(vec![alvo('a'), alvo('b')])), |s| {
        s.delete_gate(gate.clone());
    });
    let facts = Arc::new(SharedFacts::new(FakeFacts::loaded(&[])));
    let sweeper = sweeper_gated(src.clone(), facts.clone());
    let task = tokio::spawn({
        let sweeper = sweeper.clone();
        async move { sweeper.tick(NOW).await }
    });
    aguarda_primeiro_delete(&src).await;
    // O peek do inventário deixou de existir a ponto de não dar para reler:
    // `None` na guarda viva é VETO (fail-closed), nunca "pode apagar".
    facts.freeze_inventory();
    gate.add_permits(10);
    let report = task.await.unwrap();
    let undubbed = outcome(&report, SweepKind::Undubbed);
    assert_eq!(undubbed.planned, 2);
    assert_eq!(undubbed.removed, vec!["id-a".to_string()]);
    assert_eq!(undubbed.blocked, vec!["id-b".to_string()]);
    assert_eq!(
        undubbed.reason_of(&hash_of('b')),
        Some(Reason::GuardClosed),
        "guarda ilegível fecha a guarda"
    );
    assert!(src.deletes().contains(&"id-a".to_string()));
    assert!(!src.deletes().contains(&"id-b".to_string()));
}

#[tokio::test]
async fn duravel_ilegivel_antes_do_delete_veta_fail_closed() {
    let gate = Arc::new(Semaphore::new(0));
    let src = tweak(source(Some(vec![alvo('a'), alvo('b')])), |s| {
        s.delete_gate(gate.clone());
    });
    let facts = Arc::new(SharedFacts::new(FakeFacts::loaded(&[])));
    let sweeper = sweeper_gated(src.clone(), facts.clone());
    let task = tokio::spawn({
        let sweeper = sweeper.clone();
        async move { sweeper.tick(NOW).await }
    });
    aguarda_primeiro_delete(&src).await;
    // A fonte durável (`adprot`/`adhold`) ficou ILEGÍVEL com o delete de 'a'
    // em voo: reler hold/retenção agora é impossível, e "não protegido" sem
    // leitura não é veredito — a guarda viva VETA o id seguinte.
    facts.freeze_durable();
    gate.add_permits(10);
    let report = task.await.unwrap();
    let undubbed = outcome(&report, SweepKind::Undubbed);
    assert_eq!(undubbed.planned, 2);
    assert_eq!(undubbed.removed, vec!["id-a".to_string()]);
    assert_eq!(undubbed.blocked, vec!["id-b".to_string()]);
    assert_eq!(
        undubbed.reason_of(&hash_of('b')),
        Some(Reason::GuardClosed),
        "adprot/adhold ilegíveis fecham a guarda no instante do delete"
    );
    assert!(src.deletes().contains(&"id-a".to_string()));
    assert!(!src.deletes().contains(&"id-b".to_string()));
}
