use std::collections::HashMap;

use super::*;
use crate::premiumize::premiumize_tests::{listen, open, KEY};

#[tokio::test]
async fn cria_e_remove_por_id_com_formulario_e_propagacao_de_erro() {
    let (addr, seen) = listen(200, r#"{"status":"success","id":42}"#, None).await;
    let pm = open(addr);
    let hash = "a".repeat(40);
    assert_eq!(
        pm.enqueue(KEY, &hash, None).await.unwrap(),
        Some("42".into())
    );
    pm.remove_torrent(KEY, "42 +").await.unwrap();
    {
        let hits = seen.lock().unwrap();
        assert_eq!(hits[0].path, "/transfer/create");
        assert_eq!(hits[0].method, "POST");
        assert!(hits[0].body.contains("magnet%3A%3Fxt%3Durn%3Abtih%3A"));
        assert_eq!(hits[1].path, "/transfer/delete");
        assert_eq!(hits[1].body, "id=42+%2B");
    }
    let (addr, _) = listen(
        200,
        r#"{"status":"error","code":"account_limit_reached"}"#,
        None,
    )
    .await;
    assert_eq!(
        open(addr)
            .enqueue(KEY, &hash, None)
            .await
            .unwrap_err()
            .kind(),
        "quota"
    );
}

#[tokio::test]
async fn status_obedece_prioridade_src_id_nome_e_preserva_desconhecidos() {
    let a = "a".repeat(40);
    let b = "b".repeat(40);
    let c = "c".repeat(40);
    let data = format!(
        r#"{{"status":"success","transfers":[{{"id":"1","src":"magnet:?xt=urn:btih:{a}","name":"{c}","status":"finished"}},{{"id":"2","name":"{c}","status":"running","progress":0,"message":"0 Bytes of 0 Bytes"}},{{"name":"orphan","status":"error"}}]}}"#
    );
    let (addr, _) = listen(200, &data, None).await;
    let ids = HashMap::from([(b.clone(), "2".into())]);
    let report = open(addr).torrent_status(KEY, &ids).await.unwrap();
    assert_eq!(report.transfers[&a].state, TransferState::Ready);
    assert_eq!(report.transfers[&b].state, TransferState::Downloading);
    assert!(report.transfers[&b].stalled);
    assert!(report.transfers[&b].via_id);
    assert!(!report.transfers.contains_key(&c));
    assert_eq!((report.via_id, report.unmatched), (1, 1));
}
