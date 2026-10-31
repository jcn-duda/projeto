use super::*;

#[test]
fn flush_e_leitura_fazem_ida_e_volta() {
    let kv = NativeKv::open_memory().expect("kv em memória");
    let mut snapshot = BTreeMap::new();
    snapshot.insert("meta.resolve.total".to_string(), 12);
    snapshot.insert("meta.fallback.used".to_string(), 3);
    flush_now(&kv, snapshot.clone(), 1_000).expect("grava o agregado");

    let counts = load_persisted(&kv, 2_000).expect("lê o agregado");
    assert_eq!(counts, snapshot);
}

#[test]
fn primeiro_boot_sem_linha_e_mapa_vazio() {
    let kv = NativeKv::open_memory().expect("kv em memória");
    let counts = load_persisted(&kv, 1_000).expect("linha ausente não é erro");
    assert!(counts.is_empty());
}

#[test]
fn valor_que_nao_e_objeto_e_erro() {
    let kv = NativeKv::open_memory().expect("kv em memória");
    kv.put_json(KEY, &Value::Bool(true), 0, 1_000)
        .expect("grava lixo");
    let err = load_persisted(&kv, 2_000).expect_err("não é objeto");
    assert!(err.contains(KEY), "{err} cita a chave");
}

#[test]
fn contador_nao_numerico_e_erro() {
    let kv = NativeKv::open_memory().expect("kv em memória");
    let mut object = Map::new();
    object.insert(
        "meta.resolve.total".to_string(),
        Value::String("12".to_string()),
    );
    kv.put_json(KEY, &Value::Object(object), 0, 1_000)
        .expect("grava lixo");
    let err = load_persisted(&kv, 2_000).expect_err("contador não numérico");
    assert!(err.contains("não é numérico"), "{err}");
}

#[test]
fn chave_tem_segmento_apos_a_versao_para_a_guarda_do_prefixo() {
    // O Node bloqueia pelo PREFIXO (`metam:v1:` em `RUST_OWNED_PREFIXES`): a
    // chave sem segmento (`metam:v1`) não casaria com o `startsWith` da guarda.
    assert!(
        KEY.starts_with("metam:v1:") && KEY.len() > "metam:v1:".len(),
        "{KEY} casa com o prefixo guardado"
    );
}
