use super::*;
use crate::types::{HarvestMediaType, PendingFull};

fn entry(reason: &str, br_probe: bool, full_base: bool) -> HarvestEntry {
    HarvestEntry {
        imdb_id: "tt0111161".into(),
        media_type: HarvestMediaType::Movie,
        season: None,
        episode: None,
        reason: reason.into(),
        enqueued_at: 1_000,
        priority_at: (reason == "br-gap").then_some(1_000),
        resumed: false,
        br_probe,
        full_base,
        full_intent: None,
    }
}

#[test]
fn strongest_empate_preserva_o_atual() {
    let old = PendingFull {
        reason: "miss".into(),
        priority_at: Some(1),
    };
    let new = PendingFull {
        reason: "popular".into(),
        priority_at: Some(2),
    };
    let kept = PendingFull::strongest(Some(old.clone()), Some(new)).unwrap();
    assert_eq!(kept.reason, "miss");
    assert_eq!(kept.priority_at, Some(1));
}

#[test]
fn strongest_sobe_so_com_motivo_mais_forte() {
    let old = PendingFull {
        reason: "miss".into(),
        priority_at: None,
    };
    let new = PendingFull {
        reason: "br-gap".into(),
        priority_at: Some(9),
    };
    let kept = PendingFull::strongest(Some(old), Some(new)).unwrap();
    assert_eq!(kept.reason, "br-gap");
    assert_eq!(kept.priority_at, Some(9));
}

#[test]
fn pending_full_sintetiza_full_e_legado_full_base() {
    let full = entry("miss", false, false);
    assert_eq!(full.pending_full().unwrap().reason, "miss");

    let probe = entry("br-gap", true, false);
    assert_eq!(probe.pending_full(), None);

    let legado = entry("br-gap", true, true);
    assert_eq!(legado.pending_full().unwrap().reason, "br-gap");
}

#[test]
fn merge_sonda_sobre_full_e_full_sobre_sonda() {
    let mut base = entry("miss", false, false);
    let mut probe = entry("br-gap", true, false);
    base.merge_intent(&probe);
    assert!(base.br_probe);
    assert!(base.full_base);
    assert_eq!(base.reason, "br-gap");
    assert_eq!(base.pending_full().unwrap().reason, "miss");

    probe.merge_intent(&entry("miss", false, false));
    assert!(probe.br_probe);
    assert!(probe.full_base);
    assert_eq!(probe.reason, "br-gap");
    assert_eq!(probe.pending_full().unwrap().reason, "miss");
    assert_eq!(probe.enqueued_at, 1_000);
}
