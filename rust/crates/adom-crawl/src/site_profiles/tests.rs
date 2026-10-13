//! Testes dos perfis de site e da allowlist resolvida.

use super::*;

/// `vacatorrent` existe no registry e usa FlareSolverr.
#[test]
fn vacatorrent_has_flare() {
    let cfg = site_network_config("vacatorrent").expect("vacatorrent deve existir");
    assert!(cfg.uses_flare, "vacatorrent deve usar FlareSolverr");
    assert_eq!(cfg.site_id, "vacatorrent");
    assert_eq!(cfg.candidate_hosts, vec!["vaqueirofilmes1.com", "vaqueirofilmes.com"]);
}

/// `mico` tem ritmo próprio e gap mínimo configurado.
#[test]
fn mico_own_pace() {
    let cfg = site_network_config("mico").expect("mico deve existir");
    assert!(cfg.own_pace, "mico deve ter own_pace=true");
    assert_eq!(cfg.min_gap_ms, Some(1_000));
    assert!(cfg.candidate_hosts.is_empty(), "mico é API, não tem host de site");
    assert_eq!(cfg.max_hops, 1);
}

/// Site desconhecido retorna `None`.
#[test]
fn unknown_site_returns_none() {
    assert!(site_network_config("unknown").is_none());
    assert!(site_network_config("").is_none());
}

/// `resolve_allowlist` para vacatorrent inclui `systemtech.space` (protetor extra)
/// e `t.co` (assert-only).
#[test]
fn vacatorrent_allowlist_includes_extras() {
    let cfg = site_network_config("vacatorrent").unwrap();
    let allowlist = resolve_allowlist(cfg);

    // Protetor extra do Vaca.
    assert!(
        allowlist.has_allowed_host("systemtech.space"),
        "allowlist deve incluir systemtech.space"
    );
    assert!(
        allowlist.has_allowed_host("sub.systemtech.space"),
        "allowlist deve cobrir subdomínio de systemtech.space"
    );

    // Assert-only: t.co e vacadb.org.
    assert!(
        allowlist.is_assert_only_host("t.co"),
        "t.co deve ser assert-only"
    );
    assert!(
        allowlist.is_assert_only_host("vacadb.org"),
        "vacadb.org deve ser assert-only"
    );

    // Host do próprio site.
    assert!(
        allowlist.has_allowed_host("vaqueirofilmes1.com"),
        "allowlist deve incluir candidate_hosts"
    );
}

/// Todos os 9 sites estão no registry.
#[test]
fn all_nine_sites_registered() {
    let expected_ids = vec![
        "vacatorrent",
        "redetorrent-cardigann",
        "bludv-cardigann",
        "nerdfilmes",
        "comandotorrents",
        "torrentdosfilmesv2",
        "hdrtorrent-cardigann",
        "apachetorrent-cardigann",
        "mico",
    ];

    let all = all_site_configs();
    assert_eq!(all.len(), 9, "devem ser 9 sites registrados");

    for id in &expected_ids {
        assert!(
            site_network_config(id).is_some(),
            "site '{id}' deve estar no registry"
        );
    }
}

/// `all_site_ids` retorna os mesmos 9 ids.
#[test]
fn all_site_ids_count() {
    let ids = all_site_ids();
    assert_eq!(ids.len(), 9);
}

/// Sites sem Flare têm `flare_session_ttl_ms = 0`.
#[test]
fn non_flare_sites_have_zero_ttl() {
    for cfg in all_site_configs() {
        if !cfg.uses_flare {
            assert_eq!(
                cfg.flare_session_ttl_ms, 0,
                "site '{}' sem Flare deve ter ttl=0",
                cfg.site_id
            );
        }
    }
}

/// BLUDV tem max_hops=6 (diferente do default 10).
#[test]
fn bludv_max_hops_is_six() {
    let cfg = site_network_config("bludv-cardigann").unwrap();
    assert_eq!(cfg.max_hops, 6);
}

/// `resolve_allowlist` para Mico é vazia (API sem hosts).
#[test]
fn mico_allowlist_is_empty() {
    let cfg = site_network_config("mico").unwrap();
    let allowlist = resolve_allowlist(cfg);
    assert!(allowlist.all_suffixes().is_empty());
}

/// Defaults globais estão corretos.
#[test]
fn default_constants() {
    assert_eq!(DEFAULT_TIMEOUT_MS, 15_000);
    assert_eq!(DEFAULT_MAX_HOPS, 10);
    assert_eq!(FLARE_SESSION_TTL_MS, 1_200_000);
    assert!(DEFAULT_USER_AGENT.contains("Mozilla"));
}
