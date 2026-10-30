//! Posse da checagem (`adsub:v1`) gravada no KV nativo: chave, valor, TTL,
//! normalização e filtros (inválido/duplicado), TTL zero e a régua do env.
//! Tudo com `NativeKv::open_memory()`; o `spawn` com gate fica em
//! `alldebrid_marks_tests.rs` (precisa do banco de teste do processo).

use adom_index::NativeKv;
use serde_json::json;

use super::{parse_ttl_seconds, write_marks, MarkedBatch};
use crate::alldebrid_cleanup::{account_scope, adsub_key};

const KEY: &str = "chave-da-conta-marks";
const NOW: i64 = 1_700_000_000_000;
const WEEK_SECONDS: i64 = 604_800;
const HIT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HIT2: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn batch(submitted: &[&str]) -> MarkedBatch {
    MarkedBatch {
        api_key: KEY.into(),
        submitted: submitted.iter().map(|hash| hash.to_string()).collect(),
    }
}

fn kv() -> NativeKv {
    NativeKv::open_memory().expect("KV em memória")
}

#[test]
fn grava_chave_com_escopo_da_conta_valor_at_e_ttl() {
    let kv = kv();
    let written = write_marks(&kv, &batch(&[HIT]), WEEK_SECONDS, NOW).unwrap();
    assert_eq!(written, 1);
    let key = format!("adsub:v1:{}:{HIT}", account_scope(KEY));
    assert_eq!(key, adsub_key(&account_scope(KEY), HIT));
    assert_eq!(kv.get_json(&key, NOW).unwrap(), Some(json!({ "at": NOW })));
    // TTL de 7 dias: o restante é o próprio TTL, arredondado.
    assert_eq!(kv.remaining_seconds(&key, NOW).unwrap(), Some(WEEK_SECONDS));
    // Vencida a janela, o leitor não enxerga mais a posse.
    assert_eq!(kv.get_json(&key, NOW + WEEK_SECONDS * 1_000).unwrap(), None);
}

#[test]
fn ignora_invalido_e_duplicado_e_conta_so_os_unicos_validos() {
    let kv = kv();
    let lote = batch(&[HIT, HIT2, "nao-e-hash", "123", "", HIT, HIT2]);
    assert_eq!(write_marks(&kv, &lote, WEEK_SECONDS, NOW).unwrap(), 2);
    let scope = account_scope(KEY);
    assert!(kv.get_json(&adsub_key(&scope, HIT), NOW).unwrap().is_some());
    assert!(kv
        .get_json(&adsub_key(&scope, HIT2), NOW)
        .unwrap()
        .is_some());
    // Hash inválido nunca vira chave.
    let live = kv
        .keys_matching(&format!("adsub:v1:{scope}:"), NOW)
        .unwrap();
    assert_eq!(live.len(), 2, "só os dois hashes válidos: {live:?}");
}

#[test]
fn hash_em_maiusculas_vira_minusculas_e_dedupa_com_a_forma_minuscula() {
    let kv = kv();
    let maiusculas = HIT.to_uppercase();
    // Mesmo hash em caixa alta e com espaço: uma única posse.
    let com_espaco = format!("  {HIT}  ");
    let lote = batch(&[maiusculas.as_str(), com_espaco.as_str()]);
    assert_eq!(write_marks(&kv, &lote, WEEK_SECONDS, NOW).unwrap(), 1);
    // `adsub_key` já normaliza: a forma em caixa alta cai na MESMA linha, então
    // a prova é a contagem de linhas da conta (uma só, não duas).
    let live = kv
        .keys_matching(&format!("adsub:v1:{}:", account_scope(KEY)), NOW)
        .unwrap();
    assert_eq!(live, vec![adsub_key(&account_scope(KEY), HIT)]);
}

#[test]
fn ttl_zero_nao_grava_nada() {
    let kv = kv();
    assert_eq!(write_marks(&kv, &batch(&[HIT]), 0, NOW).unwrap(), 0);
    assert_eq!(write_marks(&kv, &batch(&[HIT]), -5, NOW).unwrap(), 0);
    let live = kv
        .keys_matching(&format!("adsub:v1:{}:", account_scope(KEY)), NOW)
        .unwrap();
    assert!(live.is_empty(), "posse desligada não escreve linha");
}

#[test]
fn lote_sem_hash_valido_devolve_zero_sem_erro() {
    let kv = kv();
    assert_eq!(
        write_marks(&kv, &batch(&["x", ""]), WEEK_SECONDS, NOW).unwrap(),
        0
    );
}

#[test]
fn ttl_do_env_default_zero_negativo_e_lixo() {
    // Ausente = 7 dias (o default do Node).
    assert_eq!(parse_ttl_seconds(None), WEEK_SECONDS);
    // Vazio e `0` desligam a posse.
    assert_eq!(parse_ttl_seconds(Some("")), 0);
    assert_eq!(parse_ttl_seconds(Some("   ")), 0);
    assert_eq!(parse_ttl_seconds(Some("0")), 0);
    // Negativo nunca chega a `> 0`: desliga.
    assert_eq!(parse_ttl_seconds(Some("-1")), 0);
    assert_eq!(parse_ttl_seconds(Some("-604800000")), 0);
    // Lixo cai no default.
    assert_eq!(parse_ttl_seconds(Some("lixo")), WEEK_SECONDS);
    // Ms → segundos com piso.
    assert_eq!(parse_ttl_seconds(Some("120000")), 120);
    assert_eq!(parse_ttl_seconds(Some("1500")), 1);
    assert_eq!(parse_ttl_seconds(Some("999")), 0);
}
