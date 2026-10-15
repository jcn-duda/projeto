//! Play do AllDebrid contra o servidor falso. Sem rede real.

use std::time::Duration;

use adom_core::PlayHint;
use serde_json::json;

use super::alldebrid_tests::{
    empty_ok, envelope, hash_of, hits, listen, mock, open, values, Hit, API_KEY,
};
use super::ResolveOpts;

fn play_opts(drop_uncached: bool, held: bool) -> ResolveOpts {
    ResolveOpts {
        poll_wait: Duration::ZERO,
        drop_uncached,
        held,
    }
}

#[tokio::test]
async fn resolve_ready_devolve_o_link_do_episodio() {
    let status = envelope(json!({"magnets": {"id": 9, "status": "Ready", "files": [{
        "n": "Season 1",
        "e": [
            {"n": "Show.S01E01.mkv", "s": 10, "l": "https://files.test/e01"},
            {"n": "Show.S01E02.mkv", "s": 20, "l": "https://files.test/e02"}
        ]
    }]}}));
    let scene = mock(
        &envelope(json!({"magnets": [{"id": 9}]})),
        &status,
        &envelope(json!({"link": "https://cdn.test/s01e02"})),
    );
    let ad = open(listen(scene.clone()).await);
    let hint = PlayHint {
        season: Some(1),
        episode: Some(2),
        ..PlayHint::default()
    };
    let link = tokio::time::timeout(
        Duration::from_secs(2),
        ad.resolve_link(API_KEY, &hash_of('a'), &hint, &play_opts(true, false)),
    )
    .await
    .expect("poll")
    .unwrap();
    assert_eq!(link.as_deref(), Some("https://cdn.test/s01e02"));
    let seen = hits(&scene);
    assert!(seen
        .iter()
        .all(|hit| hit.auth_ok && hit.query.starts_with("agent=stremio-adom")));
    assert_eq!(
        seen.iter()
            .filter(|hit| hit.path == "/magnet/status")
            .count(),
        1
    );
    assert!(seen.iter().all(|hit| hit.path != "/magnet/delete"));
    let unlock = seen.iter().find(|hit| hit.path == "/link/unlock").unwrap();
    assert_eq!(
        values(&unlock.query, "link"),
        vec!["https://files.test/e02".to_string()]
    );
}

#[tokio::test]
async fn resolve_que_nao_fica_ready_devolve_none_e_apaga_uma_vez() {
    let scene = mock(
        &envelope(json!({"magnets": [{"id": 9}]})),
        &envelope(json!({"magnets": [{"id": 9, "status": "Downloading"}]})),
        &empty_ok(),
    );
    let ad = open(listen(scene.clone()).await);
    let link = tokio::time::timeout(
        Duration::from_secs(2),
        ad.resolve_link(
            API_KEY,
            &hash_of('c'),
            &PlayHint::default(),
            &play_opts(true, false),
        ),
    )
    .await
    .expect("poll")
    .unwrap();
    assert!(link.is_none());
    let seen = hits(&scene);
    assert_eq!(
        seen.iter()
            .filter(|hit| hit.path == "/magnet/status")
            .count(),
        4
    );
    let deleted: Vec<&Hit> = seen
        .iter()
        .filter(|hit| hit.path == "/magnet/delete")
        .collect();
    assert_eq!(deleted.len(), 1);
    assert_eq!(values(&deleted[0].query, "id"), vec!["9".to_string()]);
}

#[tokio::test]
async fn resolve_held_nao_apaga_e_sem_video_sobe_erro() {
    let cold = mock(
        &envelope(json!({"magnets": [{"id": 9}]})),
        &envelope(json!({"magnets": [{"id": 9, "status": "Downloading"}]})),
        &empty_ok(),
    );
    let ad = open(listen(cold.clone()).await);
    let link = ad
        .resolve_link(
            API_KEY,
            &hash_of('c'),
            &PlayHint::default(),
            &play_opts(true, true),
        )
        .await
        .unwrap();
    assert!(link.is_none());
    assert!(hits(&cold).iter().all(|hit| hit.path != "/magnet/delete"));

    let text = mock(
        &envelope(json!({"magnets": [{"id": 4}]})),
        &envelope(
            json!({"magnets": {"id": 4, "status": "Ready", "files": [{"n": "readme.txt", "s": 1, "l": "https://files.test/txt"}]}}),
        ),
        &empty_ok(),
    );
    let ad = open(listen(text.clone()).await);
    let err = ad
        .resolve_link(
            API_KEY,
            &hash_of('a'),
            &PlayHint::default(),
            &play_opts(false, false),
        )
        .await
        .unwrap_err();
    assert_eq!(err.kind(), "no_video");
    assert!(hits(&text).iter().all(|hit| hit.path != "/link/unlock"));
}
