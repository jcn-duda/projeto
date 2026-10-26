//! Provas do `NativeKv` na tabela `cache`: TTL 0 é permanente, expirado some
//! na leitura e a varredura por prefixo apaga o que venceu no caminho.

use serde_json::json;

use super::NativeKv;

#[test]
fn ttl_zero_persiste_e_expirado_some_na_leitura() {
    let kv = NativeKv::open_memory().unwrap();
    kv.put_json("autofetch:q", &json!([1]), 0, 1_000).unwrap();
    assert!(kv.get_json("autofetch:q", 10_000_000).unwrap().is_some());
    kv.put_json("autofetch:x", &json!(1), 1, 1_000).unwrap();
    assert!(kv.get_json("autofetch:x", 2_000).unwrap().is_none());
}

#[test]
fn forget_remove_so_a_chave_pedida_e_e_idempotente() {
    let kv = NativeKv::open_memory().unwrap();
    kv.put_json("autofetch:v1:q", &json!([]), 0, 1_000).unwrap();
    kv.put_json("autofetch:v1:hold:x", &json!({}), 0, 1_000)
        .unwrap();

    assert!(kv.forget("autofetch:v1:q").unwrap());
    assert!(!kv.forget("autofetch:v1:q").unwrap(), "idempotente");
    assert!(
        kv.get_json("autofetch:v1:hold:x", 2_000).unwrap().is_some(),
        "vizinha de prefixo não é tocada"
    );
}

#[test]
fn keys_matching_por_prefixo_apaga_expirado() {
    let kv = NativeKv::open_memory().unwrap();
    kv.put_json("autofetch:obra:tt1", &json!({"a": 1}), 0, 1_000)
        .unwrap();
    // expira em 2_000: a varredura em 2_000 já a considera vencida.
    kv.put_json("autofetch:suppressed:tt2", &json!(2), 1, 1_000)
        .unwrap();
    kv.put_json("rdq:hash", &json!(3), 0, 1_000).unwrap();

    let vivas = kv.keys_matching("autofetch:", 2_000).unwrap();
    assert_eq!(
        vivas,
        vec!["autofetch:obra:tt1".to_string()],
        "só a viva volta, e prefixo alheio fica fora"
    );

    // A expirada foi APAGADA na varredura: com relógio anterior à expiração
    // ela ainda seria "viva" se a linha existisse.
    let restantes = kv.keys_matching("autofetch:", 1_000).unwrap();
    assert_eq!(
        restantes,
        vec!["autofetch:obra:tt1".to_string()],
        "a linha expirada não volta nem com o relógio recuado"
    );

    assert!(
        kv.get_json("rdq:hash", 9_999_999).unwrap().is_some(),
        "prefixo alheio não é tocado pela varredura"
    );
}

#[test]
fn remaining_seconds_segue_a_regua_do_peek_remaining() {
    let kv = NativeKv::open_memory().unwrap();
    kv.put_json("adprot:v1:alldebrid:a:h1", &json!({"a": 1}), 3_600, 1_000)
        .unwrap();
    kv.put_json("adprot:v1:alldebrid:a:h2", &json!({"a": 1}), 0, 1_000)
        .unwrap();

    // 3_599_500 ms restantes = 3599,5 s: o Node arredonda para 3600.
    assert_eq!(
        kv.remaining_seconds("adprot:v1:alldebrid:a:h1", 1_500)
            .unwrap(),
        Some(3_600)
    );
    assert_eq!(
        kv.remaining_seconds("adprot:v1:alldebrid:a:h2", 1_500)
            .unwrap(),
        None,
        "permanente não tem o que renovar"
    );
    assert_eq!(
        kv.remaining_seconds("adprot:v1:alldebrid:a:h1", 4_000_000)
            .unwrap(),
        None,
        "vencida devolve None sem apagar"
    );
    assert!(
        kv.get_json("adprot:v1:alldebrid:a:h1", 1_600)
            .unwrap()
            .is_some(),
        "a sonda de TTL não apaga a linha"
    );
}

#[test]
fn forget_prefix_apaga_so_o_namespace_e_conta_linhas() {
    let kv = NativeKv::open_memory().unwrap();
    kv.put_json("adsub:v1:a:h1", &json!({"at": 1}), 0, 1_000)
        .unwrap();
    kv.put_json("adsub:v1:b:h2", &json!({"at": 2}), 0, 1_000)
        .unwrap();
    kv.put_json("adsub:v1x:a:h3", &json!({"at": 3}), 0, 1_000)
        .unwrap();

    assert_eq!(kv.forget_prefix("adsub:v1:").unwrap(), 2);
    assert_eq!(kv.forget_prefix("adsub:v1:").unwrap(), 0, "idempotente");
    assert!(
        kv.get_json("adsub:v1x:a:h3", 2_000).unwrap().is_some(),
        "prefixo mais longo não casa"
    );
}
