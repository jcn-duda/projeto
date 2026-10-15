//! Testes do executor de fundo dos portões (`gate-pending`).
//!
//! Exercitam o executor REAL contra um `crawl.db` temporário, um Node falso
//! e um resolver falso com contagem de pagamentos. A infra (semeadores,
//! falsos, handlers) vive em [`super::support`], separada pela catraca de
//! 400 linhas; o acervo "in_memory" aqui é a captura do Node — é por ela que
//! a release chega ao índice no mundo real.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use super::*;
use super::support::*;
use crate::store::ops::CrawlStore;

/// (b) Post pendente de portão: o executor paga pelo resolver e a release é
/// GRAVADA NO ACERVO (captura do POST ao Node) com a linha fechada como `done`.
#[tokio::test]
async fn executor_paga_e_grava_no_acervo() {
    let dir = tempfile::tempdir().expect("tempdir");
    let caminho = dir.path().join("crawl.db").to_str().unwrap().to_string();
    semear_gate(&caminho, "post-1", GATE);

    let entregues: Entregues = Arc::new(StdMutex::new(Vec::new()));
    let node = node_falso(entregues.clone(), false).await;
    let chamadas = Arc::new(AtomicUsize::new(0));
    let ex = executor(
        &caminho,
        &node,
        falso(chamadas.clone(), false),
        Arc::new(FlareFake { ocupado: false }),
        4,
    );

    let report = ex.run_round().await.expect("rodada");
    assert_eq!(report, GateRoundReport { claimed: 1, paid: 1, skipped: None });
    assert_eq!(chamadas.load(Ordering::SeqCst), 1, "um pagamento");

    // Acervo: um resultado `done` com o magnet do resolver.
    let posts = entregues.lock().unwrap();
    assert_eq!(posts.len(), 1, "release gravada no acervo");
    assert_eq!(posts[0]["status"], "done");
    assert_eq!(posts[0]["url_key"], "post-1");
    let magnet = posts[0]["releases"][0]["magnet"].as_str().expect("magnet no item");
    assert!(magnet.starts_with("magnet:"), "release com o magnet pago");
    assert!(posts[0]["releases"][0]["is_br"].as_bool().unwrap());
    drop(posts);

    // A linha saiu de `gate-pending` para `done` terminal.
    let (status, tries, next_at) = ler_linha(&caminho, "post-1");
    assert_eq!(status, "done");
    assert_eq!(tries, 1);
    assert_eq!(next_at, 0);

    // A pendência saiu da fila de portões e o pagamento ficou provado.
    let db = CrawlStore::open(&caminho).expect("reabrir");
    assert!(db.take_gate_batch(10).expect("lote").is_empty(), "crawl_gate esvaziada");
    let pago = db.get_state(SITE, &format!("gate-magnet:{GATE}")).expect("state");
    assert!(pago.is_some(), "pagamento durável gravado");
}

/// (c) Teto horário esgotado: a rodada é pulada ANTES de chamar o resolver e o
/// post continua pendente (nada é apagado nem queimado).
#[tokio::test]
async fn teto_esgotado_nao_chama_o_resolver() {
    let dir = tempfile::tempdir().expect("tempdir");
    let caminho = dir.path().join("crawl.db").to_str().unwrap().to_string();
    semear_gate(&caminho, "post-1", GATE);

    // Node em porta fechada: se a rodada chegasse ao freio, falharia em log —
    // pulou no teto, NENHUMA requisição acontece.
    let chamadas = Arc::new(AtomicUsize::new(0));
    let ex = executor(
        &caminho,
        "http://127.0.0.1:1",
        falso(chamadas.clone(), false),
        Arc::new(FlareFake { ocupado: false }),
        0, // teto já esgotado (e kill-switch do knob)
    );

    let report = ex.run_round().await.expect("rodada");
    assert_eq!(report, GateRoundReport { claimed: 0, paid: 0, skipped: Some("teto-horario") });
    assert_eq!(chamadas.load(Ordering::SeqCst), 0, "nenhum pagamento");
    let (status, tries, _) = ler_linha(&caminho, "post-1");
    assert_eq!(status, "gate-pending", "pendente para a rodada seguinte");
    assert_eq!(tries, 0, "sem veneno");
}

/// (c2) Teto esgotado NO MEIO da rodada: um post é pago, o outro fica para a
/// rodada seguinte.
#[tokio::test]
async fn teto_estourado_no_meio_da_rodada() {
    let dir = tempfile::tempdir().expect("tempdir");
    let caminho = dir.path().join("crawl.db").to_str().unwrap().to_string();
    semear_gate(&caminho, "post-1", GATE);
    semear_gate(&caminho, "post-2", GATE);

    let entregues: Entregues = Arc::new(StdMutex::new(Vec::new()));
    let node = node_falso(entregues.clone(), false).await;
    let chamadas = Arc::new(AtomicUsize::new(0));
    let ex = executor(
        &caminho,
        &node,
        falso(chamadas.clone(), false),
        Arc::new(FlareFake { ocupado: false }),
        1, // um pagamento por hora
    );

    let report = ex.run_round().await.expect("primeira rodada");
    assert_eq!(report.claimed, 1, "lote cortado pelo teto");
    assert_eq!(report.paid, 1);

    let report2 = ex.run_round().await.expect("segunda rodada");
    assert_eq!(report2, GateRoundReport { claimed: 0, paid: 0, skipped: Some("teto-horario") });
    assert_eq!(chamadas.load(Ordering::SeqCst), 1, "não paga além do teto");
    let (status, _, _) = ler_linha(&caminho, "post-2");
    assert_eq!(status, "gate-pending", "o segundo fica para a rodada seguinte");
}

/// (e) Falha do resolver: pendente, SEM VENENO (tries intacta, pendência na
/// fila) e a próxima rodada tenta de novo.
#[tokio::test]
async fn falha_do_resolver_mantem_pendente_sem_veneno() {
    let dir = tempfile::tempdir().expect("tempdir");
    let caminho = dir.path().join("crawl.db").to_str().unwrap().to_string();
    semear_gate(&caminho, "post-1", GATE);

    let entregues: Entregues = Arc::new(StdMutex::new(Vec::new()));
    let node = node_falso(entregues.clone(), false).await;
    let chamadas = Arc::new(AtomicUsize::new(0));
    let ex = executor(
        &caminho,
        &node,
        falso(chamadas.clone(), true),
        Arc::new(FlareFake { ocupado: false }),
        4,
    );

    let report = ex.run_round().await.expect("rodada");
    assert_eq!(report, GateRoundReport { claimed: 1, paid: 0, skipped: None });
    assert!(entregues.lock().unwrap().is_empty(), "nada entregue ao acervo");

    // Pendente, sem veneno e com o registro do portão intacto.
    let (status, tries, _) = ler_linha(&caminho, "post-1");
    assert_eq!(status, "gate-pending");
    assert_eq!(tries, 0, "falha do resolver não queima tentativa");
    let db = CrawlStore::open(&caminho).expect("reabrir");
    assert_eq!(db.take_gate_batch(10).expect("lote").len(), 1, "pendência na fila");

    // A próxima rodada tenta de novo (não há dedupe de falha).
    let report2 = ex.run_round().await.expect("segunda rodada");
    assert_eq!(report2.claimed, 1);
    assert_eq!(chamadas.load(Ordering::SeqCst), 2, "re-tenta na rodada seguinte");
}

/// Dedupe: pagamento NÃO se repete quando a entrega falha — a rodada seguinte
/// re-entrega o magnet durável SEM chamar o resolver de novo.
#[tokio::test]
async fn pagamento_nao_se_repete_quando_a_entrega_falha() {
    let dir = tempfile::tempdir().expect("tempdir");
    let caminho = dir.path().join("crawl.db").to_str().unwrap().to_string();
    semear_gate(&caminho, "post-1", GATE);

    let entregues: Entregues = Arc::new(StdMutex::new(Vec::new()));
    let node = node_recusa_primeira(entregues.clone()).await;
    let chamadas = Arc::new(AtomicUsize::new(0));
    let ex = executor(
        &caminho,
        &node,
        falso(chamadas.clone(), false),
        Arc::new(FlareFake { ocupado: false }),
        4,
    );

    // 1ª rodada: paga (FlareSolverr gastou) mas a entrega ao Node falha.
    let report = ex.run_round().await.expect("primeira rodada");
    assert_eq!(report.paid, 0);
    assert_eq!(chamadas.load(Ordering::SeqCst), 1, "um pagamento");

    // 2ª rodada: re-entrega do magnet durável — SEM novo pagamento.
    let report2 = ex.run_round().await.expect("segunda rodada");
    assert_eq!(report2.paid, 1);
    assert_eq!(chamadas.load(Ordering::SeqCst), 1, "portão nunca pago duas vezes");

    let (status, _, _) = ler_linha(&caminho, "post-1");
    assert_eq!(status, "done", "fechada pela re-entrega");
    assert!(db_gate_vazia(&caminho), "pendência resolvida");
}

/// Faixa Flare ocupada: a rodada é pulada inteira e o pagamento não enfileira.
#[tokio::test]
async fn flare_ocupado_pula_a_rodada() {
    let dir = tempfile::tempdir().expect("tempdir");
    let caminho = dir.path().join("crawl.db").to_str().unwrap().to_string();
    semear_gate(&caminho, "post-1", GATE);

    let chamadas = Arc::new(AtomicUsize::new(0));
    let ex = executor(
        &caminho,
        "http://127.0.0.1:1",
        falso(chamadas.clone(), false),
        Arc::new(FlareFake { ocupado: true }),
        4,
    );

    let report = ex.run_round().await.expect("rodada");
    assert_eq!(report, GateRoundReport { claimed: 0, paid: 0, skipped: Some("flare-ocupado") });
    assert_eq!(chamadas.load(Ordering::SeqCst), 0);
    let (status, _, _) = ler_linha(&caminho, "post-1");
    assert_eq!(status, "gate-pending");
}

/// Ociosidade: usuário ativo pula a rodada (mesmo critério do freio do
/// raspador — `recent_user_traffic` faz o fail-closed).
#[tokio::test]
async fn usuario_ativo_pula_a_rodada() {
    let dir = tempfile::tempdir().expect("tempdir");
    let caminho = dir.path().join("crawl.db").to_str().unwrap().to_string();
    semear_gate(&caminho, "post-1", GATE);

    let entregues: Entregues = Arc::new(StdMutex::new(Vec::new()));
    let node = node_falso(entregues.clone(), true).await; // recent: true
    let chamadas = Arc::new(AtomicUsize::new(0));
    let ex = executor(
        &caminho,
        &node,
        falso(chamadas.clone(), false),
        Arc::new(FlareFake { ocupado: false }),
        4,
    );

    let report = ex.run_round().await.expect("rodada");
    assert_eq!(report, GateRoundReport { claimed: 0, paid: 0, skipped: Some("usuario-ativo") });
    assert_eq!(chamadas.load(Ordering::SeqCst), 0, "usuário na frente: nada pago");
    let (status, _, _) = ler_linha(&caminho, "post-1");
    assert_eq!(status, "gate-pending");
}

fn db_gate_vazia(caminho: &str) -> bool {
    let db = CrawlStore::open(caminho).expect("reabrir");
    db.take_gate_batch(10).expect("lote").is_empty()
}
