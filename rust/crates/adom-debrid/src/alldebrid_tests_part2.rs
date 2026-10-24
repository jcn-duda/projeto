use super::super::AccountStatus;
use super::*;

#[tokio::test]
async fn upload_separa_cache_e_apaga_so_o_que_pode() {
    let scene = mock(&sample_upload(), &empty_ok(), &empty_ok());
    let ad = open(listen(scene.clone()).await);
    let report = ad
        .check_cached(API_KEY, &asked(), &cache_opts(true))
        .await
        .unwrap();
    assert_eq!(report.cached, vec![hash_of('a'), hash_of('b')]);
    assert!(report.complete);
    assert_eq!(report.deleted, vec!["101".to_string(), "103".to_string()]);
    let plan = report.cleanup.expect("plano com a flag ON");
    plan.run_with(
        &ad,
        API_KEY,
        crate::alldebrid_delete::DeleteConfig {
            kill: Some(false),
            ..crate::alldebrid_delete::DeleteConfig::fast()
        },
    )
    .await
    .expect("fila rodou");
    let seen = hits(&scene);
    assert!(seen.iter().all(|hit| hit.auth_ok
        && hit.method == "GET"
        && hit.query.starts_with("agent=stremio-adom")));
    let upload: Vec<&Hit> = seen
        .iter()
        .filter(|hit| hit.path == "/magnet/upload")
        .collect();
    assert_eq!(upload.len(), 1);
    assert_eq!(
        values(&upload[0].query, "magnets[]"),
        asked()
            .into_iter()
            .filter(|hash| !hash.starts_with('f'))
            .collect::<Vec<_>>()
    );
    let deleted: Vec<&Hit> = seen
        .iter()
        .filter(|hit| hit.path == "/magnet/delete")
        .collect();
    // A fila manda um GET por id (4 workers); a ordem não é contrato.
    assert_eq!(deleted.len(), 2);
    let mut ids: Vec<String> = deleted
        .iter()
        .flat_map(|hit| values(&hit.query, "id"))
        .collect();
    ids.sort();
    assert_eq!(ids, vec!["101".to_string(), "103".to_string()]);
}

#[tokio::test]
async fn inventario_fechado_nao_chama_delete() {
    // Chave própria: o snapshot `knownBefore` é global por conta e outro teste
    // não pode deixar um snapshot vazio fresco aqui.
    const KEY: &str = "ad-inventory-closed";
    let scene = mock(&sample_upload(), &empty_ok(), &empty_ok());
    let ad = open(listen(scene.clone()).await);
    let report = ad
        .check_cached(KEY, &asked(), &cache_opts(false))
        .await
        .unwrap();
    assert_eq!(report.cached, vec![hash_of('a'), hash_of('b')]);
    assert!(report.deleted.is_empty());
    let plan = report.cleanup.expect("flag ON produz plano");
    assert_eq!(
        plan.suppressed,
        Some(crate::alldebrid_cleanup::CleanupSuppressed::InventoryMissing)
    );
    // O refresh em fundo pode consultar `/magnet/status`; delete, nunca.
    assert!(hits(&scene).iter().all(|hit| hit.path != "/magnet/delete"));
}

#[tokio::test]
async fn status_error_classifica_auth_quota_e_deixa_o_resto_so_com_mensagem() {
    let cases = [
        (
            r#"{"status":"error","error":{"code":"AUTH_BAD_APIKEY","message":"chave recusada"}}"#,
            "auth",
            "chave recusada (AUTH_BAD_APIKEY)",
        ),
        (
            r#"{"status":"error","error":{"code":"MAGNET_TOO_MANY_ACTIVE","message":"cheio"}}"#,
            "quota",
            "cheio (MAGNET_TOO_MANY_ACTIVE)",
        ),
        (
            // Teto real de 1000 magnets (sem `_ACTIVE`): precisa sair como quota
            // para o `/resolve` nativo devolver 502 explícito, nunca 404.
            r#"{"status":"error","error":{"code":"MAGNET_TOO_MANY","message":"Magnets limit reached"}}"#,
            "quota",
            "Magnets limit reached (MAGNET_TOO_MANY)",
        ),
        (
            // Igual ao `batched` do TS: erro genérico do envelope vira "nenhum lote".
            r#"{"status":"error","error":{"code":"MAGNET_NOPE","message":"ruim"}}"#,
            "other",
            "nenhum lote de checagem de cache respondeu",
        ),
    ];
    for (body, kind, message) in cases {
        let scene = Arc::new(Mock {
            hits: Mutex::new(Vec::new()),
            upload: empty_ok(),
            status_body: empty_ok(),
            unlock: empty_ok(),
            error_body: Some(body.into()),
            delete_status: 200,
        });
        let ad = open(listen(scene).await);
        let err = ad
            .check_cached(API_KEY, &[hash_of('a')], &CheckOpts::default())
            .await
            .unwrap_err();
        assert_eq!(err.kind(), kind);
        assert_eq!(err.message(), message);
    }
}

#[tokio::test]
async fn falha_de_delete_nao_repete_nem_derruba_o_veredito() {
    let scene = Arc::new(Mock {
        hits: Mutex::new(Vec::new()),
        upload: envelope(json!({"magnets": [{"hash": hash_of('c'), "ready": false, "id": 103}]})),
        status_body: empty_ok(),
        unlock: empty_ok(),
        error_body: None,
        delete_status: 500,
    });
    let ad = open(listen(scene.clone()).await);
    let opts = CheckOpts {
        drop_uncached: true,
        inventory_loaded: true,
        cleanup: crate::alldebrid_cleanup::CleanupMode::On,
        holds_complete: true,
        kill_switch: Some(false),
        ..CheckOpts::default()
    };
    // Igual ao Node: a checagem devolve o veredito sem esperar o delete; a
    // falha da fila não vira erro da checagem.
    let report = ad
        .check_cached(API_KEY, &[hash_of('c')], &opts)
        .await
        .unwrap();
    assert!(report.complete);
    assert_eq!(report.cached, Vec::<String>::new());
    assert_eq!(report.deleted, vec!["103".to_string()]);
    assert!(hits(&scene).iter().all(|hit| hit.path != "/magnet/delete"));
    // A fila tenta 3× na 1ª rodada e 3× na 2ª (sem espera no teste).
    let queue = crate::alldebrid_delete::delete_with_backoff(
        &ad,
        API_KEY,
        &report.deleted,
        crate::alldebrid_delete::DeleteConfig {
            delays: vec![
                std::time::Duration::ZERO,
                std::time::Duration::ZERO,
                std::time::Duration::ZERO,
            ],
            kill: Some(false),
            ..crate::alldebrid_delete::DeleteConfig::fast()
        },
    )
    .await;
    assert!(queue.removed.is_empty());
    assert_eq!(queue.failed, vec!["103".to_string()]);
    assert_eq!(queue.attempts, 6);
    assert_eq!(
        hits(&scene)
            .iter()
            .filter(|hit| hit.path == "/magnet/delete")
            .count(),
        6
    );
}

#[tokio::test]
async fn account_status_conta_estados_e_o_mais_antigo() {
    let body = envelope(json!({"magnets": [
        {"ready": true, "status": "Downloading", "uploadDate": 100},
        {"status": "ready", "uploadDate": 10},
        {"status": "Queued", "uploadDate": 40},
        {"status": "Failed", "uploadDate": 0},
        {"status": ""}
    ]}));
    let scene = mock(&empty_ok(), &body, &empty_ok());
    let ad = open(listen(scene.clone()).await);
    let got = ad.account_status(API_KEY).await.unwrap();
    assert_eq!(
        got,
        AccountStatus {
            magnets: 5,
            ready: 2,
            active: 1,
            error: 1,
            oldest_at: Some(10)
        }
    );
    let seen = hits(&scene);
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].path, "/magnet/status");
    assert_eq!(seen[0].query, "agent=stremio-adom");
    assert!(seen[0].auth_ok);
}
