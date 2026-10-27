use serde_json::json;

use super::*;
use crate::alldebrid::alldebrid_tests::{
    empty_ok, envelope, listen, mock, mock_delete_fails, open, API_KEY,
};

#[test]
fn guards_nao_autorizam_upload_ou_posse_sem_evidencia() {
    assert_eq!(
        enqueue_decision(ReuploadEvidence::Unavailable),
        EnqueueDecision::GuardUnavailable
    );
    assert_eq!(
        enqueue_decision(ReuploadEvidence::Blocked),
        EnqueueDecision::Blocked
    );
    assert_eq!(
        enqueue_decision(ReuploadEvidence::BlockedButInventoryReady),
        EnqueueDecision::AlreadyReady
    );
    assert_eq!(
        enqueue_decision(ReuploadEvidence::Clear),
        EnqueueDecision::Upload
    );
    assert!(!should_mark_owned(true, Provenance::Unavailable));
    assert!(!should_mark_owned(true, Provenance::Preexisting));
    assert!(!should_mark_owned(false, Provenance::New));
    assert!(should_mark_owned(true, Provenance::New));
}

#[tokio::test]
async fn status_preserva_progresso_tipado_e_nao_condena_pelo_codigo() {
    let status = envelope(json!({"magnets": [
        {"hash":"AA", "id":42, "status":"Downloading", "statusCode":10,
         "downloaded":10, "size":100, "downloadSpeed":0, "seeders":0},
        {"hash":"BB", "status":"Downloading", "downloaded":"10", "size":100, "downloadSpeed":0, "seeders":0},
        {"hash":"CC", "status":"Error: no peer"},
        {"hash":"DD", "status":"Ready"}
    ]}));
    let addr = listen(mock(&empty_ok(), &status, &empty_ok())).await;
    let result = open(addr).torrent_status(API_KEY).await.unwrap();
    assert_eq!(result["aa"].state, AutofetchState::Downloading);
    assert_eq!(result["aa"].id.as_deref(), Some("42"));
    assert_eq!(result["aa"].progress.as_ref().unwrap().bytes, 10.0);
    assert!(result["bb"].progress.is_none());
    assert_eq!(result["cc"].state, AutofetchState::Dead);
    assert_eq!(result["dd"].state, AutofetchState::Ready);
}

#[tokio::test]
async fn delete_por_id_propagando_falha() {
    let addr = listen(mock(&empty_ok(), &empty_ok(), &empty_ok())).await;
    open(addr).remove_torrent(API_KEY, "42").await.unwrap();
    let addr = listen(mock_delete_fails(&empty_ok(), &empty_ok())).await;
    assert!(open(addr).remove_torrent(API_KEY, "42").await.is_err());
}
