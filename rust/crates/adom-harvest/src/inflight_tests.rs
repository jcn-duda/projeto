use super::*;

const ID: &str = "tt0111161::";

fn intent(reason: &str, br_probe: bool) -> HarvestIntent {
    HarvestIntent {
        reason: reason.into(),
        rank: reason_priority(reason),
        br_probe,
        priority_at: (reason == "br-gap").then_some(7),
        full: (!br_probe).then(|| PendingFull {
            reason: reason.into(),
            priority_at: (reason == "br-gap").then_some(7),
        }),
    }
}

#[test]
fn so_a_mesma_obra_coalesce() {
    let mut inflight = HarvestInflight::new();
    inflight.begin(ID, intent("miss", false));
    assert!(inflight.is_inflight(ID));
    assert!(!inflight.is_inflight("tt0903747:1:2"));
    assert!(!inflight.coalesce("tt0903747:1:2", &intent("miss", false)));
    assert!(inflight.coalesce(ID, &intent("miss", false)));
}

#[test]
fn rank_so_sobe_e_probe_e_aderente() {
    let mut inflight = HarvestInflight::new();
    inflight.begin(ID, intent("br-gap", false));
    assert!(inflight.coalesce(ID, &intent("miss", false)));
    assert!(inflight.coalesce(ID, &intent("miss", true)));
    let pending = inflight.pending(ID).unwrap();
    assert_eq!(pending.reason, "br-gap");
    assert!(pending.br_probe);
    assert_eq!(pending.priority_at, Some(7));
    assert!(inflight.coalesce(ID, &intent("next-episode", false)));
    assert_eq!(inflight.pending(ID).unwrap().reason, "next-episode");
    assert_eq!(inflight.pending(ID).unwrap().priority_at, None);
}

#[test]
fn full_ignora_dirigida_e_guarda_a_mais_forte() {
    let mut inflight = HarvestInflight::new();
    inflight.begin(ID, intent("miss", true));
    assert!(inflight.coalesce(ID, &intent("miss", true)));
    assert_eq!(inflight.pending(ID).unwrap().full, None);
    assert!(inflight.coalesce(ID, &intent("br-gap", false)));
    assert!(inflight.coalesce(ID, &intent("miss", false)));
    let full = inflight.pending(ID).unwrap().full.unwrap();
    assert_eq!(full.reason, "br-gap");
    assert_eq!(full.priority_at, Some(7));
}

#[test]
fn begin_semeia_full_da_base_e_nao_perde_para_sonda() {
    let mut inflight = HarvestInflight::new();
    inflight.begin(ID, intent("miss", false));
    assert_eq!(inflight.pending(ID).unwrap().full.unwrap().reason, "miss");
    assert!(inflight.coalesce(ID, &intent("br-gap", true)));
    let pending = inflight.pending(ID).unwrap();
    assert!(pending.br_probe);
    assert_eq!(pending.reason, "br-gap");
    assert_eq!(pending.full.as_ref().unwrap().reason, "miss");
}

#[test]
fn full_base_forte_ignora_full_fraca() {
    let mut inflight = HarvestInflight::new();
    inflight.begin(ID, intent("br-gap", false));
    assert!(inflight.coalesce(ID, &intent("miss", false)));
    assert_eq!(inflight.pending(ID).unwrap().full.unwrap().reason, "br-gap");
}

#[test]
fn pf_base_preserva_obrigacao_quando_sonda_chega() {
    let mut inflight = HarvestInflight::new();
    let mut pf = intent("br-gap", true);
    pf.full = Some(PendingFull {
        reason: "miss".into(),
        priority_at: None,
    });
    inflight.begin(ID, pf);
    assert!(inflight.coalesce(ID, &intent("next-episode", true)));
    let pending = inflight.pending(ID).unwrap();
    assert_eq!(pending.reason, "next-episode");
    assert_eq!(pending.full.unwrap().reason, "miss");
}

#[test]
fn identidade_diferente_nao_fecha_o_slot() {
    let mut inflight = HarvestInflight::new();
    inflight.begin(ID, intent("miss", false));
    inflight.end("tt0903747:1:2");
    assert!(inflight.is_inflight(ID));
    inflight.end(ID);
    assert!(!inflight.is_inflight(ID));
    assert_eq!(inflight.pending(ID), None);
}
