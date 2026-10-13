//! Configuração de rede por site do raspador.
//!
//! Cada site BR tem suas próprias características de rede: hosts candidatos,
//! protetores de link, timeout, uso de FlareSolverr, etc. Este módulo define
//! a struct `SiteNetworkConfig` e os defaults compartilhados.

/// Timeout padrão para fetch direto (ms).
pub const DEFAULT_TIMEOUT_MS: u64 = 15_000;

/// Máximo de redirects por cadeia.
pub const DEFAULT_MAX_HOPS: usize = 10;

/// TTL da sessão FlareSolverr (ms) — 20 minutos.
pub const FLARE_SESSION_TTL_MS: u64 = 1_200_000;

/// User-Agent padrão do raspador.
pub const DEFAULT_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

/// Base comum de protetores de link (TS: `BASE_PROTECTOR_SUFFIXES`).
///
/// Compartilhada entre a maioria dos sites; cada perfil pode estender com
/// sufixos específicos.
pub const BASE_PROTECTOR_SUFFIXES: &[&str] = &[
    "systemads1.com",
    "systemads.net",
    "videosad.net",
    "canalfutebol.com",
    "temreceita.com",
];

/// Configuração de rede de um site específico.
///
/// Define hosts, protetores, timeouts e comportamento de FlareSolverr para
/// cada perfil do raspador. Os dados vêm dos profiles TS equivalentes.
#[derive(Debug, Clone)]
pub struct SiteNetworkConfig {
    /// Identificador do site (id do card do Jackett / perfil TS).
    pub site_id: String,
    /// Hosts candidatos do site (domínios principais).
    pub candidate_hosts: Vec<String>,
    /// Sufixos de protetores de link conhecidos deste site.
    pub protector_suffixes: Vec<String>,
    /// Hosts aceitos apenas como salto (não são destino final).
    pub assert_only_suffixes: Vec<String>,
    /// Timeout do fetch direto (ms).
    pub timeout_ms: u64,
    /// Máximo de redirects na cadeia.
    pub max_hops: usize,
    /// Se o site usa FlareSolverr para contorno de proteção.
    pub uses_flare: bool,
    /// TTL da sessão FlareSolverr (ms). Só relevante quando `uses_flare = true`.
    pub flare_session_ttl_ms: u64,
    /// User-Agent padrão para requisições a este site.
    pub user_agent: String,
    /// Se o site tem ritmo próprio (ex.: Mico — API com throttle próprio).
    pub own_pace: bool,
    /// Gap mínimo entre requisições (ms). Só relevante quando `own_pace = true`.
    pub min_gap_ms: Option<u64>,
}

impl SiteNetworkConfig {
    /// Construtor com defaults sensíveis; o registry preenche os campos
    /// específicos de cada site.
    pub fn new(site_id: impl Into<String>) -> Self {
        Self {
            site_id: site_id.into(),
            candidate_hosts: Vec::new(),
            protector_suffixes: Vec::new(),
            assert_only_suffixes: Vec::new(),
            timeout_ms: DEFAULT_TIMEOUT_MS,
            max_hops: DEFAULT_MAX_HOPS,
            uses_flare: false,
            flare_session_ttl_ms: FLARE_SESSION_TTL_MS,
            user_agent: DEFAULT_USER_AGENT.to_string(),
            own_pace: false,
            min_gap_ms: None,
        }
    }
}

// Allowlist foi movida para `crate::net::allowlist::Allowlist`.
// Use `site_profiles::resolve_allowlist(config)` para montar a partir da config.
