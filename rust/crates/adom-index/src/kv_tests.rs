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
