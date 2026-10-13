//! Registro dos 9 sites BR com suas configs de rede.
//!
//! A tabela é construída uma vez (via `OnceLock`) e consultada por `site_id`.
//! Os dados foram extraídos dos profiles TS equivalentes.

use std::sync::OnceLock;

use super::config::{SiteNetworkConfig, BASE_PROTECTOR_SUFFIXES, FLARE_SESSION_TTL_MS};

/// Constrói a lista de configs de todos os sites conhecidos.
fn build_site_table() -> Vec<SiteNetworkConfig> {
    vec![
        build_vacatorrent(),
        build_redetorrent(),
        build_bludv(),
        build_nerdfilmes(),
        build_comandotorrents(),
        build_torrentdosfilmes(),
        build_hdrtorrent(),
        build_apachetorrent(),
        build_mico(),
    ]
}

/// Tabela global de configs — inicializada uma vez, imutável depois.
static SITE_TABLE: OnceLock<Vec<SiteNetworkConfig>> = OnceLock::new();

/// Retorna a config de rede de um site pelo `site_id`.
pub fn site_network_config(site_id: &str) -> Option<&'static SiteNetworkConfig> {
    let table = SITE_TABLE.get_or_init(build_site_table);
    table.iter().find(|c| c.site_id == site_id)
}

/// Retorna as configs de todos os sites registrados.
pub fn all_site_configs() -> Vec<&'static SiteNetworkConfig> {
    let table = SITE_TABLE.get_or_init(build_site_table);
    table.iter().collect()
}

/// Lista de todos os `site_id` conhecidos.
pub fn all_site_ids() -> Vec<&'static str> {
    vec![
        "vacatorrent",
        "redetorrent-cardigann",
        "bludv-cardigann",
        "nerdfilmes",
        "comandotorrents",
        "torrentdosfilmesv2",
        "hdrtorrent-cardigann",
        "apachetorrent-cardigann",
        "mico",
    ]
}

// ─── Helpers de construção ──────────────────────────────────────────────────

/// Protetores base + sufixos extras como `Vec<String>`.
fn protector_suffixes(extras: &[&str]) -> Vec<String> {
    BASE_PROTECTOR_SUFFIXES
        .iter()
        .chain(extras.iter())
        .map(|s| s.to_string())
        .collect()
}

/// Vec<String> a partir de slice de &str.
fn strings(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

// ─── Builders por site ──────────────────────────────────────────────────────

/// VacaTorrent: base + systemtech.space; assert-only: t.co, vacadb.org.
fn build_vacatorrent() -> SiteNetworkConfig {
    SiteNetworkConfig {
        site_id: "vacatorrent".into(),
        candidate_hosts: strings(&["vaqueirofilmes1.com", "vaqueirofilmes.com"]),
        protector_suffixes: protector_suffixes(&["systemtech.space"]),
        assert_only_suffixes: strings(&["t.co", "vacadb.org"]),
        timeout_ms: 15_000,
        max_hops: 10,
        uses_flare: true,
        flare_session_ttl_ms: FLARE_SESSION_TTL_MS,
        user_agent: super::config::DEFAULT_USER_AGENT.to_string(),
        own_pace: false,
        min_gap_ms: None,
    }
}

/// RedeTorrent: magnet direto + token systemads (base64).
fn build_redetorrent() -> SiteNetworkConfig {
    SiteNetworkConfig {
        site_id: "redetorrent-cardigann".into(),
        candidate_hosts: strings(&["redetorrent.com", "redetorrent.tv"]),
        // TODO: confirmar hosts específicos do TS (redetorrent usa systemads base)
        protector_suffixes: protector_suffixes(&[]),
        assert_only_suffixes: Vec::new(),
        timeout_ms: 15_000,
        max_hops: 10,
        uses_flare: true,
        flare_session_ttl_ms: FLARE_SESSION_TTL_MS,
        user_agent: super::config::DEFAULT_USER_AGENT.to_string(),
        own_pace: false,
        min_gap_ms: None,
    }
}

/// BLUDV: systemads → 302 → videosad → magnet. Dois saltos.
fn build_bludv() -> SiteNetworkConfig {
    SiteNetworkConfig {
        site_id: "bludv-cardigann".into(),
        candidate_hosts: strings(&[
            "bludvfilmes.xyz",
            "bludvfilmes1.xyz",
            "bludv.net",
            "bludv.xyz",
            "bludv.to",
        ]),
        // TODO: confirmar hosts específicos do TS (bludv usa systemads/videosad da base)
        protector_suffixes: protector_suffixes(&[]),
        assert_only_suffixes: Vec::new(),
        timeout_ms: 15_000,
        max_hops: 6,
        uses_flare: true,
        flare_session_ttl_ms: FLARE_SESSION_TTL_MS,
        user_agent: super::config::DEFAULT_USER_AGENT.to_string(),
        own_pace: false,
        min_gap_ms: None,
    }
}

/// NerdFilmes: sem Flare, protetor embutido `/link.php`.
fn build_nerdfilmes() -> SiteNetworkConfig {
    SiteNetworkConfig {
        site_id: "nerdfilmes".into(),
        candidate_hosts: strings(&["nerdfilmes.net", "nerdfilmes.tv"]),
        protector_suffixes: protector_suffixes(&[]),
        assert_only_suffixes: Vec::new(),
        timeout_ms: 15_000,
        max_hops: 10,
        uses_flare: false,
        flare_session_ttl_ms: 0,
        user_agent: super::config::DEFAULT_USER_AGENT.to_string(),
        own_pace: false,
        min_gap_ms: None,
    }
}

/// ComandoTorrents: sem Flare, usa a régua compartilhada de protetor.
fn build_comandotorrents() -> SiteNetworkConfig {
    SiteNetworkConfig {
        site_id: "comandotorrents".into(),
        candidate_hosts: strings(&["comandotorrents.com", "comandotorrents.tv"]),
        protector_suffixes: protector_suffixes(&[]),
        assert_only_suffixes: Vec::new(),
        timeout_ms: 15_000,
        max_hops: 10,
        uses_flare: false,
        flare_session_ttl_ms: 0,
        user_agent: super::config::DEFAULT_USER_AGENT.to_string(),
        own_pace: false,
        min_gap_ms: None,
    }
}

/// TorrentDosFilmes: sem Flare, magnet por prefixo ou protetor absoluto.
fn build_torrentdosfilmes() -> SiteNetworkConfig {
    SiteNetworkConfig {
        site_id: "torrentdosfilmesv2".into(),
        candidate_hosts: strings(&["torrentdosfilmes.net", "torrentdosfilmes.tv"]),
        protector_suffixes: protector_suffixes(&[]),
        assert_only_suffixes: Vec::new(),
        timeout_ms: 15_000,
        max_hops: 10,
        uses_flare: false,
        flare_session_ttl_ms: 0,
        user_agent: super::config::DEFAULT_USER_AGENT.to_string(),
        own_pace: false,
        min_gap_ms: None,
    }
}

/// HDRTorrent: sem Flare, catálogo PHP próprio.
fn build_hdrtorrent() -> SiteNetworkConfig {
    SiteNetworkConfig {
        site_id: "hdrtorrent-cardigann".into(),
        candidate_hosts: strings(&["hdrtorrents.net"]),
        protector_suffixes: protector_suffixes(&[]),
        assert_only_suffixes: Vec::new(),
        timeout_ms: 15_000,
        max_hops: 10,
        uses_flare: false,
        flare_session_ttl_ms: 0,
        user_agent: super::config::DEFAULT_USER_AGENT.to_string(),
        own_pace: false,
        min_gap_ms: None,
    }
}

/// ApacheTorrent: sem Flare, catálogo PHP próprio.
fn build_apachetorrent() -> SiteNetworkConfig {
    SiteNetworkConfig {
        site_id: "apachetorrent-cardigann".into(),
        candidate_hosts: strings(&["apachetorrent.com"]),
        protector_suffixes: protector_suffixes(&[]),
        assert_only_suffixes: Vec::new(),
        timeout_ms: 15_000,
        max_hops: 10,
        uses_flare: false,
        flare_session_ttl_ms: 0,
        user_agent: super::config::DEFAULT_USER_AGENT.to_string(),
        own_pace: false,
        min_gap_ms: None,
    }
}

/// Mico: API própria, ritmo próprio, sem host de site.
fn build_mico() -> SiteNetworkConfig {
    SiteNetworkConfig {
        site_id: "mico".into(),
        candidate_hosts: Vec::new(),
        protector_suffixes: Vec::new(),
        assert_only_suffixes: Vec::new(),
        timeout_ms: 15_000,
        max_hops: 1,
        uses_flare: false,
        flare_session_ttl_ms: 0,
        user_agent: super::config::DEFAULT_USER_AGENT.to_string(),
        own_pace: true,
        min_gap_ms: Some(1_000),
    }
}
