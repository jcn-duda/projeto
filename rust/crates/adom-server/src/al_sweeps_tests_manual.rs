//! Testes da execução MANUAL de um tipo (`Sweeper::run_kind`) e dos contadores.
//!
//! Filho de `al_sweeps_tests` (reusa linhas, duplos e o helper `sweeper`). O
//! ponto central: o manual usa o MESMO guard do tick agendado e ignora o `due`,
//! mas nunca lista a conta duas vezes nem apaga em ReadOnly.

use std::sync::Arc;

use adom_debrid::alldebrid_sweeps::{SweepKind, SweepMode};
use tokio::sync::Semaphore;

use super::{dead_row, ready_row, source, sweeper, tweak, FakeFacts, HOUR, INTERVAL, NOW};

#[tokio::test]
async fn manual_ignora_due_e_atualiza_o_relogio_do_tipo() {
    let source = source(Some(vec![ready_row('b')]));
    let sweeper = sweeper(SweepMode::ReadOnly, source.clone(), FakeFacts::loaded(&[]));
    assert_eq!(sweeper.tick(NOW).await.outcomes.len(), 4);
    let at = NOW + HOUR;
    let report = sweeper.run_kind(SweepKind::Undubbed, at).await;
    assert_eq!(report.outcomes.len(), 1, "manual roda SÓ o tipo pedido");
    assert_eq!(report.outcomes[0].kind, SweepKind::Undubbed);
    assert_eq!(source.rows_calls(), 2, "uma listagem por rodada");
    let snap = sweeper.snapshot();
    let last = snap
        .last_by_kind
        .iter()
        .find(|(kind, _)| *kind == SweepKind::Undubbed)
        .map(|(_, at)| *at);
    assert_eq!(last, Some(at), "o relógio do tipo anda mesmo fora do due");
    assert_eq!(
        snap.next_due_at_ms,
        Some(NOW + INTERVAL),
        "o próximo vencimento é o do tick agendado, não o do manual"
    );
    assert_eq!(snap.counters.manual_runs, 1);
}

#[tokio::test]
async fn manual_e_agendado_um_executa_o_outro_reentra() {
    let gate = Arc::new(Semaphore::new(0));
    let source = tweak(source(Some(vec![ready_row('b')])), |s| {
        s.gate(gate.clone());
    });
    let sweeper = sweeper(SweepMode::ReadOnly, source.clone(), FakeFacts::loaded(&[]));
    let first = tokio::spawn({
        let sweeper = sweeper.clone();
        async move { sweeper.tick(NOW).await }
    });
    while source.rows_calls() == 0 {
        tokio::task::yield_now().await;
    }
    let second = sweeper.run_kind(SweepKind::Dead, NOW).await;
    assert!(second.reentered, "manual durante o agendado sai reentered");
    assert!(second.outcomes.is_empty());
    gate.add_permits(1);
    assert_eq!(first.await.unwrap().outcomes.len(), 4);
    assert_eq!(
        source.rows_calls(),
        1,
        "o reentered não lista a conta uma segunda vez"
    );
    assert_eq!(sweeper.snapshot().counters.reentered, 1);
}

#[tokio::test]
async fn manual_readonly_planeja_sem_delete() {
    let source = source(Some(vec![dead_row('a'), ready_row('b')]));
    let sweeper = sweeper(
        SweepMode::ReadOnly,
        source.clone(),
        FakeFacts::loaded(&[]).owns('b'),
    );
    let report = sweeper.run_kind(SweepKind::Dead, NOW).await;
    assert_eq!(report.planned(), 1, "o plano existe para diagnóstico");
    assert_eq!(report.calls(), 0, "ReadOnly não chama DELETE");
    assert!(report.outcomes.iter().all(|item| !item.applied));
    assert!(source.deletes().is_empty());
    let snap = sweeper.snapshot();
    assert_eq!(snap.counters.planned, 1);
    assert_eq!(snap.counters.swept, 0);
    assert!(snap.last_tick.expect("resumo gravado").manual);
}

#[tokio::test]
async fn manual_dead_nao_consulta_arquivos_e_undubbed_consulta() {
    let mut target = ready_row('a');
    target.files.clear();
    let source = tweak(source(Some(vec![target, dead_row('d')])), |s| {
        s.file_paths
            .insert("id-a".into(), vec!["Release.ENGLISH.DTS.mkv".into()]);
    });
    let sweeper = sweeper(SweepMode::ReadOnly, source.clone(), FakeFacts::loaded(&[]));
    sweeper.run_kind(SweepKind::Dead, NOW).await;
    assert!(
        source.file_calls().is_empty(),
        "sweepDead não busca arquivo"
    );
    sweeper.run_kind(SweepKind::Undubbed, NOW).await;
    assert_eq!(source.file_calls(), vec!["id-a"], "sweepUndubbed busca");
}

#[tokio::test]
async fn contadores_refletem_apply_com_um_removido() {
    let source = source(Some(vec![dead_row('a'), ready_row('b')]));
    let sweeper = sweeper(
        SweepMode::Apply,
        source.clone(),
        FakeFacts::loaded(&[]).owns('b'),
    );
    let report = sweeper.run_kind(SweepKind::Dead, NOW).await;
    assert_eq!(report.removed(), 1);
    let snap = sweeper.snapshot();
    assert_eq!(snap.counters.runs, 1);
    assert_eq!(snap.counters.manual_runs, 1);
    assert_eq!(snap.counters.swept, 1, "só o que saiu de verdade");
    assert_eq!(snap.counters.calls, 1);
    assert_eq!(snap.counters.by_kind[SweepKind::Dead.as_str()].swept, 1);
    assert_eq!(snap.counters.by_kind[SweepKind::Dead.as_str()].calls, 1);
    assert_eq!(snap.counters.swept_of(SweepKind::Undubbed), 0);
    assert_eq!(snap.counters.reasons["ready"], 1);
    let json = snap.to_json();
    assert_eq!(json["counters"]["sweptUndubbed"], 0);
    assert_eq!(json["counters"]["byKind"]["sweepDead"]["swept"], 1);
    assert_eq!(json["last"]["outcomes"][0]["kind"], "sweepDead");
    // O snapshot é operacional: nenhum hash/id de magnet atravessa o JSON.
    assert!(!json.to_string().contains(&super::hash_of('a')), "{json}");
    assert!(!json.to_string().contains("id-a"), "{json}");
}

#[tokio::test]
async fn modo_off_nao_executa_nem_na_rota_manual() {
    let source = source(Some(vec![dead_row('a')]));
    let sweeper = sweeper(
        SweepMode::Off,
        source.clone(),
        FakeFacts::loaded(&[]).owns('a'),
    );
    let report = sweeper.run_kind(SweepKind::Dead, NOW).await;
    assert!(report.outcomes.is_empty());
    assert_eq!(source.rows_calls(), 0, "Off não lista nem apaga");
    let snap = sweeper.snapshot();
    assert!(snap.last_tick.is_none());
    assert_eq!(snap.counters.runs, 0, "Off não conta rodada");
}
