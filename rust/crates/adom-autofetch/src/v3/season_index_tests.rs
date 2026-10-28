//! Paridade do índice LRU de temporadas (`autofetch-season-index.ts`).
//!
//! Sem config nem relógio: os dois tetos entram por parâmetro, como no TS eles
//! entram pela config efetiva.

use super::{season_fill_decision, SeasonFill, SeasonGap, SeasonIndex};

fn register(
    index: &mut SeasonIndex,
    season: i64,
    key: &str,
    max_seasons: usize,
    max_keys: usize,
) -> bool {
    index.register(
        true,
        "premiumize",
        "conta",
        "tt123",
        season,
        key,
        max_seasons,
        max_keys,
    )
}

#[test]
fn registra_e_devolve_a_busca_da_temporada() {
    let mut index = SeasonIndex::new();
    assert!(index.is_empty());
    assert!(register(&mut index, 2, "busca-s2", 8, 8));
    assert_eq!(index.len(), 1);
    assert_eq!(
        index.keys_of(&SeasonIndex::key("premiumize", "conta", "tt123", 2)),
        Some(["busca-s2".to_string()].as_slice())
    );
    assert_eq!(
        SeasonIndex::key("premiumize", "conta", "tt123", 2),
        "premiumize:conta:tt123:2"
    );
}

#[test]
fn mesma_busca_nao_duplica() {
    let mut index = SeasonIndex::new();
    register(&mut index, 1, "busca", 8, 8);
    register(&mut index, 1, "busca", 8, 8);
    let key = SeasonIndex::key("premiumize", "conta", "tt123", 1);
    assert_eq!(index.keys_of(&key).map(|keys| keys.len()), Some(1));
}

#[test]
fn teto_de_buscas_por_temporada_descarta_a_mais_antiga() {
    let mut index = SeasonIndex::new();
    register(&mut index, 1, "k1", 8, 2);
    register(&mut index, 1, "k2", 8, 2);
    register(&mut index, 1, "k3", 8, 2);
    let key = SeasonIndex::key("premiumize", "conta", "tt123", 1);
    assert_eq!(
        index.keys_of(&key),
        Some(["k2".to_string(), "k3".to_string()].as_slice())
    );
}

#[test]
fn teto_de_temporadas_evicta_a_mais_antiga() {
    let mut index = SeasonIndex::new();
    register(&mut index, 1, "b1", 2, 8);
    register(&mut index, 2, "b2", 2, 8);
    register(&mut index, 3, "b3", 2, 8);
    assert_eq!(index.len(), 2);
    assert!(index
        .keys_of(&SeasonIndex::key("premiumize", "conta", "tt123", 1))
        .is_none());
    assert!(index
        .keys_of(&SeasonIndex::key("premiumize", "conta", "tt123", 3))
        .is_some());
}

#[test]
fn registrar_de_novo_move_a_temporada_para_o_fim_do_lru() {
    let mut index = SeasonIndex::new();
    register(&mut index, 1, "b1", 2, 8);
    register(&mut index, 2, "b2", 2, 8);
    // S1 volta a ser usada: passa a ser a mais nova.
    register(&mut index, 1, "b1b", 2, 8);
    register(&mut index, 3, "b3", 2, 8);
    assert!(index
        .keys_of(&SeasonIndex::key("premiumize", "conta", "tt123", 2))
        .is_none());
    assert!(index
        .keys_of(&SeasonIndex::key("premiumize", "conta", "tt123", 1))
        .is_some());
}

#[test]
fn desligado_ou_teto_zero_nao_registram() {
    let mut index = SeasonIndex::new();
    assert!(!index.register(false, "premiumize", "conta", "tt123", 1, "b1", 8, 8));
    assert!(!index.register(true, "premiumize", "conta", "tt123", 1, "b1", 0, 8));
    assert!(index.is_empty());
}

#[test]
fn take_devolve_e_remove_a_temporada() {
    let mut index = SeasonIndex::new();
    register(&mut index, 4, "b1", 8, 8);
    register(&mut index, 4, "b2", 8, 8);
    let key = SeasonIndex::key("premiumize", "conta", "tt123", 4);
    assert_eq!(index.take(&key), vec!["b1".to_string(), "b2".to_string()]);
    assert!(index.take(&key).is_empty());
    assert!(index.is_empty());
}

#[test]
fn pack_pronto_invalida_so_a_temporada_declarada() {
    // A ordem real do recheck: decisão de preenchimento e depois `take` da
    // temporada do pack. A busca da OUTRA temporada não pode ser descartada.
    let mut index = SeasonIndex::new();
    register(&mut index, 1, "b1", 8, 8);
    register(&mut index, 2, "b2", 8, 8);
    let decision = season_fill_decision(
        true,
        "Some Show Season 2 Complete",
        SeasonGap { season: Some(3) },
        true,
    );
    assert_ne!(decision, SeasonFill::Fill { season: 3 });
    let keys = index.take(&SeasonIndex::key("premiumize", "conta", "tt123", 2));
    assert_eq!(keys, vec!["b2".to_string()]);
    assert!(index
        .keys_of(&SeasonIndex::key("premiumize", "conta", "tt123", 1))
        .is_some());
}
