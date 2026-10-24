use super::*;

#[tokio::test]
async fn check_cached_nao_faz_http_e_o_complete_segue_o_known() {
    let (addr, mock) = listen(Scene::Idle).await;
    let svc = open(addr);
    let unknown = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    let miss = "cccccccccccccccccccccccccccccccccccccccc";
    let report = svc.check_cached(&[HASH_UP, unknown, miss, HASH], |hash| {
        assert_eq!(hash, hash.to_ascii_lowercase());
        if hash == HASH {
            Some(true)
        } else if hash == miss {
            Some(false)
        } else {
            None
        }
    });
    assert_eq!(report.cached, vec![HASH.to_string()]);
    assert!(!report.complete);
    let known = svc.check_cached(&[HASH, miss], |hash| Some(hash == HASH));
    assert_eq!(known.cached, vec![HASH.to_string()]);
    assert!(known.complete);
    assert_eq!(mock.hits.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn add_magnet_451_e_blocked_sem_select_nem_unrestrict() {
    let (addr, mock) = listen(Scene::Blocked).await;
    let svc = open(addr);
    let err = play(&svc, Some("https://cdn.example/nope"))
        .await
        .unwrap_err();
    assert_eq!(err.kind(), "blocked");
    assert_eq!(
        paths(&mock),
        vec![
            "GET /torrents".to_string(),
            "POST /torrents/addMagnet".to_string()
        ]
    );
    assert_clean(&mock);
}

#[tokio::test]
async fn torrent_baixado_pula_add_magnet() {
    let (addr, mock) = listen(Scene::Ready).await;
    let svc = open(addr);
    assert_eq!(play(&svc, None).await.unwrap().as_deref(), Some(DOWNLOAD));
    assert_eq!(
        paths(&mock),
        vec![
            "GET /torrents".to_string(),
            "GET /torrents/info/READY1".to_string(),
            "POST /unrestrict/link".to_string(),
        ]
    );
    assert_clean(&mock);
}

#[tokio::test]
async fn dubbed_prometido_com_grupo_en_vira_dub_lie_sem_unrestrict() {
    let (addr, mock) = listen(Scene::DubLie).await;
    let svc = open(addr);
    let hint = PlayHint {
        dubbed: true,
        ..PlayHint::default()
    };
    let err = svc
        .resolve_link(KEY, HASH, &hint, None, Duration::ZERO)
        .await
        .unwrap_err();
    assert_eq!(err.kind(), "dub_lie");
    assert_eq!(
        paths(&mock),
        vec![
            "GET /torrents".to_string(),
            "GET /torrents/info/READY1".to_string(),
        ]
    );
    assert_clean(&mock);
}

#[tokio::test]
async fn fluxo_select_files_204_e_unrestrict() {
    let (addr, mock) = listen(Scene::Flow).await;
    let svc = open(addr);
    let magnet = format!("magnet:?xt=urn:btih:{HASH}&dn=KeepMe");
    assert_eq!(
        play(&svc, Some(&magnet)).await.unwrap().as_deref(),
        Some(DOWNLOAD)
    );
    assert_eq!(
        paths(&mock),
        vec![
            "GET /torrents".to_string(),
            "POST /torrents/addMagnet".to_string(),
            "GET /torrents/info/NEW1".to_string(),
            "POST /torrents/selectFiles/NEW1".to_string(),
            "GET /torrents/info/NEW1".to_string(),
            "POST /unrestrict/link".to_string(),
        ]
    );
    assert_clean(&mock);
}

#[tokio::test]
async fn no_video_dispara_um_unico_delete() {
    let (addr, mock) = listen(Scene::NoVideo).await;
    let svc = open(addr);
    let err = play(&svc, None).await.unwrap_err();
    assert_eq!(err.kind(), "no_video");
    assert_eq!(mock.deletes.load(Ordering::SeqCst), 1);
    let seen = paths(&mock);
    assert!(!seen
        .iter()
        .any(|path| path.contains("selectFiles") || path.contains("unrestrict")));
    assert_clean(&mock);
}

#[test]
fn base_so_https_ou_loopback() {
    assert!(super::super::accepted_base("https://api.real-debrid.com/rest/1.0/").is_ok());
    assert!(super::super::accepted_base("http://127.0.0.1:9").is_ok());
    assert!(super::super::accepted_base("http://localhost:9").is_ok());
    assert!(super::super::accepted_base("http://example.com").is_err());
    let svc = with_env(Some("http://example.com"), || {
        RealDebrid::new(HttpClient::new().expect("cliente"))
    });
    assert!(svc.base.is_empty());
}
