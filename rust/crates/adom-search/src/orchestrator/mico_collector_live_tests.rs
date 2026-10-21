//! Matriz do `live` do coletor Mico: ok/empty/4xx/429/5xx/JSON inválido/rede/
//! timeout/pending, mais o breaker só no caminho vivo. O servidor falso e as
//! asserções moram em `mico_collector_live_support.rs` (catraca de 400 linhas).

use super::live_support::*;
use super::*;
use crate::orchestrator::live_state::LiveAllState;
use adom_sources::{now_ms, MicoClient, MicoConfig};
use std::collections::BTreeSet;

#[tokio::test]
async fn live_ok_quando_o_item_e_relevante() {
    let (base, fake) = start().await;
    let batch = collector_at(&base, 1_500)
        .collect(job_at(deadline_soon()))
        .await
        .expect("coleta");
    assert_eq!(fake.hits(), 1);
    assert_eq!(batch.items.len(), 1);
    let item = &batch.items[0];
    assert_eq!(item.indexer.as_deref(), Some("mico"));
    assert!(!item.is_br, "título EN não é BR");
    assert_ok(&batch);
}

#[tokio::test]
async fn live_empty_quando_a_resposta_e_vazia() {
    let (base, fake) = start().await;
    fake.set_mode(Mode::Empty);
    let batch = collector_at(&base, 1_500)
        .collect(job_at(deadline_soon()))
        .await
        .expect("coleta");
    assert!(batch.items.is_empty());
    assert_empty(&batch);
}

/// 200 com item de OUTRA obra é vazio suspeito (`relevant: 0`), mas o item
/// continua no lote — quem filtra é o build, como no Node.
#[tokio::test]
async fn live_empty_quando_nada_e_relevante() {
    let (base, fake) = start().await;
    fake.set_mode(Mode::Irrelevant);
    let batch = collector_at(&base, 1_500)
        .collect(job_at(deadline_soon()))
        .await
        .expect("coleta");
    assert_eq!(batch.items.len(), 1);
    assert_empty(&batch);
}

/// 4xx (salvo 429) pertence à obra: o Node NÃO abre o breaker, devolve `[]` e
/// o `onQueryResult({responded:true})` vira `empty`.
#[tokio::test]
async fn http_400_vira_empty_responded_e_nao_abre_breaker() {
    let (base, fake) = start().await;
    fake.set_mode(Mode::Http400);
    let client = MicoClient::new(MicoConfig {
        breaker_failures: 1,
        ..config(&base, 1_500)
    })
    .expect("client");
    let collector = MicoCollector::new(client);
    let batch = collector
        .collect(job_at(deadline_soon()))
        .await
        .expect("coleta");
    assert!(batch.items.is_empty());
    assert_empty(&batch);
    assert_eq!(collector.client().breaker().failures(), 0, "4xx é neutro");

    // Circuito fechado: a próxima consulta vai à rede de novo.
    let again = collector
        .collect(job_at(deadline_soon()))
        .await
        .expect("coleta");
    assert_empty(&again);
    assert_eq!(fake.hits(), 2);
}

#[tokio::test]
async fn live_failed_em_http_429_e_5xx() {
    for mode in [Mode::Http429, Mode::Http500] {
        let (base, fake) = start().await;
        fake.set_mode(mode);
        let batch = collector_at(&base, 1_500)
            .collect(job_at(deadline_soon()))
            .await
            .expect("coleta");
        assert_failed(&batch);
        assert_eq!(fake.hits(), 1);
    }
}

#[tokio::test]
async fn live_failed_em_json_invalido_e_rede() {
    let (base, fake) = start().await;
    fake.set_mode(Mode::InvalidJson);
    assert_failed(
        &collector_at(&base, 1_500)
            .collect(job_at(deadline_soon()))
            .await
            .expect("coleta"),
    );

    // Porta efêmera aberta e fechada: conexão recusada.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    drop(listener);
    assert_failed(
        &collector_at(&format!("http://{addr}"), 1_500)
            .collect(job_at(deadline_soon()))
            .await
            .expect("coleta"),
    );
}

/// Timeout do CLIENTE (antes do deadline do coletor) é falha viva e alimenta o
/// breaker — não vira `pending`.
#[tokio::test]
async fn live_failed_em_timeout_do_cliente() {
    let (base, fake) = start().await;
    fake.set_mode(Mode::Hang);
    let client = MicoClient::new(MicoConfig {
        breaker_failures: 1,
        ..config(&base, 60)
    })
    .expect("client");
    let collector = MicoCollector::new(client);
    let batch = collector
        .collect(job_at(deadline_soon()))
        .await
        .expect("coleta");
    assert_failed(&batch);
    assert_eq!(collector.client().breaker().failures(), 1);
}

/// Deadline do coletor já vencido: o Node também teria a consulta em voo
/// (`pending`), então o lote é parcial e NÃO faz rede nem conta falha.
#[tokio::test]
async fn pending_quando_o_deadline_ja_venceu() {
    let (base, fake) = start().await;
    let client = MicoClient::new(config(&base, 1_500)).expect("client");
    let collector = MicoCollector::new(client);
    let batch = collector
        .collect(job_at(now_ms() - 1))
        .await
        .expect("coleta");
    assert!(batch.items.is_empty());
    assert!(batch.partial, "consulta não concluída no prazo");
    let live = live_of(&batch);
    assert_eq!(live.pending, BTreeSet::from([MICO_LIVE_KEY.to_string()]));
    assert!(live.failed.is_empty() && live.empty.is_empty());
    assert_eq!(live.all, LiveAllState::Unknown);
    assert_eq!(fake.hits(), 0, "pending não faz rede");
    assert_eq!(collector.client().breaker().failures(), 0);
}

/// O deadline vence DURANTE a consulta (timeout efetivo = restante): `pending`,
/// parcial e sem falha no breaker — como o `noteStart` sem `noteResult` do Node.
#[tokio::test]
async fn pending_quando_o_deadline_vence_durante_a_consulta() {
    let (base, fake) = start().await;
    fake.set_mode(Mode::Hang);
    let client = MicoClient::new(MicoConfig {
        breaker_failures: 1,
        ..config(&base, 5_000)
    })
    .expect("client");
    let collector = MicoCollector::new(client);
    let batch = collector
        .collect(job_at(now_ms() + 40))
        .await
        .expect("coleta");
    assert!(batch.partial);
    let live = live_of(&batch);
    assert_eq!(live.pending, BTreeSet::from([MICO_LIVE_KEY.to_string()]));
    assert!(live.failed.is_empty());
    assert_eq!(collector.client().breaker().failures(), 0);
}
