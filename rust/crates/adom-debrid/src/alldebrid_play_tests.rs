//! Play do AllDebrid contra o servidor falso. Sem rede real.

use std::time::Duration;

use adom_core::PlayHint;
use serde_json::json;

use super::alldebrid_tests::{
    empty_ok, envelope, hash_of, hits, listen, mock, mock_delete_fails, open, values, Hit, API_KEY,
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
    assert_eq!(link.url.as_deref(), Some("https://cdn.test/s01e02"));
    assert!(!link.unavailable);
    // Prova do play: a lista inteira do torrent, como o recordFileEvidence do TS.
    let files = link.files.expect("lista do torrent pronto");
    assert_eq!(files.len(), 2);
    assert_eq!(files[1].path, "Season 1/Show.S01E02.mkv");
    assert_eq!(files[1].size, 20.0);
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
    assert!(link.url.is_none());
    assert!(link.unavailable, "frio apagado vira davail=0 no Node");
    assert!(link.files.is_none());
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
    assert!(link.url.is_none());
    assert!(
        !link.unavailable,
        "protegido segue baixando na conta: não é negativo"
    );
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
    assert_eq!(err.error.kind(), "no_video");
    assert!(
        err.files.is_none(),
        "sem vídeo lança antes da prova, como no TS"
    );
    assert!(hits(&text).iter().all(|hit| hit.path != "/link/unlock"));
}

#[tokio::test]
async fn dubbed_prometido_com_grupo_en_vira_dub_lie_sem_unlock() {
    let status = envelope(json!({"magnets": {"id": 7, "status": "Ready", "files": [{
        "n": "Filme.1080p.WEB-DL.x264-RARBG.mkv", "s": 10, "l": "https://files.test/en"
    }]}}));
    let scene = mock(
        &envelope(json!({"magnets": [{"id": 7}]})),
        &status,
        &envelope(json!({"link": "https://cdn.test/en"})),
    );
    let ad = open(listen(scene.clone()).await);
    let hint = PlayHint {
        dubbed: true,
        ..PlayHint::default()
    };
    let err = ad
        .resolve_link(API_KEY, &hash_of('f'), &hint, &play_opts(false, false))
        .await
        .unwrap_err();
    assert_eq!(err.error.kind(), "dub_lie");
    // A lista é gravada antes do assert (ordem do TS), mas o link não abre.
    assert!(err.files.is_some());
    assert!(hits(&scene).iter().all(|hit| hit.path != "/link/unlock"));
}

#[tokio::test]
async fn resolve_frio_com_delete_que_falha_ainda_e_negativo_e_nao_derruba() {
    // O delete falha: o TS só avisa e ainda grava davail=0.
    let scene = mock_delete_fails(
        &envelope(json!({"magnets": [{"id": 9}]})),
        &envelope(json!({"magnets": [{"id": 9, "status": "Downloading"}]})),
    );
    let ad = open(listen(scene.clone()).await);
    let played = ad
        .resolve_link(
            API_KEY,
            &hash_of('d'),
            &PlayHint::default(),
            &play_opts(true, false),
        )
        .await
        .expect("falha do delete não derruba o play");
    assert!(played.url.is_none());
    assert!(played.unavailable);
}

#[tokio::test]
async fn resolve_frio_com_drop_uncached_desligado_nao_e_negativo() {
    let scene = mock(
        &envelope(json!({"magnets": [{"id": 9}]})),
        &envelope(json!({"magnets": [{"id": 9, "status": "Downloading"}]})),
        &empty_ok(),
    );
    let ad = open(listen(scene.clone()).await);
    let played = ad
        .resolve_link(
            API_KEY,
            &hash_of('e'),
            &PlayHint::default(),
            &play_opts(false, false),
        )
        .await
        .unwrap();
    assert!(!played.unavailable, "sem delete não há prova de frio");
}
