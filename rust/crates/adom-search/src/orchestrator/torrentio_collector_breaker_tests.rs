//! Breaker do coletor Torrentio (vivo abre/reseta; sombra read-only ignora) e
//! as não-consultas (priority/late_sweep/providers/disabled/args/SSRF).

use super::test_support::*;
use super::*;
use crate::orchestrator::live_state::LiveAllState;
use adom_sources::TorrentioConfig;

/// Caminho VIVO: 5xx alimenta o circuito, aberto bloqueia a rede e um sucesso
/// abaixo do limiar reseta.
#[tokio::test]
async fn vivo_abre_e_reseta_o_breaker() {
    let (base, fake) = start(Mode::Http500).await;
    let client = TorrentioClient::new(TorrentioConfig {
        breaker_failures: 2,
        ..config(&base, 1_500)
    })
    .expect("client");
    let collector = TorrentioCollector::new(client);

    // Falha 1 (abaixo do limiar): circuito fechado, ainda consulta.
    assert_failed(&collector.collect(base_job()).await.expect("coleta"));
    assert_eq!(collector.client().breaker().failures(), 1);
    assert!(!collector
        .client()
        .breaker()
        .is_open(collector.client().config(), adom_sources::now_ms()));

    // Falha 2 → abre e a próxima não vai à rede.
    assert_failed(&collector.collect(base_job()).await.expect("coleta"));
    assert_eq!(collector.client().breaker().failures(), 2);
    assert_eq!(fake.hits(), 2);
    let _ = collector.collect(base_job()).await.expect("coleta");
    assert_eq!(fake.hits(), 2, "aberto não faz nova requisição");

    // Caminho vivo com sucesso abaixo do limiar fecha o circuito.
    let (base_ok, fake_ok) = start(Mode::Http500).await;
    let client = TorrentioClient::new(TorrentioConfig {
        breaker_failures: 2,
        ..config(&base_ok, 1_500)
    })
    .expect("client");
    let collector = TorrentioCollector::new(client);
    let _ = collector.collect(base_job()).await.expect("coleta");
    assert_eq!(collector.client().breaker().failures(), 1);
    fake_ok.set_mode(Mode::Ok);
    let batch = collector.collect(base_job()).await.expect("coleta");
    assert_eq!(batch.items.len(), 1);
    assert_eq!(
        collector.client().breaker().failures(),
        0,
        "sucesso no caminho vivo reseta"
    );
}

/// Sombra: ignora o circuito aberto, consulta e NÃO abre nem reseta.
#[tokio::test]
async fn sombra_read_only_nao_abre_nem_reseta_o_breaker() {
    let (base, fake) = start(Mode::Http500).await;
    let client = TorrentioClient::new(TorrentioConfig {
        breaker_failures: 1,
        ..config(&base, 1_500)
    })
    .expect("client");
    let shadow = TorrentioCollector::new(client).with_shadow(true);

    assert_failed(&shadow.collect(base_job()).await.expect("coleta"));
    assert_eq!(
        shadow.client().breaker().failures(),
        0,
        "sombra não alimenta o breaker"
    );
    assert_failed(&shadow.collect(base_job()).await.expect("coleta"));
    assert_eq!(
        fake.hits(),
        2,
        "referência consulta mesmo com falhas seguidas (sem breaker aberto)"
    );

    // Sucesso na sombra também não mexe no circuito (já zerado).
    fake.set_mode(Mode::Ok);
    let batch = shadow.collect(base_job()).await.expect("coleta");
    assert_eq!(batch.items.len(), 1);
    assert_eq!(fake.hits(), 3);
    assert_eq!(shadow.client().breaker().failures(), 0);
}

// ── Não-consultas: nada prometido, nada de falha sintética ─────────────

#[tokio::test]
async fn priority_e_late_sweep_nao_consultam_e_nao_inventam_falha() {
    let (base, fake) = start(Mode::Ok).await;
    let collector = collector_at(&base, 1_500);

    let priority = CollectJob {
        scope: TaskScope::Priority,
        priority: true,
        ..base_job()
    };
    let batch = collector.collect(priority).await.expect("ok");
    assert!(batch.items.is_empty());
    let live = batch.live.expect("live");
    assert!(!live.has_any_failure());
    assert_eq!(live.all, LiveAllState::Unknown);

    let late = CollectJob {
        late_sweep: true,
        ..base_job()
    };
    let batch = collector.collect(late).await.expect("ok");
    assert!(batch.items.is_empty());
    assert!(!batch.live.expect("live").has_any_failure());
    assert_eq!(fake.hits(), 0, "nenhuma rede");
}

#[tokio::test]
async fn fora_dos_providers_nao_consulta() {
    let (base, fake) = start(Mode::Ok).await;
    let collector = collector_at(&base, 1_500);
    let job = CollectJob {
        providers: vec!["jackett".into()],
        ..base_job()
    };
    let batch = collector.collect(job).await.expect("ok");
    assert!(batch.items.is_empty());
    assert!(!batch.live.expect("live").has_any_failure());
    assert_eq!(fake.hits(), 0);
}

#[tokio::test]
async fn disabled_fail_open_vazio_e_sem_falha_viva() {
    let (base, fake) = start(Mode::Ok).await;
    let client = TorrentioClient::new(TorrentioConfig {
        enabled: false,
        ..config(&base, 1_500)
    })
    .expect("client");
    let collector = TorrentioCollector::new(client);
    let batch = collector.collect(base_job()).await.expect("ok");
    assert!(batch.items.is_empty());
    assert!(!batch.partial);
    let live = batch.live.expect("live");
    assert!(!live.has_any_failure(), "kill-switch não é falha viva");
    assert_no_pending_and_unknown_all(&live);
    assert_eq!(fake.hits(), 0);
}

/// Base barrada pela guarda SSRF é configuração inválida, não consulta falha.
#[tokio::test]
async fn url_barrada_nao_vira_falha_viva() {
    let client = TorrentioClient::new(TorrentioConfig {
        url: "file:///etc/passwd".into(),
        ..config("http://127.0.0.1:9", 500)
    })
    .expect("client");
    let batch = TorrentioCollector::new(client)
        .collect(base_job())
        .await
        .expect("coleta");
    assert!(batch.items.is_empty());
    let live = batch.live.expect("live");
    assert!(!live.has_any_failure());
    assert_no_pending_and_unknown_all(&live);
}

/// Obra sem IMDb (args incompletos) não sai de rede e não inventa falha.
#[tokio::test]
async fn obra_sem_imdb_nao_consulta() {
    let (base, fake) = start(Mode::Ok).await;
    let collector = collector_at(&base, 1_500);
    let job = CollectJob {
        imdb_id: String::new(),
        ..base_job()
    };
    let batch = collector.collect(job).await.expect("ok");
    assert!(batch.items.is_empty());
    assert!(!batch.live.expect("live").has_any_failure());
    assert_eq!(fake.hits(), 0);
}
