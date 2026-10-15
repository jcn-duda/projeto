//! Play do TorBox: poll, requestdl e status da conta. Servidor falso.

use std::time::{Duration, Instant};

use super::torbox_tests::{listen, movie, open, Kind, Mode, H1, KEY};
use super::AccountStatus;

#[tokio::test]
async fn resolve_feliz_com_poll_e_requestdl() {
    let (addr, mock) = listen(Mode::Resolve(Kind::Happy), 200, "", None).await;
    let svc = open(addr);
    let magnet = format!("magnet:?xt=urn:btih:{H1}&dn=Filme");
    let started = Instant::now();
    let url = svc
        .resolve_link(KEY, H1, &movie(), Some(&magnet), Duration::ZERO)
        .await
        .unwrap();
    assert!(started.elapsed() < Duration::from_millis(1500));
    assert_eq!(url.as_deref(), Some("https://dl.test/movie.mkv")); // data.url
    let hits = mock.hits.lock().unwrap();
    assert!(hits.iter().all(|hit| hit.auth_ok));
    let post = hits
        .iter()
        .find(|hit| hit.path == "/torrents/createtorrent")
        .unwrap();
    assert_eq!(post.method, "POST");
    assert!(post
        .content_type
        .starts_with("application/x-www-form-urlencoded"));
    assert!(post.body.starts_with("magnet="));
    assert!(post.body.ends_with("&seed=3&allow_zip=false"));
    assert!(post.body.contains("magnet%3A%3F"));
    assert!(post.body.contains("dn%3DFilme"));
    assert!(post.body.contains(H1));
    assert!(!post.body.contains("opentrackr"));
    assert!(!post.body.contains(KEY));
    let polls: Vec<_> = hits
        .iter()
        .filter(|hit| hit.path == "/torrents/mylist")
        .collect();
    assert_eq!(polls.len(), 2);
    assert!(polls
        .iter()
        .all(|hit| hit.query.contains("id=42") && hit.query.contains("bypass_cache=true")));
    let dl = hits
        .iter()
        .find(|hit| hit.path == "/torrents/requestdl")
        .unwrap();
    assert!(dl.token_ok);
    assert!(dl.query.contains("torrent_id=42"));
    assert!(dl.query.contains("file_id=7"));
    assert!(dl.query.contains("redirect=false"));
}

#[tokio::test]
async fn sem_id_devolve_none() {
    let (addr, mock) = listen(Mode::Resolve(Kind::NoId), 200, "", None).await;
    let svc = open(addr);
    let url = svc
        .resolve_link(KEY, H1, &movie(), None, Duration::ZERO)
        .await
        .unwrap();
    assert_eq!(url, None);
    let hits = mock.hits.lock().unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].path, "/torrents/createtorrent");
}

#[tokio::test]
async fn quatro_polls_sem_pronto_devolve_none() {
    let (addr, mock) = listen(Mode::Resolve(Kind::Stuck), 200, "", None).await;
    let svc = open(addr);
    let started = Instant::now();
    let url = svc
        .resolve_link(KEY, H1, &movie(), None, Duration::ZERO)
        .await
        .unwrap();
    assert!(started.elapsed() < Duration::from_millis(1500));
    assert_eq!(url, None);
    let hits = mock.hits.lock().unwrap();
    assert_eq!(
        hits.iter()
            .filter(|hit| hit.path == "/torrents/mylist")
            .count(),
        4
    );
    assert!(hits.iter().all(|hit| hit.path != "/torrents/requestdl"));
    let post = hits
        .iter()
        .find(|hit| hit.path == "/torrents/createtorrent")
        .unwrap();
    assert!(post.body.contains("opentrackr"));
    assert!(post.body.ends_with("&seed=3&allow_zip=false"));
    assert!(!post.body.contains(KEY));
}

#[tokio::test]
async fn pick_sem_video_e_erro() {
    let (addr, mock) = listen(Mode::Resolve(Kind::NoVideo), 200, "", None).await;
    let svc = open(addr);
    let err = svc
        .resolve_link(KEY, H1, &movie(), None, Duration::ZERO)
        .await
        .unwrap_err();
    assert_eq!(err.kind(), "no_video");
    let hits = mock.hits.lock().unwrap();
    assert!(hits.iter().all(|hit| hit.path != "/torrents/requestdl"));
}

#[tokio::test]
async fn conta_conta_magnet_pronto_e_ativo() {
    let (addr, mock) = listen(Mode::Account, 200, "", None).await;
    let svc = open(addr);
    let status: AccountStatus = svc.account_status(KEY).await.unwrap();
    assert_eq!(status.magnets, 5);
    assert_eq!(status.ready, 1);
    assert_eq!(status.active, 3);
    let hits = mock.hits.lock().unwrap();
    assert_eq!(hits.len(), 1);
    assert!(hits[0].auth_ok);
    assert_eq!(hits[0].method, "GET");
    assert_eq!(hits[0].path, "/torrents/mylist");
    assert!(hits[0].query.is_empty());
    assert!(!hits[0].body.contains(KEY));
}
