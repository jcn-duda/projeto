use std::collections::HashSet;

use super::*;

#[tokio::test]
async fn timeout_de_um_lote_preserva_o_hit_do_outro() {
    let (ad, scene) = open_scene(Behavior::SlowBatch('b'), Duration::from_millis(400)).await;
    let asked = vec![hash_of('a'), hash_of('b')];
    let report = ad
        .check_cached_report(API_KEY, &asked, &opts(1, 120))
        .await
        .unwrap();
    assert!(!report.complete);
    assert!(report.attempted);
    assert_eq!(report.cached, vec![hash_of('a')], "hit parcial sobrevive");
    let uploads = upload_hits(&scene);
    assert_eq!(uploads.len(), 2);
}

#[tokio::test]
async fn auth_quota_e_rate_limit_sobem_classificados() {
    let cases = [
        (
            Behavior::PayloadError("AUTH_BAD_APIKEY", "chave recusada"),
            "auth",
        ),
        (
            Behavior::PayloadError("MAGNET_TOO_MANY_ACTIVE", "cheio"),
            "quota",
        ),
        (Behavior::RateLimit, "rate_limit"),
    ];
    for (behavior, kind) in cases {
        let (ad, _scene) = open_scene(behavior, Duration::ZERO).await;
        let failure = ad
            .check_cached_report(API_KEY, &[hash_of('a')], &opts(25, 1_000))
            .await
            .unwrap_err();
        assert_eq!(failure.error.kind(), kind);
        assert!(failure.attempted, "{kind}: o upload foi enviado");
        assert!(!failure.error.message().contains(API_KEY));
    }
}

#[tokio::test]
async fn lote_quebrado_nao_derruba_o_hit_do_outro_e_todos_quebrados_e_erro() {
    let (ad, _scene) = open_scene(Behavior::BrokenBatch('b'), Duration::ZERO).await;
    let report = ad
        .check_cached_report(API_KEY, &[hash_of('a'), hash_of('b')], &opts(1, 2_000))
        .await
        .unwrap();
    assert!(!report.complete);
    assert_eq!(report.cached, vec![hash_of('a')]);

    let (ad, _scene) = open_scene(Behavior::BrokenBatch('a'), Duration::ZERO).await;
    let failure = ad
        .check_cached_report(API_KEY, &[hash_of('a')], &opts(25, 2_000))
        .await
        .unwrap_err();
    assert_eq!(failure.error.kind(), "other");
    assert_eq!(
        failure.error.message(),
        "nenhum lote de checagem de cache respondeu"
    );
}

#[tokio::test]
async fn bloqueado_nao_e_enviado_e_o_resto_sobe() {
    let (ad, scene) = open_scene(Behavior::AllReady, Duration::ZERO).await;
    let opts = super::super::CheckOpts {
        blocked: HashSet::from([hash_of('a')]),
        ..opts(25, 1_000)
    };
    // Lote 100% bloqueado: nada sobe e o vazio conhecido continua verdadeiro.
    let sozinho = ad
        .check_cached_report(API_KEY, &[hash_of('a')], &opts)
        .await
        .unwrap();
    assert!(sozinho.cached.is_empty());
    assert_eq!(sozinho.blocked, vec![hash_of('a')]);
    assert!(sozinho.complete, "vazio conhecido, não 'não sei'");
    assert!(!sozinho.attempted);
    assert!(upload_hits(&scene).is_empty());

    // Misturado: só o não bloqueado vai ao `/magnet/upload`; o filtrado volta no
    // relatório para o escape do Node (prova de pronto no inventário).
    let misto = ad
        .check_cached_report(API_KEY, &[hash_of('a'), hash_of('b')], &opts)
        .await
        .unwrap();
    assert_eq!(misto.cached, vec![hash_of('b')]);
    assert_eq!(misto.blocked, vec![hash_of('a')]);
    assert!(misto.complete);
    assert!(misto.attempted);
    let uploads = upload_hits(&scene);
    assert_eq!(uploads.len(), 1);
    assert_eq!(uploads[0].hashes, vec![hash_of('b')], "bloqueado não sobe");
}

#[tokio::test]
async fn falha_de_delete_nao_muda_o_veredito() {
    let (ad, scene) = open_scene(Behavior::AllReady, Duration::ZERO).await;
    // O mock sempre responde 200 no delete; este teste garante que a limpeza
    // pedida (inventário carregado) não segura nem altera o cache. A fila roda
    // DEPOIS, fora do prazo da checagem.
    let opts = super::super::CheckOpts {
        drop_ready: true,
        drop_uncached: true,
        inventory_loaded: true,
        cleanup: crate::alldebrid_cleanup::CleanupMode::On,
        holds_complete: true,
        ..opts(25, 1_000)
    };
    let report = ad
        .check_cached(API_KEY, &[hash_of('a')], &opts)
        .await
        .unwrap();
    assert_eq!(report.cached, vec![hash_of('a')]);
    assert!(report.complete);
    assert_eq!(report.deleted.len(), 1);
    assert_eq!(scene.deletes.load(Ordering::SeqCst), 0);
    let queue = crate::alldebrid_delete::delete_with_backoff(
        &ad,
        API_KEY,
        &report.deleted,
        crate::alldebrid_delete::DeleteConfig::fast(),
    )
    .await;
    assert_eq!(queue.removed, vec![report.deleted[0].clone()]);
    assert!(queue.failed.is_empty());
    assert_eq!(scene.deletes.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn quota_na_checagem_nao_agenda_limpeza() {
    // Conta no teto: o upload devolve quota (unusable) e não há magnet ecoado
    // para apagar. A limpeza nunca é a saída para a conta cheia.
    let (ad, scene) = open_scene(
        Behavior::PayloadError("MAGNET_TOO_MANY_ACTIVE", "cheio"),
        Duration::ZERO,
    )
    .await;
    let opts = super::super::CheckOpts {
        drop_ready: true,
        drop_uncached: true,
        inventory_loaded: true,
        cleanup: crate::alldebrid_cleanup::CleanupMode::On,
        holds_complete: true,
        ..opts(25, 1_000)
    };
    let failure = ad
        .check_cached_report(API_KEY, &[hash_of('a')], &opts)
        .await
        .unwrap_err();
    assert_eq!(failure.error.kind(), "quota");
    assert!(failure.attempted);
    assert_eq!(scene.deletes.load(Ordering::SeqCst), 0);
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn env_controla_lote_e_timeout() {
    // O servidor sobe ANTES do lock: `open()` também pega o lock de env, e
    // pegá-lo duas vezes no mesmo teste trava a suíte.
    let scene = scene(Behavior::AllReady, Duration::ZERO);
    let addr = listen(scene.clone()).await;
    let _lock = crate::test_env::lock();
    let previous_base = std::env::var("ALLDEBRID_API_BASE").ok();
    let previous_batch = std::env::var("DEBRID_BATCH_SIZE").ok();
    let previous_timeout = std::env::var("DEBRID_CACHE_CHECK_TIMEOUT_MS").ok();
    unsafe {
        std::env::set_var("ALLDEBRID_API_BASE", format!("http://{addr}"));
        std::env::set_var("DEBRID_BATCH_SIZE", "2");
        std::env::set_var("DEBRID_CACHE_CHECK_TIMEOUT_MS", "2000");
    }
    let ad = AllDebrid::new(crate::http::HttpClient::new().unwrap());
    let asked = hashes(5, 'e');
    let opts = super::super::CheckOpts {
        batch_size: None,
        timeout: None,
        ..super::super::CheckOpts::default()
    };
    let report = ad.check_cached(API_KEY, &asked, &opts).await.unwrap();
    assert!(report.complete);
    let uploads = upload_hits(&scene);
    assert_eq!(uploads.len(), 3, "5 hashes / 2 por lote");
    restore("ALLDEBRID_API_BASE", previous_base);
    restore("DEBRID_BATCH_SIZE", previous_batch);
    restore("DEBRID_CACHE_CHECK_TIMEOUT_MS", previous_timeout);
}

fn restore(name: &str, value: Option<String>) {
    unsafe {
        match value {
            Some(value) => std::env::set_var(name, value),
            None => std::env::remove_var(name),
        }
    }
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn base_recusada_nao_tenta_upload() {
    let _lock = crate::test_env::lock();
    let previous = std::env::var("ALLDEBRID_API_BASE").ok();
    unsafe { std::env::set_var("ALLDEBRID_API_BASE", "http://evil.test") };
    let ad = AllDebrid::new(crate::http::HttpClient::new().unwrap());
    let failure = ad
        .check_cached_report(API_KEY, &[hash_of('a')], &opts(25, 1_000))
        .await
        .unwrap_err();
    assert_eq!(failure.error.kind(), "other");
    assert!(!failure.attempted);
    restore("ALLDEBRID_API_BASE", previous);
}
