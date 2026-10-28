use super::season_fill_eligible;

#[test]
fn so_pack_compativel_com_temporada_gera_fill() {
    assert!(season_fill_eligible(
        "Some Show Season 2 Complete",
        Some(2),
        true
    ));
    assert!(!season_fill_eligible(
        "Some Show Season 2 Complete",
        Some(2),
        false
    ));
    assert!(!season_fill_eligible(
        "Some Show Season 3 Complete",
        Some(2),
        true
    ));
}
