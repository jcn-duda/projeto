//! Pack multiobra no lote do Chupim: só entra quando é o único BR dublado.

use serde_json::json;

use super::parse_items;

fn hashes(payload: serde_json::Value) -> Vec<String> {
    parse_items(payload.as_object().expect("objeto"))
        .into_iter()
        .map(|item| item.info_hash)
        .collect()
}

#[test]
fn colecao_dublada_entra_quando_e_o_unico_br() {
    let got = hashes(json!({"items": [
        {"infoHash": "en1", "_br": false, "_dubbed": false},
        {"infoHash": "col", "_multiWorkAdmitted": true, "_br": true, "_dubClaim": true}
    ]}));
    assert_eq!(got, ["en1", "col"]);
}

#[test]
fn colecao_fica_fora_com_br_de_obra_unica() {
    let got = hashes(json!({"items": [
        {"infoHash": "br1", "_br": true, "_dubbed": true},
        {"infoHash": "col", "_multiWorkAdmitted": true, "_br": true, "_dubbed": true}
    ]}));
    assert_eq!(got, ["br1"]);
}

#[test]
fn colecao_sem_prova_de_dublado_ou_desmentida_fica_fora() {
    let got = hashes(json!({"items": [
        {"infoHash": "leg", "_multiWorkAdmitted": true, "_br": true},
        {"infoHash": "lie", "_multiWorkAdmitted": true, "_br": true, "_dubbed": true, "_lied": true},
        {"infoHash": "glb", "_multiWorkAdmitted": true, "_br": false, "_dubbed": true}
    ]}));
    assert!(got.is_empty(), "{got:?}");
}
