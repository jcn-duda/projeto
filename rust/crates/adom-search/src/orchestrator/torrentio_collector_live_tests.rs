//! Matriz do `live` do coletor Torrentio contra servidor falso: ok/empty/4xx/
//! 429/5xx/JSON inválido/rede/timeout/breaker aberto + `pending` ausente.

use super::test_support::*;
use super::*;
use adom_sources::TorrentioConfig;

#[tokio::test]
async fn live_ok_quando_a_resposta_tem_item_relevante() {
    let (base, fake) = start(Mode::Ok).await;
    let batch = collect_at(&base, 1_500).await;
    assert_eq!(fake.hits(), 1);
    assert_eq!(batch.items.len(), 1);
    let item = &batch.items[0];
    assert_eq!(item.indexer.as_deref(), Some("torrentio"));
    assert_eq!(item.extra.get("fileIdx"), Some(&serde_json::json!(1)));
    let live = batch.live.as_ref().expect("live");
    assert!(live.failed.is_empty() && live.empty.is_empty());
    assert_no_pending_and_unknown_all(live);
    assert!(!live.has_any_failure());
}

#[tokio::test]
async fn live_empty_quando_a_resposta_e_vazia() {
    let (base, _fake) = start(Mode::Empty).await;
    let batch = collect_at(&base, 1_500).await;
    assert!(batch.items.is_empty());
    assert_empty(&batch);
}

/// 200 com item de OUTRA obra é vazio suspeito (`relevant: 0`), mas o item
/// continua no lote — quem filtra é o build, como no Node.
#[tokio::test]
async fn live_empty_quando_nada_e_relevante() {
    let (base, _fake) = start(Mode::Irrelevant).await;
    let batch = collect_at(&base, 1_500).await;
    assert_eq!(batch.items.len(), 1);
    assert_empty(&batch);
}

/// 4xx (salvo 429) pertence à obra: o Node NÃO abre o breaker e devolve `[]`.
/// O host está vivo, então não é falha viva — é vazio suspeito.
#[tokio::test]
async fn http_400_vira_vazio_sem_falha_e_sem_abrir_breaker() {
    let (base, fake) = start(Mode::Http400).await;
    let client = TorrentioClient::new(TorrentioConfig {
        breaker_failures: 1,
        ..config(&base, 1_500)
    })
    .expect("client");
    let collector = TorrentioCollector::new(client);
    let batch = collector.collect(base_job()).await.expect("coleta");
    assert_eq!(fake.hits(), 1);
    assert!(batch.items.is_empty());
    assert_empty(&batch);
    assert_eq!(
        collector.client().breaker().failures(),
        0,
        "4xx não alimenta o breaker"
    );
}

#[tokio::test]
async fn live_failed_em_http_429() {
    let (base, fake) = start(Mode::Http429).await;
    assert_failed(&collect_at(&base, 1_500).await);
    assert_eq!(fake.hits(), 1);
}

#[tokio::test]
async fn live_failed_em_http_5xx() {
    let (base, _fake) = start(Mode::Http500).await;
    assert_failed(&collect_at(&base, 1_500).await);
}

#[tokio::test]
async fn live_failed_em_json_invalido() {
    let (base, _fake) = start(Mode::InvalidJson).await;
    assert_failed(&collect_at(&base, 1_500).await);
}

#[tokio::test]
async fn live_failed_em_timeout() {
    let (base, _fake) = start(Mode::Hang).await;
    assert_failed(&collect_at(&base, 80).await);
}

#[tokio::test]
async fn live_failed_em_falha_de_rede() {
    // Porta efêmera aberta e fechada em seguida: conexão recusada (o reqwest
    // classifica como timeout ou rede, dependendo do sistema — os dois são
    // falha do host).
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    drop(listener);
    assert_failed(&collect_at(&format!("http://{addr}"), 1_500).await);
}

/// Breaker ABERTO é consulta prometida e não feita: falha viva (conservadora —
/// mantém 📦/selo do que não foi provado). Nenhuma rede.
#[tokio::test]
async fn live_failed_quando_o_breaker_esta_aberto() {
    let (base, fake) = start(Mode::Http500).await;
    let client = TorrentioClient::new(TorrentioConfig {
        breaker_failures: 1,
        ..config(&base, 1_500)
    })
    .expect("client");
    let collector = TorrentioCollector::new(client);
    assert_failed(&collector.collect(base_job()).await.expect("coleta"));
    assert_eq!(fake.hits(), 1, "abriu na primeira falha");

    let batch = collector.collect(base_job()).await.expect("coleta");
    assert_eq!(fake.hits(), 1, "aberto não faz rede");
    let live = batch.live.as_ref().expect("live");
    assert!(live.failed.contains(TORRENTIO_LIVE_KEY));
    assert_no_pending_and_unknown_all(live);
}
