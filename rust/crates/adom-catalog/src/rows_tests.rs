use super::{is_active, CatalogStore, MarkInput, Row};

fn row(id: &str) -> Row {
    Row {
        adapter: "alldebrid".into(),
        account: "acc".into(),
        service_id: id.into(),
        hash: "abc".into(),
        filename: "Filme.mkv".into(),
        cached: "unknown".into(),
        first_seen_at: 100,
        last_seen_at: 100,
        ..Row::default()
    }
}

fn get(store: &CatalogStore, id: &str) -> Row {
    store.get_row("alldebrid", "acc", id).unwrap().unwrap()
}

#[test]
fn upsert_nao_regride_first_seen_e_reabre_tombstone() {
    let store = CatalogStore::open_memory().unwrap();
    store.upsert_row(&row("1")).unwrap();
    let items = [MarkInput {
        service_id: "1".into(),
        reason: "duplicado".into(),
    }];
    store.mark_deleted("alldebrid", "acc", &items, 150).unwrap();
    let got = get(&store, "1");
    assert_eq!(got.deleted_at, 150);
    assert_eq!(got.delete_reason, "duplicado");

    let mut again = row("1");
    again.first_seen_at = 200;
    store.upsert_row(&again).unwrap();
    let got = get(&store, "1");
    assert_eq!(got.first_seen_at, 100);
    assert_eq!(got.deleted_at, 0);
    assert_eq!(got.delete_reason, "");
}

#[test]
fn prova_de_arquivo_vence_rescan_por_titulo() {
    let store = CatalogStore::open_memory().unwrap();
    let mut audited = row("1");
    audited.pt_proof = "arquivo".into();
    audited.audio = "dublado".into();
    audited.audited_at = 120;
    store.upsert_row(&audited).unwrap();

    let mut rescan = row("1");
    rescan.foreign_proof = "cena".into();
    store.upsert_row(&rescan).unwrap();
    let got = get(&store, "1");
    assert_eq!(got.pt_proof, "arquivo");
    assert_eq!(got.foreign_proof, "");
    assert_eq!(got.audio, "dublado");
    assert_eq!(got.audited_at, 120);
}

#[test]
fn absolvicao_por_titulo_nao_congela() {
    let store = CatalogStore::open_memory().unwrap();
    let mut first = row("1");
    first.pt_proof = "titulo".into();
    store.upsert_row(&first).unwrap();
    let mut rescan = row("1");
    rescan.foreign_proof = "cena".into();
    store.upsert_row(&rescan).unwrap();
    let got = get(&store, "1");
    assert_eq!(got.pt_proof, "");
    assert_eq!(got.foreign_proof, "cena");
}

#[test]
fn cached_at_so_renova_quando_o_veredito_muda() {
    let store = CatalogStore::open_memory().unwrap();
    let mut first = row("1");
    first.cached = "hit".into();
    first.cached_at = 10;
    store.upsert_row(&first).unwrap();
    let mut same = first.clone();
    same.cached_at = 20;
    store.upsert_row(&same).unwrap();
    assert_eq!(get(&store, "1").cached_at, 10);
    let mut changed = first.clone();
    changed.cached = "miss".into();
    changed.cached_at = 30;
    store.upsert_row(&changed).unwrap();
    assert_eq!(get(&store, "1").cached_at, 30);
}

#[test]
fn ativo_ignora_caixa() {
    assert!(is_active("Downloading"));
    assert!(!is_active("Ready"));
    assert!(!is_active(""));
}

#[test]
fn abre_arquivo_com_o_mesmo_esquema() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("sub").join("catalog.db");
    let store = CatalogStore::open(&path).unwrap();
    store.put_row(&row("9")).unwrap();
    drop(store);
    let reopened = CatalogStore::open(&path).unwrap();
    assert_eq!(reopened.list_rows("alldebrid", "acc").unwrap().len(), 1);
}
