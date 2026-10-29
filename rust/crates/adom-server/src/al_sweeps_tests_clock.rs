//! Testes do RELÓGIO e da montagem por env do agendador das varreduras.
//!
//! Filho de `al_sweeps_tests` (reusa as linhas e os duplos de lá).

use std::sync::Arc;

use adom_debrid::alldebrid::SweepMagnet;
use adom_debrid::alldebrid_sweeps::SweepMode;
use tokio::sync::Semaphore;

use super::super::env::{interval_from, settings_from, spawn_with, Settings, DEFAULT_INTERVAL_MS};
use super::super::native::rows_from;
use super::fx::FakeEffects;
use super::{
    dead_row, hash_of, ready_row, source, sweeper, tweak, FactSource, FakeFacts, DAY, INTERVAL, NOW,
};

#[test]
fn intervalo_zero_nao_agenda() {
    assert_eq!(interval_from(Some("0")), 0);
    assert!(settings_from(Some("0"), Some("on"), false, true).is_none());
    assert!(settings_from(None, Some("off"), false, true).is_none());
    let settings = Settings {
        mode: SweepMode::Apply,
        interval_ms: 0,
    };
    let facts: Arc<dyn FactSource> = Arc::new(FakeFacts::default());
    assert!(spawn_with(
        settings,
        source(Some(Vec::new())),
        facts,
        Arc::new(FakeEffects::default()),
        None,
    )
    .is_none());
}

#[test]
fn default_de_seis_horas() {
    assert_eq!(interval_from(None), DEFAULT_INTERVAL_MS);
    assert_eq!(interval_from(Some("")), DEFAULT_INTERVAL_MS);
    assert_eq!(interval_from(Some("lixo")), DEFAULT_INTERVAL_MS);
    assert_eq!(interval_from(Some(" 900000 ")), 900_000);
    assert_eq!(interval_from(Some("-5")), 0, "negativo desliga");
}

#[tokio::test]
async fn intervalo_minimo_por_tipo() {
    let source = source(Some(vec![ready_row('b')]));
    let sweeper = sweeper(SweepMode::ReadOnly, source.clone(), FakeFacts::loaded(&[]));
    assert_eq!(sweeper.tick(NOW).await.outcomes.len(), 4);
    assert!(
        sweeper.tick(NOW + INTERVAL - 1).await.not_due,
        "antes do intervalo nenhum tipo roda"
    );
    assert_eq!(source.rows_calls(), 1, "nada de listagem extra");
    assert_eq!(sweeper.tick(NOW + INTERVAL).await.outcomes.len(), 4);
    assert_eq!(source.rows_calls(), 2);
}

#[tokio::test]
async fn anti_reentrada_dois_ticks_um_executa() {
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
    let second = sweeper.tick(NOW).await;
    assert!(second.reentered, "o segundo tick sai sem tocar na conta");
    assert!(second.outcomes.is_empty());
    gate.add_permits(1);
    assert_eq!(first.await.unwrap().outcomes.len(), 4);
}

#[tokio::test]
async fn modo_off_nao_faz_io() {
    let source = source(Some(vec![dead_row('a')]));
    let report = sweeper(
        SweepMode::Off,
        source.clone(),
        FakeFacts::loaded(&[]).owns('a'),
    )
    .tick(NOW)
    .await;
    assert!(report.outcomes.is_empty());
    assert_eq!(source.rows_calls(), 0, "Off não lista nem apaga");
}

#[tokio::test]
async fn busca_arquivos_so_para_ready_antigo_e_nao_protegido() {
    let mut target = ready_row('a');
    target.files.clear();
    let mut protected = ready_row('b');
    protected.files.clear();
    let mut recent = ready_row('c');
    recent.files.clear();
    recent.uploaded_at_ms = NOW - DAY;
    let source = tweak(
        source(Some(vec![target, protected, recent, dead_row('d')])),
        |s| {
            s.file_paths
                .insert("id-a".into(), vec!["Release.ENGLISH.DTS.mkv".into()]);
            s.file_paths
                .insert("id-b".into(), vec!["Release.ENGLISH.DTS.mkv".into()]);
        },
    );
    let report = sweeper(
        SweepMode::ReadOnly,
        source.clone(),
        FakeFacts::loaded(&['b']),
    )
    .tick(NOW)
    .await;
    assert_eq!(source.file_calls(), vec!["id-a"]);
    assert_eq!(
        report.calls(),
        0,
        "prova de arquivo não libera DELETE no modo atual"
    );
}

#[test]
fn mapeamento_de_estado_nao_inventa_terminal() {
    let rows = rows_from(vec![
        SweepMagnet {
            id: "id-b".into(),
            hash: hash_of('b'),
            status: "Downloading".into(),
            ready: false,
            filename: "Release b".into(),
            upload_date_ms: (NOW - DAY) as f64,
        },
        SweepMagnet {
            id: "id-a".into(),
            hash: hash_of('a'),
            status: "Ready".into(),
            ready: true,
            filename: "Release a".into(),
            upload_date_ms: NOW as f64,
        },
    ]);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].status, "Ready");
    assert!(rows[0].ready);
    assert_eq!(rows[0].name, "Release a");
    assert_eq!(rows[0].uploaded_at_ms, NOW);
    assert_eq!(rows[1].status, "Downloading");
    assert_eq!(rows[1].uploaded_at_ms, NOW - DAY);
    assert!(rows.iter().all(|row| row.files.is_empty()));
}
