//! Estados do snapshot `knownBefore` por conta: fresco, vencido, em voo e falha.
//!
//! O refresh real (`load_inner`) pede a rede; aqui exercitamos o contrato de
//! estado (`begin`/`finish`/`peek`) que decide se a limpeza pode usar a
//! referência. Sem referência autorizada, ninguém sai (fail-safe).

use std::collections::HashSet;
use std::time::Duration;

use super::Inventory;

fn set(items: &[&str]) -> HashSet<String> {
    items.iter().map(|item| item.to_string()).collect()
}

#[test]
fn snapshot_fresco_e_consultavel() {
    let inv = Inventory::new(Duration::from_secs(60));
    assert!(inv.begin("conta"));
    inv.finish("conta", Some(set(&["aa"])));
    let snapshot = inv.peek("conta").expect("snapshot fresco");
    assert!(snapshot.contains("aa"));
}

#[test]
fn snapshot_vencido_nao_autoriza_e_aceita_novo_refresh() {
    let inv = Inventory::new(Duration::from_millis(1));
    assert!(inv.begin("conta"));
    inv.finish("conta", Some(set(&["aa"])));
    std::thread::sleep(Duration::from_millis(10));
    assert!(inv.peek("conta").is_none(), "vencido não é referência");
    assert!(inv.begin("conta"), "vencido libera o refresh");
}

#[test]
fn ttl_zero_nunca_e_fresco() {
    // `ALLDEBRID_PREEXISTING_TTL_MS=0`: nenhum snapshot vale, como no Node.
    let inv = Inventory::new(Duration::ZERO);
    assert!(inv.begin("conta"));
    inv.finish("conta", Some(set(&["aa"])));
    assert!(inv.peek("conta").is_none());
}

#[test]
fn refresh_em_voo_nao_dispara_segundo() {
    let inv = Inventory::new(Duration::from_secs(60));
    assert!(inv.begin("conta"));
    assert!(!inv.begin("conta"), "um refresh em voo por conta");
    assert!(inv.peek("conta").is_none(), "em voo não há referência");
}

#[test]
fn falha_limpa_a_referencia_e_a_proxima_tenta_de_novo() {
    let inv = Inventory::new(Duration::from_secs(60));
    assert!(inv.begin("conta"));
    inv.finish("conta", Some(set(&["aa"])));
    assert!(inv.begin("conta"));
    inv.finish("conta", None);
    assert!(
        inv.peek("conta").is_none(),
        "falha não deixa referência velha"
    );
    assert!(inv.begin("conta"), "falha libera nova tentativa");
}

#[test]
fn contas_nao_compartilham_snapshot() {
    let inv = Inventory::new(Duration::from_secs(60));
    assert!(inv.begin("a"));
    inv.finish("a", Some(set(&["aa"])));
    assert!(
        inv.peek("b").is_none(),
        "snapshot da conta A não vaza para B"
    );
}
