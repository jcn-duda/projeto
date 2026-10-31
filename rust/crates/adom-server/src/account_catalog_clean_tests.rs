//! Auditoria de arquivos e limpeza de estrangeiro provado do catálogo, contra
//! o mesmo fake da porta (sem rede).

use std::sync::Arc;

use super::clean;
use super::port::CatalogFile;
use super::support::*;

#[tokio::test(flavor = "multi_thread")]
async fn limpeza_sem_inventario_fecha_e_com_include_known_libera() {
    let store = store_with(vec![]);
    let mut port = FakePort::new(Ok(vec![]), &[]);
    port.known = None;
    let d = deps(store, port, Arc::new(FakeFacts::default()));
    let closed = clean::cleanup_preview(d.clone(), false).await;
    assert_eq!(
        closed,
        serde_json::json!({ "ok": false, "reason": "inventario-frio" })
    );
    let open = clean::cleanup_preview(d, true).await;
    assert_eq!(open["ok"], true, "{open}");
}

#[tokio::test(flavor = "multi_thread")]
async fn limpeza_apaga_estrangeiro_provado_e_marca_com_nome() {
    let mut foreign = row("1", HASH_A, "Filme.2019.RARBG.mkv", 1000, true, 1000);
    foreign.foreign_proof = "cena".to_string();
    let store = store_with(vec![foreign]);
    let facts = Arc::new(FakeFacts::default());
    let d = deps(
        store.clone(),
        FakePort::new(Ok(vec![]), &["1"]),
        facts.clone(),
    );
    let out = clean::cleanup_apply(d, None, false).await;
    assert_eq!(num(&out, "deleted"), 1, "{out}");
    assert!(!alive(&store, "1"));
    let hooks = facts.hooks.lock().unwrap().clone();
    assert_eq!(
        hooks,
        vec![(HASH_A.to_string(), Some("Filme.2019.RARBG.mkv".to_string()))]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn auditoria_sem_arquivos_marca_sem_condenar_e_erro_conta_e_segue() {
    let store = store_with(vec![
        row("1", HASH_A, "Filme.mkv", 1000, true, 1000),
        row("2", HASH_B, "Outro.mkv", 900, true, 1000),
    ]);
    let mut port = FakePort::new(Ok(vec![]), &[]);
    port.files_err.insert("1".to_string());
    // "2" tem arquivos: a prova é gravada e a linha ganha bucket.
    port.files.insert(
        "2".to_string(),
        vec![CatalogFile {
            path: "Outro.DUBLADO.mkv".to_string(),
            size: 900.0,
        }],
    );
    let facts = Arc::new(FakeFacts::default());
    let d = deps(store.clone(), port, facts.clone());
    let out = clean::audit(d, Some(5), Some(1)).await;
    assert_eq!(num(&out, "failed"), 1, "{out}");
    assert_eq!(num(&out, "scanned"), 1);
    assert_eq!(num(&out, "evidenced"), 1);
    assert_eq!(
        facts.recorded.lock().unwrap().clone(),
        vec![HASH_B.to_string()]
    );
    assert!(
        store
            .get_row(ADAPTER, ACCOUNT, "2")
            .unwrap()
            .unwrap()
            .audited_at
            > 0
    );
    assert_eq!(
        store
            .get_row(ADAPTER, ACCOUNT, "1")
            .unwrap()
            .unwrap()
            .audited_at,
        0
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn auditoria_sem_arquivos_marca_auditada_sem_tocar_a_condenacao() {
    let store = store_with(vec![row("1", HASH_A, "Filme.mkv", 1000, true, 1000)]);
    let d = deps(
        store.clone(),
        FakePort::new(Ok(vec![]), &[]),
        Arc::new(FakeFacts::default()),
    );
    let out = clean::audit(d, Some(5), Some(1)).await;
    assert_eq!(num(&out, "scanned"), 1, "{out}");
    assert_eq!(num(&out, "evidenced"), 0);
    assert!(
        store
            .get_row(ADAPTER, ACCOUNT, "1")
            .unwrap()
            .unwrap()
            .audited_at
            > 0
    );
}
