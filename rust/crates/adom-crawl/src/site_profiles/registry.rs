//! Registro dos sites com suas configs de rede.
//!
//! São os 9 sites BR do raspador (8 cards do Jackett + o Mico) mais o
//! TorrentGalaxy, que é GLOBAL (en-US) e entra aqui só como PERFIL DE REDE:
//! o `adom-resolvers` tira daqui host, espelho, timeout e User-Agent (o
//! `profile.rs` do resolver lê este registry — nada é duplicado). O raspador
//! NÃO cobre o TGx: ele não tem parser nem trilha de descoberta, logo nunca
//! entra na fila do motor (`crawl_url` é a fila; a lista do registry não a
//! decide). Ver `tests.rs::torrentgalaxy_e_perfil_mas_nao_site_do_raspador`.
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
        build_torrentgalaxy(),
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

/// O site tem ritmo próprio (ex.: Mico)?
///
/// Roteamento single-owner: o dono de um site `own_pace` é a lane dedicada do
/// motor Rust (`motor::mico_lane`), com adaptador e ritmo próprios. O lote
/// paralelo o exclui em `store::ops::take_next_batch` (não divide vaga nem
/// teto agregado) e o `RoutedPageEngine` manda a página para a engine dele.
pub fn is_own_pace(site_id: &str) -> bool {
    site_network_config(site_id).is_some_and(|c| c.own_pace)
}

/// Lista de todos os `site_id` conhecidos — perfis de rede registrados, NÃO a
/// lista de sites do raspador: o TorrentGalaxy aparece aqui (perfil do
/// resolver) sem ser coberto pela raspagem.
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
        "torrentgalaxy-cardigann",
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
//
// `candidate_hosts` espelha o `FALLBACK_SITE_SUFFIXES` de cada profile TS
// (`resolvers/profiles/*`). Domínio de site BR muda: ao trocar lá, troque aqui.

/// VacaTorrent: base + systemtech.space + mundgostoso.site; assert-only: t.co,
/// vacadb.org. O `mundgostoso.site` é um SALTO da cadeia do protetor (o botão
/// segue em systemtech.space): medido em 2026-10-24, sem ele todo `/resolve` do
/// Vaca dava `blocked_host` e o dublado sumia da lista.
fn build_vacatorrent() -> SiteNetworkConfig {
    SiteNetworkConfig {
        site_id: "vacatorrent".into(),
        candidate_hosts: strings(&[
            "vaqueirofilmes1.com",
            "vaqueirofilmes.com",
            "vacatorrentmov.com",
        ]),
        // Fonte única dos hosts do protetor do Vaca (botão + saltos).
        protector_suffixes: protector_suffixes(
            crate::shared::protector_suffixes::VACA_EXTRA_PROTECTOR_SUFFIXES,
        ),
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
        candidate_hosts: strings(&["redetorrent.xyz", "redetorrent.com"]),
        protector_suffixes: protector_suffixes(&["systemads.free.nf"]),
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
            "bludvfilmes2.xyz",
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
        candidate_hosts: strings(&[
            "xnerdfilmes.net",
            "nerdfilmestorrent.com",
            "nerdfilmestorrent.org",
            "nerdfilmestorrent.net",
            "nerdviatorrents.net",
            "filmesviatorrents.net",
            "filmesviatorrenthd.org",
            "filmesviatorrenthd.net",
            "xfilmeshd.org",
            "xfilmeshd.net",
        ]),
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
        candidate_hosts: strings(&[
            "comandotorrents.to",
            "comandotorrents.net",
            "comandotorrents.org",
        ]),
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
        candidate_hosts: strings(&[
            "torrentdosfilmes-v2.xyz",
            "torrentdosfilmes.com",
            "torrentdosfilmes.net",
        ]),
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
        candidate_hosts: strings(&["apachetorrents.com", "apachetorrent.com"]),
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

/// TorrentGalaxy: SEM FlareSolverr. Medido em 2026-10-24: o cliente HTTP do
/// Jackett (.NET HttpClient/SChannel) cai na página de desafio do Cloudflare e
/// devolve 200 com ZERO itens, com resposta byte-idêntica para qualquer
/// User-Agent (node, Chrome, `Jackett/1.0`, curl e vazio: 381.622 B, 50 linhas,
/// `server: cloudflare`) — não é header, é transporte. O `reqwest` 0.12 com
/// rustls (HTTP/1.1) passa limpo: 10/10 requisições com as 50 linhas em
/// 0,22–0,61 s, no host e no container. O FlareSolverr também passa, mas custa
/// 2,7–3,8 s por chamada — não pode ser o caminho quente. Por isso
/// `uses_flare: false`: o fetch direto é o caminho, e a detecção de desafio do
/// `is_cloudflare_challenge` NÃO entra (ela dá falso positivo aqui: marca
/// desafio numa página de 200 com 50 linhas).
fn build_torrentgalaxy() -> SiteNetworkConfig {
    SiteNetworkConfig {
        site_id: "torrentgalaxy-cardigann".into(),
        candidate_hosts: strings(&["torrentgalaxy.one", "torrentgalaxy.info"]),
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
