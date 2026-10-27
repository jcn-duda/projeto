use serde_json::json;

use super::*;
use crate::alldebrid::alldebrid_tests::{
    empty_ok, envelope, hash_of, hits, listen, mock, mock_delete_fails, open, values, API_KEY,
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

/// O upload já é o "começa a baixar": o id numérico vira texto (o delete o usa
/// assim) e `ready:true` prova o ⚡ sem uma segunda chamada.
#[tokio::test]
async fn upload_aceito_com_id_numerico_e_pronto() {
    let upload = envelope(json!({"magnets": [
        {"id": 4242, "hash": hash_of('a'), "ready": true}
    ]}));
    let scene = mock(&upload, &empty_ok(), &empty_ok());
    let addr = listen(scene.clone()).await;
    // Entra em caixa alta de propósito: o serviço e o memo de posse comparam em
    // minúsculas, e o hash enviado tem que ser o normalizado.
    let out = open(addr)
        .upload_magnet(API_KEY, &hash_of('a').to_uppercase())
        .await
        .unwrap();
    assert!(out.accepted);
    assert_eq!(out.id.as_deref(), Some("4242"));
    assert!(out.ready);

    // O nome do parâmetro é contrato da API (`magnets[]`, não `magnet`): sem
    // esta prova o teste passaria mesmo com um upload que a AllDebrid ignora.
    let hit = hits(&scene);
    assert_eq!(hit.len(), 1);
    assert_eq!(hit[0].path, "/magnet/upload");
    assert!(hit[0].auth_ok);
    assert_eq!(values(&hit[0].query, "magnets[]"), vec![hash_of('a')]);
}

/// Aceite sem `ready` é download em andamento, não cache: o chamador precisa
/// da distinção para esperar o status em vez de gravar ⚡.
#[tokio::test]
async fn upload_aceito_ainda_baixando_nao_e_pronto() {
    let upload = envelope(json!({"magnets": [
        {"id": "77", "hash": hash_of('b'), "ready": false, "status": "Downloading"}
    ]}));
    let addr = listen(mock(&upload, &empty_ok(), &empty_ok())).await;
    let out = open(addr)
        .upload_magnet(API_KEY, &hash_of('b'))
        .await
        .unwrap();
    assert!(out.accepted);
    assert_eq!(out.id.as_deref(), Some("77"));
    assert!(!out.ready);
}

/// A API alterna entre o booleano e o texto; o texto `Ready` também é prova.
#[tokio::test]
async fn pronto_tambem_pelo_texto_do_status() {
    let upload = envelope(json!({"magnets": [{"id": 8, "status": "Ready"}]}));
    let addr = listen(mock(&upload, &empty_ok(), &empty_ok())).await;
    let out = open(addr)
        .upload_magnet(API_KEY, &hash_of('c'))
        .await
        .unwrap();
    assert!(out.accepted);
    assert!(out.ready);
}

/// Lista vazia é a RECUSA do serviço (não erro de rede): `accepted:false` sem
/// `Err`, para o chamador seguir a fila em vez de tratar como falha transitória.
#[tokio::test]
async fn lista_vazia_e_recusa_sem_erro() {
    let upload = envelope(json!({"magnets": []}));
    let scene = mock(&upload, &empty_ok(), &empty_ok());
    let addr = listen(scene.clone()).await;
    let out = open(addr)
        .upload_magnet(API_KEY, &hash_of('d'))
        .await
        .unwrap();
    assert_eq!(
        out,
        UploadOutcome {
            accepted: false,
            id: None,
            ready: false,
        }
    );
    // A requisição foi feita — a recusa veio do serviço, não da guarda local.
    assert_eq!(hits(&scene).len(), 1);
}

/// Hash vazio (ou só espaço) não vira requisição: um magnet sem hash entraria
/// na conta sem nada para casar com o inventário depois.
#[tokio::test]
async fn hash_vazio_nao_gera_requisicao() {
    let scene = mock(&empty_ok(), &empty_ok(), &empty_ok());
    let addr = listen(scene.clone()).await;
    for hash in ["", "   "] {
        let out = open(addr).upload_magnet(API_KEY, hash).await.unwrap();
        assert_eq!(
            out,
            UploadOutcome {
                accepted: false,
                id: None,
                ready: false,
            }
        );
    }
    assert!(hits(&scene).is_empty());
}
