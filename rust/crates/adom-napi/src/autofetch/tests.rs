//! Testes unitários do `decide` (puro, sem Node).

use super::*;

fn gates() -> EnqueueGatesIn {
    EnqueueGatesIn {
        is_paused: false,
        is_dead: false,
        is_cached: false,
        marker_active: false,
        lock_acquired: true,
        slot_acquired: true,
        obra_cap_granted: true,
        account_blocked: false,
        budget_granted: true,
    }
}

fn options() -> PoolOptionsIn {
    PoolOptionsIn {
        season: None,
        min_seeders: 1.0,
        pt_first: true,
        auto_fetch_max: 3.0,
        queue_depth: 0.0,
        top_seeds_max: 2.0,
        rare_max: 0.0,
        rare_threshold: 0.0,
        rare_max_seeders: 0.0,
        auto_fetch_br: true,
        adapter_cache_check: true,
        adapter_autofetch_source: false,
        any_dubbed: true,
        top_seeds: true,
    }
}

fn policy() -> SeedsPolicyIn {
    SeedsPolicyIn {
        dubbed_only: false,
        cached_only: true,
        max_size_gb: 0.0,
        seeds_max_gb: 0.0,
        seeds_max_quality: "1080p".into(),
    }
}

fn br_stream(hash: &str, quality: &str) -> AutofetchStreamIn {
    AutofetchStreamIn {
        info_hash: Some(hash.into()),
        title: Some(format!("Movie 1988 {quality} DUBLADO")),
        name: None,
        quality: Some(quality.into()),
        seeders: Some(10.0),
        size_bytes: Some(1_000_000_000.0),
        pack_bytes: None,
        is_br: true,
        is_dubbed: true,
        is_dub_claim: false,
        is_bank_dub: false,
        is_lied: false,
        is_cached: false,
        from_fallback: false,
        fallback_fetchable: false,
        viable: true,
    }
}

fn input(streams: Vec<AutofetchStreamIn>) -> AutofetchInput {
    AutofetchInput {
        streams,
        options: options(),
        seeds_policy: policy(),
        gates: gates(),
        obra_entries: Vec::new(),
        pending_reservations: Vec::new(),
    }
}

#[test]
fn toggle_desligado_nao_seleciona() {
    let mut inp = input(vec![br_stream("aaa", "1080p")]);
    inp.options.auto_fetch_br = false;
    let d = decide(&inp);
    assert!(d.immediates.is_empty());
    assert!(d.trace.disabled);
    assert_eq!(d.trace.pool, "none");
}

#[test]
fn pool_br_vira_imediato() {
    let d = decide(&input(vec![
        br_stream("aaa", "1080p"),
        br_stream("bbb", "720p"),
    ]));
    assert_eq!(d.trace.pool, "br");
    assert_eq!(d.immediates.len(), 2);
    assert_eq!(d.immediates[0].info_hash, "aaa");
    assert!(d.skips.is_empty());
}

#[test]
fn portao_fechado_vira_skip_com_rollback() {
    let mut inp = input(vec![br_stream("aaa", "1080p")]);
    inp.gates.is_paused = true;
    let d = decide(&inp);
    assert!(d.immediates.is_empty());
    assert_eq!(d.skips.len(), 1);
    assert_eq!(d.skips[0].reason, "paused");
    assert_eq!(d.skips[0].rollback, vec!["hold".to_string()]);
}

#[test]
fn stream_inviavel_sai_do_pool_br() {
    let mut s = br_stream("aaa", "1080p");
    s.viable = false;
    let d = decide(&input(vec![s]));
    assert_eq!(d.trace.pool, "none");
    assert!(d.immediates.is_empty());
}

#[test]
fn obra_status_conta_registro_e_reservas() {
    let mut inp = input(vec![br_stream("aaa", "1080p")]);
    inp.obra_entries.push(ObraRecordIn {
        hash: "x".into(),
        pool: "br".into(),
        accepted_at: 0.0,
        title: None,
        br: true,
        dubbed: true,
        id: None,
        quality: Some("720p".into()),
        overflow: false,
    });
    inp.pending_reservations.push(PendingIn {
        id: "1".into(),
        pool: "seeds".into(),
        rare: false,
        at: 0.0,
        hash: "y".into(),
        quality: None,
        overflow: false,
    });
    let d = decide(&inp);
    assert_eq!(d.obra_status.br, 1);
    assert_eq!(d.obra_status.seeds, 1);
    assert_eq!(d.obra_status.total, 2);
    assert_eq!(d.obra_status.view_len, 2);
}
