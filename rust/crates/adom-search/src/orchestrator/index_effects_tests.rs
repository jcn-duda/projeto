use super::*;

fn wire(
    hash: &str,
    is_br: bool,
    dubbed: bool,
    quality: &str,
    source: Option<&str>,
) -> IndexedReleaseWire {
    IndexedReleaseWire {
        hash: hash.to_string(),
        title: format!("Release {hash}"),
        size: None,
        indexer: "bludv".to_string(),
        tracker: None,
        is_br,
        dubbed,
        quality: quality.to_string(),
        seeders: 1,
        seen_at: 1,
        lied: false,
        source: source.map(str::to_string),
        media_source: None,
    }
}

fn plan(
    indexed: &[IndexedReleaseWire],
    partial: bool,
    covered: bool,
    autofetch: bool,
    bank: bool,
) -> FollowUpPlan {
    follow_up_plan(indexed, partial, covered, autofetch, true, || bank)
}

#[test]
fn indice_vazio_enfileira_miss() {
    let out = plan(&[], false, false, false, false);
    assert_eq!(out.actions, vec![FollowUpKind::HarvesterMiss]);
    assert!(out.miss);
}

#[test]
fn nao_coberto_enfileira_gap() {
    let indexed = vec![wire("a", true, true, "1080p", None)];
    let out = plan(&indexed, false, false, false, false);
    assert_eq!(out.actions, vec![FollowUpKind::HarvesterGap]);
    assert!(out.gap);
}

#[test]
fn parcial_nunca_vira_hit() {
    let indexed = vec![wire("a", true, true, "1080p", None)];
    let out = plan(&indexed, true, true, false, false);
    assert_eq!(out.actions, vec![FollowUpKind::HarvesterGap]);
    assert!(out.partial);
}

#[test]
fn autofetch_nao_vira_cobertura() {
    let indexed = vec![wire("a", false, false, "1080p", Some("autofetch"))];
    let out = plan(&indexed, false, false, true, false);
    assert_eq!(out.actions, vec![FollowUpKind::HarvesterGap]);
    assert!(out.autofetch_seed);
}

#[test]
fn coberto_com_br_dublado_nao_emite() {
    let indexed = vec![wire("a", true, true, "1080p", None)];
    let out = plan(&indexed, false, true, false, false);
    assert!(out.hit);
    assert!(out.served);
    assert!(out.actions.is_empty());
}

#[test]
fn coberto_sem_br_abre_sonda_com_evidencia_do_indice() {
    // BR público (isBr) sem dublado comprovado: evidência de origem basta.
    let indexed = vec![wire("a", true, false, "1080p", None)];
    let out = plan(&indexed, false, true, false, false);
    assert_eq!(out.actions, vec![FollowUpKind::BrProbeEvidence]);
    assert!(out.br_gap && !out.upgrade);
}

#[test]
fn br_so_abaixo_da_faixa_alvo_vira_upgrade() {
    let indexed = vec![wire("a", true, true, "720p", None)];
    let out = plan(&indexed, false, true, false, false);
    assert_eq!(out.actions, vec![FollowUpKind::BrProbeUpgrade]);
    assert!(out.upgrade);
}

#[test]
fn evidencia_so_no_acervo_tambem_abre_sonda() {
    let indexed = vec![wire("a", false, false, "1080p", None)];
    let out = plan(&indexed, false, true, false, true);
    assert_eq!(out.actions, vec![FollowUpKind::BrProbeEvidence]);
    assert!(out.bank_evidence);
}

#[test]
fn sem_evidencia_nenhuma_nao_emite_sonda() {
    let indexed = vec![wire("a", false, false, "1080p", None)];
    let out = plan(&indexed, false, true, false, false);
    assert!(out.actions.is_empty());
    assert!(out.no_evidence);
}

#[test]
fn sem_index_only_configurado_nao_ha_br_gap() {
    let indexed = vec![wire("a", false, false, "1080p", None)];
    let out = follow_up_plan(&indexed, false, true, false, false, || {
        panic!("não lê o banco")
    });
    assert!(out.actions.is_empty());
    assert!(!out.br_gap);
}

#[test]
fn efeitos_de_fio_do_plano() {
    let indexed = vec![wire("a", true, false, "1080p", None)];
    let out = plan(&indexed, false, true, false, false);
    let effects = effect_entries(&out, "tt123", "movie", None, None);
    assert_eq!(effects.len(), 1);
    assert_eq!(effects[0].kind, "br_probe");
    assert_eq!(
        effects[0].payload.get("mode").and_then(|v| v.as_str()),
        Some("evidence")
    );

    let miss = effect_entries(
        &plan(&[], false, false, false, false),
        "tt123",
        "series",
        Some(2),
        Some(5),
    );
    assert_eq!(miss[0].kind, "harvester_enqueue");
    assert_eq!(
        miss[0].payload.get("reason").and_then(|v| v.as_str()),
        Some("miss")
    );
    assert_eq!(
        miss[0].payload.get("season").and_then(|v| v.as_i64()),
        Some(2)
    );
    assert_eq!(
        plan_json(&plan(&[], false, false, false, false)),
        vec![json!({"kind": "harvester_enqueue", "reason": "miss"})]
    );
}
