//! Conta e limite ativo do Real-Debrid contra o servidor falso.

use std::sync::atomic::Ordering;

use super::realdebrid_tests::{assert_clean, listen, open, Scene, KEY};
use super::AccountStatus;

#[tokio::test]
async fn account_status_conta_ready_active_e_error() {
    let (addr, mock) = listen(Scene::Account).await;
    let svc = open(addr);
    let status = svc.account_status(KEY).await.unwrap();
    assert_eq!(
        status,
        AccountStatus {
            magnets: 8,
            ready: 2,
            active: 2,
            error: 4,
            premium_until: Some(1_609_459_200_000)
        }
    );
    let recs = mock.recs.lock().unwrap();
    assert_eq!(recs.len(), 2);
    assert_eq!(recs[0].path, "/user");
    assert_eq!(recs[1].path, "/torrents");
    assert_eq!(recs[1].query, "limit=2500&offset=0");
    drop(recs);
    assert_clean(&mock);
}

#[tokio::test]
async fn active_count_finito_ou_none() {
    let (addr, mock) = listen(Scene::ActiveOk).await;
    let svc = open(addr);
    let count = svc.active_count(KEY).await.unwrap().unwrap();
    assert_eq!((count.nb, count.limit), (4.0, 25.0));
    assert_clean(&mock);
    let (addr, mock) = listen(Scene::ActiveBad).await;
    let svc = open(addr);
    assert!(svc.active_count(KEY).await.unwrap().is_none());
    assert_eq!(mock.hits.load(Ordering::SeqCst), 1);
    assert_clean(&mock);
    let (addr, mock) = listen(Scene::ActiveNan).await;
    let svc = open(addr);
    assert!(svc.active_count(KEY).await.unwrap().is_none());
    assert_clean(&mock);
}
