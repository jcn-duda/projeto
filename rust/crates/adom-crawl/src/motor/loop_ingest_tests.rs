//! Testes do efeito do veredito da INGESTÃO no tick (T3-L3).
//!
//! Separados do `loop_tests.rs` pela catraca de 400 linhas; como módulo filho,
//! enxergam os helpers do irmão-pai via `super::*`. Provam que a página passou a
//! ser gravada NO PROCESSO (o POST antigo não recebe nada) e que os dois modos
//! de reentrega (`PageReport.retryable` e erro de store) voltam com backoff.

use super::*;

#[tokio::test]
async fn ingest_retentavel_dorme_com_backoff() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("crawl.db");
    let caminho = db.to_str().unwrap();
    seed(caminho, linha("filme-3"));

    // Catálogo fora (`retryable`): a página volta com backoff, sem derrubar o tick.
    let node = node_falso(Arc::new(AtomicUsize::new(0))).await;
    let ingest = Arc::new(FakeIngest::retryable());
    let motor = CrawlMotor::new(config(caminho, &node))
        .with_page_engine(EngineFake::pronta())
        .with_ingest(ingest.clone());
    let outcome = motor.tick_once().await.expect("tick");

    assert_eq!(
        outcome,
        TickOutcome::Processed {
            claimed: 1,
            delivered: 0
        }
    );
    assert_eq!(ingest.calls(), 1);
    let (status, tries, next_at) = ler_linha(caminho, "filme-3");
    assert_eq!(status, "pending", "retry: volta para a fila");
    assert_eq!(tries, 1);
    assert!(next_at > now_ms(), "backoff empurra a próxima tentativa");
    // O fetch aconteceu: o motor cobra o custo REAL da página, e não zero.
    assert_eq!(motor.status().await.pages_this_hour, 2);
}

#[tokio::test]
async fn ingest_falhando_vira_backoff_sem_perder_a_pagina() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("crawl.db");
    let caminho = db.to_str().unwrap();
    seed(caminho, linha("filme-7"));

    let node = node_falso(Arc::new(AtomicUsize::new(0))).await;
    let motor = CrawlMotor::new(config(caminho, &node))
        .with_page_engine(EngineFake::pronta())
        .with_ingest(Arc::new(FakeIngest::failing()));
    let outcome = motor.tick_once().await.expect("tick");

    assert_eq!(
        outcome,
        TickOutcome::Processed {
            claimed: 1,
            delivered: 0
        }
    );
    let (status, tries, next_at) = ler_linha(caminho, "filme-7");
    assert_eq!(status, "pending");
    assert_eq!(tries, 1);
    assert!(next_at > now_ms());
    // Erro de store não vira zero: o fetch custou 2 requisições.
    assert_eq!(motor.status().await.pages_this_hour, 2);
}
