//! directdl e escolha de arquivo do Premiumize.

use adom_core::PlayHint;

use super::premiumize_tests::{hash_at, listen, open, KEY};
use super::ContentFile;

#[tokio::test]
async fn directdl_prefere_stream_link_e_magnet_padrao() {
    let hash = hash_at("ab");
    let body = r#"{"status":"success","content":[{"path":"Filme.mkv","size":20000000,"stream_link":"https://cdn.test/stream","link":"https://cdn.test/plain"}]}"#;
    let (addr, hits) = listen(200, body, None).await;
    let pm = open(addr);
    let files: Vec<ContentFile> = pm.file_list(KEY, &hash, None, None).await.unwrap();
    assert_eq!(files[0].link, "https://cdn.test/stream");
    assert_eq!(files[0].size, 20_000_000);
    let url = pm
        .resolve_link(KEY, &hash, &PlayHint::default(), None)
        .await
        .unwrap();
    assert_eq!(url.as_deref(), Some("https://cdn.test/stream"));
    let seen = hits.lock().unwrap().clone();
    assert_eq!(seen[0].path, "/transfer/directdl");
    assert_eq!(seen[0].method, "POST");
    assert_eq!(seen[0].content_type, "application/x-www-form-urlencoded");
    assert!(seen[0].body.starts_with("src="));
    assert!(seen[0].body.contains(&hash));
    assert!(seen[0].body.contains("%3A"));
    assert!(seen[0].body.contains("opentrackr"));
    assert!(!seen[0].body.contains("magnet:?"));
    assert!(!seen[0].body.contains('&'));
    assert!(!seen[0].body.contains(KEY));
}

#[tokio::test]
async fn episodio_s01e02_usa_o_stream_link() {
    let hash = hash_at("cd");
    let body = r#"{"status":"success","content":[
        {"path":"Show.S01E01.mkv","size":20000000,"link":"https://cdn.test/e1"},
        {"path":"Show.S01E02.mkv","size":21000000,"stream_link":"https://cdn.test/e2","link":"https://cdn.test/e2-plain"}
    ]}"#;
    let (addr, _) = listen(200, body, None).await;
    let pm = open(addr);
    let hint = PlayHint {
        season: Some(1),
        episode: Some(2),
        work: None,
    };
    let url = pm.resolve_link(KEY, &hash, &hint, None).await.unwrap();
    assert_eq!(url.as_deref(), Some("https://cdn.test/e2"));
}

#[tokio::test]
async fn link_fresco_pelo_path_exato() {
    let hash = hash_at("ef");
    let wanted = "Pasta/O.Segredo.de.Widow's Bay.S01.Dub.EP-2.mp4";
    let body = r#"{"status":"success","content":[
        {"path":"Pasta/O.Segredo.de.Widow's Bay.S01.Dub.EP-1.mp4","size":1480,"link":"https://cdn.test/ep1"},
        {"path":"Pasta/O.Segredo.de.Widow's Bay.S01.Dub.EP-2.mp4","size":1320,"link":"https://cdn.test/ep2"}
    ]}"#;
    let (addr, hits) = listen(200, body, None).await;
    let pm = open(addr);
    let magnet = format!("magnet:?xt=urn:btih:{hash}&dn=Widow");
    let got = pm
        .fresh_file_link(KEY, &hash, wanted, Some(&magnet))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(got.url, "https://cdn.test/ep2");
    assert_eq!(got.size, 1320);
    let miss = pm
        .fresh_file_link(KEY, &hash, "Pasta/outro.mp4", Some(&magnet))
        .await
        .unwrap();
    assert!(miss.is_none());
    let seen = hits.lock().unwrap().clone();
    assert!(seen[0].body.contains("Widow"));
    assert!(seen[0].body.contains(&hash));
    assert!(!seen[0].body.contains("opentrackr"));
    assert!(!seen[0].body.contains(KEY));
}

#[tokio::test]
async fn resolve_vazio_e_sem_video() {
    let hash = hash_at("11");
    let (addr, _) = listen(200, r#"{"status":"success","content":[]}"#, None).await;
    let pm = open(addr);
    let none = pm
        .resolve_link(KEY, &hash, &PlayHint::default(), None)
        .await
        .unwrap();
    assert!(none.is_none());

    let (addr, _) = listen(
        200,
        r#"{"status":"success","content":[{"path":"leia.txt","size":4,"link":"https://cdn.test/x"}]}"#,
        None,
    )
    .await;
    let pm = open(addr);
    let err = pm
        .resolve_link(KEY, &hash, &PlayHint::default(), None)
        .await
        .unwrap_err();
    assert_eq!(err.kind(), "no_video");
    assert_eq!(
        err.message(),
        "o torrent não contém nenhum arquivo de vídeo"
    );
}
