use super::*;

fn gap<'a>(
    is_br: bool,
    dubbed: bool,
    quality: &'a str,
    source: Option<&'a str>,
    lied: bool,
) -> BrGapRelease<'a> {
    BrGapRelease {
        source,
        is_br,
        dubbed,
        lied,
        quality,
    }
}

fn probe<'a>(
    hash: &'a str,
    seeders: f64,
    is_br: bool,
    dubbed: bool,
    quality: &'a str,
    source: Option<&'a str>,
    lied: bool,
) -> BrProbeRelease<'a> {
    BrProbeRelease {
        hash,
        seeders,
        release: gap(is_br, dubbed, quality, source, lied),
    }
}

#[test]
fn hash_repetido_e_caixa_diferente_nao_contam() {
    let before = [probe("ABCD", 5.0, true, true, "1080p", None, false)];
    let same = [probe("abcd", 8.0, true, true, "1080p", None, false)];
    assert!(!probe_found_viable(&before, &same, None));
}

#[test]
fn hash_vazio_lied_autofetch_e_seed_zero_nao_contam() {
    let before = [];
    assert!(!probe_found_viable(
        &before,
        &[probe("", 4.0, true, true, "1080p", None, false)],
        None
    ));
    assert!(!probe_found_viable(
        &before,
        &[probe("aa", 4.0, true, true, "1080p", None, true)],
        None
    ));
    assert!(!probe_found_viable(
        &before,
        &[probe(
            "aa",
            4.0,
            true,
            true,
            "1080p",
            Some("autofetch"),
            false
        )],
        None
    ));
    assert!(!probe_found_viable(
        &before,
        &[probe("aa", 0.0, true, true, "1080p", None, false)],
        None
    ));
}

#[test]
fn upgrade_exige_1080p_exato() {
    let before = [probe("old", 2.0, true, true, "720p", None, false)];
    let only_720 = [probe("new1", 3.0, true, true, "720p", None, false)];
    let hd = [probe("new2", 3.0, true, true, "1080p", None, false)];
    let fourk = [probe("new3", 3.0, true, true, "2160p", None, false)];
    assert!(!probe_found_viable(
        &before,
        &only_720,
        Some(BR_GAP_TARGET_QUALITY)
    ));
    assert!(probe_found_viable(
        &before,
        &hd,
        Some(BR_GAP_TARGET_QUALITY)
    ));
    assert!(!probe_found_viable(
        &before,
        &fourk,
        Some(BR_GAP_TARGET_QUALITY)
    ));
}

#[test]
fn transicao_br_e_upgrade_sao_separadas() {
    let empty: [BrGapRelease<'_>; 0] = [];
    let low = [gap(true, true, "720p", None, false)];
    let hd = [gap(true, true, "1080p", None, false)];
    assert_eq!(br_transition(&empty, &low), BrTransition::Br);
    assert_eq!(br_transition(&low, &hd), BrTransition::Upgrade);
    assert_eq!(br_transition(&hd, &hd), BrTransition::None);
    assert_eq!(br_transition(&empty, &empty), BrTransition::None);
}
