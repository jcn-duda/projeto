//! Recuo do pagamento que falhou. Fora do `gate_tests.rs` pela catraca de 400 linhas.

use std::sync::Arc;

use super::support::*;
use super::*;
use crate::store::ops::CrawlStore;

/// Falha real do pagamento recua a linha: sem isso, as linhas da cabeça da fila
/// repetiam e comiam o teto por hora, e o resto do acervo nunca era pago.
#[tokio::test]
async fn falha_real_do_pagamento_recua_e_libera_a_fila() {
    struct Negado;
    impl GateResolver for Negado {
        fn resolve<'a>(&'a self, _gate: &'a str, _post: &'a str) -> GateFuture<'a> {
            Box::pin(async { Err("resolver: http 502 bludv: portao de anuncio (x)".to_string()) })
        }
    }
    let dir = tempfile::tempdir().expect("tempdir");
    let caminho = dir.path().join("crawl.db").to_str().unwrap().to_string();
    semear_gate(&caminho, "post-1", GATE);
    let ingest = IngestFake::novo(Recusa::Nunca);
    let node = node_falso(false).await;
    let ex = executor(
        &caminho,
        &node,
        plug(&ingest),
        Arc::new(Negado),
        Arc::new(FlareFake { ocupado: false }),
        4,
    );
    let report = ex.run_round().await.expect("rodada");
    assert_eq!(report.paid, 0);
    let (status, tries, next_at) = ler_linha(&caminho, "post-1");
    assert_eq!(status, "gate-pending", "segue pendente");
    assert_eq!(tries, 1);
    assert!(next_at > now_ms(), "espera o recuo");
    let db = CrawlStore::open(&caminho).expect("reabrir");
    assert!(db.take_gate_batch(10).expect("lote").is_empty());
}
