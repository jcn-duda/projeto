//! Play do Debrid-Link contra o servidor falso.

use std::sync::atomic::Ordering;

use adom_core::PlayHint;

use super::debridlink_tests::{
    episode, harness, movie, of, play, snapshot, Scene, H1, MATRIX, S01E02, SHOW,
};

#[tokio::test]
async fn fluxo_feliz_escolhe_o_mkv_grande() {
    let (mock, svc, _reset) = harness(Scene::Happy).await;
    let link = play(&svc, &movie(), Some("magnet:?xt=urn:btih:nope"))
        .await
        .unwrap();
    assert_eq!(link.as_deref(), Some(MATRIX));
    let recs = snapshot(&mock);
    let adds = of(&recs, "/seedbox/add");
    let lists = of(&recs, "/seedbox/list");
    assert_eq!((adds.len(), lists.len()), (1, 2));
    assert_eq!(
        (adds[0].method.as_str(), adds[0].path.as_str()),
        ("POST", "/seedbox/add")
    );
    assert_eq!(adds[0].content_type, "application/x-www-form-urlencoded");
    assert!(adds[0].auth_ok, "Authorization Bearer ausente");
    assert!(adds[0].async_flag, "corpo do add sem async=true");
    assert!(adds[0].has_hash, "magnet padrao sem o hash");
    assert!(!adds[0].has_show);
    let lists_ok = lists
        .iter()
        .all(|rec| rec.method == "GET" && rec.auth_ok && rec.query == "ids=dl-item-42");
    assert!(lists_ok);
    assert!(!mock.bad.load(Ordering::SeqCst));
}

#[tokio::test]
async fn episodio_escolhe_s01e02_sem_listar() {
    let (mock, svc, _reset) = harness(Scene::Episode).await;
    let magnet = format!("magnet:?xt=urn:btih:{H1}&dn={SHOW}");
    let link = play(&svc, &episode(2), Some(&magnet)).await.unwrap();
    assert_eq!(link.as_deref(), Some(S01E02));
    let recs = snapshot(&mock);
    let adds = of(&recs, "/seedbox/add");
    assert_eq!(adds.len(), 1);
    assert!(of(&recs, "/seedbox/list").is_empty());
    assert_eq!(adds[0].method, "POST");
    assert!(adds[0].async_flag, "corpo do add sem async=true");
    assert!(adds[0].has_show, "magnet informado foi ignorado");
    assert!(adds[0].auth_ok, "Authorization Bearer ausente");
    assert_eq!(mock.hits.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn quatro_listas_sem_100_devolve_none() {
    let (mock, svc, _reset) = harness(Scene::Stuck).await;
    let link = play(&svc, &movie(), None).await.unwrap();
    assert!(link.is_none());
    let recs = snapshot(&mock);
    assert_eq!(of(&recs, "/seedbox/add").len(), 1);
    let lists = of(&recs, "/seedbox/list");
    assert_eq!(lists.len(), 4);
    assert!(lists
        .iter()
        .all(|rec| rec.method == "GET" && rec.query == "ids=dl-stuck"));
    assert!(of(&recs, "/seedbox/add")[0].async_flag);
    assert_eq!(mock.hits.load(Ordering::SeqCst), 5);
}

#[tokio::test]
async fn add_sem_id_devolve_none_sem_listar() {
    let (mock, svc, _reset) = harness(Scene::MissingId).await;
    let link = play(&svc, &movie(), None).await.unwrap();
    assert!(link.is_none());
    let recs = snapshot(&mock);
    assert_eq!(of(&recs, "/seedbox/add").len(), 1);
    assert!(of(&recs, "/seedbox/list").is_empty());
    assert_eq!(mock.hits.load(Ordering::SeqCst), 1);
    assert!(!mock.bad.load(Ordering::SeqCst));
}

#[tokio::test]
async fn success_false_em_200_e_other() {
    let (mock, svc, _reset) = harness(Scene::Failure).await;
    let err = play(&svc, &movie(), None).await.unwrap_err();
    assert_eq!(err.kind(), "other");
    assert_eq!(err.message(), "invalid api key");
    let recs = snapshot(&mock);
    assert_eq!(of(&recs, "/seedbox/add").len(), 1);
    assert!(of(&recs, "/seedbox/list").is_empty());
}

#[tokio::test]
async fn dubbed_prometido_com_grupo_en_vira_dub_lie() {
    let (mock, svc, _reset) = harness(Scene::DubLie).await;
    let hint = PlayHint {
        dubbed: true,
        ..PlayHint::default()
    };
    let err = play(&svc, &hint, None).await.unwrap_err();
    assert_eq!(err.kind(), "dub_lie");
    let recs = snapshot(&mock);
    // A prova de áudio sai antes de qualquer listagem/leitura de link.
    assert!(of(&recs, "/seedbox/list").is_empty());
}

#[tokio::test]
async fn episodio_errado_vira_episode_pick() {
    let (mock, svc, _reset) = harness(Scene::Mismatch).await;
    let err = play(&svc, &episode(2), None).await.unwrap_err();
    assert_eq!(err.kind(), "episode_pick");
    let recs = snapshot(&mock);
    assert!(of(&recs, "/seedbox/list").is_empty());
}
